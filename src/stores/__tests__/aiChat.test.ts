// AI 聊天 store：历史读回、一轮问答落库、错误文案、sending 守卫，以及「AI 的结果你能自己验」
// ——openInFilter 必须与手点漏斗走同一个 recipeFilter store。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

// transport 里的 AiError 要真身；它所属的 api 模块会牵出 Tauri 存储，这里挡掉
vi.mock("@/services/api", () => ({
  hasBaseUrl: () => true,
  apiFetch: vi.fn(),
}));

vi.mock("@/services/ai/agent", () => ({ runAgent: vi.fn() }));

vi.mock("@/services/ai/session", () => ({
  loadOrCreateSession: vi.fn(),
  loadMessages: vi.fn(),
  appendMessage: vi.fn(),
  clearMessages: vi.fn(),
}));

vi.mock("@/services/ai/filter", () => ({ loadDict: vi.fn() }));

// 菜谱列表在真机上来自 SQLite；store 单测只关心「先 fetchAll 再交给 agent」
const recipeStub = vi.hoisted(() => ({
  fetchAll: vi.fn(async () => {}),
  recipes: [] as unknown[],
}));
vi.mock("@/stores/recipe", () => ({ useRecipeStore: () => recipeStub }));

import { AiError } from "@/services/ai/transport";
import { runAgent, type AgentDeps, type AgentOutcome } from "@/services/ai/agent";
import { loadDict } from "@/services/ai/filter";
import {
  appendMessage,
  clearMessages,
  loadMessages,
  loadOrCreateSession,
  type StoredMessage,
} from "@/services/ai/session";
import { PROMPT_VERSION } from "@/services/ai/prompt";
import { useAiChatStore } from "@/stores/aiChat";
import { useRecipeFilterStore } from "@/stores/recipeFilter";
import { emptyFilter } from "@/utils/recipeFilter";
import type { RecipeListItem } from "@/types";

const CAT = { id: "cat-家常菜", name: "家常菜", kind: "category" as const, created_at: "", updated_at: "", deleted_at: null };
const TAG = { id: "tag-快手", name: "快手", kind: "tag" as const, created_at: "", updated_at: "", deleted_at: null };

function item(id: string, name: string): RecipeListItem {
  return {
    recipe: {
      id,
      name,
      cover_path: null,
      category_id: CAT.id,
      is_public: 0,
      owner_nickname: null,
      owner_avatar_url: null,
      created_at: "",
      updated_at: "",
      deleted_at: null,
      owner_id: null,
    },
    category: CAT,
    tags: [TAG],
    ingredients: [],
  };
}

const items = [item("r1", "红烧肉"), item("r2", "红烧排骨")];
const filter = { ...emptyFilter(), categoryIds: [CAT.id], tagIds: [TAG.id] };
const unresolved = { categories: [], tags: ["不存在的标签"], ingredients: [] };

function outcome(overrides: Partial<AgentOutcome> = {}): AgentOutcome {
  return {
    text: "找到 2 道红烧菜",
    filter,
    resolved: { matched: 2, items },
    unresolved,
    messages: [],
    ...overrides,
  };
}

const stored: StoredMessage[] = [
  {
    id: "m1",
    role: "user",
    content: "有没有快手的红烧菜",
    payload: null,
    promptVersion: null,
    createdAt: "2026-10-16T10:00:00.000Z",
  },
  {
    id: "m2",
    role: "assistant",
    content: "找到 2 道红烧菜",
    payload: { filter, matched: 2, items, unresolved },
    promptVersion: PROMPT_VERSION,
    createdAt: "2026-10-16T10:00:01.000Z",
  },
];

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  vi.mocked(loadOrCreateSession).mockResolvedValue("s1");
  vi.mocked(loadMessages).mockResolvedValue([]);
  vi.mocked(appendMessage).mockResolvedValue(undefined);
  vi.mocked(clearMessages).mockResolvedValue(undefined);
  vi.mocked(loadDict).mockResolvedValue({ categories: [], tags: [], ingredients: [] });
  vi.mocked(runAgent).mockResolvedValue(outcome());
  recipeStub.recipes = items;
});

describe("aiChatStore.load", () => {
  it("load 把历史消息读进 messages，顺序不变", async () => {
    vi.mocked(loadMessages).mockResolvedValue(stored);
    const store = useAiChatStore();

    await store.load();

    expect(loadOrCreateSession).toHaveBeenCalledTimes(1);
    expect(loadMessages).toHaveBeenCalledWith("s1");
    expect(store.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(store.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(store.messages[0]).toEqual({
      id: "m1",
      role: "user",
      text: "有没有快手的红烧菜",
      filter: null,
      items: [],
      matched: 0,
      unresolved: null,
    });
    expect(store.messages[1]).toEqual({
      id: "m2",
      role: "assistant",
      text: "找到 2 道红烧菜",
      filter,
      items,
      matched: 2,
      unresolved,
    });
    expect(store.sending).toBe(false);
    expect(store.error).toBeNull();
  });
});

describe("aiChatStore.send", () => {
  it("send：先插 user 消息再插 assistant 消息，两条都落库", async () => {
    const store = useAiChatStore();

    await store.send("有没有快手的红烧菜");

    expect(store.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(store.messages[0].text).toBe("有没有快手的红烧菜");
    expect(store.messages[1]).toMatchObject({
      text: "找到 2 道红烧菜",
      filter,
      items,
      matched: 2,
      unresolved,
    });
    expect(store.error).toBeNull();
    expect(store.sending).toBe(false);

    // 落库：两条、同一个会话、带 prompt 版本
    expect(appendMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appendMessage).mock.calls.map((call) => [call[0], call[1].role])).toEqual([
      ["s1", "user"],
      ["s1", "assistant"],
    ]);
    expect(vi.mocked(appendMessage).mock.calls[1][1].payload).toEqual({
      filter,
      matched: 2,
      items,
      unresolved,
    });
    for (const call of vi.mocked(appendMessage).mock.calls) {
      expect(call[1].promptVersion).toBe(PROMPT_VERSION);
    }

    // agent 拿到的是本机菜谱与本地日期，历史里不含本轮提问
    const [text, history, deps] = vi.mocked(runAgent).mock.calls[0];
    expect(text).toBe("有没有快手的红烧菜");
    expect(history).toEqual([]);
    expect(recipeStub.fetchAll).toHaveBeenCalledTimes(1);
    const today = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    expect((deps as AgentDeps).today).toBe(
      `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    );
    await expect((deps as AgentDeps).loadItems()).resolves.toBe(items);
  });

  it("sending 期间重复 send 被拒（不并发两次请求）", async () => {
    let release: (value: AgentOutcome) => void = () => {};
    vi.mocked(runAgent).mockReturnValue(
      new Promise<AgentOutcome>((resolve) => {
        release = resolve;
      }),
    );
    const store = useAiChatStore();

    const first = store.send("第一次");
    expect(store.sending).toBe(true);
    // 第一次还在 await 会话/落库，这里等它真的打到 agent 之前先塞第二次
    const second = store.send("第二次");

    await second;
    // 第二次被守卫挡掉，agent 只会被第一次调用一次
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));

    release(outcome());
    await first;

    expect(store.messages.map((message) => message.text)).toEqual(["第一次", "找到 2 道红烧菜"]);
    expect(appendMessage).toHaveBeenCalledTimes(2);
    expect(store.sending).toBe(false);
  });

  it("send 失败时把错误文案写进 error，messages 里不留半条 assistant 消息", async () => {
    vi.mocked(runAgent).mockRejectedValue(new AiError("ai_quota_exceeded"));
    const store = useAiChatStore();

    await expect(store.send("今天吃什么")).resolves.toBeUndefined();

    expect(store.error).toBe("今日 AI 次数已用完");
    expect(store.messages.map((message) => message.role)).toEqual(["user"]);
    // 用户说的话不因为 AI 挂了就丢
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendMessage).mock.calls[0][1].role).toBe("user");
    expect(store.sending).toBe(false);
  });

  it("非 AiError 的失败（如读库失败）给通用文案，异常不冒出 store", async () => {
    vi.mocked(loadDict).mockRejectedValue(new Error("db is gone"));
    const store = useAiChatStore();

    await expect(store.send("今天吃什么")).resolves.toBeUndefined();

    expect(store.error).toBe("AI 暂时用不了，稍后再试");
    expect(store.sending).toBe(false);
  });
});

describe("aiChatStore.clear", () => {
  it("clear 清空 messages 并软删库里的行", async () => {
    vi.mocked(loadMessages).mockResolvedValue(stored);
    const store = useAiChatStore();
    await store.load();

    await store.clear();

    expect(clearMessages).toHaveBeenCalledWith("s1");
    expect(store.messages).toEqual([]);
  });
});

describe("aiChatStore.reset", () => {
  it("reset 只清内存：messages / error / 会话缓存，不碰库", async () => {
    vi.mocked(loadMessages).mockResolvedValue(stored);
    const store = useAiChatStore();
    await store.load();
    store.error = "AI 暂时用不了，稍后再试";

    store.reset();

    expect(store.messages).toEqual([]);
    expect(store.error).toBeNull();
    expect(clearMessages).not.toHaveBeenCalled();
    // 会话缓存也清了：下次 load 重新取会话（旧账号的会话 id 不得留在内存里）
    await store.load();
    expect(loadOrCreateSession).toHaveBeenCalledTimes(2);
  });

  it("send 在途时 reset：上一个账号的响应回来不得写回内存", async () => {
    let release: (value: AgentOutcome) => void = () => {};
    vi.mocked(runAgent).mockReturnValue(
      new Promise<AgentOutcome>((resolve) => {
        release = resolve;
      }),
    );
    const store = useAiChatStore();

    const pending = store.send("今天吃什么");
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));

    // 退登：清内存，同时把在飞的这一发作废
    store.reset();
    release(outcome());
    await pending;

    expect(store.messages).toEqual([]);
    expect(store.error).toBeNull();
    expect(store.sending).toBe(false);
    // 助手那条根本不该落库（用户那条已经在退登前写入，属于上一个账号，不动）
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendMessage).mock.calls[0][1].role).toBe("user");
  });

  it("send 在途时 reset：失败回来的错误文案也不得写回", async () => {
    let reject: (err: unknown) => void = () => {};
    vi.mocked(runAgent).mockReturnValue(
      new Promise<AgentOutcome>((_resolve, rejectFn) => {
        reject = rejectFn;
      }),
    );
    const store = useAiChatStore();

    const pending = store.send("今天吃什么");
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));

    store.reset();
    reject(new AiError("ai_quota_exceeded"));
    await pending;

    expect(store.error).toBeNull();
    expect(store.messages).toEqual([]);
    expect(store.sending).toBe(false);
  });
});

describe("aiChatStore.openInFilter", () => {
  it("openInFilter 把 filter apply 进 recipeFilter store", () => {
    const store = useAiChatStore();
    const next = { ...emptyFilter(), keyword: "红烧", ingredientIds: ["ing-五花肉"] };

    store.openInFilter(next);

    // Review Focus：这是「AI 的结果你能自己验」的机制，必须与手点漏斗走同一个 store
    const applied = useRecipeFilterStore().filter;
    expect(applied).toEqual(next);
    expect(applied).not.toBe(next);
  });
});
