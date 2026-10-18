// 朗读封装：手机放在厨房桌上时「不方便看屏幕」，所以失败只降级成文字，绝不打断指导模式。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pluginSpeak: vi.fn(),
  pluginStop: vi.fn(),
  onSpeechEvent: vi.fn(),
  handlers: {} as Record<string, () => void>,
  unlisten: vi.fn(),
}));

vi.mock("tauri-plugin-tts-api", () => ({
  speak: mocks.pluginSpeak,
  stop: mocks.pluginStop,
  onSpeechEvent: mocks.onSpeechEvent,
}));

import { speakAndWait, stopSpeaking } from "@/services/voice/tts";

function fire(type: string): void {
  mocks.handlers[type]?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers = {};
  mocks.pluginSpeak.mockResolvedValue({ utteranceId: "u1" });
  mocks.pluginStop.mockResolvedValue(undefined);
  mocks.onSpeechEvent.mockImplementation(
    async (type: string, handler: () => void) => {
      mocks.handlers[type] = handler;
      return mocks.unlisten;
    },
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("tts", () => {
  it("以中文音色朗读，等到念完才交还控制权", async () => {
    let done = false;
    const speaking = speakAndWait("低筋面粉，200 克").then(() => {
      done = true;
    });

    await Promise.resolve();
    expect(mocks.pluginSpeak).toHaveBeenCalledWith({ text: "低筋面粉，200 克", language: "zh-CN" });
    // 还没念完就不能把麦克风还给识别（TTS 与识别抢音频通路）
    expect(done).toBe(false);

    fire("speech:finish");
    await speaking;
    expect(done).toBe(true);
  });

  it("插件不支持事件时靠超时兜底，不会永远卡住", async () => {
    vi.useFakeTimers();
    mocks.onSpeechEvent.mockRejectedValue(new Error("no such event"));
    let done = false;

    const speaking = speakAndWait("在，问吧。").then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10_400);
    await speaking;

    expect(done).toBe(true);
    vi.useRealTimers();
  });

  it("插件抛错时不 reject（TTS 不可用只降级成纯文字）", async () => {
    mocks.pluginSpeak.mockRejectedValue(new Error("no engine"));

    await expect(speakAndWait("在，问吧。")).resolves.toBeUndefined();
  });

  it("stopSpeaking 停掉当前朗读", async () => {
    await stopSpeaking();

    expect(mocks.pluginStop).toHaveBeenCalledTimes(1);
  });
});
