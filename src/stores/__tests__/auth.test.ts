import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import * as api from "@/services/api";
import * as tokenStorage from "@/services/tokenStorage";
import { writeRefreshToken } from "@/services/tokenStorage";
import { useAuthStore } from "@/stores/auth";

const NOW = "2026-10-14T10:00:00.000Z";

let db: Db;

/** settingsFile 在非 Tauri 环境（测试）把值 JSON 序列化进 localStorage —— 测试按同一口径铺/读。 */
function seedSetting(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function storedSetting(key: string): unknown {
  const raw = localStorage.getItem(key);
  return raw === null ? undefined : JSON.parse(raw);
}

function user(id: string, overrides: Partial<api.User> = {}): api.User {
  return {
    id,
    username: id,
    nickname: `${id}的昵称`,
    avatar_url: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function authBody(u: api.User, access: string, refresh: string): unknown {
  return { user: u, access_token: access, refresh_token: refresh };
}

/** 只喂 `ok/status/statusText/json` 的 Response 替身（happy-dom 的 fetch 不参与）。 */
function res(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => payload,
  } as unknown as Response;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  api.clearTokens();
  // clearTokens 的「删落盘 refresh token」是 fire-and-forget，等它落定再清 localStorage，
  // 否则它可能把下一条用例刚铺好的 token 删掉。
  await new Promise((resolve) => setTimeout(resolve, 0));
  localStorage.clear();
  ({ db } = await freshTestDb());
  setDb(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authStore", () => {
  // 必须能在任何顺序下成立：判据是持久化的 server_url，而不是 api 模块里可能被上一条用例设过的地址。
  it("没有 server_url 时 isOnline 为 false 且不发任何请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = useAuthStore();

    await store.restoreSession();

    expect(store.isOnline).toBe(false);
    expect(store.mode).toBe("guest");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("登录成功后写入凭据与服务器地址", async () => {
    const fetchMock = stubFetch((url) => {
      expect(url).toBe("https://srv/api/v1/auth/login");
      return res(200, authBody(user("u1", { username: "alice", nickname: "阿丽" }), "access-1", "refresh-1"));
    });
    const store = useAuthStore();

    await store.login("https://srv", "alice", "pw");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.mode).toBe("online");
    expect(store.isOnline).toBe(true);
    expect(store.serverUser?.id).toBe("u1");
    expect(store.serverUserId).toBe("u1");
    expect(store.nickname).toBe("阿丽");
    expect(api.authTokenReady.value).toBe(true);
    // 地址与账号信息落 settings.json
    expect(storedSetting("server_url")).toBe("https://srv");
    expect(storedSetting("server_user_id")).toBe("u1");
    expect(storedSetting("server_username")).toBe("alice");
    expect(storedSetting("server_nickname")).toBe("阿丽");
    // refresh token 由 api 层按 user id 落 tokens.json（setTokens 是 fire-and-forget，等它落地）
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBe("refresh-1"));
  });

  it("登录失败不改动已有凭据", async () => {
    stubFetch(() => res(200, authBody(user("u1", { username: "alice" }), "access-1", "refresh-1")));
    const store = useAuthStore();
    await store.login("https://srv", "alice", "pw");
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBe("refresh-1"));

    // 换成 401（密码错）：账号或密码要报中文，且既有会话原封不动
    stubFetch(() => res(401, { error: "invalid username or password" }));

    await expect(store.login("https://other", "alice", "wrong")).rejects.toThrow("账号或密码不对");

    expect(api.authTokenReady.value).toBe(true);
    expect(localStorage.getItem("refresh_token:u1")).toBe("refresh-1");
    expect(storedSetting("server_url")).toBe("https://srv");
    expect(store.mode).toBe("online");
    expect(store.serverUser?.id).toBe("u1");
    // api 层的地址也还原，避免「未登录却指向新地址」的错配
    expect(api.getBaseUrl()).toBe("https://srv");
  });

  it("注册重名时提示用户名已被占用", async () => {
    stubFetch(() => res(409, { error: "username already taken" }));
    const store = useAuthStore();

    await expect(store.register("https://srv", "alice", "pw", "阿丽")).rejects.toThrow(
      "用户名已被占用",
    );
    expect(api.authTokenReady.value).toBe(false);
    expect(storedSetting("server_url")).toBeUndefined();
  });

  it("连不上服务器时提示网络问题，而不是报账号密码错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("NetworkError");
      }),
    );
    const store = useAuthStore();

    await expect(store.login("https://srv", "alice", "pw")).rejects.toThrow(
      "连不上服务器，检查地址和网络",
    );
  });

  it("冷启动 restoreSession 用 refresh token 换新 access", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    seedSetting("server_nickname", "旧昵称");
    await writeRefreshToken("u1", "refresh-old");

    const store = useAuthStore();
    const fetchMock = stubFetch((url, init) => {
      expect(url).toBe("https://srv/api/v1/auth/refresh");
      expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "refresh-old" });
      return res(200, authBody(user("u1", { nickname: "新昵称" }), "access-new", "refresh-new"));
    });

    await store.restoreSession();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.mode).toBe("online");
    expect(store.isOnline).toBe(true);
    expect(store.serverUser?.id).toBe("u1");
    expect(store.nickname).toBe("新昵称");
    expect(api.authTokenReady.value).toBe(true);
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBe("refresh-new"));
  });

  it("restoreSession 遇到服务不可达时进入 guest 态但不清本地数据与设置", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    seedSetting("server_username", "alice");
    seedSetting("server_nickname", "阿丽");
    await writeRefreshToken("u1", "refresh-1");
    await db.execute(
      "INSERT INTO labels (id, name, kind, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)",
      ["c1", "家常菜", "category", NOW, NOW],
    );
    await db.execute(
      "INSERT INTO recipes (id, name, cover_path, category_id, created_at, updated_at, deleted_at) VALUES (?, ?, NULL, ?, ?, ?, NULL)",
      ["r1", "红烧肉", "c1", NOW, NOW],
    );
    // 断网 / 超时：拿不到 HTTP 响应（apiFetch 契约里这种情况一律抛）
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("请求超时");
      }),
    );

    const store = useAuthStore();
    await store.restoreSession();

    expect(store.mode).toBe("guest");
    expect(store.isOnline).toBe(false);
    // 设置与凭据都保留：只是这次没连上，不是凭据失效
    expect(storedSetting("server_url")).toBe("https://srv");
    expect(storedSetting("server_user_id")).toBe("u1");
    expect(storedSetting("server_username")).toBe("alice");
    expect(storedSetting("server_nickname")).toBe("阿丽");
    expect(localStorage.getItem("refresh_token:u1")).toBe("refresh-1");
    // 本地菜谱一条不少
    const recipes = await db.select<{ id: string }[]>("SELECT id FROM recipes");
    expect(recipes.map((row) => row.id)).toEqual(["r1"]);
  });

  it("restoreSession 服务端答 401 时清掉失效的 refresh token", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    await writeRefreshToken("u1", "refresh-dead");
    stubFetch(() => res(401, { error: "invalid or expired refresh token" }));

    const store = useAuthStore();
    await store.restoreSession();

    expect(store.mode).toBe("guest");
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBeNull());
    // 地址留着，下次登录不用重填
    expect(storedSetting("server_url")).toBe("https://srv");
  });

  it("logout 清掉凭据但保留 server_url（下次登录不用重填）", async () => {
    stubFetch(() => res(200, authBody(user("u1", { username: "alice" }), "access-1", "refresh-1")));
    const store = useAuthStore();
    await store.login("https://srv", "alice", "pw");
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBe("refresh-1"));

    await store.logout();

    expect(store.mode).toBe("guest");
    expect(store.isOnline).toBe(false);
    expect(store.serverUser).toBeNull();
    expect(api.authTokenReady.value).toBe(false);
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBeNull());
    // 地址保留，账号信息也留着做下次登录的默认值
    expect(storedSetting("server_url")).toBe("https://srv");
    expect(storedSetting("server_username")).toBe("alice");
  });

  it("logout 期间在途的 refresh 回来不得把已退出的会话写回", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    await writeRefreshToken("u1", "refresh-1");

    let releaseRefresh!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return res(200, authBody(user("u1"), "access-new", "refresh-new"));
      }),
    );

    const store = useAuthStore();
    const pending = store.restoreSession();
    // 让 restoreSession 走到 await refreshSession 之后再退登
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.logout();
    releaseRefresh();
    await pending;

    expect(store.mode).toBe("guest");
    expect(api.authTokenReady.value).toBe(false);
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBeNull());
  });

  it("在读设置/读 token 阶段退登：不再发 refresh，api 也不留凭据", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    seedSetting("server_nickname", "阿丽");
    await writeRefreshToken("u1", "refresh-1");

    // 服务端在途答什么都行：这条用例要断言的是「根本没发这次请求」
    const fetchMock = stubFetch(() =>
      res(200, authBody(user("u1"), "access-new", "refresh-new")),
    );

    // 把「读 refresh token」停在一个可控 promise 上，制造出「读设置 / 读 token 阶段」这个窗口
    let releaseRead!: (value: string | null) => void;
    const readGate = new Promise<string | null>((resolve) => {
      releaseRead = resolve;
    });
    const readSpy = vi.spyOn(tokenStorage, "readRefreshToken").mockReturnValueOnce(readGate);

    const store = useAuthStore();
    const pending = store.restoreSession();
    await vi.waitFor(() => expect(readSpy).toHaveBeenCalledWith("u1"));
    // 还在读 token 时就退登：这时 api 的世代已经是退登之后的
    await store.logout();
    releaseRead("refresh-1");
    await pending;

    // 否则 refreshSession 会把 u1 的凭据写回 api 内存与磁盘，出现「store 是 guest、api 却有凭据」
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.mode).toBe("guest");
    expect(store.isOnline).toBe(false);
    expect(api.authTokenReady.value).toBe(false);
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBeNull());
  });

  it("并发调两次 restoreSession 只发一次 refresh，后到的 401 不会把会话清掉", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    await writeRefreshToken("u1", "refresh-1");

    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      calls++;
      await gate;
      // 服务端轮换 / 一次性 refresh token：第二次拿同一个 token 换会 401
      return calls === 1
        ? res(200, authBody(user("u1"), "access-new", "refresh-new"))
        : res(401, { error: "invalid or expired refresh token" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = useAuthStore();
    const first = store.restoreSession();
    const second = store.restoreSession();
    release();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.mode).toBe("online");
    expect(api.authTokenReady.value).toBe(true);
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBe("refresh-new"));
  });

  it("在途恢复会话期间换号登录：新账号的凭据不被清掉", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    await writeRefreshToken("u1", "refresh-1");

    let releaseRefresh!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        // 在途的 refresh 答的是旧账号 u1（服务端确实会回它）
        if (url.endsWith("/api/v1/auth/refresh")) {
          return gate.then(() => res(200, authBody(user("u1"), "access-a2", "refresh-a2")));
        }
        return Promise.resolve(res(200, authBody(user("u2", { username: "bob" }), "access-b", "refresh-b")));
      }),
    );

    const store = useAuthStore();
    const pending = store.restoreSession();
    // 让 restoreSession 走到 await refreshSession 之后再换号
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.login("https://srv", "bob", "pw");
    releaseRefresh();
    await pending;

    expect(store.mode).toBe("online");
    expect(store.serverUser?.id).toBe("u2");
    // 旧会话的响应不得把刚登录的新账号清成「无凭据」（否则 T8 的同步会挂空）
    expect(api.authTokenReady.value).toBe(true);
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u2")).toBe("refresh-b"));
  });

  it("notifySyncComplete 记录上次同步时间并复位失败标记", async () => {
    const store = useAuthStore();
    store.lastSyncFailed = true;

    store.notifySyncComplete();

    expect(store.lastSyncFailed).toBe(false);
    expect(store.lastSyncedTime).not.toBeNull();
  });
});
