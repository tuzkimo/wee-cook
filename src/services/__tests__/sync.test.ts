import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import type { Unit } from "@/types";

// auth store 只在本任务里被读/写三个字段，用可变对象替身即可（真 store 依赖 plugin-store）。
const authState = vi.hoisted(() => ({
  serverUserId: "u1" as string | null,
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
import { uploadPendingFiles } from "@/services/syncFiles";
import {
  clearPendingSync,
  collectPushPayload,
  emptyPayload,
  enqueueSync,
  getLastSyncedAtFor,
  performSync,
  requestSyncNow,
  resetSyncCursorsOnce,
  resetSyncTimers,
  setLastSyncedAtFor,
  syncInFlight,
} from "@/services/sync";

const hasBaseUrlMock = vi.mocked(hasBaseUrl);
const apiFetchMock = vi.mocked(apiFetch);
const uploadMock = vi.mocked(uploadPendingFiles);

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";

function unit(id: string, name: string, updatedAt = T0): Unit {
  return { id, name, created_at: T0, updated_at: updatedAt, deleted_at: null };
}

function okResponse(serverSeq: number): OkResult {
  return { ok: true, status: 200, data: { server_seq: serverSeq, remote_changes: emptyPayload() } };
}

type OkResult = {
  ok: true;
  status: number;
  data: { server_seq: number; remote_changes: ReturnType<typeof emptyPayload> };
};

async function insertLabel(db: Db, id = "c1"): Promise<void> {
  await db.execute(
    "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES (?,'家常','category',?,?,NULL)",
    [id, T0, T0],
  );
}

async function insertRecipe(
  db: Db,
  id: string,
  ownerId: string | null,
  deletedAt: string | null = null,
): Promise<void> {
  await db.execute(
    `INSERT INTO recipes (id,name,cover_path,category_id,created_at,updated_at,deleted_at,owner_id)
     VALUES (?,'菜',NULL,'c1',?,?,?,?)`,
    [id, T0, T0, deletedAt, ownerId],
  );
}

let db: Db;

beforeEach(async () => {
  localStorage.clear();
  clearPendingSync();
  resetSyncTimers();
  vi.clearAllMocks();
  hasBaseUrlMock.mockReturnValue(true);
  uploadMock.mockResolvedValue(true);
  authState.serverUserId = "u1";
  authState.lastSyncFailed = false;
  authState.syncCompleted = 0;
  db = (await freshTestDb()).db;
  setDb(db);
});

afterEach(() => {
  resetSyncTimers();
});

describe("enqueueSync", () => {
  it("没有服务器地址时 enqueueSync 不入队也不发请求", async () => {
    hasBaseUrlMock.mockReturnValue(false);

    enqueueSync({ units: [unit("u1", "克")] });

    expect(localStorage.getItem("pending_sync:u1")).toBeNull();
    await expect(performSync()).resolves.toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("队列按 uid 隔离并立刻落盘（Review Focus ⑤：定时器没烧完就退出 App 也不丢）", () => {
    enqueueSync({ units: [unit("u-a", "克")] });

    const raw = localStorage.getItem("pending_sync:u1");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).units).toHaveLength(1);

    authState.serverUserId = "u2";
    expect(localStorage.getItem("pending_sync:u2")).toBeNull();
  });

  it("同一行重复入队只保留更新的一份", () => {
    enqueueSync({ units: [unit("u-x", "新", T1)] });
    enqueueSync({ units: [unit("u-x", "旧", T0)] });

    const parsed = JSON.parse(localStorage.getItem("pending_sync:u1") as string);
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0].name).toBe("新");
  });
});

describe("游标", () => {
  it("游标按 uid 隔离", () => {
    setLastSyncedAtFor("u1", "7");
    expect(getLastSyncedAtFor("u1")).toBe("7");
    expect(getLastSyncedAtFor("u2")).toBeNull();
  });

  it("一次性重置：第一次清掉所有账号的游标并写标记，第二次不再清（F1 回归）", () => {
    setLastSyncedAtFor("u1", "9");
    setLastSyncedAtFor("u2", "5");

    resetSyncCursorsOnce();
    expect(localStorage.getItem("last_server_seq:u1")).toBeNull();
    expect(localStorage.getItem("last_server_seq:u2")).toBeNull();
    expect(localStorage.getItem("author_avatar_backfill_v1")).toBe("1");

    // 第二次跑：标记已在，新写下的游标必须留着
    setLastSyncedAtFor("u1", "11");
    resetSyncCursorsOnce();
    expect(localStorage.getItem("last_server_seq:u1")).toBe("11");
  });
});

describe("performSync", () => {
  it("同步成功后游标推进到 server_seq 且 pending 清空", async () => {
    enqueueSync({ units: [unit("u1", "克")] });
    apiFetchMock.mockResolvedValue(okResponse(42));

    await expect(performSync()).resolves.toBe(true);

    expect(getLastSyncedAtFor("u1")).toBe("42");
    expect(localStorage.getItem("pending_sync:u1")).toBeNull();
    const [, init] = apiFetchMock.mock.calls[0];
    expect(apiFetchMock.mock.calls[0][0]).toBe("/api/v1/sync");
    expect(JSON.parse(String(init?.body)).last_server_seq).toBe(0);
  });

  it("网络异常时改动回队并返回 false，游标不推进", async () => {
    enqueueSync({ units: [unit("u1", "克")] });
    apiFetchMock.mockRejectedValue(new Error("断网"));

    await expect(performSync()).resolves.toBe(false);

    expect(getLastSyncedAtFor("u1")).toBeNull();
    const parsed = JSON.parse(localStorage.getItem("pending_sync:u1") as string);
    expect(parsed.units).toHaveLength(1);
  });

  it("服务端 500 时改动回队，界面能看到 lastSyncFailed", async () => {
    enqueueSync({ units: [unit("u1", "克")] });
    apiFetchMock.mockResolvedValue({ ok: false, status: 500, error: "sync failed" });

    await expect(performSync()).resolves.toBe(false);

    expect(authState.lastSyncFailed).toBe(true);
    const parsed = JSON.parse(localStorage.getItem("pending_sync:u1") as string);
    expect(parsed.units).toHaveLength(1);
  });

  it("在途同步不会被重入，期间的新请求结束后补跑一次", async () => {
    let resolveFirst!: (value: OkResult) => void;
    apiFetchMock
      .mockImplementationOnce(() => new Promise<OkResult>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(okResponse(2));

    const first = performSync();
    const second = performSync();
    await expect(second).resolves.toBe(false);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    resolveFirst(okResponse(1));
    await expect(first).resolves.toBe(true);
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
  });

  it("升级后第一次同步清空游标、从 0 全量重拉（F1 回归）", async () => {
    setLastSyncedAtFor("u1", "9");
    setLastSyncedAtFor("u2", "5");
    apiFetchMock.mockRejectedValue(new Error("断网"));

    await expect(performSync()).resolves.toBe(false);

    const [, init] = apiFetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body)).last_server_seq).toBe(0);
    expect(getLastSyncedAtFor("u1")).toBeNull();
    expect(getLastSyncedAtFor("u2")).toBeNull();
  });

  it("升级后第二次同步不再清游标，从上次的位置增量拉（F1 回归）", async () => {
    apiFetchMock.mockRejectedValue(new Error("断网"));
    await expect(performSync()).resolves.toBe(false);
    setLastSyncedAtFor("u1", "9");

    await expect(performSync()).resolves.toBe(false);

    const [, init] = apiFetchMock.mock.calls[1];
    expect(JSON.parse(String(init?.body)).last_server_seq).toBe(9);
    expect(getLastSyncedAtFor("u1")).toBe("9");
  });

  it("未登录时 performSync 不发请求", async () => {
    authState.serverUserId = null;

    enqueueSync({ units: [unit("u1", "克")] });

    expect(localStorage.getItem("pending_sync:u1")).toBeNull();
    await expect(performSync()).resolves.toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("Review Focus ①：服务不可达时本地读写照常，performSync 返回 false 且不清数据", async () => {
    await insertLabel(db);
    await insertRecipe(db, "r1", "u1");
    apiFetchMock.mockRejectedValue(new Error("连不上服务器"));

    await expect(performSync()).resolves.toBe(false);

    expect(await db.select("SELECT id FROM recipes WHERE owner_id = 'u1'")).toEqual([{ id: "r1" }]);
    // 本地读写不受同步失败影响
    await db.execute(
      "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('u9','克',?,?,NULL)",
      [T0, T0],
    );
    expect(await db.select("SELECT id FROM units")).toEqual([{ id: "u9" }]);
  });

  it("图上传失败时本批菜谱不推，但会安排退避重试（I2）", async () => {
    await insertLabel(db);
    await insertRecipe(db, "r1", "u1");
    // 第一次图传失败，退避重试那轮图已传上去 → 菜谱这才推出去
    uploadMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    apiFetchMock.mockResolvedValue(okResponse(1));

    vi.useFakeTimers();
    try {
      await expect(performSync()).resolves.toBe(true);

      const body = JSON.parse(String(apiFetchMock.mock.calls[0][1]?.body));
      expect(body.local_changes.recipes).toEqual([]);
      // 菜谱被扣下 = 不是「已同步」：界面能区分，且 5s 后自动重试
      expect(authState.lastSyncFailed).toBe(true);
      expect(apiFetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(apiFetchMock).toHaveBeenCalledTimes(2);
      const retryBody = JSON.parse(String(apiFetchMock.mock.calls[1][1]?.body));
      expect(retryBody.local_changes.recipes.map((r: { id: string }) => r.id)).toEqual(["r1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persistPending 写失败（配额）不把异常抛出去：enqueueSync 不抛、performSync 仍 resolve（I4）", async () => {
    // 直接换掉全局 localStorage：避免不同环境的 Storage 实现差异，setItem 一律抛配额错。
    const realStorage = localStorage;
    vi.stubGlobal("localStorage", {
      length: 0,
      key: () => null,
      clear: () => realStorage.clear(),
      getItem: (k: string) => realStorage.getItem(k),
      removeItem: (k: string) => realStorage.removeItem(k),
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    });
    try {
      expect(() => enqueueSync({ units: [unit("u1", "克")] })).not.toThrow();
      apiFetchMock.mockRejectedValue(new Error("断网"));

      await expect(performSync()).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("requestSyncNow", () => {
  it("空闲时立刻跑一次，不等 3 秒防抖", async () => {
    apiFetchMock.mockResolvedValue(okResponse(1));

    vi.useFakeTimers();
    try {
      requestSyncNow();
      // 只冲微任务、不推进 3 秒：走防抖的话这里必然是 0 次
      await vi.advanceTimersByTimeAsync(0);

      expect(apiFetchMock).toHaveBeenCalledTimes(1);
      expect(apiFetchMock.mock.calls[0][0]).toBe("/api/v1/sync");
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    // 等这轮同步真正结束，不把 isSyncing 漏给下一条用例
    await vi.waitFor(() => expect(syncInFlight.value).toBe(false));
  });

  it("在途时再调只安排一轮补跑，总请求数 2 而不是 3", async () => {
    let resolveFirst!: (value: OkResult) => void;
    apiFetchMock
      .mockImplementationOnce(() => new Promise<OkResult>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(okResponse(2));

    requestSyncNow();
    requestSyncNow();
    requestSyncNow();

    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    resolveFirst(okResponse(1));
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(syncInFlight.value).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("没地址或没登录时不发请求", async () => {
    authState.serverUserId = null;
    requestSyncNow();
    expect(apiFetchMock).not.toHaveBeenCalled();

    authState.serverUserId = "u1";
    hasBaseUrlMock.mockReturnValue(false);
    requestSyncNow();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("syncInFlight 在跑与不跑之间正确翻转", async () => {
    let resolveFirst!: (value: OkResult) => void;
    apiFetchMock.mockImplementationOnce(() => new Promise<OkResult>((resolve) => (resolveFirst = resolve)));

    expect(syncInFlight.value).toBe(false);

    const running = performSync();
    expect(syncInFlight.value).toBe(true);
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    resolveFirst(okResponse(1));
    await expect(running).resolves.toBe(true);
    expect(syncInFlight.value).toBe(false);
  });

  it("resetSyncTimers（登出）把在途标志复位", async () => {
    let resolveFirst!: (value: OkResult) => void;
    apiFetchMock.mockImplementationOnce(() => new Promise<OkResult>((resolve) => (resolveFirst = resolve)));

    const running = performSync();
    expect(syncInFlight.value).toBe(true);
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    resetSyncTimers();
    expect(syncInFlight.value).toBe(false);

    resolveFirst(okResponse(1));
    await running;
  });
});

describe("collectPushPayload", () => {
  it("只推 owner_id = 我 的菜谱，且软删的墓碑也要推", async () => {
    await insertLabel(db);
    await insertRecipe(db, "r-mine", "u1");
    await insertRecipe(db, "r-tomb", "u1", T1);
    await insertRecipe(db, "r-other", "u2");

    const payload = await collectPushPayload();

    expect(payload.recipes.map((r) => r.id).sort()).toEqual(["r-mine", "r-tomb"]);
  });

  it("带上全部字典行与菜谱子行", async () => {
    await insertLabel(db, "c1");
    await db.execute("INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('t1','快手','tag',?,?,NULL)", [T0, T0]);
    await db.execute("INSERT INTO ingredients (id,name,created_at,updated_at,deleted_at) VALUES ('i1','盐',?,?,NULL)", [T0, T0]);
    await db.execute("INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('un1','克',?,?,NULL)", [T0, T0]);
    await insertRecipe(db, "r1", "u1");
    await db.execute(
      "INSERT INTO recipe_steps (id,recipe_id,sort_order,text,image_path,updated_at,deleted_at) VALUES ('s1','r1',0,'切',NULL,?,NULL)",
      [T0],
    );
    await db.execute(
      "INSERT INTO recipe_ingredients (id,recipe_id,ingredient_id,amount,unit_id,sort_order,updated_at,deleted_at) VALUES ('ri1','r1','i1',2,'un1',0,?,NULL)",
      [T0],
    );
    await db.execute("INSERT INTO recipe_labels (recipe_id,label_id) VALUES ('r1','t1')");

    const payload = await collectPushPayload();

    expect(payload.ingredients).toHaveLength(1);
    expect(payload.units).toHaveLength(1);
    expect(payload.labels.map((l) => l.id).sort()).toEqual(["c1", "t1"]);
    expect(payload.recipes[0].steps).toEqual([{ id: "s1", sort_order: 0, text: "切", image_path: null }]);
    expect(payload.recipes[0].ingredients).toEqual([
      { id: "ri1", ingredient_id: "i1", amount: 2, unit_id: "un1", sort_order: 0 },
    ]);
    expect(payload.recipes[0].label_ids).toEqual(["t1"]);
  });

  it("图片没传到位时只推字典，不推菜谱", async () => {
    await insertLabel(db);
    await insertRecipe(db, "r1", "u1");
    uploadMock.mockResolvedValue(false);
    apiFetchMock.mockResolvedValue(okResponse(1));

    await expect(performSync()).resolves.toBe(true);

    const body = JSON.parse(String(apiFetchMock.mock.calls[0][1]?.body));
    expect(body.local_changes.recipes).toEqual([]);
    expect(body.local_changes.labels).toHaveLength(1);
  });
});
