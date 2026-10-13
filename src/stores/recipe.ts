import { defineStore } from "pinia";
import { ref, type Ref } from "vue";
import { getDb } from "@/db";
import type {
  Label,
  Recipe,
  RecipeDetail,
  RecipeIngredientRow,
  RecipeInput,
  RecipeListItem,
  RecipeStep,
} from "@/types";

export interface RecipeStore {
  recipes: Ref<RecipeListItem[]>;
  fetchAll(): Promise<void>;
  getDetail(id: string): Promise<RecipeDetail>;
  create(input: RecipeInput): Promise<string>;
  update(id: string, input: RecipeInput): Promise<void>;
  remove(id: string): Promise<void>;
}

type LabelLink = Label & { recipe_id: string };

export const useRecipeStore = defineStore("recipe", (): RecipeStore => {
  const recipes = ref<RecipeListItem[]>([]);

  async function fetchAll(): Promise<void> {
    const db = getDb();
    // 分类与标签一次查完，列表每行不用再回一次库
    const rows = await db.select<Recipe[]>(
      "SELECT * FROM recipes WHERE deleted_at IS NULL ORDER BY updated_at DESC, id ASC",
    );
    const categories = await db.select<Label[]>("SELECT * FROM labels");
    const links = await db.select<LabelLink[]>(
      `SELECT rl.recipe_id, l.id, l.name, l.kind, l.created_at, l.updated_at, l.deleted_at
       FROM recipe_labels rl
       JOIN labels l ON l.id = rl.label_id
       WHERE l.deleted_at IS NULL
       ORDER BY l.name ASC, l.id ASC`,
    );

    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const tagsByRecipe = new Map<string, Label[]>();
    for (const link of links) {
      const list = tagsByRecipe.get(link.recipe_id);
      if (list) list.push(link);
      else tagsByRecipe.set(link.recipe_id, [link]);
    }

    recipes.value = rows.map((recipe) => ({
      recipe,
      // category_id 是 NOT NULL 外键，分类只软删不物理删，查不到只可能是库被改坏了
      category: categoryById.get(recipe.category_id)!,
      tags: tagsByRecipe.get(recipe.id) ?? [],
    }));
  }

  async function getDetail(id: string): Promise<RecipeDetail> {
    const db = getDb();
    const rows = await db.select<Recipe[]>(
      "SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    const recipe = rows[0];
    if (!recipe) throw new Error("菜谱不存在");

    const categories = await db.select<Label[]>("SELECT * FROM labels WHERE id = ?", [
      recipe.category_id,
    ]);
    const tags = await db.select<Label[]>(
      `SELECT l.* FROM recipe_labels rl
       JOIN labels l ON l.id = rl.label_id
       WHERE rl.recipe_id = ? AND l.deleted_at IS NULL
       ORDER BY l.name ASC, l.id ASC`,
      [id],
    );
    const steps = await db.select<RecipeStep[]>(
      `SELECT * FROM recipe_steps
       WHERE recipe_id = ? AND deleted_at IS NULL
       ORDER BY sort_order ASC, id ASC`,
      [id],
    );
    const ingredients = await db.select<RecipeIngredientRow[]>(
      `SELECT ri.*, i.name AS ingredient_name, u.name AS unit_name
       FROM recipe_ingredients ri
       LEFT JOIN ingredients i ON i.id = ri.ingredient_id
       LEFT JOIN units u ON u.id = ri.unit_id
       WHERE ri.recipe_id = ? AND ri.deleted_at IS NULL
       ORDER BY ri.sort_order ASC, ri.id ASC`,
      [id],
    );

    return { recipe, category: categories[0], tags, steps, ingredients };
  }

  async function create(input: RecipeInput): Promise<string> {
    const name = requireNameAndCategory(input);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await getDb().execute(
      `INSERT INTO recipes (id, name, cover_path, category_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [id, name, input.cover_path, input.category_id, now, now],
    );
    await insertSteps(id, input.steps, now);
    await insertIngredients(id, input.ingredients, now);
    await syncLabels(id, input.tag_ids);
    await bumpParent(id, input, name, now);
    return id;
  }

  // shortcut: 无事务（plugin-sql 连接池不保证 BEGIN 与后续语句同连接，见规格 §4）
  //          故用「先插后删」，崩溃点最坏留下重复行而非丢数据。真需要原子性时改走 Rust 侧命令。
  async function update(id: string, input: RecipeInput): Promise<void> {
    const name = requireNameAndCategory(input);
    // 旧行 id 只有更新前能取到：新行插进去后，光看 sort_order 分不出谁是谁
    const before = await getDetail(id);
    const now = new Date().toISOString();

    await insertSteps(id, input.steps, now);
    await insertIngredients(id, input.ingredients, now);
    await syncLabels(id, input.tag_ids);
    for (const step of before.steps) await softDelete("recipe_steps", step.id, now);
    for (const line of before.ingredients) await softDelete("recipe_ingredients", line.id, now);
    await bumpParent(id, input, name, now);
  }

  async function remove(id: string): Promise<void> {
    const now = new Date().toISOString();
    await getDb().execute("UPDATE recipes SET deleted_at = ?, updated_at = ? WHERE id = ?", [
      now,
      now,
      id,
    ]);
    recipes.value = recipes.value.filter((item) => item.recipe.id !== id);
  }

  /** 只校验菜名与分类（裁决 R6），在任何写入之前。 */
  function requireNameAndCategory(input: RecipeInput): string {
    const name = input.name.trim();
    if (!name) throw new Error("请输入菜名");
    if (!input.category_id) throw new Error("请选择分类");
    return name;
  }

  async function insertSteps(
    recipeId: string,
    steps: RecipeInput["steps"],
    now: string,
  ): Promise<void> {
    const db = getDb();
    for (let index = 0; index < steps.length; index++) {
      await db.execute(
        `INSERT INTO recipe_steps (id, recipe_id, sort_order, text, image_path, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [crypto.randomUUID(), recipeId, index, steps[index].text, steps[index].image_path, now],
      );
    }
  }

  async function insertIngredients(
    recipeId: string,
    ingredients: RecipeInput["ingredients"],
    now: string,
  ): Promise<void> {
    const db = getDb();
    for (let index = 0; index < ingredients.length; index++) {
      const line = ingredients[index];
      await db.execute(
        `INSERT INTO recipe_ingredients
           (id, recipe_id, ingredient_id, amount, unit_id, sort_order, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          crypto.randomUUID(),
          recipeId,
          line.ingredient_id,
          line.amount,
          line.unit_id,
          index,
          now,
        ],
      );
    }
  }

  /** recipe_labels 没有软删除，只能按选中集合重建关联。 */
  async function syncLabels(recipeId: string, labelIds: string[]): Promise<void> {
    const db = getDb();
    for (const labelId of labelIds) {
      await db.execute(
        "INSERT OR IGNORE INTO recipe_labels (recipe_id, label_id) VALUES (?, ?)",
        [recipeId, labelId],
      );
    }
    if (labelIds.length === 0) {
      // NOT IN () 是语法错误，空集合走整表删
      await db.execute("DELETE FROM recipe_labels WHERE recipe_id = ?", [recipeId]);
      return;
    }
    const marks = labelIds.map(() => "?").join(", ");
    await db.execute(
      `DELETE FROM recipe_labels WHERE recipe_id = ? AND label_id NOT IN (${marks})`,
      [recipeId, ...labelIds],
    );
  }

  async function softDelete(
    table: "recipe_steps" | "recipe_ingredients",
    id: string,
    now: string,
  ): Promise<void> {
    await getDb().execute(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      id,
    ]);
  }

  /** 规格 §10.7：动过任何子表或封面，父行都要 bump。 */
  function bumpParent(id: string, input: RecipeInput, name: string, now: string): Promise<unknown> {
    return getDb().execute(
      "UPDATE recipes SET name = ?, cover_path = ?, category_id = ?, updated_at = ? WHERE id = ?",
      [name, input.cover_path, input.category_id, now, id],
    );
  }

  return { recipes, fetchAll, getDetail, create, update, remove };
});
