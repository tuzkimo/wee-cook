// 语音识别封装：只验证「插件事件 → 我们的回调」这一层，插件本身是真机验证的对象。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  startListening: vi.fn(),
  stopListening: vi.fn(),
  onResultHandler: undefined as ((result: { transcript: string; isFinal: boolean }) => void) | undefined,
  onErrorHandler: undefined as ((error: { code: string; message: string }) => void) | undefined,
  unlistenResult: vi.fn(),
  unlistenError: vi.fn(),
}));

vi.mock("tauri-plugin-stt-api", () => ({
  isAvailable: mocks.isAvailable,
  startListening: mocks.startListening,
  stopListening: mocks.stopListening,
  onResult: async (handler: typeof mocks.onResultHandler) => {
    mocks.onResultHandler = handler;
    return mocks.unlistenResult;
  },
  onError: async (handler: typeof mocks.onErrorHandler) => {
    mocks.onErrorHandler = handler;
    return mocks.unlistenError;
  },
}));

import { isSpeechAvailable, startSpeech } from "@/services/voice/speech";
import type { SpeechErrorKind } from "@/services/voice/speech";

function error(kind: string, message = "boom"): void {
  mocks.onErrorHandler?.({ code: kind, message });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAvailable.mockResolvedValue({ available: true });
  mocks.startListening.mockResolvedValue(undefined);
  mocks.stopListening.mockResolvedValue(undefined);
  mocks.onResultHandler = undefined;
  mocks.onErrorHandler = undefined;
});

describe("speech", () => {
  it("isAvailable 返回 available:false 时视为不可用", async () => {
    mocks.isAvailable.mockResolvedValue({ available: false, reason: "no service" });

    await expect(isSpeechAvailable()).resolves.toBe(false);
  });

  it("isAvailable 抛错（桌面端无插件）时视为不可用", async () => {
    mocks.isAvailable.mockRejectedValue(new Error("plugin not found"));

    await expect(isSpeechAvailable()).resolves.toBe(false);
  });

  it("插件 error code 为 PERMISSION_DENIED 时报 permission", async () => {
    const onError = vi.fn<(kind: SpeechErrorKind, message: string) => void>();
    await startSpeech(vi.fn(), onError);

    error("PERMISSION_DENIED", "没有麦克风权限");

    expect(onError).toHaveBeenCalledWith("permission", "没有麦克风权限");
  });

  it("插件 error code 为 NO_SPEECH 时报 transient", async () => {
    const onError = vi.fn<(kind: SpeechErrorKind, message: string) => void>();
    await startSpeech(vi.fn(), onError);

    error("NO_SPEECH");

    expect(onError).toHaveBeenCalledWith("transient", "boom");
  });

  it("插件 error code 为 NOT_AVAILABLE 时报 unavailable", async () => {
    const onError = vi.fn<(kind: SpeechErrorKind, message: string) => void>();
    await startSpeech(vi.fn(), onError);

    error("NOT_AVAILABLE");

    expect(onError).toHaveBeenCalledWith("unavailable", "boom");
  });

  it("startSpeech 以 continuous:true / interimResults:false / language zh-CN 启动", async () => {
    await startSpeech(vi.fn(), vi.fn());

    expect(mocks.startListening).toHaveBeenCalledWith({
      language: "zh-CN",
      continuous: true,
      interimResults: false,
    });
  });

  it("stop() 会调用 stopListening", async () => {
    const handle = await startSpeech(vi.fn(), vi.fn());

    await handle.stop();

    expect(mocks.stopListening).toHaveBeenCalledTimes(1);
    expect(mocks.unlistenResult).toHaveBeenCalledTimes(1);
    expect(mocks.unlistenError).toHaveBeenCalledTimes(1);
  });
});
