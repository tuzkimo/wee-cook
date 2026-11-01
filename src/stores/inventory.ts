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
  CookRecord,
  CookRecordAuthor,
  CookRecordDetail,
  CookResult,
  IngredientCook,
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

/** 制作记录明细的一行（一条 SQL 分组后的扁平行）。 */
interface CookDetailRow {
  id: string;
  scope_id: string;
  owner_id: string | null;
  recipe_id: string;
  owner_nickname: string | null;
  owner_avatar_url: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  recipe_name: string | null;
  ingredient_name: string | null;
  unit_name: string | null;
  amount: number | null;
}

const COOK_COLUMNS = `cr.id, cr.scope_id, cr.owner_id, cr.recipe_id, cr.owner_nickname,
  cr.owner_avatar_url, cr.created_at, cr.updated_at, cr.deleted_at, rc.name AS recipe_name,
  i.name AS ingredient_name, u.name AS unit_name, SUM(us.amount) AS amount`;

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
      // 并发扣减会把同一批次扣两次（spec §8.7 有意不解决）：余量按 0 兜底，不显示负数
      remaining: Math.max(0, row.amount - row.used),
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
    const cookId = crypto.randomUUID();
    // 记录先于使用记录写（spec §5）：最坏是「有记录、没扣减」，账不会错
    await getDb().execute(
      `INSERT INTO cook_records
         (id, scope_id, owner_id, recipe_id, owner_nickname, owner_avatar_url,
          created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
      [cookId, activeScope.value, currentOwnerId(), recipeId, now, now],
    );
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
             (id, scope_id, owner_id, cook_id, recipe_id, batch_id, amount, used_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          [
            usageId,
            activeScope.value,
            currentOwnerId(),
            cookId,
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
    await enqueueCook(cookId, written);
    return result;
  }

  /** 该菜谱的制作记录（明细按食材 + 单位跨批次合并，时间倒序）。 */
  async function fetchCookRecords(recipeId: string): Promise<CookRecordDetail[]> {
    const rows = await getDb().select<CookDetailRow[]>(
      `SELECT ${COOK_COLUMNS}
       FROM cook_records cr
       LEFT JOIN recipes rc ON rc.id = cr.recipe_id AND rc.deleted_at IS NULL
       LEFT JOIN inventory_usages us ON us.cook_id = cr.id AND us.deleted_at IS NULL
       LEFT JOIN inventory_batches b ON b.id = us.batch_id
       LEFT JOIN ingredients i ON i.id = b.ingredient_id
       LEFT JOIN units u ON u.id = b.unit_id
       WHERE cr.scope_id = ? AND cr.deleted_at IS NULL AND cr.recipe_id = ?
       GROUP BY cr.id, b.ingredient_id, b.unit_id
       ORDER BY cr.created_at DESC, cr.id`,
      [activeScope.value, recipeId],
    );
    return groupDetails(rows);
  }

  /** 单条制作记录；不在当前范围或不存在时返回 null。 */
  async function fetchCookRecord(id: string): Promise<CookRecordDetail | null> {
    const rows = await getDb().select<CookDetailRow[]>(
      `SELECT ${COOK_COLUMNS}
       FROM cook_records cr
       LEFT JOIN recipes rc ON rc.id = cr.recipe_id AND rc.deleted_at IS NULL
       LEFT JOIN inventory_usages us ON us.cook_id = cr.id AND us.deleted_at IS NULL
       LEFT JOIN inventory_batches b ON b.id = us.batch_id
       LEFT JOIN ingredients i ON i.id = b.ingredient_id
       LEFT JOIN units u ON u.id = b.unit_id
       WHERE cr.scope_id = ? AND cr.deleted_at IS NULL AND cr.id = ?
       GROUP BY cr.id, b.ingredient_id, b.unit_id`,
      [activeScope.value, id],
    );
    return groupDetails(rows)[0] ?? null;
  }

  /** 某食材被哪些制作扣过（时间倒序；同一记录可能跨多个单位）。 */
  async function fetchIngredientCooks(ingredientId: string): Promise<IngredientCook[]> {
    const rows = await getDb().select<CookDetailRow[]>(
      `SELECT ${COOK_COLUMNS}
       FROM cook_records cr
       LEFT JOIN recipes rc ON rc.id = cr.recipe_id AND rc.deleted_at IS NULL
       JOIN inventory_usages us ON us.cook_id = cr.id AND us.deleted_at IS NULL
       JOIN inventory_batches b ON b.id = us.batch_id
       JOIN ingredients i ON i.id = b.ingredient_id
       LEFT JOIN units u ON u.id = b.unit_id
       WHERE cr.scope_id = ? AND cr.deleted_at IS NULL AND b.ingredient_id = ?
       GROUP BY cr.id, b.unit_id
       ORDER BY cr.created_at DESC, cr.id`,
      [activeScope.value, ingredientId],
    );
    const byRecord = new Map<string, IngredientCook>();
    for (const row of rows) {
      const item = byRecord.get(row.id) ?? {
        record: toRecord(row),
        recipe_name: row.recipe_name,
        parts: [],
      };
      item.parts.push({ unit_name: row.unit_name, amount: row.amount ?? 0 });
      byRecord.set(row.id, item);
    }
    return [...byRecord.values()];
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

  /** 记录与它的使用记录一起入队（服务端按「先父后子」合并）。 */
  async function enqueueCook(recordId: string, usageIds: string[]): Promise<void> {
    const records = await getDb().select<CookRecord[]>("SELECT * FROM cook_records WHERE id = ?", [
      recordId,
    ]);
    if (records.length === 0) return;
    if (usageIds.length === 0) {
      enqueueSync({ cook_records: records });
      return;
    }
    const marks = usageIds.map(() => "?").join(",");
    const rows = await getDb().select<InventoryUsage[]>(
      `SELECT * FROM inventory_usages WHERE id IN (${marks})`,
      usageIds,
    );
    enqueueSync({ cook_records: records, inventory_usages: rows });
  }

  return {
    batches,
    fetchAll,
    addBatch,
    removeBatch,
    remainingByIngredient,
    commitCook,
    fetchCookRecords,
    fetchCookRecord,
    fetchIngredientCooks,
  };
});

/** 作者只在这里解析：自己做的回退到当前账号，队友做的用服务端派生的两列。 */
function authorOf(record: CookRecord): CookRecordAuthor {
  const auth = useAuthStore();
  const mine = record.owner_id === null || record.owner_id === auth.serverUserId;
  return mine
    ? { name: auth.nickname, avatar_url: auth.avatarUrl }
    : { name: record.owner_nickname, avatar_url: record.owner_avatar_url };
}

function toRecord(row: CookDetailRow): CookRecord {
  return {
    id: row.id,
    scope_id: row.scope_id,
    owner_id: row.owner_id,
    recipe_id: row.recipe_id,
    owner_nickname: row.owner_nickname,
    owner_avatar_url: row.owner_avatar_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

/** 扁平行 → 每条记录一份明细（保持 SQL 的行顺序）。 */
function groupDetails(rows: CookDetailRow[]): CookRecordDetail[] {
  const byRecord = new Map<string, CookRecordDetail>();
  for (const row of rows) {
    const item = byRecord.get(row.id) ?? {
      record: toRecord(row),
      author: authorOf(toRecord(row)),
      recipe_name: row.recipe_name,
      lines: [],
    };
    // 没有使用记录（或批次行已不在）时明细为空：页面显示「这次没有扣任何库存」
    if (row.ingredient_name !== null) {
      item.lines.push({
        ingredient_name: row.ingredient_name,
        unit_name: row.unit_name,
        amount: row.amount ?? 0,
      });
    }
    byRecord.set(row.id, item);
  }
  return [...byRecord.values()];
}

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
