// 分享收件箱（`<cacheDir>/share-inbox/`）的拉取与消费契约。
//
// ⚠️ 本模块有**模块级内存状态**（`consumedRaw` 去重、`inFlight` 单飞），所以：
//  - 每份 `pending.json` 原文都要**唯一**（文件名带自增序号）—— 复用同一份原文会被去重规则
//    合法地跳过，用例会假红；
//  - 用例之间串行（默认），不要用 `it.concurrent`。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MSG_MULTIPLE_TAKEN,
  MSG_NO_STREAM,
  MSG_READ_FAILED,
  MSG_TOO_LARGE,
  MSG_UNSUPPORTED,
} from "@/services/ai/attachText";
import type { Screenshot, ScreenshotResult } from "@/services/ai/image";
import {
  intakeShare,
  parsePending,
  realDeps,
  startShareIntake,
  type PendingPayload,
  type ShareIntakeDeps,
} from "@/services/ai/shareIntake";

// 生产依赖（realDeps）只碰这三个函数：inbox 的读写删全部走 AppCache。
const fs = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  readFile: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppCache: 16 },
  readTextFile: fs.readTextFile,
  readFile: fs.readFile,
  remove: fs.remove,
}));

const SHOT: Screenshot = {
  segments: ["data:image/jpeg;base64,QUFB"],
  cover: "data:image/jpeg;base64,QUFB",
  coverBytes: new Uint8Array([1, 2, 3]),
  width: 10,
  height: 10,
};

/** 每次调用生成**唯一**的原文（见文件头：模块级去重按原文比） */
let seq = 0;
function imageRaw(file = `f-${(seq += 1)}.bin`, count = 1): string {
  return JSON.stringify({ v: 1, kind: "image", file, count });
}
function errorRaw(code: string): string {
  seq += 1;
  return JSON.stringify({ v: 1, kind: "error", code, id: `e-${seq}` });
}

function harness(overrides: Partial<ShareIntakeDeps> = {}) {
  const calls = {
    readPending: 0,
    readBytes: [] as string[],
    consume: [] as (PendingPayload | null)[],
    /** 每次消费带上来的原文：实现方靠它做 compare-and-delete（「盘上还是这一份吗」） */
    consumeRaws: [] as string[],
    attached: [] as Screenshot[],
    notices: [] as string[],
    pushAi: 0,
  };
  const deps: ShareIntakeDeps = {
    readPending: async () => null,
    readBytes: async (file) => {
      calls.readBytes.push(file);
      return new Uint8Array([1, 2, 3]);
    },
    consume: async (payload, raw) => {
      calls.consume.push(payload);
      calls.consumeRaws.push(raw);
    },
    toScreenshot: async (): Promise<ScreenshotResult> => ({ ok: true, shot: SHOT }),
    setAttachment: (shot) => {
      calls.attached.push(shot);
    },
    setNotice: (text) => {
      calls.notices.push(text);
    },
    pushAi: () => {
      calls.pushAi += 1;
    },
    ...overrides,
  };
  // 覆写 readPending 的用例也要被计数（"单飞只读一次"靠它断言）
  const readPending = deps.readPending;
  deps.readPending = async () => {
    calls.readPending += 1;
    return readPending();
  };
  return { deps, calls };
}

function setTauri(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

beforeEach(() => {
  vi.restoreAllMocks();
  fs.readTextFile.mockReset();
  fs.readFile.mockReset();
  fs.remove.mockReset();
});

afterEach(() => {
  setTauri(false);
});

describe("parsePending：形状与版本", () => {
  it("认 image（count 缺省/非法都当 1）", () => {
    expect(parsePending('{"v":1,"kind":"image","file":"a.bin","count":2}')).toEqual({
      v: 1,
      kind: "image",
      file: "a.bin",
      count: 2,
    });
    expect(parsePending('{"v":1,"kind":"image","file":"a.bin"}')).toEqual({
      v: 1,
      kind: "image",
      file: "a.bin",
      count: 1,
    });
    expect(parsePending('{"v":1,"kind":"image","file":"a.bin","count":"2"}')).toEqual({
      v: 1,
      kind: "image",
      file: "a.bin",
      count: 1,
    });
  });

  it("认三个 error code", () => {
    expect(parsePending('{"v":1,"kind":"error","code":"no_stream"}')).toEqual({
      v: 1,
      kind: "error",
      code: "no_stream",
    });
  });

  it("坏 JSON / 非对象 / 版本不是 1 / 未知 kind / 未知 code / 原型链键 / file 空 ⇒ null", () => {
    expect(parsePending("not json")).toBeNull();
    expect(parsePending("null")).toBeNull();
    expect(parsePending('"x"')).toBeNull();
    expect(parsePending('{"v":2,"kind":"image","file":"a.bin","count":1}')).toBeNull();
    expect(parsePending('{"kind":"image","file":"a.bin"}')).toBeNull();
    expect(parsePending('{"v":1,"kind":"video","file":"a.bin"}')).toBeNull();
    expect(parsePending('{"v":1,"kind":"error","code":"boom"}')).toBeNull();
    // 原型链上的键**不是**合法 code：`code in ERROR_CODES` 会把它们判成合法
    expect(parsePending('{"v":1,"kind":"error","code":"constructor"}')).toBeNull();
    expect(parsePending('{"v":1,"kind":"error","code":"toString"}')).toBeNull();
    expect(parsePending('{"v":1,"kind":"image","file":""}')).toBeNull();
  });

  it("只挑已知键：多出来的 id / mime 不影响结果", () => {
    expect(parsePending('{"v":1,"kind":"image","file":"a.bin","count":1,"mime":"image/gif"}')).toEqual({
      v: 1,
      kind: "image",
      file: "a.bin",
      count: 1,
    });
    expect(parsePending('{"v":1,"kind":"error","code":"no_stream","id":"x"}')).toEqual({
      v: 1,
      kind: "error",
      code: "no_stream",
    });
  });
});

describe("intakeShare：没有待消费的分享", () => {
  it("无 pending ⇒ none，且一个副作用都没有", async () => {
    const { deps, calls } = harness();
    await expect(intakeShare(deps)).resolves.toBe("none");
    expect(calls.readBytes).toEqual([]);
    expect(calls.consume).toEqual([]);
    expect(calls.attached).toEqual([]);
    expect(calls.notices).toEqual([]);
    expect(calls.pushAi).toBe(0);
  });

  it("读 pending.json 抛 ⇒ failed + 读失败文案 + 消费出口转一圈（但一个文件都没删）+ 跳 AI 页", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, calls } = harness({
      readPending: async () => {
        throw new Error("fs down");
      },
    });
    await expect(intakeShare(deps)).resolves.toBe("failed");
    // 读不到 ≠ 这次没有分享：不静默。文案与消费都走统一出口；没有原文可比 ⇒ consume 传空串，
    // 真实的 compare-and-delete 必然不匹配 ⇒ 盘上一个文件都不删。
    expect(calls.notices).toEqual([MSG_READ_FAILED]);
    expect(calls.consume).toEqual([null]);
    expect(calls.consumeRaws).toEqual([""]);
    expect(calls.pushAi).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("intakeShare：成功路径", () => {
  it("image ⇒ 附加 + 消费 + 跳 AI 页；consume 收到解析后的 payload 与原文", async () => {
    const raw = imageRaw();
    const { deps, calls } = harness({ readPending: async () => raw });
    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.attached).toEqual([SHOT]);
    expect(calls.pushAi).toBe(1);
    expect(calls.consume).toEqual([JSON.parse(raw)]);
    // 成功路径**一律写**通知：单图写空串（= 清掉上一次的「已用第一张」），不是什么都不写
    expect(calls.notices).toEqual([""]);
    // 字节是拿 payload 里的文件名去读的
    expect(calls.readBytes).toEqual([JSON.parse(raw).file]);
  });

  it("count > 1 ⇒ 附件照附，notice 逐字 = MSG_MULTIPLE_TAKEN", async () => {
    const { deps, calls } = harness({ readPending: async () => imageRaw(undefined, 3) });
    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.attached).toEqual([SHOT]);
    expect(calls.notices).toEqual([MSG_MULTIPLE_TAKEN]);
  });

  it("上一次的多图提示会被下一次单图成功清掉", async () => {
    let raw = imageRaw(undefined, 3);
    const { deps, calls } = harness({ readPending: async () => raw });
    await expect(intakeShare(deps)).resolves.toBe("attached");
    raw = imageRaw(undefined, 1);
    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.notices).toEqual([MSG_MULTIPLE_TAKEN, ""]);
  });
});

describe("intakeShare：失败路径（都要消费 + 跳 AI 页，否则用户什么都看不到）", () => {
  it("读字节失败 ⇒ 读不到文案 + 消费 + 跳页", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = imageRaw();
    const { deps, calls } = harness({
      readPending: async () => raw,
      readBytes: async () => {
        throw new Error("gone");
      },
    });
    await expect(intakeShare(deps)).resolves.toBe("failed");
    expect(calls.notices).toEqual([MSG_READ_FAILED]);
    expect(calls.consume).toEqual([JSON.parse(raw)]);
    expect(calls.attached).toEqual([]);
    expect(calls.pushAi).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("截图失败（魔数拒 / 太大 / 解不开）⇒ 用 toScreenshot 给的那句话", async () => {
    for (const message of [MSG_UNSUPPORTED, MSG_TOO_LARGE]) {
      const { deps, calls } = harness({
        readPending: async () => imageRaw(),
        toScreenshot: async () => ({ ok: false, message }),
      });
      await expect(intakeShare(deps)).resolves.toBe("failed");
      expect(calls.notices).toEqual([message]);
      expect(calls.consume).toHaveLength(1);
      expect(calls.attached).toEqual([]);
      expect(calls.pushAi).toBe(1);
    }
  });

  it("三个 error code ⇒ 各自文案 + 消费（consume 收到 error payload）", async () => {
    const cases = [
      ["no_stream", MSG_NO_STREAM],
      ["read_failed", MSG_READ_FAILED],
      ["source_too_large", MSG_TOO_LARGE],
    ] as const;
    for (const [code, message] of cases) {
      const raw = errorRaw(code);
      const { deps, calls } = harness({ readPending: async () => raw });
      await expect(intakeShare(deps)).resolves.toBe("failed");
      expect(calls.notices).toEqual([message]);
      expect(calls.consume).toEqual([{ v: 1, kind: "error", code }]);
      expect(calls.consumeRaws).toEqual([raw]);
      expect(calls.pushAi).toBe(1);
    }
  });

  it("坏 JSON / v:2 / 未知 kind ⇒ 按 read_failed 处理并消费；紧接第二次是 none（防死循环）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const raw of ["not json", '{"v":2,"kind":"image","file":"a.bin"}', '{"v":1,"kind":"video"}']) {
      warn.mockClear();
      const { deps, calls } = harness({ readPending: async () => raw });
      await expect(intakeShare(deps)).resolves.toBe("failed");
      expect(calls.notices).toEqual([MSG_READ_FAILED]);
      expect(calls.consume).toEqual([null]);
      expect(calls.consumeRaws).toEqual([raw]);
      expect(calls.pushAi).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);

      await expect(intakeShare(deps)).resolves.toBe("none");
      expect(calls.notices).toHaveLength(1);
      expect(calls.consume).toHaveLength(1);
      expect(calls.pushAi).toBe(1);
    }
  });

  it("file 不是 inbox 里的普通 .bin ⇒ 不读字节、只消费 payload、报读失败（绝不按它删东西）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const file of ["../../etc/passwd", "a/b.bin", "C:\\x.bin", "a.txt"]) {
      const raw = imageRaw(file);
      const { deps, calls } = harness({ readPending: async () => raw });
      await expect(intakeShare(deps)).resolves.toBe("failed");
      expect(calls.readBytes).toEqual([]);
      expect(calls.notices).toEqual([MSG_READ_FAILED]);
      // payload 传 null：实现方只删 pending.json，不会碰任何 file
      expect(calls.consume).toEqual([null]);
      expect(calls.pushAi).toBe(1);
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("console.warn 不吐分享源的 URI / 路径", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const uri = "content://com.android.providers.media.documents/document/image%3A42";
    const { deps } = harness({
      readPending: async () => imageRaw(),
      readBytes: async () => {
        throw new Error(uri);
      },
    });
    await expect(intakeShare(deps)).resolves.toBe("failed");
    const logged = warn.mock.calls.flat().map((arg) => String(arg)).join(" ");
    expect(logged).not.toContain("content://");
  });
});

describe("intakeShare：去重与单飞", () => {
  it("同一份原文不重复处理（模块内去重）", async () => {
    const raw = imageRaw();
    const { deps, calls } = harness({ readPending: async () => raw });
    await expect(intakeShare(deps)).resolves.toBe("attached");
    await expect(intakeShare(deps)).resolves.toBe("none");
    expect(calls.attached).toHaveLength(1);
    expect(calls.consume).toHaveLength(1);
  });

  it("consume 抛错 ⇒ console.warn，仍按成功返回；同一份原文再来一次 ⇒ none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = imageRaw();
    const { deps, calls } = harness({
      readPending: async () => raw,
      consume: async () => {
        throw new Error("delete failed");
      },
    });
    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.attached).toHaveLength(1);
    expect(calls.pushAi).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);

    await expect(intakeShare(deps)).resolves.toBe("none");
    expect(calls.attached).toHaveLength(1);
  });

  it("单飞：并发两次 ⇒ readPending 只走一次", async () => {
    const raw = imageRaw();
    const { deps, calls } = harness({ readPending: async () => raw });
    const [a, b] = await Promise.all([intakeShare(deps), intakeShare(deps)]);
    expect([a, b]).toEqual(["attached", "attached"]);
    expect(calls.readPending).toBe(1);
    expect(calls.attached).toHaveLength(1);
  });
});

describe("realDeps：上盘口径（mock plugin-fs）", () => {
  const CACHE = { baseDir: 16 };

  beforeEach(() => {
    setTauri(true);
    fs.remove.mockResolvedValue(undefined);
    fs.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  });

  it("readPending：不存在 ⇒ null；其它错误 ⇒ 抛（否则与「这次没有分享」不可区分）", async () => {
    fs.readTextFile.mockRejectedValueOnce(new Error("failed to read file: os error 2"));
    await expect(realDeps.readPending()).resolves.toBeNull();
    expect(fs.readTextFile).toHaveBeenCalledWith("share-inbox/pending.json", CACHE);

    fs.readTextFile.mockRejectedValueOnce(new Error("forbidden path"));
    await expect(realDeps.readPending()).rejects.toThrow("forbidden path");
  });

  it("readBytes：路径落在 share-inbox 下，baseDir = AppCache", async () => {
    await expect(realDeps.readBytes("a.bin")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(fs.readFile).toHaveBeenCalledWith("share-inbox/a.bin", CACHE);
  });

  it("consume：盘上还是那一份 ⇒ 先删 pending.json，再删图", async () => {
    const raw = imageRaw("a.bin");
    fs.readTextFile.mockResolvedValue(raw);
    await realDeps.consume(JSON.parse(raw) as PendingPayload, raw);
    expect(fs.remove.mock.calls).toEqual([
      ["share-inbox/pending.json", CACHE],
      ["share-inbox/a.bin", CACHE],
    ]);
  });

  it("consume：盘上换了新的一份 ⇒ 一个文件都不删", async () => {
    const raw = imageRaw("a.bin");
    fs.readTextFile.mockResolvedValue(imageRaw("b.bin"));
    await realDeps.consume(JSON.parse(raw) as PendingPayload, raw);
    expect(fs.remove).not.toHaveBeenCalled();
  });

  it("consume：复核读失败 ⇒ 一个文件都不删，也不抛", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = imageRaw("a.bin");
    fs.readTextFile.mockRejectedValue(new Error("fs down"));
    await expect(realDeps.consume(JSON.parse(raw) as PendingPayload, raw)).resolves.toBeUndefined();
    expect(fs.remove).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("consume：file 不是普通 .bin ⇒ 只删 pending.json（路径穿越一律不删）", async () => {
    const raw = imageRaw("a.bin");
    fs.readTextFile.mockResolvedValue(raw);
    for (const file of ["../../etc/passwd", "sub/a.bin", "C:\\x.bin", "a.jpg"]) {
      fs.remove.mockClear();
      await realDeps.consume({ v: 1, kind: "image", file, count: 1 }, raw);
      expect(fs.remove.mock.calls).toEqual([["share-inbox/pending.json", CACHE]]);
    }
  });

  it("consume：error payload ⇒ 只删 pending.json", async () => {
    const raw = errorRaw("no_stream");
    fs.readTextFile.mockResolvedValue(raw);
    await realDeps.consume(JSON.parse(raw) as PendingPayload, raw);
    expect(fs.remove.mock.calls).toEqual([["share-inbox/pending.json", CACHE]]);
  });

  it("consume：删图失败不影响本次结果（图可能已被原生 latest wins 删掉）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = imageRaw("a.bin");
    fs.readTextFile.mockResolvedValue(raw);
    fs.remove.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("gone"));
    await expect(realDeps.consume(JSON.parse(raw) as PendingPayload, raw)).resolves.toBeUndefined();
    expect(fs.remove).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("startShareIntake：拉取点", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 让在途的 promise 链跑完（fake timers 下 flushPromises 不够） */
  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  it("初次拉取扑空 ⇒ 只补一次重拉；补拉仍扑空不再排（不是轮询）", async () => {
    const { deps, calls } = harness();
    const stop = startShareIntake({ ...deps, retryDelayMs: 50 });
    await settle();
    expect(calls.readPending).toBe(1);

    await vi.advanceTimersByTimeAsync(49);
    expect(calls.readPending).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.readPending).toBe(2);

    // 补拉那次（"none"）不再排：等到很久以后也只有两次
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.readPending).toBe(2);
    stop();
  });

  it("拉到东西 ⇒ 不排重拉", async () => {
    vi.useFakeTimers();
    const { deps, calls } = harness({ readPending: async () => imageRaw() });
    const stop = startShareIntake({ ...deps, retryDelayMs: 50 });
    await settle();
    expect(calls.readPending).toBe(1);
    expect(calls.attached).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.readPending).toBe(1);
    stop();
  });

  it("回到前台（visibilitychange）⇒ 再拉一次", async () => {
    const { deps, calls } = harness();
    const stop = startShareIntake({ ...deps, retryDelayMs: 50 });
    await settle();
    expect(calls.readPending).toBe(1);

    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(calls.readPending).toBe(2);
    stop();
  });

  it("卸载后不再拉：visibilitychange 与待命定时器都拆掉", async () => {
    const { deps, calls } = harness();
    const stop = startShareIntake({ ...deps, retryDelayMs: 50 });
    await settle();
    expect(calls.readPending).toBe(1);

    stop();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.readPending).toBe(1);
  });
});
