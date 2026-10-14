import type { RecipeListItem } from "@/types";

export interface RecipeFilter {
  keyword: string;
  categoryIds: string[];
  tagIds: string[];
  ingredientIds: string[];
}

/** 摘要里一个维度最多写几个名字，超出的折叠成「等N个」 */
const MAX_VISIBLE = 2;

export function emptyFilter(): RecipeFilter {
  return { keyword: "", categoryIds: [], tagIds: [], ingredientIds: [] };
}

/** 复制一份独立的条件：不复制数组的话，筛选页里勾选会直接改到已生效的筛选 */
export function cloneFilter(filter: RecipeFilter): RecipeFilter {
  return {
    keyword: filter.keyword,
    categoryIds: [...filter.categoryIds],
    tagIds: [...filter.tagIds],
    ingredientIds: [...filter.ingredientIds],
  };
}

/** 三个多选任一非空 → 活跃。关键词不算，它有自己的输入框 */
export function isFilterActive(filter: RecipeFilter): boolean {
  return (
    filter.categoryIds.length > 0 || filter.tagIds.length > 0 || filter.ingredientIds.length > 0
  );
}

/** 四个条件全满足才留下；关键词是字面子串，不做拼音、不做分词 */
export function filterRecipes(items: RecipeListItem[], filter: RecipeFilter): RecipeListItem[] {
  const keyword = filter.keyword.trim().toLowerCase();
  return items.filter((item) => {
    if (keyword && !item.recipe.name.toLowerCase().includes(keyword)) return false;
    // 分类是单值外键，一道菜只有一个分类，选多个只能是「命中任一」
    if (filter.categoryIds.length > 0 && !filter.categoryIds.includes(item.category.id)) {
      return false;
    }
    return (
      containsAll(item.tags, filter.tagIds) && containsAll(item.ingredients, filter.ingredientIds)
    );
  });
}

/** 「同时包含」：每个选中的 id 都要在行里出现 */
function containsAll(have: { id: string }[], wanted: string[]): boolean {
  return wanted.every((id) => have.some((entry) => entry.id === id));
}

/** 信息条文案；不活跃时返回空串，但调用方该按 isFilterActive 决定渲不渲染 */
export function filterSummary(filter: RecipeFilter, items: RecipeListItem[]): string {
  if (!isFilterActive(filter)) return "";

  const categories = new Map(items.map((item) => [item.category.id, item.category.name] as const));
  const tags = new Map(
    items.flatMap((item) => item.tags.map((tag) => [tag.id, tag.name] as const)),
  );
  const ingredients = new Map(
    items.flatMap((item) => item.ingredients.map((line) => [line.id, line.name] as const)),
  );

  return [
    segment("📂", filter.categoryIds, categories, "分类"),
    segment("🏷️", filter.tagIds, tags, "标签"),
    segment("🥕", filter.ingredientIds, ingredients, "食材"),
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/** 一段摘要：名字按勾选顺序取，查不到就显示 id 本身，超出的折叠 */
function segment(icon: string, ids: string[], names: Map<string, string>, unit: string): string {
  if (ids.length === 0) return "";
  const shown = ids
    .slice(0, MAX_VISIBLE)
    .map((id) => names.get(id) ?? id)
    .join("、");
  return ids.length > MAX_VISIBLE
    ? `${icon} ${shown} 等${ids.length}个${unit}`
    : `${icon} ${shown}`;
}
