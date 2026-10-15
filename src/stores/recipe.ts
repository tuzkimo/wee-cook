import { defineStore } from "pinia";
import { ref, type Ref } from "vue";
import { getDb } from "@/db";
import { enqueueSync, recipePayloadFor } from "@/services/sync";
import { useAuthStore } from "@/stores/auth";
import type {
  IngredientRef,
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
  favorites: Ref<RecipeListItem[]>;
  fetchAll(): Promise<void>;
  fetchFavorites(): Promise<void>;
  getDetail(id: string): Promise<RecipeDetail>;
  create(input: RecipeInput): Promise<string>;
  update(id: string, input: RecipeInput): Promise<void>;
  remove(id: string): Promise<void>;
}

type LabelLink = Label & { recipe_id: string };

/**
 * 「我的」列表的可见范围（spec §9.1）：
 *   未登录 → 本机自己的（无主 + 本机账号白名单）；收藏的别人的菜谱归「收藏」tab，不混进来
 *   已登录 → 只有自己名下的菜谱
 * 返回的 sql 是一段可直接接在 WHERE 后面的条件（调方自行拼），params 顺序与其中的 ? 对应。
 */
export async function visibleRecipeFilter(): Promise<{ sql: string; params: unknown[] }> {
  const uid = useAuthStore().serverUserId;
  if (!uid)
    return {
      sql: "(owner_id IS NULL OR owner_id IN (SELECT user_id FROM local_accounts))",
      params: [],
    };
  return { sql: "owner_id = ?", params: [uid] };
}

/** 能不能改 / 删：未登录只有本机未认领的菜谱，登录后只有自己名下的（spec §9.1）。 */
export function canEdit(recipe: Recipe): boolean {
  const uid = useAuthStore().serverUserId;
  return uid === null ? recipe.owner_id === null : recipe.owner_id === uid;
}

export const useRecipeStore = defineStore("recipe", (): RecipeStore => {
  const recipes = ref<RecipeListItem[]>([]);
  const favorites = ref<RecipeListItem[]>([]);

  async function fetchAll(): Promise<void> {
    const db = getDb();
    const visibility = await visibleRecipeFilter();
    const conditions = ["deleted_at IS NULL", `(${visibility.sql})`];
    const params = [...visibility.params];
    const rows = await db.select<Recipe[]>(
      `SELECT * FROM recipes WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC, id ASC`,
      params,
    );
    recipes.value = await assembleItems(rows);
  }

  /**
   * 「收藏」段落的数据源：只认本机的收藏关系，**不套可见性过滤**——登录后可见性只剩
   * 「自己名下」，套上会把别人的公开菜谱全滤掉（spec §9.1）。
   */
  async function fetchFavorites(): Promise<void> {
    const rows = await getDb().select<Recipe[]>(
      `SELECT * FROM recipes WHERE deleted_at IS NULL
         AND id IN (SELECT recipe_id FROM favorite_recipes)
       ORDER BY updated_at DESC, id ASC`,
    );
    favorites.value = await assembleItems(rows);
  }

  /** 行 → 列表项：分类 / 标签 / 食材各查一次再按 recipe_id 归拢，fetchAll 与 fetchFavorites 共用。 */
  async function assembleItems(rows: Recipe[]): Promise<RecipeListItem[]> {
    const db = getDb();
    // 分类与标签一次查完，列表每行不用再回一次库
    const categories = await db.select<Label[]>("SELECT * FROM labels");
    const links = await db.select<LabelLink[]>(
      `SELECT rl.recipe_id, l.id, l.name, l.kind, l.created_at, l.updated_at, l.deleted_at
       FROM recipe_labels rl
       JOIN labels l ON l.id = rl.label_id
       WHERE l.deleted_at IS NULL
       ORDER BY l.name ASC, l.id ASC`,
    );
    // 内 JOIN 且不加 i.deleted_at IS NULL：被引用的食材删不掉，JOIN 得出来的必然没软删；
    // 加上反而会把关联静默漏掉。
    const ingredientRows = await db.select<
      { recipe_id: string; ingredient_id: string; ingredient_name: string }[]
    >(
      `SELECT ri.recipe_id, ri.ingredient_id, i.name AS ingredient_name
       FROM recipe_ingredients ri
       JOIN ingredients i ON i.id = ri.ingredient_id
       WHERE ri.deleted_at IS NULL
       ORDER BY ri.recipe_id ASC, ri.sort_order ASC, ri.id ASC`,
    );

    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const tagsByRecipe = new Map<string, Label[]>();
    for (const link of links) {
      const list = tagsByRecipe.get(link.recipe_id);
      if (list) list.push(link);
      else tagsByRecipe.set(link.recipe_id, [link]);
    }
    const ingredientsByRecipe = new Map<string, IngredientRef[]>();
    for (const row of ingredientRows) {
      const list = ingredientsByRecipe.get(row.recipe_id) ?? [];
      // 同一道菜里同一个食材可能有多行（编辑页允许重复添加），列表里只留第一次出现的
      if (!list.some((item) => item.id === row.ingredient_id)) {
        list.push({ id: row.ingredient_id, name: row.ingredient_name });
      }
      ingredientsByRecipe.set(row.recipe_id, list);
    }

    return rows.map((recipe) => ({
      recipe,
      // category_id 是 NOT NULL 外键，分类只软删不物理删，查不到只可能是库被改坏了
      category: categoryById.get(recipe.category_id)!,
      tags: tagsByRecipe.get(recipe.id) ?? [],
      ingredients: ingredientsByRecipe.get(recipe.id) ?? [],
    }));
  }

  async function getDetail(id: string): Promise<RecipeDetail> {
    const db = getDb();
    // 不可见的菜谱按「不存在」处理：详情只能从列表进来，越不到可见范围之外。
    // 收藏的例外：登录后「我的」只剩自己名下，但收藏 tab 会点进来（spec §9.1 / C1）。
    // favorite_recipes 只由服务端下发的「仍公开未删」集合与收藏成功写入，是合法可见范围。
    const visibility = await visibleRecipeFilter();
    const rows = await db.select<Recipe[]>(
      `SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL
         AND ((${visibility.sql}) OR id IN (SELECT recipe_id FROM favorite_recipes))`,
      [id, ...visibility.params],
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
    const { owner_id } = currentOwnership();

    await getDb().execute(
      `INSERT INTO recipes (id, name, cover_path, category_id, is_public, created_at, updated_at, deleted_at, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [id, name, input.cover_path, input.category_id, input.is_public, now, now, owner_id],
    );
    await insertSteps(id, input.steps, now);
    await insertIngredients(id, input.ingredients, now);
    await syncLabels(id, input.tag_ids);
    await bumpParent(id, input, name, now);
    await enqueueRecipe(id);
    return id;
  }

  // shortcut: 无事务（plugin-sql 连接池不保证 BEGIN 与后续语句同连接，见规格 §4）
  //          故用「先插后删」，崩溃点最坏留下重复行而非丢数据。真需要原子性时改走 Rust 侧命令。
  async function update(id: string, input: RecipeInput): Promise<void> {
    const name = requireNameAndCategory(input);
    // 旧行 id 只有更新前能取到：新行插进去后，光看 sort_order 分不出谁是谁
    const before = await getDetail(id);
    // 根因守卫：界面藏了编辑入口，但直接进 /recipe/:id/edit 不能真改别人的菜谱
    if (!canEdit(before.recipe)) throw new Error("没有修改权限");
    const now = new Date().toISOString();

    await insertSteps(id, input.steps, now);
    await insertIngredients(id, input.ingredients, now);
    await syncLabels(id, input.tag_ids);
    for (const step of before.steps) await softDelete("recipe_steps", step.id, now);
    for (const line of before.ingredients) await softDelete("recipe_ingredients", line.id, now);
    await bumpParent(id, input, name, now);
    // 归属列不在这里动：改动不会把菜谱挪到别人名下（spec §9.1）
    await enqueueRecipe(id);
  }

  async function remove(id: string): Promise<void> {
    const rows = await getDb().select<Recipe[]>(
      "SELECT * FROM recipes WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    const target = rows[0];
    if (!target) throw new Error("菜谱不存在");
    if (!canEdit(target)) throw new Error("没有修改权限");
    const now = new Date().toISOString();
    await getDb().execute("UPDATE recipes SET deleted_at = ?, updated_at = ? WHERE id = ?", [
      now,
      now,
      id,
    ]);
    recipes.value = recipes.value.filter((item) => item.recipe.id !== id);
    // 删除是墓碑：入队的是同一份完整形状，只有 deleted_at 非空，服务端才删得掉
    await enqueueRecipe(id);
  }

  /** 写入归属：当前登录用户；未登录为 NULL（spec §9.1）。 */
  function currentOwnership(): { owner_id: string | null } {
    return { owner_id: useAuthStore().serverUserId };
  }

  /** 写入后立刻把该条完整形状入队（未登录 / 未配地址时 enqueueSync 自己早退）。 */
  async function enqueueRecipe(id: string): Promise<void> {
    const payload = await recipePayloadFor(id);
    if (payload) enqueueSync({ recipes: [payload] });
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

  /** 规格 §10.7：动过任何子表或封面，父行都要 bump。归属列（owner_id）不在这里动。 */
  function bumpParent(id: string, input: RecipeInput, name: string, now: string): Promise<unknown> {
    return getDb().execute(
      "UPDATE recipes SET name = ?, cover_path = ?, category_id = ?, is_public = ?, updated_at = ? WHERE id = ?",
      [name, input.cover_path, input.category_id, input.is_public, now, id],
    );
  }

  return { recipes, favorites, fetchAll, fetchFavorites, getDetail, create, update, remove };
});
