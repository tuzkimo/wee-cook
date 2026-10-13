export type LabelKind = "category" | "tag";

export interface Recipe {
  id: string;
  name: string;
  cover_path: string | null;
  category_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface RecipeStep {
  id: string;
  recipe_id: string;
  sort_order: number;
  text: string;
  image_path: string | null;
  updated_at: string;
  deleted_at: string | null;
}

export interface RecipeIngredient {
  id: string;
  recipe_id: string;
  ingredient_id: string;
  amount: number | null;
  unit_id: string | null;
  sort_order: number;
  updated_at: string;
  deleted_at: string | null;
}

export interface Label {
  id: string;
  name: string;
  kind: LabelKind;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Ingredient {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Unit {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** 带本地派生的使用次数。只用于列表排序，不落库。 */
export type WithUsage<T> = T & { usage_count: number };
export type LabelWithUsage = WithUsage<Label>;
export type IngredientWithUsage = WithUsage<Ingredient>;
export type UnitWithUsage = WithUsage<Unit>;

/** 列表页一行：菜谱 + 它的分类与标签 */
export interface RecipeListItem {
  recipe: Recipe;
  category: Label;
  tags: Label[];
}

/** 详情页：食材行已 JOIN 出名字，省得页面再查一遍 */
export interface RecipeIngredientRow extends RecipeIngredient {
  ingredient_name: string;
  unit_name: string | null;
}

export interface RecipeDetail {
  recipe: Recipe;
  category: Label;
  tags: Label[];
  steps: RecipeStep[];
  ingredients: RecipeIngredientRow[];
}

/** 编辑页提交的形状：全量，不含 id */
export interface RecipeInput {
  name: string;
  cover_path: string | null;
  category_id: string;
  tag_ids: string[];
  steps: { text: string; image_path: string | null }[];
  ingredients: { ingredient_id: string; amount: number | null; unit_id: string | null }[];
}
