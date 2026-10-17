// AI 入口门控的三态可见性。核心不变量：**「探不到」不等于「没启用」** ——
// 探活失败 / 未配地址 / 未登录（401）都保持未知态（status === null），入口不隐藏。
// 把未知当 false，一次断网就会永久藏掉入口，用户没有办法找回来。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

// hasBaseUrl 读的是 api 模块的模块级 baseUrl，单测里默认 null；
// 不 mock 的话 load() 永远不会去探活。
vi.mock("@/services/api", () => ({
  hasBaseUrl: vi.fn(),
  apiFetch: vi.fn(),
}));

// 保留真身（AiError 等），只换 fetchAiStatus。
vi.mock("@/services/ai/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/transport")>();
  return { ...actual, fetchAiStatus: vi.fn() };
});

vi.mock("@/services/ai/privacy", () => ({
  readAiSendingEnabled: vi.fn(),
  writeAiSendingEnabled: vi.fn(),
}));

import { hasBaseUrl } from "@/services/api";
import { setAiAccount } from "@/services/ai/account";
import { AiError, fetchAiStatus, type AiStatus } from "@/services/ai/transport";
import { readAiSendingEnabled, writeAiSendingEnabled } from "@/services/ai/privacy";
import { useAiSettingsStore } from "@/stores/aiSettings";

const ON: AiStatus = { enabled: true, model: "deepseek-flash", host: "ai.example.com" };
const OFF: AiStatus = { enabled: false, model: "", host: "" };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  // 入口门控按账号读 opt-in（spec §12.1）：没有账号时 load() 直接不发请求
  setAiAccount("u-A");
  vi.mocked(hasBaseUrl).mockReturnValue(false);
  vi.mocked(readAiSendingEnabled).mockResolvedValue(false);
  vi.mocked(writeAiSendingEnabled).mockResolvedValue(undefined);
  vi.mocked(fetchAiStatus).mockResolvedValue(ON);
});

describe("AI 入口三态可见性", () => {
  it("opt-in 关着时入口隐藏（用户没同意，入口不该在）", () => {
    const store = useAiSettingsStore();
    store.status = ON;

    expect(store.tabVisible).toBe(false);
  });

  it("opt-in 开着、后端明确回 enabled:false 时入口隐藏", () => {
    const store = useAiSettingsStore();
    store.sendingEnabled = true;
    store.status = OFF;

    expect(store.tabVisible).toBe(false);
  });

  it("opt-in 开着、探活失败时入口仍然可见", async () => {
    vi.mocked(hasBaseUrl).mockReturnValue(true);
    vi.mocked(readAiSendingEnabled).mockResolvedValue(true);
    vi.mocked(fetchAiStatus).mockRejectedValue(new AiError("unreachable"));
    const store = useAiSettingsStore();

    await store.load();

    expect(store.status).toBeNull();
    expect(store.tabVisible).toBe(true);
  });

  it("未登录导致 /ai/status 回 401 时入口仍然可见", async () => {
    // 服务端答了 401，apiFetch 把 body.error 当成 code，落到 bad_request 档
    vi.mocked(hasBaseUrl).mockReturnValue(true);
    vi.mocked(readAiSendingEnabled).mockResolvedValue(true);
    vi.mocked(fetchAiStatus).mockRejectedValue(new AiError("bad_request"));
    const store = useAiSettingsStore();

    await store.load();

    expect(store.status).toBeNull();
    expect(store.tabVisible).toBe(true);
  });

  it("未配服务器地址时不探活，status 保持未知态且入口可见", async () => {
    vi.mocked(readAiSendingEnabled).mockResolvedValue(true);
    const store = useAiSettingsStore();

    await store.load();

    expect(fetchAiStatus).not.toHaveBeenCalled();
    expect(store.status).toBeNull();
    expect(store.tabVisible).toBe(true);
  });

  it("配了服务器地址时 load() 探一次状态并写进 status", async () => {
    vi.mocked(hasBaseUrl).mockReturnValue(true);
    const store = useAiSettingsStore();

    await store.load();

    expect(fetchAiStatus).toHaveBeenCalledTimes(1);
    expect(store.status).toEqual(ON);
    expect(store.tabVisible).toBe(false);
  });

  it("登录前 load() 不发探活、入口隐藏", async () => {
    vi.mocked(hasBaseUrl).mockReturnValue(true);
    vi.mocked(readAiSendingEnabled).mockResolvedValue(true);
    setAiAccount(null);
    const store = useAiSettingsStore();

    await store.load();

    expect(fetchAiStatus).not.toHaveBeenCalled();
    expect(store.tabVisible).toBe(false);
  });
});

describe("隐私说明卡与开关", () => {
  it("拿不到 host 时不给看隐私说明卡", () => {
    const store = useAiSettingsStore();

    store.status = OFF;
    expect(store.canShowPrivacyCard).toBe(false);

    store.status = null;
    expect(store.canShowPrivacyCard).toBe(false);
  });

  it("拿到 host 时给看隐私说明卡", () => {
    const store = useAiSettingsStore();
    store.status = ON;

    expect(store.canShowPrivacyCard).toBe(true);
  });

  it("后端 AI_API_KEY 为空、客户端 opt-in 已开：入口隐藏、不给看说明卡、load() 不抛错", async () => {
    vi.mocked(hasBaseUrl).mockReturnValue(true);
    vi.mocked(readAiSendingEnabled).mockResolvedValue(true);
    vi.mocked(fetchAiStatus).mockResolvedValue(OFF);
    const store = useAiSettingsStore();

    await expect(store.load()).resolves.toBeUndefined();

    expect(store.tabVisible).toBe(false);
    expect(store.canShowPrivacyCard).toBe(false);
  });
});

describe("reset", () => {
  it("reset() 只清内存，不写盘", () => {
    const store = useAiSettingsStore();
    store.sendingEnabled = true;
    store.status = ON;

    store.reset();

    expect(store.sendingEnabled).toBe(false);
    expect(store.status).toBeNull();
    // 退登不是撤回同意：盘上属于这个账号的键一概不动（spec §12.1）
    expect(writeAiSendingEnabled).not.toHaveBeenCalled();
  });
});

describe("setSendingEnabled", () => {
  it("落盘成功后内存开关同步", async () => {
    const store = useAiSettingsStore();

    await store.setSendingEnabled(true);

    expect(writeAiSendingEnabled).toHaveBeenCalledWith(true);
    expect(store.sendingEnabled).toBe(true);
  });

  it("落盘失败时 reject，且内存开关不变（不做假确认）", async () => {
    vi.mocked(writeAiSendingEnabled).mockRejectedValue(new Error("disk full"));
    const store = useAiSettingsStore();

    await expect(store.setSendingEnabled(true)).rejects.toThrow();
    expect(store.sendingEnabled).toBe(false);
  });
});
