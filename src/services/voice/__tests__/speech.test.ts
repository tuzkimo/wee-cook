// 语音识别封装：只验证「插件事件 → 我们的回调」这一层，插件本身是真机验证的对象。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  startListening: vi.fn(),
  stopListening: vi.fn(),
  requestPermission: vi.fn(),
  onResultHandler: undefined as ((result: { transcript: string; isFinal: boolean }) => void) | undefined,
  onErrorHandler: undefined as ((error: { code: string; message: string }) => void) | undefined,
  unlistenResult: vi.fn(),
  unlistenError: vi.fn(),
}));

vi.mock("tauri-plugin-stt-api", () => ({
  isAvailable: mocks.isAvailable,
  startListening: mocks.startListening,
  stopListening: mocks.stopListening,
  requestPermission: mocks.requestPermission,
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
  mocks.requestPermission.mockResolvedValue({ microphone: "granted", speechRecognition: "granted" });
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

  it("插件 error code 为 NO_SPEECH 时报 silence（正常安静，不是故障）", async () => {
    const onError = vi.fn<(kind: SpeechErrorKind, message: string) => void>();
    await startSpeech(vi.fn(), onError);

    error("NO_SPEECH");

    expect(onError).toHaveBeenCalledWith("silence", "boom");
  });

  it("插件 TIMEOUT 同样算 silence", async () => {
    const onError = vi.fn<(kind: SpeechErrorKind, message: string) => void>();
    await startSpeech(vi.fn(), onError);

    error("TIMEOUT");

    expect(onError).toHaveBeenCalledWith("silence", "boom");
  });

  it("插件报出结果后会话已经终结，stop() 不再调 stopListening（紧接着的启动会变哑）", async () => {
    const handle = await startSpeech(vi.fn(), vi.fn());

    mocks.onResultHandler?.({ transcript: "天气咋样", isFinal: true });
    await handle.stop();

    expect(mocks.stopListening).not.toHaveBeenCalled();
  });

  it("插件自己报错停下后，stop() 也不再调 stopListening（避免紧接着的启动被拒 BUSY）", async () => {
    const handle = await startSpeech(vi.fn(), vi.fn());

    error("NO_SPEECH");
    await handle.stop();

    expect(mocks.unlistenResult).toHaveBeenCalledTimes(1);
    expect(mocks.stopListening).not.toHaveBeenCalled();
  });

  it("插件 error code 为 NOT_AVAILABLE 时报 unavailable", async () => {
    const onError = vi.fn<(kind: SpeechErrorKind, message: string) => void>();
    await startSpeech(vi.fn(), onError);

    error("NOT_AVAILABLE");

    expect(onError).toHaveBeenCalledWith("unavailable", "boom");
  });

  it("startSpeech 以 continuous:false / interimResults:false / language zh-CN 启动", async () => {
    await startSpeech(vi.fn(), vi.fn());

    // continuous:true 会踩插件双重重启 bug（见 speech.ts 注释与实机日志），续听由页面负责
    expect(mocks.startListening).toHaveBeenCalledWith({
      language: "zh-CN",
      continuous: false,
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

  it("启动前先申请麦克风权限：首次使用时授权即开麦，不用用户再点一次", async () => {
    await startSpeech(vi.fn(), vi.fn());

    expect(mocks.requestPermission).toHaveBeenCalledTimes(1);
    expect(mocks.startListening).toHaveBeenCalledTimes(1);
  });

  it("权限被拒时报 permission，且不启动识别", async () => {
    mocks.requestPermission.mockResolvedValue({ microphone: "permanently_denied", speechRecognition: "denied" });
    const onError = vi.fn<(kind: SpeechErrorKind, message: string) => void>();

    await startSpeech(vi.fn(), onError);

    expect(onError).toHaveBeenCalledWith("permission", expect.any(String));
    expect(mocks.startListening).not.toHaveBeenCalled();
  });

  it("startListening 因权限被 reject 时报 permission（不能是可重试的 unavailable）", async () => {
    mocks.startListening.mockRejectedValue(
      new Error("Microphone permission required. Please grant permission and try again."),
    );
    const onError = vi.fn<(kind: SpeechErrorKind, message: string) => void>();

    await startSpeech(vi.fn(), onError);

    expect(onError).toHaveBeenCalledWith("permission", expect.any(String));
  });

  it("startListening 因设备没有识别服务被 reject 时报 unavailable", async () => {
    mocks.startListening.mockRejectedValue(
      new Error("Speech recognition not available on this device. Please install Google app."),
    );
    const onError = vi.fn<(kind: SpeechErrorKind, message: string) => void>();

    await startSpeech(vi.fn(), onError);

    expect(onError).toHaveBeenCalledWith("unavailable", expect.any(String));
  });
});
