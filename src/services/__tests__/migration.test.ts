import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";

// auth store 只被读三个字段，用可变对象替身即可（真 store 依赖 plugin-store）。
const authState = vi.hoisted(() => ({
  serverUserId: "me" as string | null,
  lastSyncFailed: false,
  syncCompleted: 0,
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({
    get serverUserId() {
      return authState.serverUserId;
    },
    get lastSyncFailed() {
      return authState.lastSyncFailed;
    },
    set lastSyncFailed(v: boolean) {
      authState.lastSyncFailed = v;
    },
    notifySyncComplete() {
      authState.syncCompleted++;
      authState.lastSyncFailed = false;
    },
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

import { apiFetch, hasBaseUrl } from "@/services/api";
import { collectPushPayload, emptyPayload, resetSyncTimers } from "@/services/sync";
import { claimOrphanRecipes, triggerFullPushAndSync } from "@/services/migration";

const hasBaseUrlMock = vi.mocked(hasBaseUrl);
const apiFetchMock = vi.mocked(apiFetch);

const T0 = "2026-01-01T00:00:00.000Z";

type OkResult = {
  ok: true;
  status: number;
  data: { server_seq: number; remote_changes: ReturnType<typeof emptyPayload> };
};

function okResponse(serverSeq: number): OkResult {
  return { ok: true, status: 200, data: { server_seq: serverSeq, remote_changes: emptyPayload() } };
}

async function insertCategory(db: Db, id = "c1"): Promise<void> {
  await db.execute(
    "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES (?,'家常','category',?,?,NULL)",
    [id, T0, T0],
  );
}

async function insertRecipe(db: Db, id: string, ownerId: string | null): Promise<void> {
  await db.execute(
    `INSERT INTO recipes (id,name,cover_path,category_id,created_at,updated_at,deleted_at,owner_id)
     VALUES (?,'菜',NULL,'c1',?,?,NULL,?)`,
    [id, T0, T0, ownerId],
  );
}

async function owners(db: Db): Promise<Record<string, string | null>> {
  const rows = await db.select<{ id: string; owner_id: string | null }[]>(
    "SELECT id, owner_id FROM recipes ORDER BY id",
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.owner_id]));
}

async function pushedRecipeIds(): Promise<string[]> {
  const payload = await collectPushPayload();
  return payload.recipes.map((r) => r.id);
}

let db: Db;

beforeEach(async () => {
  localStorage.clear();
  resetSyncTimers();
  vi.clearAllMocks();
  hasBaseUrlMock.mockReturnValue(true);
  authState.serverUserId = "me";
  authState.lastSyncFailed = false;
  authState.syncCompleted = 0;
  db = (await freshTestDb()).db;
  setDb(db);
});

afterEach(() => {
  resetSyncTimers();
});

describe("claimOrphanRecipes", () => {
  it("认领只动 owner_id 为 NULL 的行", async () => {
    await insertCategory(db);
    await insertRecipe(db, "r-null", null);
    await insertRecipe(db, "r-other", "other");
    await insertRecipe(db, "r-me", "me");

    await expect(claimOrphanRecipes("me")).resolves.toBe(1);

    expect(await owners(db)).toEqual({
      "r-me": "me",
      "r-null": "me",
      "r-other": "other",
    });
  });

  it("认领是幂等的：第二次调用返回 0", async () => {
    await insertCategory(db);
    await insertRecipe(db, "r-null", null);
    // 掺一条别人的：返回 1（只数 NULL 行）而不是 2，认领也不会碰它——
    // 否则「WHERE owner_id IS NULL」被写成无条件就照样过了。
    await insertRecipe(db, "r-other", "other");

    expect(await claimOrphanRecipes("me")).toBe(1);
    expect(await claimOrphanRecipes("me")).toBe(0);
    expect(await owners(db)).toEqual({ "r-null": "me", "r-other": "other" });
  });

  it("Review Focus ②：换人登录时不认领别人的菜谱，也不把别人的推上去", async () => {
    // A 登录并认领了本机存量
    await insertCategory(db);
    await insertRecipe(db, "r-a", null);
    authState.serverUserId = "A";
    await claimOrphanRecipes("A");

    // A 登出，B 登录：B 的认领不得碰 A 的菜谱
    authState.serverUserId = "B";
    expect(await claimOrphanRecipes("B")).toBe(0);
    expect(await owners(db)).toEqual({ "r-a": "A" });

    // B 的全扫推送里不得出现 A 的菜谱
    expect(await pushedRecipeIds()).toEqual([]);
  });

  it("推送集合只含 owner_id = 我 的菜谱（含认领后的存量）", async () => {
    await insertCategory(db);
    await insertRecipe(db, "r-null", null);
    await insertRecipe(db, "r-other", "other");

    authState.serverUserId = "me";
    await claimOrphanRecipes("me");

    expect((await pushedRecipeIds()).sort()).toEqual(["r-null"]);
  });
});

describe("triggerFullPushAndSync", () => {
  it("认领本地存量后做一次全扫推送，带上全部字典行与子行", async () => {
    await insertCategory(db, "c1");
    await db.execute(
      "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('t1','快手','tag',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO ingredients (id,name,created_at,updated_at,deleted_at) VALUES ('i1','盐',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('un1','克',?,?,NULL)",
      [T0, T0],
    );
    await insertRecipe(db, "r1", null);
    await db.execute(
      "INSERT INTO recipe_steps (id,recipe_id,sort_order,text,image_path,updated_at,deleted_at) VALUES ('s1','r1',0,'切',NULL,?,NULL)",
      [T0],
    );
    await db.execute(
      "INSERT INTO recipe_ingredients (id,recipe_id,ingredient_id,amount,unit_id,sort_order,updated_at,deleted_at) VALUES ('ri1','r1','i1',2,'un1',0,?,NULL)",
      [T0],
    );
    await db.execute("INSERT INTO recipe_labels (recipe_id,label_id) VALUES ('r1','t1')");
    apiFetchMock.mockResolvedValue(okResponse(42));

    await triggerFullPushAndSync();

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/sync");
    const body = JSON.parse(String(init?.body));
    expect(body.local_changes.ingredients).toHaveLength(1);
    expect(body.local_changes.units).toHaveLength(1);
    expect(body.local_changes.labels.map((l: { id: string }) => l.id).sort()).toEqual(["c1", "t1"]);
    expect(body.local_changes.recipes).toHaveLength(1);
    const recipe = body.local_changes.recipes[0];
    expect(recipe.id).toBe("r1");
    expect(recipe.owner_id).toBe("me");
    expect(recipe.steps).toHaveLength(1);
    expect(recipe.ingredients).toHaveLength(1);
    expect(recipe.label_ids).toEqual(["t1"]);
  });

  it("登出期间录的菜（owner_id 为 NULL）重新登录后被推上去（全扫补推）", async () => {
    // 未登录：本地新增菜谱的行 owner_id 为 NULL，且不会入队（enqueueSync 直接返回）
    authState.serverUserId = null;
    await insertCategory(db);
    await insertRecipe(db, "r-offline", null);
    expect(localStorage.getItem("pending_sync:me")).toBeNull();

    // 重新登录：认领 + 一次全扫推送，把登出期间录的菜补上去
    authState.serverUserId = "me";
    apiFetchMock.mockResolvedValue(okResponse(7));

    await triggerFullPushAndSync();

    const body = JSON.parse(String(apiFetchMock.mock.calls[0][1]?.body));
    expect(body.local_changes.recipes.map((r: { id: string }) => r.id)).toEqual(["r-offline"]);
    expect(body.local_changes.recipes[0].owner_id).toBe("me");
    expect(body.last_server_seq).toBe(0);
    expect(authState.lastSyncFailed).toBe(false);
  });

  it("未登录 / 未配置地址时一次请求都不发", async () => {
    authState.serverUserId = null;
    await triggerFullPushAndSync();
    expect(apiFetchMock).not.toHaveBeenCalled();

    authState.serverUserId = "me";
    hasBaseUrlMock.mockReturnValue(false);
    await triggerFullPushAndSync();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
