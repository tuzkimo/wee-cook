import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import { useIngredientStore, useUnitStore } from "@/stores/ingredient";
import { useLabelStore } from "@/stores/label";
import { useRecipeStore } from "@/stores/recipe";
import type { RecipeInput } from "@/types";

let db: Db;

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
});

/** ISO 时间戳只到毫秒，紧接着的两次写入可能落在同一毫秒，测试要比较先后就得让开一点。 */
const sleep = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function newCategory(name = "炒菜"): Promise<string> {
  return (await useLabelStore().add("category", name)).id;
}

async function newTag(name = "家常"): Promise<string> {
  return (await useLabelStore().add("tag", name)).id;
}

async function newIngredient(name: string): Promise<string> {
  return (await useIngredientStore().add(name)).id;
}

async function newUnit(name: string): Promise<string> {
  return (await useUnitStore().add(name)).id;
}

/** 一份最小输入，各用例只覆盖自己关心的字段。 */
function input(overrides: Partial<RecipeInput> & { category_id: string }): RecipeInput {
  return {
    name: "番茄炒蛋",
    cover_path: null,
    tag_ids: [],
    steps: [],
    ingredients: [],
    ...overrides,
  };
}

async function countRows(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await db.select<{ n: number }[]>(sql, params);
  return rows[0].n;
}

async function deletedAtOf(table: string, id: string): Promise<string | null> {
  const rows = await db.select<{ deleted_at: string | null }[]>(
    `SELECT deleted_at FROM ${table} WHERE id = ?`,
    [id],
  );
  return rows[0].deleted_at;
}

describe("recipeStore", () => {
  it("create 返回新 id，详情能按 sort_order 回读步骤和食材", async () => {
    const categoryId = await newCategory();
    const egg = await newIngredient("鸡蛋");
    const tomato = await newIngredient("番茄");
    const unit = await newUnit("个");
    const store = useRecipeStore();

    const id = await store.create(
      input({
        category_id: categoryId,
        steps: [
          { text: "打蛋", image_path: null },
          { text: "切番茄", image_path: "step-2.jpg" },
          { text: "下锅", image_path: null },
        ],
        // 传入顺序与食材的创建顺序相反，回读必须按传入顺序
        ingredients: [
          { ingredient_id: tomato, amount: 2, unit_id: unit },
          { ingredient_id: egg, amount: null, unit_id: null },
        ],
      }),
    );

    expect(typeof id).toBe("string");
    const detail = await store.getDetail(id);
    expect(detail.recipe.id).toBe(id);
    expect(detail.steps.map((step) => step.text)).toEqual(["打蛋", "切番茄", "下锅"]);
    expect(detail.steps.map((step) => step.sort_order)).toEqual([0, 1, 2]);
    expect(detail.steps[1].image_path).toBe("step-2.jpg");
    expect(detail.ingredients.map((row) => row.ingredient_id)).toEqual([tomato, egg]);
    expect(detail.ingredients.map((row) => row.sort_order)).toEqual([0, 1]);
    expect(detail.ingredients[0].ingredient_name).toBe("番茄");
    expect(detail.ingredients[0].unit_name).toBe("个");
    expect(detail.ingredients[1].ingredient_name).toBe("鸡蛋");
    expect(detail.ingredients[1].unit_name).toBeNull();
    expect(detail.ingredients[1].amount).toBeNull();
  });

  it("create 把标签写进 recipe_labels", async () => {
    const categoryId = await newCategory();
    const home = await newTag("家常");
    const quick = await newTag("快手");
    const store = useRecipeStore();

    const id = await store.create(input({ category_id: categoryId, tag_ids: [home, quick] }));

    const links = await db.select<{ label_id: string }[]>(
      "SELECT label_id FROM recipe_labels WHERE recipe_id = ?",
      [id],
    );
    expect(links.map((link) => link.label_id).sort()).toEqual([home, quick].sort());
    const detail = await store.getDetail(id);
    expect(detail.tags.map((tag) => tag.id).sort()).toEqual([home, quick].sort());
  });

  it("create 未选分类时报错且库里没有新行", async () => {
    const store = useRecipeStore();

    await expect(
      store.create(input({ category_id: "", steps: [{ text: "打蛋", image_path: null }] })),
    ).rejects.toThrow("请选择分类");

    expect(await countRows("SELECT COUNT(*) AS n FROM recipes")).toBe(0);
    expect(await countRows("SELECT COUNT(*) AS n FROM recipe_steps")).toBe(0);
  });

  it("create 菜名 trim；纯空格菜名被拒绝", async () => {
    const categoryId = await newCategory();
    const store = useRecipeStore();

    const id = await store.create(input({ category_id: categoryId, name: "  番茄炒蛋  " }));
    expect((await store.getDetail(id)).recipe.name).toBe("番茄炒蛋");

    await expect(
      store.create(input({ category_id: categoryId, name: "   " })),
    ).rejects.toThrow("请输入菜名");
    await expect(store.create(input({ category_id: categoryId, name: "" }))).rejects.toThrow(
      "请输入菜名",
    );
    expect(await countRows("SELECT COUNT(*) AS n FROM recipes")).toBe(1);
  });

  it("同一道菜里重复添加同一个食材可以保存，且使用次数只算 1 次", async () => {
    const categoryId = await newCategory();
    const pork = await newIngredient("五花肉");
    const store = useRecipeStore();

    const id = await store.create(
      input({
        category_id: categoryId,
        ingredients: [
          { ingredient_id: pork, amount: 100, unit_id: null },
          { ingredient_id: pork, amount: 50, unit_id: null },
        ],
      }),
    );

    const detail = await store.getDetail(id);
    expect(detail.ingredients).toHaveLength(2);
    expect(detail.ingredients.map((row) => row.amount)).toEqual([100, 50]);

    const ingredients = useIngredientStore();
    await ingredients.fetchAll();
    expect(ingredients.items.find((item) => item.id === pork)?.usage_count).toBe(1);
  });

  it("create 允许空菜谱：没有步骤、没有食材", async () => {
    const categoryId = await newCategory();
    const store = useRecipeStore();

    const id = await store.create(input({ category_id: categoryId, name: "白粥" }));

    const detail = await store.getDetail(id);
    expect(detail.recipe.name).toBe("白粥");
    expect(detail.steps).toEqual([]);
    expect(detail.ingredients).toEqual([]);
    expect(detail.tags).toEqual([]);
  });

  it("store 不校验用量：0、负数、适量（null）都照存，校验留给页面", async () => {
    const categoryId = await newCategory();
    const pork = await newIngredient("五花肉");
    const store = useRecipeStore();

    const id = await store.create(
      input({
        category_id: categoryId,
        ingredients: [
          { ingredient_id: pork, amount: 0, unit_id: null },
          { ingredient_id: pork, amount: -1, unit_id: null },
          { ingredient_id: pork, amount: null, unit_id: null },
        ],
      }),
    );

    const detail = await store.getDetail(id);
    expect(detail.ingredients.map((row) => row.amount)).toEqual([0, -1, null]);
  });

  it("update 改菜名、改食材用量、删一条步骤、加一条标签后回读一致", async () => {
    const categoryId = await newCategory();
    const pork = await newIngredient("五花肉");
    const unit = await newUnit("克");
    const home = await newTag("家常");
    const store = useRecipeStore();
    const id = await store.create(
      input({
        category_id: categoryId,
        steps: [
          { text: "腌肉", image_path: null },
          { text: "下锅", image_path: null },
        ],
        ingredients: [{ ingredient_id: pork, amount: 100, unit_id: unit }],
      }),
    );

    await store.update(
      id,
      input({
        category_id: categoryId,
        name: "回锅肉",
        tag_ids: [home],
        steps: [{ text: "腌肉 10 分钟", image_path: null }],
        ingredients: [{ ingredient_id: pork, amount: 250, unit_id: unit }],
      }),
    );

    const detail = await store.getDetail(id);
    expect(detail.recipe.name).toBe("回锅肉");
    expect(detail.category.id).toBe(categoryId);
    expect(detail.steps.map((step) => step.text)).toEqual(["腌肉 10 分钟"]);
    expect(detail.ingredients.map((row) => row.amount)).toEqual([250]);
    expect(detail.ingredients[0].ingredient_name).toBe("五花肉");
    expect(detail.ingredients[0].unit_name).toBe("克");
    expect(detail.tags.map((tag) => tag.id)).toEqual([home]);
  });

  it("update 后旧的步骤和食材行被软删而不是物理删除", async () => {
    const categoryId = await newCategory();
    const pork = await newIngredient("五花肉");
    const store = useRecipeStore();
    const id = await store.create(
      input({
        category_id: categoryId,
        steps: [
          { text: "腌肉", image_path: null },
          { text: "下锅", image_path: null },
        ],
        ingredients: [{ ingredient_id: pork, amount: 100, unit_id: null }],
      }),
    );
    const before = await store.getDetail(id);
    const oldStepIds = before.steps.map((step) => step.id);
    const oldLineIds = before.ingredients.map((row) => row.id);

    await store.update(
      id,
      input({
        category_id: categoryId,
        steps: [{ text: "腌肉 10 分钟", image_path: null }],
        ingredients: [{ ingredient_id: pork, amount: 250, unit_id: null }],
      }),
    );

    const steps = await db.select<{ id: string; deleted_at: string | null }[]>(
      "SELECT id, deleted_at FROM recipe_steps WHERE recipe_id = ?",
      [id],
    );
    expect(steps).toHaveLength(3); // 2 条旧的都还在库里，只是被软删，加上新插的 1 条
    for (const stepId of oldStepIds) {
      expect(await deletedAtOf("recipe_steps", stepId)).not.toBeNull();
    }
    expect(steps.filter((row) => row.deleted_at === null)).toHaveLength(1);

    const lines = await db.select<{ id: string; deleted_at: string | null }[]>(
      "SELECT id, deleted_at FROM recipe_ingredients WHERE recipe_id = ?",
      [id],
    );
    expect(lines).toHaveLength(2);
    for (const lineId of oldLineIds) {
      expect(await deletedAtOf("recipe_ingredients", lineId)).not.toBeNull();
    }
    expect(lines.filter((row) => row.deleted_at === null)).toHaveLength(1);

    const after = await store.getDetail(id);
    for (const stepId of oldStepIds) {
      expect(after.steps.map((step) => step.id)).not.toContain(stepId);
    }
    for (const lineId of oldLineIds) {
      expect(after.ingredients.map((row) => row.id)).not.toContain(lineId);
    }
  });

  it("update 把步骤与食材全清空：旧行软删，详情两段为空，父行照常 bump", async () => {
    const categoryId = await newCategory();
    const pork = await newIngredient("五花肉");
    const store = useRecipeStore();
    const id = await store.create(
      input({
        category_id: categoryId,
        steps: [
          { text: "腌肉", image_path: null },
          { text: "下锅", image_path: null },
        ],
        ingredients: [{ ingredient_id: pork, amount: 100, unit_id: null }],
      }),
    );
    const before = await store.getDetail(id);
    const oldStepIds = before.steps.map((step) => step.id);
    const oldLineIds = before.ingredients.map((row) => row.id);

    await sleep();
    await store.update(id, input({ category_id: categoryId, steps: [], ingredients: [] }));

    const after = await store.getDetail(id);
    expect(after.steps).toEqual([]);
    expect(after.ingredients).toEqual([]);

    // 旧行没被物理删，只是软删：直接查表看
    for (const stepId of oldStepIds) {
      expect(await deletedAtOf("recipe_steps", stepId)).not.toBeNull();
    }
    for (const lineId of oldLineIds) {
      expect(await deletedAtOf("recipe_ingredients", lineId)).not.toBeNull();
    }
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM recipe_steps WHERE recipe_id = ? AND deleted_at IS NULL",
        [id],
      ),
    ).toBe(0);
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM recipe_ingredients WHERE recipe_id = ? AND deleted_at IS NULL",
        [id],
      ),
    ).toBe(0);

    // 清空子表也是改动，父行 updated_at 要 bump（规格 §10.7）
    expect(new Date(after.recipe.updated_at).getTime()).toBeGreaterThan(
      new Date(before.recipe.updated_at).getTime(),
    );
  });

  /** 只改一处就 update 一次，断言父菜谱 updated_at 变大（规格 §10.7）。 */
  async function expectParentBump(mutate: (base: RecipeInput) => RecipeInput): Promise<void> {
    const categoryId = await newCategory();
    const pork = await newIngredient("五花肉");
    const home = await newTag("家常");
    const store = useRecipeStore();
    const base = input({
      category_id: categoryId,
      tag_ids: [home],
      steps: [{ text: "腌肉", image_path: null }],
      ingredients: [{ ingredient_id: pork, amount: 100, unit_id: null }],
    });
    const id = await store.create(base);
    const before = (await store.getDetail(id)).recipe.updated_at;

    await sleep();
    await store.update(id, mutate(base));

    const after = (await store.getDetail(id)).recipe.updated_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  }

  it("update 只改步骤时 recipes.updated_at 变大", async () => {
    await expectParentBump((base) => ({
      ...base,
      steps: [{ text: "腌肉 10 分钟", image_path: null }],
    }));
  });

  it("update 只改食材用量时 recipes.updated_at 变大", async () => {
    await expectParentBump((base) => ({
      ...base,
      ingredients: [
        { ingredient_id: base.ingredients[0].ingredient_id, amount: 250, unit_id: null },
      ],
    }));
  });

  it("update 只加删标签时 recipes.updated_at 变大", async () => {
    await expectParentBump((base) => ({ ...base, tag_ids: [] }));
  });

  it("update 只换封面时 recipes.updated_at 变大", async () => {
    await expectParentBump((base) => ({ ...base, cover_path: "cover.jpg" }));
  });

  it("fetchAll 按 updated_at DESC 且带出分类与标签", async () => {
    const categoryId = await newCategory();
    const home = await newTag("家常");
    const store = useRecipeStore();
    const first = await store.create(input({ category_id: categoryId, name: "A" }));
    await sleep();
    const second = await store.create(input({ category_id: categoryId, name: "B" }));
    await sleep();
    await store.create(input({ category_id: categoryId, name: "C" }));
    await sleep();

    await store.update(first, input({ category_id: categoryId, name: "A2", tag_ids: [home] }));
    await store.fetchAll();

    expect(store.recipes.map((item) => item.recipe.name)).toEqual(["A2", "C", "B"]);
    expect(store.recipes[0].category.id).toBe(categoryId);
    expect(store.recipes[0].category.name).toBe("炒菜");
    expect(store.recipes[0].tags.map((tag) => tag.id)).toEqual([home]);
    expect(store.recipes[1].tags).toEqual([]);

    // 软删的菜谱不再出现
    await store.remove(second);
    await store.fetchAll();
    expect(store.recipes.map((item) => item.recipe.name)).toEqual(["A2", "C"]);
  });

  it("remove 只软删父行，子行原封不动", async () => {
    const categoryId = await newCategory();
    const pork = await newIngredient("五花肉");
    const home = await newTag("家常");
    const store = useRecipeStore();
    const id = await store.create(
      input({
        category_id: categoryId,
        tag_ids: [home],
        steps: [
          { text: "腌肉", image_path: null },
          { text: "下锅", image_path: null },
        ],
        ingredients: [{ ingredient_id: pork, amount: 100, unit_id: null }],
      }),
    );

    await store.remove(id);

    expect(await deletedAtOf("recipes", id)).not.toBeNull();

    const steps = await db.select<{ deleted_at: string | null }[]>(
      "SELECT deleted_at FROM recipe_steps WHERE recipe_id = ?",
      [id],
    );
    expect(steps).toHaveLength(2);
    expect(steps.every((row) => row.deleted_at === null)).toBe(true);

    const lines = await db.select<{ deleted_at: string | null }[]>(
      "SELECT deleted_at FROM recipe_ingredients WHERE recipe_id = ?",
      [id],
    );
    expect(lines).toHaveLength(1);
    expect(lines.every((row) => row.deleted_at === null)).toBe(true);

    const links = await db.select<{ label_id: string }[]>(
      "SELECT label_id FROM recipe_labels WHERE recipe_id = ?",
      [id],
    );
    expect(links).toHaveLength(1);
  });

  it("remove 后该菜谱引用的食材使用次数减 1", async () => {
    const categoryId = await newCategory();
    const pork = await newIngredient("五花肉");
    const store = useRecipeStore();
    const id = await store.create(
      input({
        category_id: categoryId,
        ingredients: [{ ingredient_id: pork, amount: 100, unit_id: null }],
      }),
    );

    const ingredients = useIngredientStore();
    await ingredients.fetchAll();
    expect(ingredients.items.find((item) => item.id === pork)?.usage_count).toBe(1);

    await store.remove(id);
    await ingredients.fetchAll();
    expect(ingredients.items.find((item) => item.id === pork)?.usage_count).toBe(0);
  });
});
