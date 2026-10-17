// 一轮对话的编排：模型只负责说名字与说人话，检索、命中数、卡片全部来自本地。
//
// 最多两轮：第一轮调工具（本地跑检索，把真实摘要回给模型），第二轮取最终回答；
// 第一轮的工具名/参数不可用时，第二轮就是纠错轮，仍失败则降级成普通文本，绝不抛到界面。
import {
  callAiChat,
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

export interface AgentOutcome {
  text: string;
  filter: RecipeFilter | null;
  resolved: { matched: number; items: RecipeListItem[] } | null;
  unresolved: UnresolvedNames | null;
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

export async function runAgent(
  userText: string,
  history: AiMessage[],
  deps: AgentDeps,
): Promise<AgentOutcome> {
  const messages: AiMessage[] = [
    { role: "system", content: buildSystemPrompt(deps.dict, deps.today) },
    ...history,
    { role: "user", content: userText },
  ];

  let found: LocalSearch | null = null;

  for (let round = 0; round < ROUNDS; round++) {
    const reply = await callAiChat(messages, [SEARCH_TOOL]);
    if (reply.tool_calls.length === 0) {
      // 第一轮就空答（既没工具也没正文）：空气泡比兜底文案更糟。
      // 第二轮的空 text 是「只渲染卡片」的既有语义，不能改成兜底。
      const empty = round === 0 && reply.text.trim() === "";
      return outcome(empty ? FALLBACK_TEXT : reply.text, found, messages);
    }

    messages.push({ role: "assistant", content: reply.text, tool_calls: reply.tool_calls });
    const searched = await applyToolCalls(reply.tool_calls, deps, messages);
    if (searched) found = searched;
  }

  // 第二轮还是工具调用：检索到了就只渲染卡片（text 空串），否则兜底
  return outcome(found ? "" : FALLBACK_TEXT, found, messages);
}

function outcome(text: string, found: LocalSearch | null, messages: AiMessage[]): AgentOutcome {
  return {
    text,
    filter: found?.filter ?? null,
    resolved: found ? { matched: found.matched, items: found.items } : null,
    unresolved: found?.unresolved ?? null,
    messages,
  };
}

/**
 * 处理一轮里的工具调用：只认第一个 `search_recipes`，其余一律回错误消息。
 * 每个 tool_call 都必须有回应，否则上游把整条请求判非法。
 */
async function applyToolCalls(
  calls: AiToolCall[],
  deps: AgentDeps,
  messages: AiMessage[],
): Promise<LocalSearch | null> {
  let found: LocalSearch | null = null;

  for (const call of calls) {
    const known = call.name === SEARCH_TOOL.function.name;
    const searched: SearchResult | null = found === null && known ? await runSearch(call.arguments, deps) : null;

    if (searched) {
      found = searched.local;
      messages.push(toolMessage(call.id, searched.summary));
    } else {
      const error = known ? "bad_arguments" : "unknown_tool";
      messages.push(toolMessage(call.id, JSON.stringify({ error })));
    }
  }

  return found;
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
