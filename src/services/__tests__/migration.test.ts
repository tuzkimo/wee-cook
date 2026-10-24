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
import { claimLocalScope, triggerFullPushAndSync } from "@/services/migration";

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

async function insertCategory(db: Db, id = "c1", scope = "p:local", name = "家常"): Promise<void> {
  await db.execute(
    "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES (?,?,?,'category',?,?,NULL)",
    [id, scope, name, T0, T0],
  );
}

async function insertRecipe(
  db: Db,
  id: string,
  scope: string,
  ownerId: string | null = null,
): Promise<void> {
  await db.execute(
    `INSERT INTO recipes (id,scope_id,name,cover_path,category_id,created_at,updated_at,deleted_at,owner_id)
     VALUES (?,?,'菜',NULL,'c1',?,?,NULL,?)`,
    [id, scope, T0, T0, ownerId],
  );
}

async function insertBatch(db: Db, id: string, scope: string, ingredientId: string): Promise<void> {
  await db.execute(
    `INSERT INTO inventory_batches
       (id,scope_id,owner_id,ingredient_id,amount,created_at,updated_at,deleted_at)
     VALUES (?,?,NULL,?,100,?,?,NULL)`,
    [id, scope, ingredientId, T0, T0],
  );
}

async function insertUsage(db: Db, id: string, scope: string, batchId: string): Promise<void> {
  await db.execute(
    `INSERT INTO inventory_usages
       (id,scope_id,owner_id,recipe_id,batch_id,amount,used_at,updated_at,deleted_at)
     VALUES (?,?,NULL,'r1',?,10,?,?,NULL)`,
    [id, scope, batchId, T0, T0],
  );
}

async function owners(db: Db): Promise<Record<string, string | null>> {
  const rows = await db.select<{ id: string; owner_id: string | null }[]>(
    "SELECT id, owner_id FROM recipes ORDER BY id",
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.owner_id]));
}

async function localScopeRows(db: Db): Promise<number> {
  const tables = ["recipes", "ingredients", "units", "labels", "inventory_batches", "inventory_usages"];
  let total = 0;
  for (const table of tables) {
    const rows = await db.select<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE scope_id = 'p:local'`,
    );
    total += rows[0].n;
  }
  return total;
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

describe("claimLocalScope", () => {
  it("把 p:local 的菜谱 / 批次 / 使用记录整批改写成个人范围并补上 owner_id", async () => {
    await insertCategory(db);
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('i1','p:local','盐',?,?,NULL)",
      [T0, T0],
    );
    await insertRecipe(db, "r-guest", "p:local");
    await insertBatch(db, "b1", "p:local", "i1");
    await insertUsage(db, "us1", "p:local", "b1");

    await claimLocalScope("me");

    expect(await owners(db)).toEqual({ "r-guest": "me" });
    expect(await db.select("SELECT scope_id FROM inventory_batches WHERE id = 'b1'")).toEqual([
      { scope_id: "p:me" },
    ]);
    expect(
      await db.select("SELECT scope_id, owner_id FROM inventory_usages WHERE id = 'us1'"),
    ).toEqual([{ scope_id: "p:me", owner_id: "me" }]);
    expect(await db.select("SELECT scope_id FROM ingredients WHERE id = 'i1'")).toEqual([
      { scope_id: "p:me" },
    ]);
    // 登出即空态的前提：认领之后 p:local 里一行都不剩
    expect(await localScopeRows(db)).toBe(0);
  });

  it("目标范围已有同名食材时，游客那条被删、引用被改指（菜谱与批次两个方向）", async () => {
    await insertCategory(db);
    // 目标范围早就有「生抽」
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('i-target','p:me','生抽',?,?,NULL)",
      [T0, T0],
    );
    // 游客也录了一条「生抽」，且被菜谱的食材行与库存批次引用
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('i-guest','p:local','生抽',?,?,NULL)",
      [T0, T0],
    );
    await insertRecipe(db, "r-guest", "p:local");
    await db.execute(
      `INSERT INTO recipe_ingredients (id,recipe_id,ingredient_id,amount,unit_id,sort_order,updated_at,deleted_at)
       VALUES ('ri1','r-guest','i-guest',1,NULL,0,?,NULL)`,
      [T0],
    );
    await insertBatch(db, "b1", "p:local", "i-guest");

    await claimLocalScope("me");

    // 游客那条被合并掉，只剩目标范围那条
    expect(await db.select("SELECT id, scope_id FROM ingredients ORDER BY id")).toEqual([
      { id: "i-target", scope_id: "p:me" },
    ]);
    expect(
      await db.select("SELECT ingredient_id FROM recipe_ingredients WHERE id = 'ri1'"),
    ).toEqual([{ ingredient_id: "i-target" }]);
    expect(
      await db.select("SELECT ingredient_id FROM inventory_batches WHERE id = 'b1'"),
    ).toEqual([{ ingredient_id: "i-target" }]);
  });

  it("分类同名合并：引用改指到已有那条，游客那条连同 recipe_labels 关联一起清掉", async () => {
    await insertCategory(db, "c1", "p:me", "随便");
    await insertCategory(db, "c-target", "p:me");
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('c-guest','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await insertRecipe(db, "r-guest", "p:local"); // category_id 先用 c1，下面改成游客分类
    await db.execute("UPDATE recipes SET category_id = 'c-guest' WHERE id = 'r-guest'");
    await db.execute("INSERT INTO recipe_labels (recipe_id,label_id) VALUES ('r-guest','c-guest')");

    await claimLocalScope("me");

    expect(await db.select("SELECT category_id FROM recipes WHERE id = 'r-guest'")).toEqual([
      { category_id: "c-target" },
    ]);
    expect(await db.select("SELECT label_id FROM recipe_labels WHERE recipe_id = 'r-guest'")).toEqual(
      [{ label_id: "c-target" }],
    );
    // 游客那条「家常」被删，剩下的目标范围那条与开头为菜谱准备的 c1
    expect(await db.select("SELECT id FROM labels ORDER BY id")).toEqual([
      { id: "c-target" },
      { id: "c1" },
    ]);
  });

  it("幂等：第二次调用是空操作", async () => {
    await insertCategory(db);
    await insertRecipe(db, "r-guest", "p:local");

    await claimLocalScope("me");
    await claimLocalScope("me");

    expect(await owners(db)).toEqual({ "r-guest": "me" });
  });

  it("Review Focus ②：换人登录时不认领别人的范围，也不把别人的推上去", async () => {
    await insertCategory(db);
    await insertRecipe(db, "r-a", "p:local");
    authState.serverUserId = "A";
    await claimLocalScope("A");

    authState.serverUserId = "B";
    await claimLocalScope("B");
    expect(await owners(db)).toEqual({ "r-a": "A" });
    expect(await pushedRecipeIds()).toEqual([]);
  });
});

describe("triggerFullPushAndSync", () => {
  it("认领本地存量后做一次全扫推送，带上全部字典行与子行", async () => {
    await insertCategory(db, "c1");
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('t1','p:local','快手','tag',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('i1','p:local','盐',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('un1','p:local','克',?,?,NULL)",
      [T0, T0],
    );
    await insertRecipe(db, "r1", "p:local");
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
    expect(recipe.scope_id).toBe("p:me");
    expect(recipe.steps).toHaveLength(1);
    expect(recipe.ingredients).toHaveLength(1);
    expect(recipe.label_ids).toEqual(["t1"]);
  });

  it("登出期间录的菜（p:local）重新登录后被认领并推上去", async () => {
    authState.serverUserId = null;
    await insertCategory(db);
    await insertRecipe(db, "r-offline", "p:local");
    expect(localStorage.getItem("pending_sync:me")).toBeNull();

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
