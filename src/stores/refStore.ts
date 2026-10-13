import { ref, type Ref } from "vue";
import { getDb } from "@/db";
import type { WithUsage } from "@/types";

export interface RefRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface RefStore {
  items: Ref<WithUsage<RefRow>[]>;
  fetchAll(): Promise<void>;
  add(name: string): Promise<WithUsage<RefRow>>;
  update(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

type RefTable = "ingredients" | "units";

/** 表名到「关联表里指向本表的外键列」的映射，两者形状同构。 */
const REF_COLUMN: Record<RefTable, string> = {
  ingredients: "ingredient_id",
  units: "unit_id",
};

export function createRefStore(opts: { table: RefTable; label: string }): RefStore {
  const { table, label } = opts;
  const refColumn = REF_COLUMN[table];
  const items = ref<WithUsage<RefRow>[]>([]);

  async function fetchAll(): Promise<void> {
    const db = getDb();
    // 计数先聚合成「实体 → 未删除菜谱数」再 LEFT JOIN 回主表；写成 JOIN + GROUP BY
    // 会退化成嵌套循环（规格 §5）。
    items.value = await db.select<WithUsage<RefRow>[]>(
      `SELECT t.id, t.name, t.created_at, t.updated_at, t.deleted_at,
              COALESCE(u.cnt, 0) AS usage_count
       FROM ${table} t
       LEFT JOIN (
         SELECT ri.${refColumn} AS id, COUNT(DISTINCT ri.recipe_id) AS cnt
         FROM recipe_ingredients ri
         JOIN recipes r ON r.id = ri.recipe_id AND r.deleted_at IS NULL
         WHERE ri.deleted_at IS NULL
         GROUP BY ri.${refColumn}
       ) u ON u.id = t.id
       WHERE t.deleted_at IS NULL
       ORDER BY usage_count DESC, t.name ASC, t.id ASC`,
    );
  }

  async function add(name: string): Promise<WithUsage<RefRow>> {
    const db = getDb();
    const trimmed = name.trim();
    if (!trimmed) throw new Error(`请输入${label}名称`);
    await assertNameFree(trimmed);

    const now = new Date().toISOString();
    const row: RefRow = {
      id: crypto.randomUUID(),
      name: trimmed,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await db.execute(
      `INSERT INTO ${table} (id, name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL)`,
      [row.id, row.name, now, now],
    );
    const item: WithUsage<RefRow> = { ...row, usage_count: 0 };
    items.value.push(item);
    return item;
  }

  async function update(id: string, name: string): Promise<void> {
    const db = getDb();
    const trimmed = name.trim();
    if (!trimmed) throw new Error(`请输入${label}名称`);
    await assertNameFree(trimmed, id);

    const now = new Date().toISOString();
    await db.execute(`UPDATE ${table} SET name = ?, updated_at = ? WHERE id = ?`, [
      trimmed,
      now,
      id,
    ]);
    const existing = items.value.find((item) => item.id === id);
    if (existing) {
      existing.name = trimmed;
      existing.updated_at = now;
    }
  }

  async function remove(id: string): Promise<void> {
    const db = getDb();
    const count = await countRecipes(id);
    if (count > 0) {
      const name = items.value.find((item) => item.id === id)?.name ?? "";
      throw new Error(`有 ${count} 道菜谱在用「${name}」，不能删除`);
    }
    const now = new Date().toISOString();
    await db.execute(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      id,
    ]);
    items.value = items.value.filter((item) => item.id !== id);
  }

  async function assertNameFree(name: string, exceptId?: string): Promise<void> {
    const rows = await getDb().select<{ id: string }[]>(
      `SELECT id FROM ${table} WHERE name = ? AND deleted_at IS NULL AND id != ?`,
      [name, exceptId ?? ""],
    );
    if (rows.length > 0) throw new Error(`同名${label}已存在`);
  }

  async function countRecipes(id: string): Promise<number> {
    const rows = await getDb().select<{ count: number }[]>(
      `SELECT COUNT(DISTINCT ri.recipe_id) AS count
       FROM recipe_ingredients ri
       JOIN recipes r ON r.id = ri.recipe_id AND r.deleted_at IS NULL
       WHERE ri.${refColumn} = ? AND ri.deleted_at IS NULL`,
      [id],
    );
    return rows[0]?.count ?? 0;
  }

  return { items, fetchAll, add, update, remove };
}
