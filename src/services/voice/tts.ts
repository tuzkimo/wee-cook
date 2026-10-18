// 朗读：失败只 warn，不抛。TTS 不可用时指导模式降级成纯文字。
import { speak as pluginSpeak, isSpeaking as pluginIsSpeaking, stop as pluginStop } from "tauri-plugin-tts-api";

export async function speak(text: string): Promise<void> {
  try {
    await pluginSpeak({ text, language: "zh-CN" });
  } catch (err) {
    console.warn("朗读失败", err);
  }
}

/** 拿不到状态就当不在朗读：绝不能因为一次调用失败卡住页面 */
export async function isSpeaking(): Promise<boolean> {
  try {
    return await pluginIsSpeaking();
  } catch {
    return false;
  }
}

export async function stopSpeaking(): Promise<void> {
  try {
    await pluginStop();
  } catch (err) {
    console.warn("停止朗读失败", err);
  }
}
