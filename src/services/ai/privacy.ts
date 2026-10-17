// AI 隐私开关的落盘读写。键按账号隔离（`aiSendingEnabled:<uid>`，spec §12.1），
// 与 settings.json 里的服务器地址同一层（settingsFile.ts），不另开存储。
// 默认关闭：未设置 / 读不懂 / 读不到都算「用户没同意」；没登录也算没同意。
import { readSetting, writeSetting, type SettingLogContext } from "@/services/settingsFile";
import { aiAccount } from "@/services/ai/account";

const LOG_WRITE: SettingLogContext = { tag: "ai-privacy", label: "AI 隐私开关", action: "保存" };

export function aiSendingKey(userId: string): string {
  return `aiSendingEnabled:${userId}`;
}

function parseBool(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * 读当前账号的开关，**永不抛错**：没账号 / 读不出来一律按关闭。
 * `invalid`（键在但读不懂）只在内存回落默认值，不写回 —— 那是别的版本的数据，覆盖它就是丢数据。
 */
export async function readAiSendingEnabled(): Promise<boolean> {
  const userId = aiAccount();
  if (userId === null) return false;
  const read = await readSetting(aiSendingKey(userId), parseBool);
  return read.kind === "found" ? read.value : false;
}

/** 写当前账号的开关。落盘失败必须 reject：用户主动开关的动作不能被静默假确认。 */
export async function writeAiSendingEnabled(value: boolean): Promise<void> {
  const userId = aiAccount();
  if (userId === null) throw new Error("未登录");
  await writeSetting(aiSendingKey(userId), value, LOG_WRITE);
}
