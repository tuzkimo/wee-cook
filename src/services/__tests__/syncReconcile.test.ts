// Task 4：同步成功后的收藏对账与本机账号白名单。真 SQLite，不 mock SQL。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";

// 只把网络层与 auth store 换成替身（参照 sync.test.ts），sync 本体保持真身，
// 这样能真的驱动 performSync 跑完一整轮。
const authState = vi.hoisted(() => ({ serverUserId: "me" as string | null }));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({
    get serverUserId() {
      return authState.serverUserId;
    },
    lastSyncFailed: false,
    notifySyncComplete() {},
  }),
}));

vi.mock("@/services/api", () => ({
  hasBaseUrl: vi.fn(() => true),
  apiFetch: vi.fn(),
}));

vi.mock("@/services/syncFiles", () => ({
  uploadPendingFiles: vi.fn(async () => true),
  downloadMissingFiles: vi.fn(async () => ({ downloaded: 0, failed: 0 })),
  downloadPendingFiles: vi.fn(async () => ({ retry: [] })),
}));

import { apiFetch } from "@/services/api";
import {
  bumpFavoriteOps,
  emptyPayload,
  favoriteOpsEpoch,
  getLastSyncedAtFor,
  performSync,
  reconcileFavorites,
  registerLocalAccount,
  resetSyncTimers,
} from "@/services/sync";

const apiFetchMock = vi.mocked(apiFetch);

/** 一次成功的 /sync 响应；收藏列表默认空表。 */
function okResponse(seq: number, favoriteIds: string[] = []): {
  ok: true;
  status: number;
  data: {
    server_seq: number;
    remote_changes: ReturnType<typeof emptyPayload>;
    favorite_recipe_ids: string[];
  };
} {
  return {
    ok: true,
    status: 200,
    data: { server_seq: seq, remote_changes: emptyPayload(), favorite_recipe_ids: favoriteIds },
  };
}

const NOW = "2026-10-15T10:00:00.000Z";
const ME = "me";
const B = "B";
const OTHER = "other";

let db: Db;

beforeEach(async () => {
  ({ db } = await freshTestDb());
  setDb(db);
  localStorage.clear();
  resetSyncTimers();
  vi.clearAllMocks();
  authState.serverUserId = "me";
  await db.execute(
    "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('cat','家常','category',?,?,NULL)",
    [NOW, NOW],
  );
  await db.execute(
    "INSERT INTO ingredients (id,name,created_at,updated_at,deleted_at) VALUES ('ing','盐',?,?,NULL)",
    [NOW, NOW],
  );
});

async function insertRecipe(opts: {
  owner: string | null;
  name: string;
  withChildren?: boolean;
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO recipes (id,name,cover_path,category_id,is_public,owner_nickname,created_at,updated_at,deleted_at,owner_id)
     VALUES (?,?,NULL,'cat',1,?,?,?,NULL,?)`,
    [id, opts.name, opts.owner, NOW, NOW, opts.owner],
  );
  if (opts.withChildren) {
    await db.execute(
      "INSERT INTO recipe_steps (id,recipe_id,sort_order,text,image_path,updated_at,deleted_at) VALUES (?,?,0,'切',NULL,?,NULL)",
      [crypto.randomUUID(), id, NOW],
    );
    await db.execute(
      "INSERT INTO recipe_ingredients (id,recipe_id,ingredient_id,amount,unit_id,sort_order,updated_at,deleted_at) VALUES (?,?,'ing',1,NULL,0,?,NULL)",
      [crypto.randomUUID(), id, NOW],
    );
    await db.execute("INSERT INTO recipe_labels (recipe_id,label_id) VALUES (?, 'cat')", [id]);
  }
  return id;
}

async function recipeIds(): Promise<string[]> {
  const rows = await db.select<{ id: string }[]>("SELECT id FROM recipes ORDER BY id");
  return rows.map((r) => r.id);
}

async function favoriteIds(): Promise<string[]> {
  const rows = await db.select<{ recipe_id: string }[]>(
    "SELECT recipe_id FROM favorite_recipes ORDER BY recipe_id",
  );
  return rows.map((r) => r.recipe_id);
}

async function childCount(recipeId: string): Promise<number> {
  const rows = await db.select<{ n: number }[]>(
    `SELECT (SELECT COUNT(*) FROM recipe_steps       WHERE recipe_id = ?)
          + (SELECT COUNT(*) FROM recipe_ingredients WHERE recipe_id = ?)
          + (SELECT COUNT(*) FROM recipe_labels      WHERE recipe_id = ?) AS n`,
    [recipeId, recipeId, recipeId],
  );
  return rows[0].n;
}

describe("reconcileFavorites", () => {
  it("整表替换收藏集合：旧收藏被换掉", async () => {
    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES ('old')");

    await reconcileFavorites(ME, ["new-1", "new-2"], db);

    expect(await favoriteIds()).toEqual(["new-1", "new-2"]);
  });

  it("清掉既不是我本机账号、又没被收藏的别人的菜谱（含子行）", async () => {
    const cached = await insertRecipe({ owner: OTHER, name: "别人的缓存", withChildren: true });

    await reconcileFavorites(ME, [], db);

    expect(await recipeIds()).toEqual([]);
    expect(await childCount(cached)).toBe(0);
  });

  it("本机上另一个账号自己的菜谱不被清掉（多账号回归）", async () => {
    const mine = await insertRecipe({ owner: ME, name: "我的" });
    await registerLocalAccount(B, db);
    const bRecipe = await insertRecipe({ owner: B, name: "B 的" });
    await insertRecipe({ owner: OTHER, name: "别人的" });

    await reconcileFavorites(ME, [], db);

    expect((await recipeIds()).sort()).toEqual([mine, bRecipe].sort());
  });

  it("我自己的菜谱不被清掉", async () => {
    const mine = await insertRecipe({ owner: ME, name: "我的" });

    await reconcileFavorites(ME, [], db);

    expect(await recipeIds()).toEqual([mine]);
  });

  it("收藏操作版本变了就跳过本轮对账", async () => {
    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES ('kept')");
    const cached = await insertRecipe({ owner: OTHER, name: "别人的", withChildren: true });
    const epoch = favoriteOpsEpoch();

    bumpFavoriteOps();
    await reconcileFavorites(ME, ["new"], db);

    expect(favoriteOpsEpoch()).toBe(epoch + 1);
    // 收藏集合与缓存副本都原样不动（整段跳过）
    expect(await favoriteIds()).toEqual(["kept"]);
    expect(await recipeIds()).toEqual([cached]);
  });
});

// 驱动真的 doSync：验证「基线在发请求前写入」与「跳过时仍推进游标、并补跑一轮」这条接线。
describe("performSync 里的收藏对账接线", () => {
  it("请求在途时又收藏：对账整段跳过，游标照推，并补跑一轮", async () => {
    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES ('kept')");
    const cached = await insertRecipe({ owner: OTHER, name: "别人的", withChildren: true });
    // 请求已发出、响应还没回来时用户点了收藏（主竞态）：apiFetch 被调时 bump
    apiFetchMock.mockImplementationOnce(async () => {
      bumpFavoriteOps();
      return okResponse(7);
    });
    apiFetchMock.mockResolvedValue(okResponse(8));

    vi.useFakeTimers();
    try {
      await expect(performSync()).resolves.toBe(true);

      // 过期的响应快照没抹掉刚落的收藏，也没清掉缓存副本
      expect(await favoriteIds()).toEqual(["kept"]);
      expect(await recipeIds()).toEqual([cached]);
      // 跳过对账不影响游标推进
      expect(getLastSyncedAtFor("me")).toBe("7");

      // 补跑：enqueueSync({}) 的 3s 防抖烧完后又发了一次同步
      expect(apiFetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(apiFetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("没有竞态时：响应的收藏 id 落库，缓存副本被清", async () => {
    const cached = await insertRecipe({ owner: OTHER, name: "别人的", withChildren: true });
    const fav = await insertRecipe({ owner: OTHER, name: "收藏的" });
    apiFetchMock.mockResolvedValue(okResponse(9, [fav]));

    await expect(performSync()).resolves.toBe(true);

    expect(await favoriteIds()).toEqual([fav]);
    expect(await recipeIds()).toEqual([fav]);
    expect(await childCount(cached)).toBe(0);
    expect(getLastSyncedAtFor("me")).toBe("9");
  });
});
