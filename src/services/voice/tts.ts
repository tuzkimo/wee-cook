// 朗读：失败只 warn，不抛。TTS 不可用时指导模式降级成纯文字。
//
// 为什么必须等「念完」再交还：Android 上 TTS 播放与 SpeechRecognizer 共用音频通路，
// 边听边念会让识别直接报 ERROR_AUDIO / ERROR_CLIENT（实机复现：进页面十几秒就红条）。
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onSpeechEvent, speak as pluginSpeak, stop as pluginStop } from "tauri-plugin-tts-api";

/** 等不到 speech:finish 时的兜底：宁可短暂不监听，也不要永远不听 */
const SPEAK_TIMEOUT_MS = 10000;
/** finish 之后尾音还在房间里：立刻开麦会把这半秒听回去 */
const TAIL_SILENCE_MS = 300;
const END_EVENTS = ["speech:finish", "speech:error", "speech:cancel"] as const;

/** 朗读到结束（或失败/超时）才 resolve，调用方据此决定何时恢复识别 */
export async function speakAndWait(text: string): Promise<void> {
  const unlisteners: UnlistenFn[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const finished = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SPEAK_TIMEOUT_MS);
      const done = (): void => resolve();
      void (async () => {
        for (const type of END_EVENTS) {
          // 事件 API 拿不到就只靠超时兜底：听不见回执也不能把页面卡死
          try {
            unlisteners.push(await onSpeechEvent(type, done));
          } catch {
            continue;
          }
        }
      })();
    });

    await pluginSpeak({ text, language: "zh-CN" });
    await finished;
    await new Promise((resolve) => setTimeout(resolve, TAIL_SILENCE_MS));
  } catch (err) {
    console.warn("朗读失败", err);
  } finally {
    if (timer !== null) clearTimeout(timer);
    for (const off of unlisteners) off();
  }
}

export async function stopSpeaking(): Promise<void> {
  try {
    await pluginStop();
  } catch (err) {
    console.warn("停止朗读失败", err);
  }
}
