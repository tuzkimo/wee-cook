import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import {
  collectReferencedFileNames,
  downloadMissingFiles,
  uploadPendingFiles,
  type FileRef,
  type FileSyncDeps,
  type SyncPayload,
} from "@/services/syncFiles";

// 真网络层（api.ts）在这里整体换掉：本任务测的是「什么时候发请求、失败了写不写库」，
// 401/超时/单飞刷新是 api.ts 自己的测试范围。
vi.mock("@/services/api", () => ({
  hasBaseUrl: vi.fn(() => true),
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth, hasBaseUrl } from "@/services/api";

const hasBaseUrlMock = hasBaseUrl as unknown as ReturnType<typeof vi.fn>;
const fetchWithAuthMock = fetchWithAuth as unknown as ReturnType<typeof vi.fn>;

/** 造一个可断言的 Response 替身：只喂二进制通道用到的 `ok/status/arrayBuffer`。 */
function fileRes(status: number, bytes: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  } as unknown as Response;
}

/** 内存假文件系统：路径是相对 $APPDATA 的 `images/<name>`，与 imageStore 的约定一致。 */
interface FakeIo {
  deps: FileSyncDeps;
  store: Map<string, Uint8Array>;
  renames: { from: string; to: string }[];
  writePaths: string[];
}

function fakeIo(initial: Record<string, number[]> = {}): FakeIo {
  const store = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, bytes]) => [path, new Uint8Array(bytes)]),
  );
  const renames: { from: string; to: string }[] = [];
  const writePaths: string[] = [];
  const deps: FileSyncDeps = {
    readFile: async (path) => {
      const bytes = store.get(path);
      if (!bytes) throw new Error(`本地没有这个文件: ${path}`);
      return bytes;
    },
    exists: async (path) => store.has(path),
    writeFile: async (path, bytes) => {
      writePaths.push(path);
      store.set(path, bytes);
    },
    rename: async (from, to) => {
      renames.push({ from, to });
      const bytes = store.get(from);
      store.delete(from);
      if (bytes) store.set(to, bytes);
    },
  };
  return { deps, store, renames, writePaths };
}

function payload(...names: string[]): SyncPayload {
  return {
    recipes: names.map((name, i) => ({
      cover_path: i === 0 ? name : null,
      steps: i === 0 ? [] : [{ image_path: name }],
    })),
  };
}

async function freshDb(): Promise<Db> {
  const { db } = await freshTestDb();
  setDb(db);
  return db;
}

async function uploadedNames(db: Db): Promise<string[]> {
  const rows = await db.select<{ name: string }[]>("SELECT name FROM uploaded_files ORDER BY name");
  return rows.map((r) => r.name);
}

describe("collectReferencedFileNames", () => {
  it("collectReferencedFileNames 收集封面与步骤图，去重，跳过 null", () => {
    const changes: SyncPayload = {
      recipes: [
        { cover_path: "c1.jpg", steps: [{ image_path: "s1.jpg" }, { image_path: null }] },
        { cover_path: null, steps: [{ image_path: "s1.jpg" }, { image_path: "s2.jpg" }] },
        { cover_path: null, steps: [] },
      ],
    };

    expect(collectReferencedFileNames(changes)).toEqual(["c1.jpg", "s1.jpg", "s2.jpg"]);
  });
});

describe("uploadPendingFiles", () => {
  beforeEach(() => {
    hasBaseUrlMock.mockReturnValue(true);
    fetchWithAuthMock.mockReset();
  });

  it("已上传过的文件不再上传（uploaded_files 里有的跳过）", async () => {
    const db = await freshDb();
    await db.execute("INSERT INTO uploaded_files (name, uploaded_at) VALUES (?, ?)", [
      "done.jpg",
      "2020-01-01T00:00:00.000Z",
    ]);
    const io = fakeIo({ "images/done.jpg": [1], "images/new.jpg": [2] });
    fetchWithAuthMock.mockResolvedValue(fileRes(200, new Uint8Array([0])));

    const ok = await uploadPendingFiles(payload("done.jpg", "new.jpg"), io.deps);

    expect(ok).toBe(true);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock.mock.calls[0][0]).toBe("/api/v1/files?name=new.jpg");
  });

  it("上传成功写 uploaded_files", async () => {
    const db = await freshDb();
    const io = fakeIo({ "images/a.jpg": [0xff, 0xd8, 0xff] });
    fetchWithAuthMock.mockResolvedValue(fileRes(200, new Uint8Array([0])));

    const ok = await uploadPendingFiles(payload("a.jpg"), io.deps);

    expect(ok).toBe(true);
    expect(await uploadedNames(db)).toEqual(["a.jpg"]);
    const [url, init] = fetchWithAuthMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/files?name=${encodeURIComponent("a.jpg")}`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("image/jpeg");
    // body 是本地读出来的真字节
    expect(Array.from(init.body as Uint8Array)).toEqual([0xff, 0xd8, 0xff]);
    // 时间戳是 ISO 8601 UTC
    const row = await db.select<{ uploaded_at: string }[]>(
      "SELECT uploaded_at FROM uploaded_files WHERE name = ?",
      ["a.jpg"],
    );
    expect(row[0].uploaded_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("Review Focus ③：任何一张图上传失败 → 返回 false，且失败的那张不进 uploaded_files", async () => {
    const db = await freshDb();
    const io = fakeIo({ "images/bad.jpg": [1], "images/good.jpg": [2] });
    fetchWithAuthMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes("bad.jpg") ? fileRes(500, new Uint8Array()) : fileRes(200, new Uint8Array())),
    );

    const ok = await uploadPendingFiles(payload("bad.jpg", "good.jpg"), io.deps);

    expect(ok).toBe(false);
    // 批次里其它成功的照常记录；失败的留着下次重试
    expect(await uploadedNames(db)).toEqual(["good.jpg"]);
  });

  it("没有配置服务器地址时不发请求，返回 false", async () => {
    await freshDb();
    hasBaseUrlMock.mockReturnValue(false);
    const io = fakeIo({ "images/a.jpg": [1] });

    const ok = await uploadPendingFiles(payload("a.jpg"), io.deps);

    expect(ok).toBe(false);
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });
});

describe("downloadMissingFiles", () => {
  beforeEach(() => {
    hasBaseUrlMock.mockReturnValue(true);
    fetchWithAuthMock.mockReset();
  });

  it("下载时本地已存在的文件跳过，不发请求", async () => {
    const io = fakeIo({ "images/have.jpg": [1, 2, 3] });

    const result = await downloadMissingFiles([{ name: "have.jpg", size: 3 }], io.deps);

    expect(result).toEqual({ downloaded: 0, failed: 0 });
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it("Review Focus ④：404 的文件不再重试（本轮记为失败即可），不阻塞其它文件", async () => {
    const io = fakeIo();
    fetchWithAuthMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes("gone.jpg") ? fileRes(404, new Uint8Array()) : fileRes(200, new Uint8Array([7]))),
    );
    const refs: FileRef[] = [
      { name: "gone.jpg", size: 1 },
      { name: "ok.jpg", size: 1 },
    ];

    const result = await downloadMissingFiles(refs, io.deps);

    expect(result).toEqual({ downloaded: 1, failed: 1 });
    // 同一个 name 只发一次 GET（404 不再重试）
    expect(fetchWithAuthMock.mock.calls.filter((c) => (c[0] as string).includes("gone.jpg"))).toHaveLength(1);
    // 其余文件照常下载
    expect(io.store.get("images/ok.jpg")).toEqual(new Uint8Array([7]));
  });

  it("下载写入 $APPDATA/images/<name>，字节与响应一致", async () => {
    const io = fakeIo();
    fetchWithAuthMock.mockResolvedValue(fileRes(200, new Uint8Array([1, 2, 3])));

    const result = await downloadMissingFiles([{ name: "x.jpg", size: 3 }], io.deps);

    expect(result).toEqual({ downloaded: 1, failed: 0 });
    expect(fetchWithAuthMock.mock.calls[0][0]).toBe(`/api/v1/files/${encodeURIComponent("x.jpg")}`);
    expect(io.store.get("images/x.jpg")).toEqual(new Uint8Array([1, 2, 3]));
    // 先写临时名再改名：正式名只由 rename 产出，半截文件不会挂着正式名
    expect(io.writePaths).toEqual(["images/x.jpg.tmp"]);
    expect(io.renames).toEqual([{ from: "images/x.jpg.tmp", to: "images/x.jpg" }]);
    expect(io.store.has("images/x.jpg.tmp")).toBe(false);
  });
});
