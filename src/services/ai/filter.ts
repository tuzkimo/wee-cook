// 读本地字典，把模型给的中文名字解析成 id。
//
// 匹配不猜：trim 后精确相等 → 唯一包含命中（「五花」→「五花肉」）→ 多命中
// （「肉」同时命中「五花肉」「肉末」）或零命中一律归入 unresolved，交给用户确认或让模型重说，
// 绝不自己挑一个。JS 的 trim 本来就吃掉全角空格 U+3000。
import { getDb } from "@/db";
import { emptyFilter, type RecipeFilter } from "@/utils/recipeFilter";

export interface DictEntry {
  id: string;
  name: string;
}

export interface Dict {
  categories: DictEntry[];
  tags: DictEntry[];
  ingredients: DictEntry[];
}

export interface SearchRecipesArgs {
  keyword?: string;
  categories?: string[];
  labels?: string[];
  ingredients?: string[];
}

export type ValidateResult = { ok: true; args: SearchRecipesArgs } | { ok: false; error: string };

export interface UnresolvedNames {
  categories: string[];
  tags: string[];
  ingredients: string[];
}

export interface ResolvedFilter {
  filter: RecipeFilter;
  unresolved: UnresolvedNames;
}

const LIST_FIELDS = ["categories", "labels", "ingredients"] as const;

/** 入参是模型给的 arguments 原文；类型不对就退回让模型重说，多余字段忽略。 */
export function validateSearchArgs(raw: string): ValidateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "工具参数不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "工具参数必须是 JSON 对象" };
  }

  const source = parsed as Record<string, unknown>;
  const args: SearchRecipesArgs = {};

  const keyword = source.keyword;
  if (keyword !== undefined) {
    if (typeof keyword !== "string") return { ok: false, error: "keyword 必须是字符串" };
    args.keyword = keyword;
  }

  for (const field of LIST_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      return { ok: false, error: `${field} 必须是字符串数组` };
    }
    args[field] = value as string[];
  }

  return { ok: true, args };
}

export async function loadDict(): Promise<Dict> {
  const db = getDb();
  const entries = (sql: string): Promise<DictEntry[]> => db.select<DictEntry[]>(sql);

  return {
    categories: await entries(
      `SELECT id, name FROM labels WHERE kind = 'category' AND deleted_at IS NULL ORDER BY name`,
    ),
    tags: await entries(
      `SELECT id, name FROM labels WHERE kind = 'tag' AND deleted_at IS NULL ORDER BY name`,
    ),
    ingredients: await entries(
      `SELECT id, name FROM ingredients WHERE deleted_at IS NULL ORDER BY name`,
    ),
  };
}

/** 纯函数：命中的收 id，没命中的留名字，等模型或用户再确认。 */
export function resolveFilter(args: SearchRecipesArgs, dict: Dict): ResolvedFilter {
  const filter = emptyFilter();
  const unresolved: UnresolvedNames = { categories: [], tags: [], ingredients: [] };

  filter.keyword = args.keyword ?? "";
  collect(args.categories, dict.categories, filter.categoryIds, unresolved.categories);
  collect(args.labels, dict.tags, filter.tagIds, unresolved.tags);
  collect(args.ingredients, dict.ingredients, filter.ingredientIds, unresolved.ingredients);

  return { filter, unresolved };
}

function collect(
  names: string[] | undefined,
  entries: DictEntry[],
  ids: string[],
  missed: string[],
): void {
  for (const name of names ?? []) {
    const id = matchId(name, entries);
    if (id === null) missed.push(name);
    else if (!ids.includes(id)) ids.push(id);
  }
}

function matchId(name: string, entries: DictEntry[]): string | null {
  const wanted = name.trim();
  if (wanted === "") return null;

  const exact = entries.find((entry) => entry.name.trim() === wanted);
  if (exact) return exact.id;

  const partial = entries.filter((entry) => entry.name.includes(wanted));
  return partial.length === 1 ? partial[0].id : null;
}
