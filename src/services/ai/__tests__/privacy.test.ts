// AI 隐私开关的落盘读写（settings.json 的 aiSendingEnabled 键）。
// 非 Tauri 环境（单元测试）走 settingsFile 的 localStorage 分支，与本文件同口径读写。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAiSendingEnabled, writeAiSendingEnabled } from "@/services/ai/privacy";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI 隐私开关落盘", () => {
  it("键不存在时默认关闭", async () => {
    await expect(readAiSendingEnabled()).resolves.toBe(false);
  });

  it("写入 true 后读回 true，键名是 aiSendingEnabled", async () => {
    await writeAiSendingEnabled(true);

    expect(localStorage.getItem("aiSendingEnabled")).toBe("true");
    await expect(readAiSendingEnabled()).resolves.toBe(true);
  });

  it("写入 false 后读回 false", async () => {
    await writeAiSendingEnabled(false);

    await expect(readAiSendingEnabled()).resolves.toBe(false);
  });

  it("存量值读不懂时按关闭处理，且不覆盖它", async () => {
    localStorage.setItem("aiSendingEnabled", JSON.stringify("yes"));

    await expect(readAiSendingEnabled()).resolves.toBe(false);
    // invalid 是别的版本写的数据：只在内存回落默认值，不能就地改写成 false
    expect(localStorage.getItem("aiSendingEnabled")).toBe(JSON.stringify("yes"));
  });

  it("落盘失败时 reject（用户主动开关的动作不能被静默假确认）", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    await expect(writeAiSendingEnabled(true)).rejects.toThrow();
  });
});
