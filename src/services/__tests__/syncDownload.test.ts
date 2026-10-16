// I3 端到端：待下载图集合按 uid 落盘并在下一轮同步重试。
// 本文件用**真** sync + 真 syncFiles（只把网络层与 auth store 换成替身），
// 文件 IO 通过 syncFiles 的 setFileSyncDeps 注入内存假文件系统。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDb } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";

const authState = vi.hoisted(() => ({ serverUserId: "u1" as string | null }));

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
  fetchWithAuth: vi.fn(),
  authTokenReady: { value: true },
}));

import { apiFetch } from "@/services/api";
import { emptyPayload, performSync } from "@/services/sync";
import { fetchWithAuth } from "@/services/api";
import { setFileSyncDeps, type FileSyncDeps } from "@/services/syncFiles";

const apiFetchMock = vi.mocked(apiFetch);
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

/** 只喂二进制通道用到的 `ok/status/arrayBuffer`。 */
function fileRes(status: number, bytes: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  } as unknown as Response;
}

type OkResult = {
  ok: true;
  status: number;
  data: { server_seq: number; remote_changes: ReturnType<typeof emptyPayload> };
};

/** 一次成功的 /sync 响应，`files` 只列这些名字（服务端行为：只带本批菜谱引用的图）。 */
function okWithFiles(seq: number, names: string[]): OkResult {
  return {
    ok: true,
    status: 200,
    data: {
      server_seq: seq,
      remote_changes: {
        ...emptyPayload(),
        files: names.map((name) => ({ name, size: 1 })),
      },
    },
  };
}

/** 内存假文件系统：只实现 downloadOne 用到的 exists/writeFile/rename。 */
function fakeIo(): { deps: FileSyncDeps; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    deps: {
      readFile: async () => new Uint8Array(),
      exists: async (path) => store.has(path),
      writeFile: async (path, bytes) => {
        store.set(path, bytes);
      },
      rename: async (from, to) => {
        const bytes = store.get(from);
        store.delete(from);
        if (bytes) store.set(to, bytes);
      },
    },
  };
}

beforeEach(async () => {
  localStorage.clear();
  setDb((await freshTestDb()).db);
  vi.clearAllMocks();
  authState.serverUserId = "dl-transient";
});

afterEach(() => {
  setFileSyncDeps(null);
  authState.serverUserId = "u1";
});

describe("待下载图集合（I3）", () => {
  it("瞬时失败的下载会在下次同步重试，成功即从集合移除", async () => {
    const io = fakeIo();
    setFileSyncDeps(io.deps);
    // 第一次下载断网
    fetchWithAuthMock.mockRejectedValue(new Error("断网"));
    apiFetchMock.mockResolvedValue(okWithFiles(1, ["a.jpg"]));

    await expect(performSync()).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem("pending_files:dl-transient") as string)).toEqual([
        "a.jpg",
      ]),
    );

    // 下一次同步：远端不再下发该文件，但集合里有它 → 再试一次，成功
    fetchWithAuthMock.mockResolvedValue(fileRes(200, new Uint8Array([1, 2])));
    apiFetchMock.mockResolvedValue(okWithFiles(2, []));

    await expect(performSync()).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(localStorage.getItem("pending_files:dl-transient")).toBeNull(),
    );
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    expect(io.store.get("images/a.jpg")).toEqual(new Uint8Array([1, 2]));
  });

  it("404 的下载从集合移除，下一轮不再发 GET", async () => {
    const io = fakeIo();
    setFileSyncDeps(io.deps);
    fetchWithAuthMock.mockResolvedValue(fileRes(404, new Uint8Array()));
    apiFetchMock.mockResolvedValue(okWithFiles(1, ["gone.jpg"]));

    await expect(performSync()).resolves.toBe(true);
    await vi.waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    // 404 是服务端明确说没有：立刻放弃，不留在集合里每轮刷屏
    expect(localStorage.getItem("pending_files:dl-transient")).toBeNull();

    apiFetchMock.mockResolvedValue(okWithFiles(2, []));
    await expect(performSync()).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
});
