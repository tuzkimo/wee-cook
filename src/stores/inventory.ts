import { ref } from "vue";
import { defineStore } from "pinia";
import { getDb } from "@/db";
import { activeScope } from "@/services/scope";
import { enqueueSync } from "@/services/sync";
import { useAuthStore } from "@/stores/auth";
import type {
  BatchInput,
  BatchStock,
  CookLine,
  CookResult,
  InventoryBatch,
  InventoryUsage,
} from "@/types";
import { planDeduction } from "@/utils/inventory";

interface BatchRow {
  id: string;
  scope_id: string;
  owner_id: string | null;
  ingredient_id: string;
  amount: number;
  unit_id: string | null;
  produced_at: string | null;
  shelf_life_days: number | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  ingredient_name: string;
  unit_name: string | null;
  used: number;
}

/**
 * 库存归范围（个人 / 团队）：所有查询都带 `scope_id = 当前范围`（spec §11.3）。
 * 余量永远派生（批次数量 − 未删除使用记录），所以「改批次」这种操作不存在，只提供删除。
 * 写库后把整行重新读出来入同步队列：服务端要的是完整形状，不是差量。
 */
export const useInventoryStore = defineStore("inventory", () => {
  const batches = ref<BatchStock[]>([]);

  async function fetchAll(): Promise<void> {
    const scope = activeScope.value;
    const rows = await getDb().select<BatchRow[]>(
      `SELECT b.id, b.scope_id, b.owner_id, b.ingredient_id, b.amount, b.unit_id, b.produced_at,
              b.shelf_life_days, b.expires_at, b.created_at, b.updated_at, b.deleted_at,
              i.name AS ingredient_name, u.name AS unit_name,
              COALESCE(x.used, 0) AS used
       FROM inventory_batches b
       JOIN ingredients i ON i.id = b.ingredient_id
       LEFT JOIN units u ON u.id = b.unit_id
       LEFT JOIN (
         SELECT batch_id, SUM(amount) AS used
         FROM inventory_usages
         WHERE deleted_at IS NULL AND scope_id = ?
         GROUP BY batch_id
       ) x ON x.batch_id = b.id
       WHERE b.scope_id = ? AND b.deleted_at IS NULL
       ORDER BY b.expires_at IS NULL ASC, b.expires_at ASC, b.created_at ASC, b.id ASC`,
      [scope, scope],
    );
    batches.value = rows.map((row) => ({
      batch: {
        id: row.id,
        scope_id: row.scope_id,
        owner_id: row.owner_id,
        ingredient_id: row.ingredient_id,
        amount: row.amount,
        unit_id: row.unit_id,
        produced_at: row.produced_at,
        shelf_life_days: row.shelf_life_days,
        expires_at: row.expires_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at,
      },
      ingredient_name: row.ingredient_name,
      unit_name: row.unit_name,
      remaining: row.amount - row.used,
    }));
  }

  async function addBatch(input: BatchInput): Promise<void> {
    requireValid(input);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await getDb().execute(
      `INSERT INTO inventory_batches
         (id, scope_id, owner_id, ingredient_id, amount, unit_id, produced_at, shelf_life_days,
          expires_at, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        activeScope.value,
        currentOwnerId(),
        input.ingredient_id,
        input.amount,
        input.unit_id,
        input.produced_at,
        input.shelf_life_days,
        input.expires_at,
        now,
        now,
      ],
    );
    await fetchAll();
    await enqueueBatch(id);
  }

  /** 软删批次。使用记录一动不动 —— 历史不追改。 */
  async function removeBatch(id: string): Promise<void> {
    const now = new Date().toISOString();
    await getDb().execute(
      "UPDATE inventory_batches SET deleted_at = ?, updated_at = ? WHERE id = ?",
      [now, now, id],
    );
    await fetchAll();
    // 软删也要入队（带墓碑），否则服务端永远不知道它被删了
    await enqueueBatch(id);
  }

  /** 某食材各单位的可用余量。同步读内存，调用前先 fetchAll。 */
  function remainingByIngredient(
    ingredientIds: string[],
  ): Map<string, { unit_id: string | null; remaining: number }[]> {
    const wanted = new Set(ingredientIds);
    const map = new Map<string, { unit_id: string | null; remaining: number }[]>();
    for (const item of batches.value) {
      const { ingredient_id, unit_id } = item.batch;
      if (!wanted.has(ingredient_id) || item.remaining <= 0) continue;
      const parts = map.get(ingredient_id) ?? [];
      const part = parts.find((entry) => entry.unit_id === unit_id);
      if (part) part.remaining += item.remaining;
      else parts.push({ unit_id, remaining: item.remaining });
      map.set(ingredient_id, parts);
    }
    return map;
  }

  /**
   * 按行扣减并写使用记录。
   * shortcut: 不开事务 —— plugin-sql 连接池不保证 BEGIN 与后续语句同连接（与 stores/recipe.ts 同一契约）。
   *           每条使用记录彼此独立，崩溃点最坏是少扣一次：库存偏高，而不是凭空多出食材。
   */
  async function commitCook(recipeId: string, lines: CookLine[]): Promise<CookResult> {
    // 先拿最新余量，避免用页面打开时的内存算账
    await fetchAll();
    const usedThisCook = new Map<string, number>();
    const result: CookResult = { deducted: [], shortfall: [] };
    const now = new Date().toISOString();
    const written: string[] = [];

    for (const line of lines) {
      if (!(line.amount > 0)) continue;
      const candidates = batches.value
        .filter(
          (item) =>
            item.batch.ingredient_id === line.ingredient_id &&
            item.batch.unit_id === line.unit_id,
        )
        .map((item) => ({
          batch_id: item.batch.id,
          remaining: item.remaining - (usedThisCook.get(item.batch.id) ?? 0),
          expires_at: item.batch.expires_at,
          created_at: item.batch.created_at,
        }));
      const { plan, shortfall } = planDeduction(candidates, line.amount);
      for (const step of plan) {
        const usageId = crypto.randomUUID();
        await getDb().execute(
          `INSERT INTO inventory_usages
             (id, scope_id, owner_id, recipe_id, batch_id, amount, used_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          [
            usageId,
            activeScope.value,
            currentOwnerId(),
            recipeId,
            step.batch_id,
            step.amount,
            now,
            now,
          ],
        );
        written.push(usageId);
        usedThisCook.set(step.batch_id, (usedThisCook.get(step.batch_id) ?? 0) + step.amount);
      }
      const deducted = plan.reduce((sum, step) => sum + step.amount, 0);
      if (deducted > 0) {
        result.deducted.push({
          ingredient_name: line.ingredient_name,
          unit_name: line.unit_name,
          amount: deducted,
        });
      }
      if (shortfall > 0) {
        result.shortfall.push({
          ingredient_name: line.ingredient_name,
          unit_name: line.unit_name,
          missing: shortfall,
        });
      }
    }

    await fetchAll();
    await enqueueUsages(written);
    return result;
  }

  /**
   * 整行重读并入队：服务端要的是完整形状（含 scope_id / owner_id），
   * 用内存里的对象拼会漏掉数据库默认值与软删时间。
   */
  async function enqueueBatch(id: string): Promise<void> {
    const rows = await getDb().select<InventoryBatch[]>(
      "SELECT * FROM inventory_batches WHERE id = ?",
      [id],
    );
    if (rows.length > 0) enqueueSync({ inventory_batches: rows });
  }

  async function enqueueUsages(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(",");
    const rows = await getDb().select<InventoryUsage[]>(
      `SELECT * FROM inventory_usages WHERE id IN (${marks})`,
      ids,
    );
    if (rows.length > 0) enqueueSync({ inventory_usages: rows });
  }

  return { batches, fetchAll, addBatch, removeBatch, remainingByIngredient, commitCook };
});

/** 当前登录用户：未登录为 null（未登录录的批次只有本机的游客范围能看）。 */
function currentOwnerId(): string | null {
  return useAuthStore().serverUserId;
}

/** 校验在任何写入之前：错误文案直接给页面显示。 */
function requireValid(input: BatchInput): void {
  if (!(input.amount > 0)) throw new Error("数量要大于 0");
  const days = input.shelf_life_days;
  if (days !== null && (!Number.isInteger(days) || days < 1)) {
    throw new Error("保质期天数要是正整数");
  }
  if (input.produced_at && input.expires_at && input.expires_at < input.produced_at) {
    throw new Error("过期日不能早于生产日期");
  }
}
