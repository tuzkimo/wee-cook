// 草稿槽 + create_recipe_draft 的参数校验与名字解析。
//
// 模型给的参数一律当不可信输入：类型不对就退回让它重说，能退化的字段退化（amount → null、
// 单位 → null），食材名对不上只留名字等用户选——绝不静默新建食材。
// 草稿只在内存里活一次：写入 → 编辑页挂载时读走即清，不落库、不进 Pinia。
import { matchId, type Dict, type DictEntry } from "@/services/ai/filter";

export interface DraftIngredient {
  /** "" 表示未落定（配方 §4.4：带进编辑页、拦住保存） */
  ingredient_id: string;
  name: string;
  amount: number | null;
  unit_id: string | null;
  unit_name: string | null;
}

export interface RecipeDraft {
  name: string;
  category_id: string; // "" = 没对上，编辑页让用户选
  category_name: string;
  tag_ids: string[];
  tag_names: string[];
  ingredients: DraftIngredient[];
  steps: string[];
  cover_path: string | null; // 由 store 在跳转前填
}

export type DraftArgs = {
  name: string;
  category?: string;
  tags?: string[];
  ingredients?: { name: string; amount?: number | null; unit?: string | null }[];
  steps?: string[];
};

export type ValidateDraftResult = { ok: true; args: DraftArgs } | { ok: false; error: string };

/** 入参是模型给的 arguments 原文；校验不过就回 tool 错误让模型纠正一次，不写槽、不跳转。 */
export function validateDraftArgs(raw: string): ValidateDraftResult {
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
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (name === "") return { ok: false, error: "菜名不能为空" };

  const args: DraftArgs = { name };

  // 分类/标签/步骤类型不对就当没给：模型少说一个字段不该让整份草稿作废
  if (typeof source.category === "string") args.category = source.category.trim();
  if (Array.isArray(source.tags)) args.tags = source.tags.filter((tag) => typeof tag === "string");
  if (Array.isArray(source.steps)) {
    args.steps = source.steps
      .filter((step): step is string => typeof step === "string")
      .map((step) => step.trim())
      .filter((step) => step !== "");
  }

  if (Array.isArray(source.ingredients)) {
    args.ingredients = source.ingredients
      .filter(
        (line): line is Record<string, unknown> =>
          typeof line === "object" && line !== null && !Array.isArray(line),
      )
      .map(parseIngredient)
      .filter((line): line is DraftIngredientArgs => line !== null);
  }

  return { ok: true, args };
}

type DraftIngredientArgs = NonNullable<DraftArgs["ingredients"]>[number];

function parseIngredient(line: Record<string, unknown>): DraftIngredientArgs | null {
  const name = typeof line.name === "string" ? line.name.trim() : "";
  if (name === "") return null;

  const amount =
    typeof line.amount === "number" && Number.isFinite(line.amount) && line.amount > 0
      ? line.amount
      : null;

  let unit: string | null = null;
  if (typeof line.unit === "string") {
    const trimmed = line.unit.trim();
    unit = trimmed === "" ? null : trimmed;
  }

  return { name, amount, unit };
}

/** 纯函数：命中的收 id，没命中的留名字（食材）或丢弃（分类留空、标签不留未落定项）。 */
export function resolveDraft(args: DraftArgs, dict: Dict): RecipeDraft {
  const categoryName = args.category?.trim() ?? "";
  const categoryId = categoryName === "" ? "" : (matchId(categoryName, dict.categories) ?? "");

  const tagIds: string[] = [];
  const tagNames: string[] = [];
  for (const tag of args.tags ?? []) {
    const id = matchId(tag, dict.tags);
    if (id === null) continue;
    tagIds.push(id);
    tagNames.push(nameOf(id, dict.tags));
  }

  return {
    name: args.name.trim(),
    category_id: categoryId,
    category_name: categoryName,
    tag_ids: tagIds,
    tag_names: tagNames,
    ingredients: (args.ingredients ?? []).map((line) => {
      const unit = line.unit?.trim() ?? "";
      const unitId = unit === "" ? null : matchId(unit, dict.units);
      return {
        ingredient_id: matchId(line.name, dict.ingredients) ?? "",
        name: line.name.trim(),
        amount: line.amount ?? null,
        unit_id: unitId,
        unit_name: unitId === null ? null : nameOf(unitId, dict.units),
      };
    }),
    steps: args.steps ?? [],
    cover_path: null,
  };
}

/** matchId 已经证明 id 存在，这里只取显示名。 */
function nameOf(id: string, entries: DictEntry[]): string {
  return entries.find((entry) => entry.id === id)?.name ?? "";
}

let slot: RecipeDraft | null = null;

export function setDraft(draft: RecipeDraft): void {
  slot = draft;
}

/** 读走即清：读完再取一次是 null */
export function takeDraft(): RecipeDraft | null {
  const draft = slot;
  slot = null;
  return draft;
}

export function clearDraft(): void {
  slot = null;
}
