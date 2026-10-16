// 社区 store：mock 网络层（api）与图片下载，SQLite 与 sync 的落库逻辑保持真身。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";

vi.mock("@/services/api", () => ({
  hasBaseUrl: vi.fn(() => true),
  apiFetch: vi.fn(),
}));

// 图片下载走真身会碰网络（fetchWithAuth），换成空实现。
vi.mock("@/services/syncFiles", () => ({
  uploadPendingFiles: vi.fn(async () => true),
  downloadMissingFiles: vi.fn(async () => ({ downloaded: 0, failed: 0 })),
  downloadPendingFiles: vi.fn(async () => ({ retry: [] })),
}));

// 只换掉入队动作（真发同步会碰网络）；cacheCommunityChanges 等保持真身。
vi.mock("@/services/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/sync")>();
  return { ...actual, enqueueSync: vi.fn() };
});

import { apiFetch } from "@/services/api";
import type { ApiResult } from "@/services/api";
import { enqueueSync } from "@/services/sync";
import { useAuthStore } from "@/stores/auth";
import { useCommunityStore } from "@/stores/community";
import type { CommunityPage, CommunityRecipe } from "@/services/community";
import type { SyncPayload } from "@/services/sync";

const apiFetchMock = vi.mocked(apiFetch);
const enqueueSyncMock = vi.mocked(enqueueSync);

const NOW = "2026-10-15T10:00:00.000Z";

let db: Db;

function ok<T>(data: T): { ok: true; status: number; data: T } {
  return { ok: true, status: 200, data };
}

/** 手动控制 resolve 时机的 promise（模拟「响应还在路上」）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function recipe(id: string, favorited = false): CommunityRecipe {
  return {
    id,
    name: `菜 ${id}`,
    cover_path: null,
    author_id: "author",
    author_nickname: "老王",
    author_avatar_url: null,
    updated_at: NOW,
    favorited,
  };
}

/** 一条能被 applyRemoteChanges 直接落库的社区详情载荷。 */
function detailPayload(): SyncPayload {
  return {
    ingredients: [{ id: "ing", name: "盐", created_at: NOW, updated_at: NOW, deleted_at: null }],
    units: [{ id: "unit", name: "克", created_at: NOW, updated_at: NOW, deleted_at: null }],
    labels: [
      { id: "cat", name: "家常", kind: "category", created_at: NOW, updated_at: NOW, deleted_at: null },
    ],
    recipes: [
      {
        id: "r1",
        owner_id: "author",
        name: "红烧肉",
        cover_path: null,
        category_id: "cat",
        is_public: 1,
        owner_nickname: "老王",
        owner_avatar_url: null,
        created_at: NOW,
        updated_at: NOW,
        deleted_at: null,
        steps: [{ id: "s1", sort_order: 0, text: "切块", image_path: null }],
        ingredients: [
          { id: "ri1", ingredient_id: "ing", amount: 1, unit_id: "unit", sort_order: 0 },
        ],
        label_ids: ["cat"],
      },
    ],
    files: [],
  };
}

async function count(table: string): Promise<number> {
  const rows = await db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM ${table}`);
  return rows[0].n;
}

async function favoriteIds(): Promise<string[]> {
  const rows = await db.select<{ recipe_id: string }[]>(
    "SELECT recipe_id FROM favorite_recipes ORDER BY recipe_id",
  );
  return rows.map((r) => r.recipe_id);
}

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
  localStorage.clear();
  // 社区请求只在登录态发出；下面大多数用例要先站在登录态上（C3 的咽喉在 store.load）
  useAuthStore().mode = "online";
  vi.clearAllMocks();
});

describe("社区 store", () => {
  it("未登录时不发任何社区请求，也不进失败态（C3 回归）", async () => {
    useAuthStore().mode = "guest";
    const store = useCommunityStore();

    await store.load(true);

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });

  it("openRecipe 把详情落本地，返回 id", async () => {
    apiFetchMock.mockResolvedValue(ok(detailPayload()));

    const store = useCommunityStore();

    await expect(store.openRecipe("r1")).resolves.toBe("r1");

    expect(await count("recipes")).toBe(1);
    expect(await count("recipe_steps")).toBe(1);
    expect(await count("recipe_ingredients")).toBe(1);
    expect(await count("recipe_labels")).toBe(1);
    // 详情引用的字典行也一并落库（否则子行的外键找不到目标）
    expect(await count("ingredients")).toBe(1);
    expect(await count("units")).toBe(1);
    expect(await count("labels")).toBe(1);
    expect(new URL(apiFetchMock.mock.calls[0][0], "http://x").pathname).toBe(
      "/api/v1/community/recipes/r1",
    );
  });

  it("load 累积翻页，has_more 决定按钮显不显示", async () => {
    apiFetchMock
      .mockResolvedValueOnce(ok({ items: [recipe("a"), recipe("b")], has_more: true }))
      .mockResolvedValueOnce(ok({ items: [recipe("c")], has_more: false }));

    const store = useCommunityStore();

    await store.load();
    expect(store.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(store.hasMore).toBe(true);

    await store.load();
    expect(store.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(store.hasMore).toBe(false);
    // 第二页按已有条数作 offset
    expect(new URL(apiFetchMock.mock.calls[1][0], "http://x").searchParams.get("offset")).toBe("2");
  });

  it("load 失败时 error 有值、items 保留上一次的结果", async () => {
    apiFetchMock.mockResolvedValueOnce(ok({ items: [recipe("a")], has_more: true }));
    const store = useCommunityStore();
    await store.load();

    apiFetchMock.mockResolvedValueOnce({ ok: false, status: 500, error: "服务器错误" });
    await store.load();

    expect(store.error).toBe("服务器错误");
    expect(store.items.map((item) => item.id)).toEqual(["a"]);
    expect(store.loading).toBe(false);
  });

  it("favorite 成功后本地收藏集合里有它、items 里的 favorited 变 true", async () => {
    apiFetchMock.mockResolvedValueOnce(ok({ items: [recipe("r1")], has_more: false }));
    const store = useCommunityStore();
    await store.load();
    apiFetchMock.mockResolvedValueOnce({ ok: true, status: 204, data: undefined });

    await store.favorite("r1");

    expect(store.items[0].favorited).toBe(true);
    expect(await favoriteIds()).toEqual(["r1"]);
    expect(enqueueSyncMock).toHaveBeenCalledWith({});
  });

  it("favorite 失败（断网）时不改本地状态", async () => {
    apiFetchMock.mockResolvedValueOnce(ok({ items: [recipe("r1")], has_more: false }));
    const store = useCommunityStore();
    await store.load();
    apiFetchMock.mockRejectedValueOnce(new Error("请求超时"));

    await expect(store.favorite("r1")).rejects.toThrow("请求超时");

    expect(store.items[0].favorited).toBe(false);
    expect(await favoriteIds()).toEqual([]);
    expect(enqueueSyncMock).not.toHaveBeenCalled();
  });

  it("unfavorite 成功后本地收藏集合删掉它、items 里的 favorited 变 false", async () => {
    apiFetchMock.mockResolvedValueOnce(ok({ items: [recipe("r1", true)], has_more: false }));
    const store = useCommunityStore();
    await store.load();
    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES ('r1')");
    apiFetchMock.mockResolvedValueOnce({ ok: true, status: 204, data: undefined });

    await store.unfavorite("r1");

    expect(store.items[0].favorited).toBe(false);
    expect(await favoriteIds()).toEqual([]);
    expect(enqueueSyncMock).toHaveBeenCalledWith({});
  });

  it("isFavorited 读本地收藏集合（详情页收藏按钮的初值）", async () => {
    const store = useCommunityStore();

    expect(await store.isFavorited("r1")).toBe(false);

    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES ('r1')");

    expect(await store.isFavorited("r1")).toBe(true);
    expect(await store.isFavorited("r2")).toBe(false);
  });

  it("load 在途时切筛选：load(true) 不被丢弃，迟到的旧响应写不进列表", async () => {
    const stale = deferred<ApiResult<CommunityPage>>();
    const fresh = deferred<ApiResult<CommunityPage>>();
    apiFetchMock.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    const store = useCommunityStore();
    const first = store.load(); // followedOnly = false，挂在半路
    store.followedOnly = true;
    const second = store.load(true); // 切「关注」重拉：不能被在途的旧请求挤掉

    // reset 的请求真的发出去了，且带的是新筛选与第一页
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(apiFetchMock.mock.calls[1][0], "http://x");
    expect(secondUrl.searchParams.get("followed_only")).toBe("1");
    expect(secondUrl.searchParams.get("offset")).toBe("0");

    stale.resolve(ok({ items: [recipe("old")], has_more: false })); // 旧响应先到
    await first;
    fresh.resolve(ok({ items: [recipe("new")], has_more: true })); // 新响应后到
    await second;

    expect(store.items.map((item) => item.id)).toEqual(["new"]);
    expect(store.hasMore).toBe(true);
    expect(store.loading).toBe(false);
  });

  it("load 在途时切筛选：新响应先到，迟到的旧响应不覆盖它", async () => {
    const stale = deferred<ApiResult<CommunityPage>>();
    const fresh = deferred<ApiResult<CommunityPage>>();
    apiFetchMock.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    const store = useCommunityStore();
    const first = store.load();
    store.followedOnly = true;
    const second = store.load(true);

    fresh.resolve(ok({ items: [recipe("new")], has_more: true })); // 新响应先到
    await second;
    expect(store.items.map((item) => item.id)).toEqual(["new"]);
    expect(store.loading).toBe(false);

    stale.resolve(ok({ items: [recipe("old")], has_more: false })); // 旧响应后到
    await first;

    expect(store.items.map((item) => item.id)).toEqual(["new"]);
    expect(store.hasMore).toBe(true);
    expect(store.loading).toBe(false);
  });
});
