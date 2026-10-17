// AI 隐私开关的落盘读写（settings.json 的 aiSendingEnabled:<uid> 键，spec §12.1）。
// 非 Tauri 环境（单元测试）走 settingsFile 的 localStorage 分支，与本文件同口径读写。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAiAccount } from "@/services/ai/account";
import { readAiSendingEnabled, writeAiSendingEnabled } from "@/services/ai/privacy";

beforeEach(() => {
  localStorage.clear();
  setAiAccount("u-A");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI 隐私开关落盘", () => {
  it("键不存在时默认关闭", async () => {
    await expect(readAiSendingEnabled()).resolves.toBe(false);
  });

  it("写入 true 后读回 true，键名是 aiSendingEnabled:<uid>", async () => {
    await writeAiSendingEnabled(true);

    expect(localStorage.getItem("aiSendingEnabled:u-A")).toBe("true");
    await expect(readAiSendingEnabled()).resolves.toBe(true);
  });

  it("写入 false 后读回 false", async () => {
    await writeAiSendingEnabled(false);

    await expect(readAiSendingEnabled()).resolves.toBe(false);
  });

  it("存量值读不懂时按关闭处理，且不覆盖它", async () => {
    localStorage.setItem("aiSendingEnabled:u-A", JSON.stringify("yes"));

    await expect(readAiSendingEnabled()).resolves.toBe(false);
    // invalid 是别的版本写的数据：只在内存回落默认值，不能就地改写成 false
    expect(localStorage.getItem("aiSendingEnabled:u-A")).toBe(JSON.stringify("yes"));
  });
});

describe("opt-in 按账号隔离", () => {
  it("键按账号隔离：A 写 true 不影响 B", async () => {
    await writeAiSendingEnabled(true);
    expect(localStorage.getItem("aiSendingEnabled:u-A")).toBe("true");
    setAiAccount("u-B");

    expect(await readAiSendingEnabled()).toBe(false);
  });

  it("没有账号时读到 false，且一个键都不读", async () => {
    setAiAccount(null);
    localStorage.setItem("aiSendingEnabled:u-A", "true");

    expect(await readAiSendingEnabled()).toBe(false);
  });

  it("没有账号时写入直接抛错，不落盘", async () => {
    setAiAccount(null);

    await expect(writeAiSendingEnabled(true)).rejects.toThrow("未登录");
    expect(Object.keys({ ...localStorage })).toHaveLength(0);
  });

  // 放最后：happy-dom 的 localStorage spy 在此环境里不会被 restoreAllMocks 还原，
  // 留在末尾才不会污染后面的用例。
  it("落盘失败时 reject（用户主动开关的动作不能被静默假确认）", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    await expect(writeAiSendingEnabled(true)).rejects.toThrow();
  });
});
