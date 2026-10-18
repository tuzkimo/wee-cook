// 系统语音识别的唯一出口：页面不 import 插件，插件异常在这里转成 kind。
// 契约见 docs/superpowers/specs/2026-10-18-voice-guidance-design.md §4.2。
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  isAvailable,
  onError,
  onResult,
  startListening,
  stopListening,
} from "tauri-plugin-stt-api";

export type SpeechErrorKind = "permission" | "unavailable" | "transient";

export interface SpeechHandle {
  stop(): Promise<void>;
}

/** 桌面端 / 无识别服务 / 插件加载失败一律 false，不冒泡。 */
export async function isSpeechAvailable(): Promise<boolean> {
  try {
    return (await isAvailable()).available;
  } catch {
    return false;
  }
}

/** 识别永不 reject：读不到插件就当成 unavailable 报给页面，页面照常可用。 */
export async function startSpeech(
  onResultText: (text: string) => void,
  onErrorKind: (kind: SpeechErrorKind, message: string) => void,
): Promise<SpeechHandle> {
  let unlistenResult: UnlistenFn | null = null;
  let unlistenError: UnlistenFn | null = null;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      unlistenResult?.();
      unlistenError?.();
      await stopListening();
    } catch {
      // 已经停了再停、或插件不在，都当成功
    }
  };

  try {
    // 先订阅再启动：启动瞬间出的错误不能漏
    unlistenResult = await onResult((result) => {
      if (result.isFinal) onResultText(result.transcript);
    });
    unlistenError = await onError((err) => {
      onErrorKind(kindOf(err.code), err.message);
    });
    await startListening({ language: "zh-CN", continuous: true, interimResults: false });
  } catch (err) {
    await stop();
    onErrorKind("unavailable", err instanceof Error ? err.message : String(err));
  }

  return { stop };
}

/** 权限被拒不能重试，其余可重试（NO_SPEECH / TIMEOUT 等）。 */
function kindOf(code: string): SpeechErrorKind {
  switch (code) {
    case "PERMISSION_DENIED":
    case "SPEECH_PERMISSION_DENIED":
      return "permission";
    case "NOT_AVAILABLE":
    case "LANGUAGE_NOT_SUPPORTED":
      return "unavailable";
    default:
      return "transient";
  }
}
