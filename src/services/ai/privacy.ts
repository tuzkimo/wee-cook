// AI 隐私开关的落盘读写。键名与 settings.json 里的服务器地址同一层（settingsFile.ts），不另开存储。
// 默认关闭：未设置 / 读不懂 / 读不到都算「用户没同意」。
import { readSetting, writeSetting, type SettingLogContext } from "@/services/settingsFile";

const KEY = "aiSendingEnabled";

const LOG_WRITE: SettingLogContext = { tag: "ai-privacy", label: "AI 隐私开关", action: "保存" };

function parseBool(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * 读开关，**永不抛错**：读不出来一律按关闭。
 * `invalid`（键在但读不懂）只在内存回落默认值，不写回 —— 那是别的版本的数据，覆盖它就是丢数据。
 */
export async function readAiSendingEnabled(): Promise<boolean> {
  const read = await readSetting(KEY, parseBool);
  return read.kind === "found" ? read.value : false;
}

/** 写开关。落盘失败必须 reject：用户主动开关的动作不能被静默假确认。 */
export async function writeAiSendingEnabled(value: boolean): Promise<void> {
  await writeSetting(KEY, value, LOG_WRITE);
}
