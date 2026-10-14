import { defineStore } from "pinia";
import { ref, type Ref } from "vue";
import { getDb } from "@/db";
import { enqueueSync } from "@/services/sync";
import type { Label, LabelKind, LabelWithUsage, WithUsage } from "@/types";
import type { OwnedRefStore, RefRow } from "@/stores/refStore";

export interface LabelStore {
  labels: Ref<LabelWithUsage[]>;
  fetchAll(kind: LabelKind): Promise<void>;
  add(kind: LabelKind, name: string): Promise<LabelWithUsage>;
  update(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** 给 RefSheet 用：把某一 kind 包成统一形状 */
  asRefStore(kind: LabelKind): OwnedRefStore;
}

const KIND_LABEL: Record<LabelKind, string> = { category: "分类", tag: "标签" };

// 先聚合成「标签 → 未删除菜谱数」再 LEFT JOIN 回主表；分类与标签两条路径 UNION ALL
// 后 COUNT(DISTINCT recipe_id)，同一道菜两种路径都用也只算一次（规格 §5）。
const USAGE_COUNTS = `SELECT x.id AS id, COUNT(DISTINCT x.recipe_id) AS cnt FROM (
    SELECT r.category_id AS id, r.id AS recipe_id FROM recipes r
      WHERE r.deleted_at IS NULL AND r.category_id IS NOT NULL
    UNION ALL
    SELECT rl.label_id AS id, rl.recipe_id AS recipe_id FROM recipe_labels rl
      JOIN recipes r2 ON r2.id = rl.recipe_id AND r2.deleted_at IS NULL
  ) x
  GROUP BY x.id`;

export const useLabelStore = defineStore("label", (): LabelStore => {
  const labels = ref<LabelWithUsage[]>([]);

  async function fetchAll(kind: LabelKind): Promise<void> {
    labels.value = await selectByKind(kind);
  }

  /** kind 过滤的取数只有这一份；store 与 asRefStore 共用，SQL 形状不变。 */
  async function selectByKind(kind: LabelKind): Promise<LabelWithUsage[]> {
    return getDb().select<LabelWithUsage[]>(
      `SELECT l.id, l.name, l.kind, l.created_at, l.updated_at, l.deleted_at,
              COALESCE(u.cnt, 0) AS usage_count
       FROM labels l
       LEFT JOIN (${USAGE_COUNTS}) u ON u.id = l.id
       WHERE l.kind = ? AND l.deleted_at IS NULL
       ORDER BY usage_count DESC, l.name ASC, l.id ASC`,
      [kind],
    );
  }

  async function add(kind: LabelKind, name: string): Promise<LabelWithUsage> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error(`请输入${KIND_LABEL[kind]}名称`);
    await assertNameFree(kind, trimmed);

    const now = new Date().toISOString();
    const row: LabelWithUsage = {
      id: crypto.randomUUID(),
      name: trimmed,
      kind,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      usage_count: 0,
    };
    try {
      await getDb().execute(
        `INSERT INTO labels (id, name, kind, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [row.id, row.name, kind, now, now],
      );
    } catch (error) {
      throw asDuplicateError(error, KIND_LABEL[kind]);
    }
    labels.value.push(row);
    sortLabels();
    await enqueueLabel(row.id);
    return row;
  }

  async function update(id: string, name: string): Promise<void> {
    const current = await labelOf(id);
    if (!current) throw new Error("分类或标签不存在");
    const trimmed = name.trim();
    if (!trimmed) throw new Error(`请输入${KIND_LABEL[current.kind]}名称`);
    await assertNameFree(current.kind, trimmed, id);

    const now = new Date().toISOString();
    try {
      await getDb().execute("UPDATE labels SET name = ?, updated_at = ? WHERE id = ?", [
        trimmed,
        now,
        id,
      ]);
    } catch (error) {
      throw asDuplicateError(error, KIND_LABEL[current.kind]);
    }
    const existing = labels.value.find((label) => label.id === id);
    if (existing) {
      existing.name = trimmed;
      existing.updated_at = now;
      sortLabels();
    }
    await enqueueLabel(id);
  }

  async function remove(id: string): Promise<void> {
    const count = await countRecipes(id);
    if (count > 0) {
      // 名字从库里取，不依赖这一行此刻在 items 里
      const current = await labelOf(id);
      throw new Error(`有 ${count} 道菜谱在用「${current?.name ?? ""}」，不能删除`);
    }
    const now = new Date().toISOString();
    await getDb().execute("UPDATE labels SET deleted_at = ?, updated_at = ? WHERE id = ?", [
      now,
      now,
      id,
    ]);
    labels.value = labels.value.filter((label) => label.id !== id);
    // 软删行也要入队（带墓碑），否则服务端永远不知道它被删了
    await enqueueLabel(id);
  }

  /** 写入后把该行入队（未登录 / 未配地址时 enqueueSync 自己早退）。 */
  async function enqueueLabel(id: string): Promise<void> {
    const rows = await getDb().select<Label[]>("SELECT * FROM labels WHERE id = ?", [id]);
    if (rows.length > 0) enqueueSync({ labels: [rows[0]] });
  }

  function asRefStore(kind: LabelKind): OwnedRefStore {
    // 每个实例自己存一份列表：分类 sheet 与标签 sheet 同时打开时互不覆盖。
    const items = ref<WithUsage<RefRow>[]>([]);
    const refresh = async (): Promise<void> => {
      items.value = await selectByKind(kind);
    };
    return {
      items,
      fetchAll: refresh,
      add: async (name: string) => {
        const row = await add(kind, name);
        await refresh();
        return row;
      },
      update: async (id: string, name: string) => {
        await update(id, name);
        await refresh();
      },
      remove: async (id: string) => {
        await remove(id);
        await refresh();
      },
    };
  }

  /** DDL 的唯一索引区分大小写，靠大小写不敏感的预检挡重名；这里兜住并发下的真冲突。 */
  async function assertNameFree(
    kind: LabelKind,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const db = getDb();
    const where = "kind = ? AND deleted_at IS NULL AND lower(name) = lower(?)";
    const rows = exceptId
      ? await db.select<{ id: string }[]>(
          `SELECT id FROM labels WHERE ${where} AND id != ?`,
          [kind, name, exceptId],
        )
      : await db.select<{ id: string }[]>(`SELECT id FROM labels WHERE ${where}`, [kind, name]);
    if (rows.length > 0) throw new Error(`同名${KIND_LABEL[kind]}已存在`);
  }

  async function labelOf(id: string): Promise<{ name: string; kind: LabelKind } | undefined> {
    const rows = await getDb().select<{ name: string; kind: LabelKind }[]>(
      "SELECT name, kind FROM labels WHERE id = ?",
      [id],
    );
    return rows[0];
  }

  async function countRecipes(id: string): Promise<number> {
    const rows = await getDb().select<{ count: number }[]>(
      `SELECT COALESCE(u.cnt, 0) AS count FROM (${USAGE_COUNTS}) u WHERE u.id = ?`,
      [id],
    );
    return rows[0]?.count ?? 0;
  }

  /** 与 SQL 的 ORDER BY usage_count DESC, name ASC, id ASC 保持同一顺序。 */
  function sortLabels(): void {
    labels.value.sort((a, b) => {
      if (a.usage_count !== b.usage_count) return b.usage_count - a.usage_count;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  return { labels, fetchAll, add, update, remove, asRefStore };
});

function asDuplicateError(error: unknown, label: string): unknown {
  return error instanceof Error && /UNIQUE constraint/i.test(error.message)
    ? new Error(`同名${label}已存在`)
    : error;
}
