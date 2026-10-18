// 朗读封装：手机放在厨房桌上时「不方便看屏幕」，所以失败只降级成文字，绝不打断指导模式。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pluginSpeak: vi.fn(),
  pluginStop: vi.fn(),
  pluginIsSpeaking: vi.fn(),
}));

vi.mock("tauri-plugin-tts-api", () => ({
  speak: mocks.pluginSpeak,
  stop: mocks.pluginStop,
  isSpeaking: mocks.pluginIsSpeaking,
}));

import { isSpeaking, speak, stopSpeaking } from "@/services/voice/tts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pluginSpeak.mockResolvedValue({ utteranceId: "u1" });
  mocks.pluginStop.mockResolvedValue(undefined);
  mocks.pluginIsSpeaking.mockResolvedValue(false);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("tts", () => {
  it("以中文音色朗读给定文本", async () => {
    await speak("低筋面粉，200 克");

    expect(mocks.pluginSpeak).toHaveBeenCalledWith({ text: "低筋面粉，200 克", language: "zh-CN" });
  });

  it("插件抛错时不 reject（TTS 不可用只降级成纯文字）", async () => {
    mocks.pluginSpeak.mockRejectedValue(new Error("no engine"));

    await expect(speak("在，问吧。")).resolves.toBeUndefined();
  });

  it("isSpeaking 拿不到状态时报 false（不阻塞页面）", async () => {
    mocks.pluginIsSpeaking.mockRejectedValue(new Error("plugin gone"));

    await expect(isSpeaking()).resolves.toBe(false);
  });

  it("stopSpeaking 停掉当前朗读", async () => {
    await stopSpeaking();

    expect(mocks.pluginStop).toHaveBeenCalledTimes(1);
  });
});
