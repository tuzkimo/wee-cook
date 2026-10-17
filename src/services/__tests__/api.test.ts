import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  authTokenReady,
  baseUrlReady,
  clearTokens,
  fetchWithAuth,
  getBaseUrl,
  hasBaseUrl,
  refreshSession,
  setBaseUrl,
  setTokens,
} from "@/services/api";
import { writeRefreshToken } from "@/services/tokenStorage";

/** 造一个可断言的 Response 替身：happy-dom 的 fetch 未被用到，这里只喂 `ok/status/statusText/json`。 */
function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as unknown as Response;
}

/** 模拟真实 fetch 的 abort 行为：只在 signal 触发时 reject，否则永久 pending。 */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

/** 手动控制何时 resolve：用来制造「refresh 请求在飞」的窗口。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("apiFetch", () => {
  beforeEach(() => {
    localStorage.clear();
    clearTokens();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ⚠️ 必须是本文件第一条：baseUrl 只有 setBaseUrl 没有"清空"，模块级状态在本文件内不复位。
  it("没有配置地址时直接抛错，不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(hasBaseUrl()).toBe(false);
    expect(baseUrlReady.value).toBe(false);
    await expect(apiFetch("/api/v1/me")).rejects.toThrow("API base URL not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("baseUrl 去掉末尾斜杠", () => {
    setBaseUrl("http://x:8080///");

    expect(getBaseUrl()).toBe("http://x:8080");
    expect(hasBaseUrl()).toBe(true);
    expect(baseUrlReady.value).toBe(true);
  });

  it("带 Authorization 头发请求并解析 JSON", async () => {
    setBaseUrl("http://x:8080");
    setTokens("u1", "access-1", "refresh-1");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => res(200, { user: { id: "u1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiFetch<{ user: { id: string } }>("/api/v1/me");

    expect(result).toEqual({ ok: true, status: 200, data: { user: { id: "u1" } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x:8080/api/v1/me");
    expect(headerOf(init, "Authorization")).toBe("Bearer access-1");
  });

  it("fetchWithAuth 返回原始响应：带 Authorization 且不解析 body（二进制通道用）", async () => {
    setBaseUrl("http://x:8080");
    setTokens("u1", "access-1", "refresh-1");
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
      json: async () => {
        throw new Error("二进制响应不该被 JSON 解析");
      },
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWithAuth("/api/v1/files/x.jpg");

    expect(result.status).toBe(200);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x:8080/api/v1/files/x.jpg");
    expect(headerOf(init, "Authorization")).toBe("Bearer access-1");
  });

  it("401 时只发一次 refresh（三个并发 401 共享同一次 refresh）", async () => {
    setBaseUrl("http://x:8080");
    setTokens("u1", "access-old", "refresh-1");
    // setTokens 的落盘是 fire-and-forget，这里显式等它落地，让 refresh 分支读到确定的值
    await writeRefreshToken("u1", "refresh-1");

    let refreshCalls = 0;
    const seenAuth: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/v1/auth/refresh")) {
          refreshCalls++;
          return res(200, {
            user: { id: "u1" },
            access_token: "access-new",
            refresh_token: "refresh-2",
          });
        }
        const auth = headerOf(init, "Authorization");
        seenAuth.push(auth);
        // 旧 access 一律 401；换成新 access 后放行
        return auth === "Bearer access-new" ? res(200, { user: { id: "u1" } }) : res(401, { error: "unauthorized" });
      }),
    );

    const results = await Promise.all([
      apiFetch("/api/v1/me"),
      apiFetch("/api/v1/me"),
      apiFetch("/api/v1/me"),
    ]);

    expect(refreshCalls).toBe(1);
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    // 三次重试都换了新 access token（而不是各自刷新出三份并发结果）
    expect(seenAuth.filter((a) => a === "Bearer access-new")).toHaveLength(3);
  });

  it("refresh 也失败时清空凭据并返回 401", async () => {
    setBaseUrl("http://x:8080");
    setTokens("u1", "access-old", "refresh-1");
    await writeRefreshToken("u1", "refresh-1");

    let refreshCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/v1/auth/refresh")) {
          refreshCalls++;
          return res(401, { error: "invalid or expired refresh token" });
        }
        return res(401, { error: "unauthorized" });
      }),
    );

    await expect(apiFetch("/api/v1/me")).resolves.toEqual({
      ok: false,
      status: 401,
      error: "unauthorized",
    });
    expect(refreshCalls).toBe(1);
    expect(authTokenReady.value).toBe(false);
    // 落盘的凭据也要清掉，否则下次冷启动会拿一个已被服务端拒绝的 refresh token 再去换
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBeNull());
  });

  it("refresh 拿不到响应（超时 / 断网）时保留凭据，不清空", async () => {
    setBaseUrl("http://x:8080");
    setTokens("u1", "access-old", "refresh-1");
    await writeRefreshToken("u1", "refresh-1");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // 本文件约定：拿不到 HTTP 响应（超时 / 断网）就抛。这**不等于** refresh token 失效。
        if (url.endsWith("/api/v1/auth/refresh")) throw new Error("请求超时");
        return res(401, { error: "unauthorized" });
      }),
    );

    await expect(apiFetch("/api/v1/me")).resolves.toEqual({
      ok: false,
      status: 401,
      error: "unauthorized",
    });

    // 移动端网络抖动是常态：留着 refresh token，下次冷启动才能自动恢复会话
    expect(authTokenReady.value).toBe(true);
    expect(localStorage.getItem("refresh_token:u1")).toBe("refresh-1");
  });

  it("refresh 在途时退登，返回后不得写回凭据", async () => {
    setBaseUrl("http://x:8080");
    setTokens("u1", "access-old", "refresh-1");
    await writeRefreshToken("u1", "refresh-1");

    const gate = deferred<Response>();
    let refreshStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/api/v1/auth/refresh")) {
          refreshStarted = true;
          return gate.promise;
        }
        return Promise.resolve(res(401, { error: "unauthorized" }));
      }),
    );

    const pending = apiFetch("/api/v1/me");
    await vi.waitFor(() => expect(refreshStarted).toBe(true));

    // 用户在 refresh 在途时点了退登
    clearTokens();
    gate.resolve(res(200, { user: { id: "u1" }, access_token: "access-new", refresh_token: "refresh-2" }));
    await pending;

    // 否则磁盘上凭据还在，用户以为已退出，下次冷启动又自动登回去
    expect(authTokenReady.value).toBe(false);
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u1")).toBeNull());
  });

  it("refresh 在途时换号登录，返回后不得把 A 的凭据写成 B 的", async () => {
    setBaseUrl("http://x:8080");
    setTokens("u1", "access-old", "refresh-1");
    await writeRefreshToken("u1", "refresh-1");

    const gate = deferred<Response>();
    let refreshStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/api/v1/auth/refresh")) {
          refreshStarted = true;
          return gate.promise;
        }
        return Promise.resolve(res(401, { error: "unauthorized" }));
      }),
    );

    const pending = apiFetch("/api/v1/me");
    await vi.waitFor(() => expect(refreshStarted).toBe(true));

    // A 的 401 触发 refresh 期间，用户退登并以 B 身份登录
    clearTokens();
    setTokens("u2", "access-b", "refresh-b");
    gate.resolve(res(200, { user: { id: "u1" }, access_token: "access-a2", refresh_token: "refresh-a2" }));
    await pending;

    // A 的 refresh 响应不得覆盖成 A 的凭据（串号）
    expect(authTokenReady.value).toBe(true);
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u2")).toBe("refresh-b"));
    expect(localStorage.getItem("refresh_token:u1")).toBeNull();
  });

  it("超时 15 秒后 abort 并抛出", async () => {
    vi.useFakeTimers();
    setBaseUrl("http://x:8080");
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const settled = apiFetch("/api/v1/me").then(
      () => "resolved",
      (e: unknown) => e,
    );

    // 还没到 15s：请求仍在飞，没有 abort
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15000);

    // 判别力在这条**同步**断言上：没有它，"忘了 abort"的变异只会让请求一直挂着，
    // 表现为 5s 的通用测试超时而非本用例的失败。
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);

    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("请求超时");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("第三参数换掉默认 15s：AI 这类长任务按调用方给的时间撒手", async () => {
    vi.useFakeTimers();
    setBaseUrl("http://x:8080");
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const settled = apiFetch("/api/v1/ai/chat", { method: "POST" }, 150_000).then(
      () => "resolved",
      (e: unknown) => e,
    );

    await vi.advanceTimersByTimeAsync(15000);
    // 默认值不生效：后端还在等上游，客户端不能先撒手
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(135_000);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
    expect(((await settled) as Error).message).toBe("请求超时");
  });

  it("服务端 500 时不抛异常，返回 {ok:false,status:500}", async () => {
    setBaseUrl("http://x:8080");
    vi.stubGlobal("fetch", vi.fn(async () => res(500, { error: "internal error" })));

    await expect(apiFetch("/api/v1/me")).resolves.toEqual({
      ok: false,
      status: 500,
      error: "internal error",
    });
  });
});

describe("refreshSession", () => {
  beforeEach(() => {
    localStorage.clear();
    clearTokens();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("在途期间换号登录：返回后不用旧凭据覆盖新会话", async () => {
    setBaseUrl("http://x:8080");
    setTokens("u1", "access-a", "refresh-a");
    await writeRefreshToken("u1", "refresh-a");

    const gate = deferred<Response>();
    const authHeaders: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        authHeaders.push(headerOf(init, "Authorization"));
        return gate.promise;
      }),
    );

    const pending = refreshSession("refresh-a");
    // A 的 refresh 在途时用户退登并以 B 身份登录
    clearTokens();
    setTokens("u2", "access-b", "refresh-b");
    gate.resolve(res(200, { user: { id: "u1" }, access_token: "access-a2", refresh_token: "refresh-a2" }));

    await pending;
    await apiFetch("/api/v1/me");

    // 内存里仍是 B 的 access（旧响应没有覆盖它），也没被清掉
    expect(authHeaders[1]).toBe("Bearer access-b");
    expect(authTokenReady.value).toBe(true);
    await vi.waitFor(() => expect(localStorage.getItem("refresh_token:u2")).toBe("refresh-b"));
  });
});
