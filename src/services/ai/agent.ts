// 一轮对话的编排：模型只负责说名字与说人话，检索、命中数、卡片全部来自本地。
//
// 最多两轮：第一轮调工具（本地跑检索，把真实摘要回给模型），第二轮取最终回答；
// 第一轮的工具名/参数不可用时，第二轮就是纠错轮，仍失败则降级成普通文本，绝不抛到界面。
import {
  callAiChat,
  type AiContent,
  type AiMessage,
  type AiTool,
  type AiToolCall,
} from "@/services/ai/transport";
import {
  resolveFilter,
  validateSearchArgs,
  type Dict,
  type UnresolvedNames,
} from "@/services/ai/filter";
import { resolveDraft, validateDraftArgs, type RecipeDraft } from "@/services/ai/draft";
import { buildSystemPrompt } from "@/services/ai/prompt";
import { filterRecipes, type RecipeFilter } from "@/utils/recipeFilter";
import type { RecipeListItem } from "@/types";

export const SEARCH_TOOL: AiTool = {
  type: "function",
  function: {
    name: "search_recipes",
    description: "在本机菜谱库里按条件检索，返回匹配条数与菜名摘要。只读，不改任何数据。",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "菜名关键词" },
        categories: {
          type: "array",
          items: { type: "string" },
          description: "分类名，只能从给的名字里选",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "标签名，只能从给的名字里选",
        },
        ingredients: { type: "array", items: { type: "string" }, description: "食材名" },
      },
    },
  },
};

export interface AgentDeps {
  dict: Dict;
  today: string;
  loadItems(): Promise<RecipeListItem[]>;
}

export const DRAFT_TOOL: AiTool = {
  type: "function",
  function: {
    name: "create_recipe_draft",
    description:
      "把识别出的菜谱写成草稿，等用户确认保存；不得声称已经收录成功。草稿不会直接写进菜谱库。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "菜名" },
        category: { type: "string", description: "分类名，只能从给的名字里选" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "标签名，只能从给的名字里选",
        },
        ingredients: {
          type: "array",
          description: "食材列表，只用截图/用户说到的食材，不要带入作者名、点赞数等噪声",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "食材名" },
              amount: { type: ["number", "null"], description: "用量数字，不带单位；看不出就 null" },
              unit: { type: ["string", "null"], description: "单位名，如 克、勺；看不出就 null" },
            },
            required: ["name"],
          },
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "步骤，一步一句",
        },
      },
      required: ["name"],
    },
  },
};

export interface AgentOutcome {
  text: string;
  filter: RecipeFilter | null;
  resolved: { matched: number; items: RecipeListItem[] } | null;
  unresolved: UnresolvedNames | null;
  draft: RecipeDraft | null;
  messages: AiMessage[];
}

/** 工具与参数都纠不回来时的兜底：界面至少要说句人话，不能只有一张空卡片 */
export const FALLBACK_TEXT = "抱歉，这次没能处理你的请求，请换个说法再试一次。";

/** 卡片列表本来也看不完，摘要与卡片都只给前 10 条 */
const MAX_ITEMS = 10;
const ROUNDS = 2;

/** 本地这次检索的全部真值：`filter` 给筛选页，`matched` / `items` / `unresolved` 给界面 */
interface LocalSearch {
  filter: RecipeFilter;
  matched: number;
  items: RecipeListItem[];
  unresolved: UnresolvedNames;
}

/** 一次成功的检索：给界面用的真值 + 发给模型的摘要 */
interface SearchResult {
  local: LocalSearch;
  summary: string;
}

/** 一轮工具调用的产物：检索真值 + 草稿（最多各一个） */
interface ToolEffects {
  found: LocalSearch | null;
  draft: RecipeDraft | null;
}

/**
 * 无图时就是一个字符串（老路径零回归）；有图时文字块在前、图片块在后。
 * 文字为空就不加空文字块：上游对空 text 块会抱怨。
 */
export function buildUserContent(text: string, images: string[]): AiContent {
  if (images.length === 0) return text;

  const blocks: Exclude<AiContent, string> = [];
  if (text.trim() !== "") blocks.push({ type: "text", text });
  for (const url of images) blocks.push({ type: "image_url", image_url: { url } });
  return blocks;
}

export async function runAgent(
  userText: string,
  history: AiMessage[],
  deps: AgentDeps,
  extra?: { images?: string[] },
): Promise<AgentOutcome> {
  const messages: AiMessage[] = [
    { role: "system", content: buildSystemPrompt(deps.dict, deps.today) },
    ...history,
    { role: "user", content: buildUserContent(userText, extra?.images ?? []) },
  ];

  let found: LocalSearch | null = null;
  let draft: RecipeDraft | null = null;

  for (let round = 0; round < ROUNDS; round++) {
    const reply = await callAiChat(messages, [SEARCH_TOOL, DRAFT_TOOL]);
    if (reply.tool_calls.length === 0) {
      // 第一轮就空答（既没工具也没正文）：空气泡比兜底文案更糟。
      // 第二轮的空 text 是「只渲染卡片」的既有语义，不能改成兜底。
      const empty = round === 0 && reply.text.trim() === "";
      return outcome(empty ? FALLBACK_TEXT : reply.text, found, draft, messages);
    }

    messages.push({ role: "assistant", content: reply.text, tool_calls: reply.tool_calls });
    const effects = await applyToolCalls(reply.tool_calls, deps, messages);
    if (effects.found) found = effects.found;
    if (effects.draft) draft = effects.draft;
  }

  // 第二轮还是工具调用：有卡片或草稿就只渲染结果（text 空串），否则兜底
  return outcome(found || draft ? "" : FALLBACK_TEXT, found, draft, messages);
}

function outcome(
  text: string,
  found: LocalSearch | null,
  draft: RecipeDraft | null,
  messages: AiMessage[],
): AgentOutcome {
  return {
    text,
    filter: found?.filter ?? null,
    resolved: found ? { matched: found.matched, items: found.items } : null,
    unresolved: found?.unresolved ?? null,
    draft,
    messages,
  };
}

/**
 * 按名字分派；只执行第一个可识别的调用，其余一律回 `skipped`。
 * 每个 tool_call 都必须有且只有一条 tool 回应，否则上游把整条请求判非法。
 */
async function applyToolCalls(
  calls: AiToolCall[],
  deps: AgentDeps,
  messages: AiMessage[],
): Promise<ToolEffects> {
  const effects: ToolEffects = { found: null, draft: null };
  let executed = false;

  for (const call of calls) {
    let content: string;
    if (executed) {
      content = JSON.stringify({ error: "skipped" });
    } else if (call.name === SEARCH_TOOL.function.name) {
      const searched = await runSearch(call.arguments, deps);
      executed = true;
      if (searched) {
        effects.found = searched.local;
        content = searched.summary;
      } else {
        content = JSON.stringify({ error: "bad_arguments" });
      }
    } else if (call.name === DRAFT_TOOL.function.name) {
      const validated = validateDraftArgs(call.arguments);
      executed = true;
      if (validated.ok) {
        effects.draft = resolveDraft(validated.args, deps.dict);
        // 只回一句 ok，不回灌草稿：它已经知道，回灌只会诱导它复述
        content = JSON.stringify({ ok: true });
      } else {
        content = JSON.stringify({ error: "bad_arguments" });
      }
    } else {
      content = JSON.stringify({ error: "unknown_tool" });
    }
    messages.push(toolMessage(call.id, content));
  }

  return effects;
}

/** 纯本地的检索：validate → resolve → loadItems → filterRecipes，命中的 id 与条数都不经过模型 */
async function runSearch(rawArgs: string, deps: AgentDeps): Promise<SearchResult | null> {
  const validated = validateSearchArgs(rawArgs);
  if (!validated.ok) return null;

  const { filter, unresolved } = resolveFilter(validated.args, deps.dict);
  const matches = filterRecipes(await deps.loadItems(), filter);
  const items = matches.slice(0, MAX_ITEMS);
  const local: LocalSearch = { filter, matched: matches.length, items, unresolved };

  const summary = {
    matched: local.matched,
    items: items.map((item) => ({
      name: item.recipe.name,
      category: item.category.name,
      tags: item.tags.map((tag) => tag.name),
      ingredients: item.ingredients.map((line) => line.name),
    })),
    unresolved,
    applied: {
      keyword: validated.args.keyword ?? "",
      categories: appliedNames(validated.args.categories, unresolved.categories),
      labels: appliedNames(validated.args.labels, unresolved.tags),
      ingredients: appliedNames(validated.args.ingredients, unresolved.ingredients),
    },
  };

  return { local, summary: JSON.stringify(summary) };
}

/** 模型给的名字减去没对上的：摘要里给名字而不是 id，模型与摘要都不需要 id */
function appliedNames(given: string[] | undefined, missed: string[]): string[] {
  return (given ?? []).filter((name) => !missed.includes(name));
}

function toolMessage(id: string, content: string): AiMessage {
  return { role: "tool", content, tool_call_id: id };
}
