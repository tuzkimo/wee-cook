// 会话与消息的本地读写：一张本机唯一会话 + 它的消息列表。
// 用真 SQLite（node:sqlite）跑，软删、JSON 往返与外键都在真库上验。
import { beforeEach, describe, expect, it } from "vitest";
import { getDb, setDb } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import {
  appendMessage,
  clearMessages,
  loadMessages,
  loadOrCreateSession,
  type MessagePayload,
  type StoredMessage,
} from "@/services/ai/session";
import type { Label, Recipe, RecipeListItem } from "@/types";

const NOW = "2026-10-16T00:00:00.000Z";

const category: Label = {
  id: "c1",
  name: "家常菜",
  kind: "category",
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
};

const recipe: Recipe = {
  id: "r1",
  name: "红烧肉",
  cover_path: null,
  category_id: "c1",
  is_public: 0,
  owner_nickname: null,
  owner_avatar_url: null,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
  owner_id: null,
};

const item: RecipeListItem = {
  recipe,
  category,
  tags: [],
  ingredients: [{ id: "i1", name: "五花肉" }],
};

const payload: MessagePayload = {
  filter: { keyword: "红烧", categoryIds: [], tagIds: [], ingredientIds: ["i1"] },
  matched: 1,
  items: [item],
  unresolved: { categories: [], tags: [], ingredients: ["洋蓟"] },
};

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "给你找到 1 道",
    payload: null,
    promptVersion: "v1",
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  const fresh = await freshTestDb();
  setDb(fresh.db);
});

describe("session", () => {
  it("首次取会话会建一条，再取返回同一个 id", async () => {
    const first = await loadOrCreateSession();
    const second = await loadOrCreateSession();

    expect(second).toBe(first);
    const rows = await getDb().select<{ n: number }[]>("SELECT COUNT(*) AS n FROM ai_sessions");
    expect(rows[0].n).toBe(1);
  });

  it("消息读写往返整份相等（含 payload）", async () => {
    const sessionId = await loadOrCreateSession();
    // 两条同一毫秒写入，顺序靠插入序，不靠 id
    const first = message({ role: "user", content: "红烧肉怎么做", payload: null });
    const second = message({ payload, promptVersion: "v2" });
    await appendMessage(sessionId, first);
    await appendMessage(sessionId, second);

    expect(await loadMessages(sessionId)).toEqual([first, second]);
  });

  it("payload 为 null 的消息也能原样读回", async () => {
    const sessionId = await loadOrCreateSession();
    const text = message({ role: "user", content: "今天吃什么", payload: null, promptVersion: null });
    await appendMessage(sessionId, text);

    expect(await loadMessages(sessionId)).toEqual([text]);
  });

  it("clearMessages 后读回为空，但表里的行还在（软删）", async () => {
    const sessionId = await loadOrCreateSession();
    await appendMessage(sessionId, message({ role: "user" }));
    await appendMessage(sessionId, message());

    await clearMessages(sessionId);

    expect(await loadMessages(sessionId)).toEqual([]);
    const rows = await getDb().select<{ n: number }[]>("SELECT COUNT(*) AS n FROM ai_messages");
    expect(rows[0].n).toBe(2);
  });

  it("payload 是坏 JSON 时回落 null 而不是抛", async () => {
    const sessionId = await loadOrCreateSession();
    await appendMessage(sessionId, message());
    await getDb().execute("UPDATE ai_messages SET payload = ? WHERE session_id = ?", [
      "{不是 JSON",
      sessionId,
    ]);

    const loaded = await loadMessages(sessionId);

    expect(loaded[0].payload).toBeNull();
  });
});
