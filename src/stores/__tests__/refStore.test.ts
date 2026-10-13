import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import { useIngredientStore, useUnitStore } from "@/stores/ingredient";
import type { RefRow } from "@/stores/refStore";
import type { WithUsage } from "@/types";

type RefItem = WithUsage<RefRow>;

let db: Db;

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
});

/** 造一道菜，引用给定的食材（可重复，用来验证「同一道菜只算一次」）。 */
async function seedRecipe(ingredientIds: string[]): Promise<string> {
  const now = new Date().toISOString();
  const categoryId = crypto.randomUUID();
  await db.execute(
    "INSERT INTO labels (id, name, kind, created_at, updated_at, deleted_at) VALUES (?, ?, 'category', ?, ?, NULL)",
    [categoryId, categoryId, now, now],
  );
  const recipeId = crypto.randomUUID();
  await db.execute(
    "INSERT INTO recipes (id, name, cover_path, category_id, created_at, updated_at, deleted_at) VALUES (?, '菜', NULL, ?, ?, ?, NULL)",
    [recipeId, categoryId, now, now],
  );
  for (let i = 0; i < ingredientIds.length; i++) {
    await db.execute(
      `INSERT INTO recipe_ingredients (id, recipe_id, ingredient_id, amount, unit_id, sort_order, updated_at, deleted_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`,
      [crypto.randomUUID(), recipeId, ingredientIds[i], i, now],
    );
  }
  return recipeId;
}

function usageOf(items: RefItem[], name: string): number {
  return items.find((item) => item.name === name)?.usage_count ?? -1;
}

describe("refStore 工厂", () => {
  it("fetchAll 按使用次数倒序，未删除菜谱才计数", async () => {
    const store = useIngredientStore();
    const egg = await store.add("鸡蛋");
    const salt = await store.add("盐");
    const sugar = await store.add("糖");
    await seedRecipe([egg.id, salt.id]);
    const recipeB = await seedRecipe([egg.id, sugar.id]);

    await store.fetchAll();
    expect(store.items[0].name).toBe("鸡蛋");
    expect(usageOf(store.items, "鸡蛋")).toBe(2);
    expect(usageOf(store.items, "盐")).toBe(1);
    expect(usageOf(store.items, "糖")).toBe(1);

    await db.execute("UPDATE recipes SET deleted_at = ? WHERE id = ?", [
      new Date().toISOString(),
      recipeB,
    ]);
    await store.fetchAll();
    expect(usageOf(store.items, "鸡蛋")).toBe(1);
    expect(usageOf(store.items, "盐")).toBe(1);
    expect(usageOf(store.items, "糖")).toBe(0);
  });

  it("同一道菜里重复用同一食材只算一次", async () => {
    const store = useIngredientStore();
    const egg = await store.add("鸡蛋");
    await seedRecipe([egg.id, egg.id]);

    await store.fetchAll();
    expect(usageOf(store.items, "鸡蛋")).toBe(1);
  });

  it("add 存 trim 后的名字", async () => {
    const store = useIngredientStore();
    const added = await store.add("  鸡蛋 ");

    expect(added.name).toBe("鸡蛋");
    const rows = await db.select<{ name: string }[]>("SELECT name FROM ingredients");
    expect(rows.map((row) => row.name)).toEqual(["鸡蛋"]);
  });

  it("add 纯空格或空串被拒绝", async () => {
    const store = useIngredientStore();

    await expect(store.add("   ")).rejects.toThrow("请输入食材名称");
    await expect(store.add("")).rejects.toThrow("请输入食材名称");
    const rows = await db.select<{ id: string }[]>("SELECT id FROM ingredients");
    expect(rows).toEqual([]);
  });

  it("add 重名被拒绝", async () => {
    const store = useIngredientStore();
    await store.add("鸡蛋");

    await expect(store.add("鸡蛋")).rejects.toThrow("同名食材已存在");
  });

  it("update 改名、保留 usage_count、拒绝与别人重名", async () => {
    const store = useIngredientStore();
    const egg = await store.add("鸡蛋");
    const salt = await store.add("盐");
    await seedRecipe([egg.id]);
    await store.fetchAll();

    await store.update(egg.id, "土鸡蛋");
    expect(store.items.find((item) => item.id === egg.id)?.name).toBe("土鸡蛋");
    expect(usageOf(store.items, "土鸡蛋")).toBe(1);

    await expect(store.update(salt.id, "土鸡蛋")).rejects.toThrow("同名食材已存在");
    expect(store.items.find((item) => item.id === salt.id)?.name).toBe("盐");
  });

  it("remove 被引用的食材被拒绝且不改库", async () => {
    const store = useIngredientStore();
    const egg = await store.add("鸡蛋");
    await seedRecipe([egg.id]);
    await seedRecipe([egg.id]);
    await store.fetchAll();

    await expect(store.remove(egg.id)).rejects.toThrow("有 2 道菜谱在用「鸡蛋」，不能删除");
    const rows = await db.select<{ deleted_at: string | null }[]>(
      "SELECT deleted_at FROM ingredients WHERE id = ?",
      [egg.id],
    );
    expect(rows[0].deleted_at).toBeNull();
    expect(store.items.some((item) => item.id === egg.id)).toBe(true);
  });

  it("remove 未被引用的食材成功软删除", async () => {
    const store = useIngredientStore();
    const egg = await store.add("鸡蛋");
    await store.fetchAll();

    await store.remove(egg.id);
    const rows = await db.select<{ deleted_at: string | null }[]>(
      "SELECT deleted_at FROM ingredients WHERE id = ?",
      [egg.id],
    );
    expect(rows[0].deleted_at).not.toBeNull();
    expect(store.items.some((item) => item.id === egg.id)).toBe(false);
  });

  it("单位与食材互不干扰", async () => {
    const ingredients = useIngredientStore();
    const units = useUnitStore();
    await ingredients.add("鸡蛋");
    await units.add("克");

    await ingredients.fetchAll();
    await units.fetchAll();
    expect(units.items.map((item) => item.name)).toEqual(["克"]);
    expect(units.items.some((item) => item.name === "鸡蛋")).toBe(false);
  });
});
