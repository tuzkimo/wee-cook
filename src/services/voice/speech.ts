// 系统语音识别的唯一出口：页面不 import 插件，插件异常在这里转成 kind。
// 契约见 docs/superpowers/specs/2026-10-18-voice-guidance-design.md §4.2。
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  isAvailable,
  onError,
  onResult,
  requestPermission,
  startListening,
  stopListening,
} from "tauri-plugin-stt-api";

export type SpeechErrorKind = "permission" | "unavailable" | "silence" | "transient";

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
  // 插件自己报错就停下了（isListening=false）。这时再调 stopListening 是多余的，
  // 反而会让紧接着的 startListening 被识别服务拒成 BUSY。
  let dead = false;

  const detach = (): void => {
    unlistenResult?.();
    unlistenError?.();
    unlistenResult = null;
    unlistenError = null;
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    detach();
    if (dead) return;
    try {
      await stopListening();
    } catch {
      // 已经停了再停、或插件不在，都当成功
    }
  };

  try {
    // 插件在缺 RECORD_AUDIO 时只会 reject + 弹系统框，授权后**不会自己开麦**。
    // 所以先显式申请：首次使用时用户点了「允许」就直接在听，不需要再点一次重试。
    const permission = await requestPermission();
    if (permission.microphone !== "granted") {
      onErrorKind("permission", "麦克风权限未开启");
      return { stop };
    }

    // 先订阅再启动：启动瞬间出的错误不能漏
    unlistenResult = await onResult((result) => {
      if (result.isFinal) onResultText(result.transcript);
    });
    unlistenError = await onError((err) => {
      dead = true;
      onErrorKind(kindOf(err.code), err.message);
    });
    await startListening({ language: "zh-CN", continuous: true, interimResults: false });
  } catch (err) {
    await stop();
    onErrorKind(kindOfFailure(err), messageOf(err));
  }

  return { stop };
}

/** 启动失败一律是 reject 出来的字符串，只能按文案分流（插件没有错误码）。 */
function kindOfFailure(err: unknown): SpeechErrorKind {
  const message = messageOf(err);
  if (/permission/i.test(message)) return "permission";
  if (/not available|no recognition|install google/i.test(message)) return "unavailable";
  return "transient";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** error 事件的码表。权限被拒不能重试，其余可重试（BUSY / AUDIO_ERROR 等）。 */
function kindOf(code: string): SpeechErrorKind {
  switch (code) {
    case "PERMISSION_DENIED":
    case "SPEECH_PERMISSION_DENIED":
      return "permission";
    case "NOT_AVAILABLE":
    case "LANGUAGE_NOT_SUPPORTED":
      return "unavailable";
    // 插件只在连续 3 次静音后把它抛上来：做菜时没人说话是常态，不是故障
    case "NO_SPEECH":
    case "TIMEOUT":
      return "silence";
    default:
      return "transient";
  }
}
