export type LabelKind = "category" | "tag";

/** 我加入的一个团队（GET /teams 的行，spec §9）。 */
export interface TeamSummary {
  id: string;
  name: string;
  role: "owner" | "member";
  member_count: number;
}

export interface TeamMember {
  user_id: string;
  nickname: string;
  username: string;
  role: "owner" | "member";
}

export interface Recipe {
  id: string;
  name: string;
  cover_path: string | null;
  category_id: string;
  /** 范围键：'p:<uid>' 个人 / 't:<teamId>' 团队 / 'p:local' 未登录（spec §7.1）。 */
  scope_id: string;
  /** 作者昵称的本地副本，供离线显示（spec §11.12）；本机自建 / 未认领时为 NULL。 */
  owner_nickname: string | null;
  /** 作者头像的本地副本（别人发的菜谱才有）；本机自建 / 未认领为 NULL。 */
  owner_avatar_url: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** 归属账号（服务端 user id）。NULL = 本机自建 / 尚未认领（spec §9.1）。 */
  owner_id: string | null;
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
  /** 范围键（字典按个人 / 团队分开，spec §7.1）。 */
  scope_id: string;
  name: string;
  kind: LabelKind;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Ingredient {
  id: string;
  /** 范围键（字典按个人 / 团队分开，spec §7.1）。 */
  scope_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Unit {
  id: string;
  /** 范围键（字典按个人 / 团队分开，spec §7.1）。 */
  scope_id: string;
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

/** 列表行里用到的食材：只要 id 与名字，够筛选和显示摘要 */
export interface IngredientRef {
  id: string;
  name: string;
}

/** 列表页一行：菜谱 + 它的分类、标签、食材 */
export interface RecipeListItem {
  recipe: Recipe;
  category: Label;
  tags: Label[];
  ingredients: IngredientRef[];
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

export interface InventoryBatch {
  id: string;
  /** 范围键：'p:<uid>' 个人 / 't:<teamId>' 团队 / 'p:local' 未登录（spec §7.1）。 */
  scope_id: string;
  /** 录入者（不展示，只用来推「我的批次」）。 */
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
}

/** 一条扣减记录：只增不清，used_at 就是发生时间（没有 created_at）。 */
export interface InventoryUsage {
  id: string;
  scope_id: string;
  owner_id: string | null;
  recipe_id: string;
  batch_id: string;
  amount: number;
  used_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** 批次 + 派生出来的余量。余量永不落库（spec §4.2）。 */
export interface BatchStock {
  batch: InventoryBatch;
  ingredient_name: string;
  unit_name: string | null;
  remaining: number;
}

/** 库存页一行 = 一个食材，按单位拆成若干份额（不同单位不混算，spec §4.4） */
export interface IngredientStock {
  ingredient_id: string;
  ingredient_name: string;
  parts: { unit_id: string | null; unit_name: string | null; remaining: number }[];
  /** 余量 > 0 的批次里最早的过期日，用于临期标记与排序；全为空则 null */
  soonest_expires_at: string | null;
  /** 所有份额余量都 ≤ 0 */
  usedUp: boolean;
}

/** 录入批次的提交形状 */
export interface BatchInput {
  ingredient_id: string;
  amount: number;
  unit_id: string | null;
  produced_at: string | null;
  shelf_life_days: number | null;
  expires_at: string | null;
}

/** 制作表单的一行（预填自菜谱食材，可改数量与单位） */
export interface CookLine {
  ingredient_id: string;
  ingredient_name: string;
  unit_id: string | null;
  /** 页面上选中的单位名，只用于结果态显示，不落库 */
  unit_name: string | null;
  amount: number;
}

export interface CookResult {
  /** 实际扣掉的量（可能小于表单填的） */
  deducted: { ingredient_name: string; unit_name: string | null; amount: number }[];
  /** 扣不满的行 */
  shortfall: { ingredient_name: string; unit_name: string | null; missing: number }[];
}
