// 编排循环：模型只说名字，检索、命中数、卡片全部来自本地。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callAiChat, type AiChatResult, type AiMessage, type AiToolCall } from "@/services/ai/transport";
import { FALLBACK_TEXT, runAgent, SEARCH_TOOL, type AgentDeps } from "@/services/ai/agent";
import type { Dict } from "@/services/ai/filter";
import type { Label, RecipeListItem } from "@/types";

vi.mock("@/services/ai/transport", () => ({ callAiChat: vi.fn() }));

const NOW = "2026-10-16T00:00:00Z";

const DICT: Dict = {
  categories: [{ id: "c1", name: "家常菜" }],
  tags: [{ id: "t1", name: "下饭" }],
  ingredients: [
    { id: "i1", name: "五花肉" },
    { id: "i2", name: "肉末" },
  ],
  units: [{ id: "u1", name: "克" }],
};

function label(id: string, name: string, kind: Label["kind"]): Label {
  return { id, name, kind, created_at: NOW, updated_at: NOW, deleted_at: null };
}

function recipeItem(name: string, ingredients: { id: string; name: string }[]): RecipeListItem {
  return {
    recipe: {
      id: `r-${name}`,
      name,
      cover_path: null,
      category_id: "c1",
      is_public: 0,
      owner_nickname: null,
      owner_avatar_url: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      owner_id: null,
    },
    category: label("c1", "家常菜", "category"),
    tags: [label("t1", "下饭", "tag")],
    ingredients,
  };
}

const ITEMS: RecipeListItem[] = [
  recipeItem("红烧肉", [
    { id: "i1", name: "五花肉" },
    { id: "i3", name: "冰糖" },
  ]),
  recipeItem("麻婆豆腐", [{ id: "i2", name: "肉末" }]),
  recipeItem("清炒时蔬", []),
];

function deps(items: RecipeListItem[] = ITEMS): AgentDeps {
  return { dict: DICT, today: "2026-10-16", loadItems: async () => items };
}

function reply(text: string, toolCalls: AiToolCall[] = []): AiChatResult {
  return {
    text,
    tool_calls: toolCalls,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

function toolCall(name: string, args: string, id = "c1"): AiToolCall {
  return { id, name, arguments: args };
}

/** 第 bundle 次请求里最后一条消息，必须是回给模型的 tool 结果 */
function lastToolMessage(bundle: number): AiMessage {
  const sent = vi.mocked(callAiChat).mock.calls[bundle][0];
  const last = sent[sent.length - 1];
  if (last.role !== "tool") throw new Error("最后一次请求里没有 tool 消息");
  return last;
}

/** tool 消息的 content 本任务里都是纯文本；块数组不该出现在回包侧 */
function textOf(message: AiMessage): string {
  if (typeof message.content !== "string") throw new Error("tool 消息的 content 不是字符串");
  return message.content;
}

interface Summary {
  matched: number;
  items: { name: string; category: string; tags: string[]; ingredients: string[] }[];
  unresolved: { categories: string[]; tags: string[]; ingredients: string[] };
  applied: { keyword: string; categories: string[]; labels: string[]; ingredients: string[] };
}

beforeEach(() => {
  vi.mocked(callAiChat).mockReset();
});

describe("runAgent", () => {
  it("模型直接答话（没调工具）：filter 为 null，text 原样带出", async () => {
    vi.mocked(callAiChat).mockResolvedValueOnce(reply("库里现在有 3 道菜"));

    const out = await runAgent("我库里有什么", [], deps());

    expect(out.text).toBe("库里现在有 3 道菜");
    expect(out.filter).toBeNull();
    expect(out.resolved).toBeNull();
    expect(out.unresolved).toBeNull();
    expect(out.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(out.messages[1].content).toBe("我库里有什么");
    expect(callAiChat).toHaveBeenCalledTimes(1);
  });

  it("模型调 search_recipes：本地跑 filterRecipes，返回卡片与真实命中数", async () => {
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("search_recipes", '{"ingredients":["五花肉"]}')]))
      .mockResolvedValueOnce(reply("找到 1 道红烧肉"));

    const out = await runAgent("找有五花肉的菜", [], deps());

    expect(out.resolved?.matched).toBe(1);
    expect(out.resolved?.items[0].recipe.name).toBe("红烧肉");
    expect(out.filter?.ingredientIds).toEqual(["i1"]);
    expect(out.unresolved).toEqual({ categories: [], tags: [], ingredients: [] });
    expect(out.text).toBe("找到 1 道红烧肉");

    expect(vi.mocked(callAiChat).mock.calls[1][0].map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    const tool = lastToolMessage(1);
    expect(tool.tool_call_id).toBe("c1");
    const summary = JSON.parse(textOf(tool)) as Summary;
    expect(summary).toEqual({
      matched: 1,
      items: [
        { name: "红烧肉", category: "家常菜", tags: ["下饭"], ingredients: ["五花肉", "冰糖"] },
      ],
      unresolved: { categories: [], tags: [], ingredients: [] },
      applied: { keyword: "", categories: [], labels: [], ingredients: ["五花肉"] },
    });
    expect(SEARCH_TOOL.function.name).toBe("search_recipes");
  });

  it("matched 与 applied 都来自本地，模型说什么都不影响", async () => {
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("search_recipes", '{"ingredients":["五花肉"]}')]))
      .mockResolvedValueOnce(reply("给你找到 99 道菜，还加了 10 个标签"));

    const out = await runAgent("找有五花肉的菜", [], deps());

    expect(out.text).toBe("给你找到 99 道菜，还加了 10 个标签");
    expect(out.resolved?.matched).toBe(1);
    expect(out.resolved?.items).toHaveLength(1);
    expect(out.filter).toEqual({ keyword: "", categoryIds: [], tagIds: [], ingredientIds: ["i1"] });
    expect(JSON.parse(textOf(lastToolMessage(1)))).toMatchObject({ matched: 1 });
  });

  it("工具名不存在时回一条 tool 错误并让模型纠正一次，不抛到界面", async () => {
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("delete_recipe", "{}")]))
      .mockResolvedValueOnce(reply("我这就用说的"));

    const out = await runAgent("帮我把截图存下来", [], deps());

    expect(out.text).toBe("我这就用说的");
    expect(out.filter).toBeNull();
    expect(callAiChat).toHaveBeenCalledTimes(2);
    expect(JSON.parse(textOf(lastToolMessage(1)))).toEqual({ error: "unknown_tool" });
  });

  it("arguments 不是合法 JSON 时回一条 tool 错误并让模型纠正一次", async () => {
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("search_recipes", "找五花肉")]))
      .mockResolvedValueOnce(reply("我重新组织一下条件"));

    const out = await runAgent("找有五花肉的菜", [], deps());

    expect(out.text).toBe("我重新组织一下条件");
    expect(out.filter).toBeNull();
    expect(callAiChat).toHaveBeenCalledTimes(2);
    expect(JSON.parse(textOf(lastToolMessage(1)))).toEqual({ error: "bad_arguments" });
  });

  it("纠正后仍然失败：降级成普通文本，不抛错", async () => {
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("search_recipes", "不是 JSON")]))
      .mockResolvedValueOnce(reply("", [toolCall("search_recipes", "还是不是 JSON", "c2")]));

    const out = await runAgent("找有五花肉的菜", [], deps());

    expect(out.text).toBe(FALLBACK_TEXT);
    expect(out.filter).toBeNull();
    expect(out.resolved).toBeNull();
    expect(out.unresolved).toBeNull();
    expect(callAiChat).toHaveBeenCalledTimes(2);
  });

  it("名字解析不出时 unresolved 带出原始名字，且 filter 里不含它", async () => {
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("search_recipes", '{"ingredients":["三层肉"]}')]))
      .mockResolvedValueOnce(reply("库里没有「三层肉」"));

    const out = await runAgent("找三层肉的菜", [], deps());

    expect(out.unresolved?.ingredients).toEqual(["三层肉"]);
    expect(out.filter?.ingredientIds).toEqual([]);
    // 条件没生效 ⇒ 全库都算命中，matched 要说实话
    expect(out.resolved?.matched).toBe(3);
    const summary = JSON.parse(textOf(lastToolMessage(1))) as Summary;
    expect(summary.unresolved.ingredients).toEqual(["三层肉"]);
    expect(summary.applied.ingredients).toEqual([]);
  });

  it("历史消息原样进上下文，不重排、不改写", async () => {
    const history: AiMessage[] = [
      { role: "user", content: "上一问" },
      { role: "assistant", content: "上一答" },
    ];
    vi.mocked(callAiChat).mockResolvedValueOnce(reply("好"));

    const out = await runAgent("这一问", history, deps());

    expect(out.messages[0].role).toBe("system");
    expect(out.messages.slice(1, 3)).toEqual(history);
    expect(out.messages[3]).toEqual({ role: "user", content: "这一问" });
  });

  it("无图轮：content 仍是字符串（老路径零回归）", async () => {
    vi.mocked(callAiChat).mockResolvedValueOnce(reply("好"));

    const out = await runAgent("这一问", [], deps(), { images: [] });

    expect(out.messages[1].content).toBe("这一问");
    expect(vi.mocked(callAiChat).mock.calls[0][0][1].content).toBe("这一问");
  });

  it("带图轮：user 消息 content 是块数组，text 块在前、图片块在后", async () => {
    vi.mocked(callAiChat).mockResolvedValueOnce(reply("好"));

    const out = await runAgent("这个怎么做", [], deps(), {
      images: ["data:image/jpeg;base64,A", "data:image/jpeg;base64,B"],
    });

    const expected = [
      { type: "text", text: "这个怎么做" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,A" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,B" } },
    ];
    expect(out.messages[1].content).toEqual(expected);
    expect(vi.mocked(callAiChat).mock.calls[0][0][1].content).toEqual(expected);
  });

  it("带图无文字：不出现空 text 块", async () => {
    vi.mocked(callAiChat).mockResolvedValueOnce(reply("好"));

    const out = await runAgent("  ", [], deps(), { images: ["data:image/jpeg;base64,A"] });

    expect(out.messages[1].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,A" } },
    ]);
  });

  it("历史消息原样进上下文（图片只在当前轮）", async () => {
    const history: AiMessage[] = [
      { role: "user", content: "上一问" },
      { role: "assistant", content: "上一答" },
    ];
    vi.mocked(callAiChat).mockResolvedValueOnce(reply("好"));

    const out = await runAgent("看看这张", history, deps(), {
      images: ["data:image/jpeg;base64,A"],
    });

    expect(out.messages.slice(1, 3)).toEqual(history);
    const sent = vi.mocked(callAiChat).mock.calls[0][0];
    expect(sent.slice(1, 3)).toEqual(history);
    expect(sent[3].content).toEqual([
      { type: "text", text: "看看这张" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,A" } },
    ]);
  });

  it("模型调 create_recipe_draft：草稿进 outcome，回 {\"ok\":true}，不写库", async () => {
    const draftArgs = JSON.stringify({
      name: "红烧肉",
      category: "家常菜",
      tags: ["下饭"],
      ingredients: [{ name: "五花肉", amount: 500, unit: "克" }],
      steps: ["五花肉切块焯水", "炒糖色后下肉翻炒"],
    });
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("create_recipe_draft", draftArgs)]))
      .mockResolvedValueOnce(reply("草稿写好了，确认一下就行"));

    const d = deps();
    const out = await runAgent("看看这张截图", [], d, { images: ["data:image/jpeg;base64,A"] });

    expect(out.text).toBe("草稿写好了，确认一下就行");
    expect(out.draft).toEqual({
      name: "红烧肉",
      category_id: "c1",
      category_name: "家常菜",
      tag_ids: ["t1"],
      tag_names: ["下饭"],
      ingredients: [
        { ingredient_id: "i1", name: "五花肉", amount: 500, unit_id: "u1", unit_name: "克" },
      ],
      steps: ["五花肉切块焯水", "炒糖色后下肉翻炒"],
      cover_path: null,
    });
    // 草稿不回灌：回给模型的只有一句 ok，没有菜名（回灌只会诱导它复述）
    const tool = lastToolMessage(1);
    expect(JSON.parse(textOf(tool))).toEqual({ ok: true });
    expect(textOf(tool)).not.toContain("红烧肉");
    // 本任务不引入 db：deps 仍然只有这三个字段，草稿只在内存里走一趟
    expect(Object.keys(d)).toEqual(["dict", "today", "loadItems"]);
    expect(out.filter).toBeNull();
  });

  it("草稿参数烂：回 tool 错误并给纠正轮一次机会", async () => {
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("create_recipe_draft", "{}")]))
      .mockResolvedValueOnce(reply("我没看清菜名，能再发一张吗"));

    const out = await runAgent("看看这张截图", [], deps(), { images: ["data:image/jpeg;base64,A"] });

    expect(JSON.parse(textOf(lastToolMessage(1)))).toEqual({ error: "bad_arguments" });
    expect(out.draft).toBeNull();
    expect(out.text).toBe("我没看清菜名，能再发一张吗");
    expect(callAiChat).toHaveBeenCalledTimes(2);
  });

  it("同轮同时给 search 与 draft：只执行第一个，另一个 skipped，且每个 tool_call 都有回应", async () => {
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(
        reply("", [
          toolCall("search_recipes", '{"ingredients":["五花肉"]}', "c1"),
          toolCall("create_recipe_draft", '{"name":"红烧肉"}', "c2"),
        ]),
      )
      .mockResolvedValueOnce(reply("找到 1 道红烧肉"));

    const out = await runAgent("找有五花肉的菜", [], deps());

    const sent = vi.mocked(callAiChat).mock.calls[1][0];
    const replied = sent.filter((message) => message.role === "tool");
    expect(replied.map((message) => message.tool_call_id)).toEqual(["c1", "c2"]);
    expect(JSON.parse(textOf(replied[0]))).toMatchObject({ matched: 1 });
    expect(JSON.parse(textOf(replied[1]))).toEqual({ error: "skipped" });
    expect(out.resolved?.matched).toBe(1);
    expect(out.draft).toBeNull();
  });

  it("模型嘴上说已收录但没调工具：draft 为 null，text 原样带出（界面不跳转）", async () => {
    vi.mocked(callAiChat).mockResolvedValueOnce(reply("已经帮你存好了，去编辑页看看"));

    const out = await runAgent("看看这张截图", [], deps(), { images: ["data:image/jpeg;base64,A"] });

    expect(out.draft).toBeNull();
    expect(out.text).toBe("已经帮你存好了，去编辑页看看");
    expect(callAiChat).toHaveBeenCalledTimes(1);
  });

  it("第二轮仍只调工具且已有草稿：text 留空串，草稿照样带出", async () => {
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("create_recipe_draft", '{"name":"红烧肉"}')]))
      .mockResolvedValueOnce(reply("", [toolCall("search_recipes", "{}", "c2")]));

    const out = await runAgent("看看这张截图", [], deps(), { images: ["data:image/jpeg;base64,A"] });

    expect(out.text).toBe("");
    expect(out.draft?.name).toBe("红烧肉");
    expect(callAiChat).toHaveBeenCalledTimes(2);
  });

  it("命中超过 10 条时摘要只带 10 条，matched 仍是真实总数", async () => {
    const many = Array.from({ length: 15 }, (_, i) => recipeItem(`菜${i}`, []));
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("search_recipes", "{}")]))
      .mockResolvedValueOnce(reply("找到 15 道"));

    const out = await runAgent("库里有什么", [], deps(many));

    expect(out.resolved?.matched).toBe(15);
    expect(out.resolved?.items).toHaveLength(10);
    const summary = JSON.parse(textOf(lastToolMessage(1))) as Summary;
    expect(summary.matched).toBe(15);
    expect(summary.items).toHaveLength(10);
  });

  it("第一轮就空答（没工具也没正文）时给兜底文案，不渲染空气泡", async () => {
    vi.mocked(callAiChat).mockResolvedValueOnce(reply("   "));

    const out = await runAgent("嗯", [], deps());

    expect(out.text).toBe(FALLBACK_TEXT);
    expect(out.filter).toBeNull();
    expect(callAiChat).toHaveBeenCalledTimes(1);
  });

  it("第二轮仍只调工具不答话：text 留空串，只渲染卡片", async () => {
    vi.mocked(callAiChat)
      .mockResolvedValueOnce(reply("", [toolCall("search_recipes", '{"ingredients":["五花肉"]}')]))
      .mockResolvedValueOnce(reply("", [toolCall("search_recipes", '{"ingredients":["五花肉"]}', "c2")]));

    const out = await runAgent("找有五花肉的菜", [], deps());

    expect(out.text).toBe("");
    expect(out.resolved?.matched).toBe(1);
    expect(callAiChat).toHaveBeenCalledTimes(2);
  });
});
