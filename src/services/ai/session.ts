// AI 对话的本地落库与读回：每个账号一张会话 + 它的消息列表。
// 按规格 §4.5，这两个表永不参与同步；payload 只是 TEXT(JSON)，坏数据回落 null，不拖垮整个 AI 页。
// 会话与历史属于服务端账号（规格 §12.1）：没有账号就没有会话。
import { getDb } from "@/db";
import { aiAccount } from "@/services/ai/account";
import type { UnresolvedNames } from "@/services/ai/filter";
import type { RecipeListItem } from "@/types";
import type { RecipeFilter } from "@/utils/recipeFilter";

/** 截图轮拼给模型时的替身：原图既不重发，也不让历史里留下图片内容（规格 §12.2） */
export const SCREENSHOT_PLACEHOLDER = "[用户发过一张菜谱截图]";

/** 只有拼给模型的上下文才替换，本地存储与气泡渲染保留原文 */
export function historyText(text: string, hasImage: boolean): string {
  if (!hasImage) return text;
  return text.trim() === "" ? SCREENSHOT_PLACEHOLDER : `${SCREENSHOT_PLACEHOLDER} ${text}`;
}

export interface MessagePayload {
  filter: RecipeFilter | null;
  matched: number;
  items: RecipeListItem[];
  unresolved: UnresolvedNames;
  /** 封面缩略图 dataUrl；没有图的消息不出现这个键（规格 §12.2） */
  image?: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  payload: MessagePayload | null;
  /** 写这条回答时用的 prompt 版本，改 prompt 后老会话的行为才可追溯（规格 §4.5） */
  promptVersion: string | null;
  createdAt: string;
}

/** 取当前账号的会话；没有就建一条。没有账号就没得存（规格 §12.1），调用方先门控。 */
export async function loadOrCreateSession(): Promise<string> {
  const userId = aiAccount();
  if (userId === null) throw new Error("未登录");

  const db = getDb();
  // 万一被软删过就再建一条新的；正常路径永远命中同一行。老库的无主行 user_id 为 NULL，永不匹配
  const rows = await db.select<{ id: string }[]>(
    "SELECT id FROM ai_sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
    [userId],
  );
  if (rows[0]) return rows[0].id;

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.execute(
    "INSERT INTO ai_sessions (id, user_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL)",
    [id, userId, now, now],
  );
  return id;
}

export async function appendMessage(sessionId: string, msg: StoredMessage): Promise<void> {
  await getDb().execute(
    `INSERT INTO ai_messages
       (id, session_id, role, content, payload, prompt_version, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      msg.id,
      sessionId,
      msg.role,
      msg.content,
      msg.payload === null ? null : JSON.stringify(msg.payload),
      msg.promptVersion,
      msg.createdAt,
      new Date().toISOString(),
    ],
  );
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  payload: string | null;
  prompt_version: string | null;
  created_at: string;
}

export async function loadMessages(sessionId: string): Promise<StoredMessage[]> {
  // rowid 兜底：同一毫秒写进的 user/assistant 两条，created_at 分不出先后，插入序才是对话顺序
  const rows = await getDb().select<MessageRow[]>(
    `SELECT id, role, content, payload, prompt_version, created_at
     FROM ai_messages
     WHERE session_id = ? AND deleted_at IS NULL
     ORDER BY created_at ASC, rowid ASC`,
    [sessionId],
  );
  return rows.map((row) => ({
    id: row.id,
    role: row.role as StoredMessage["role"],
    content: row.content,
    payload: parsePayload(row.payload),
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  }));
}

/** 清空会话只软删消息，会话行留着复用（下次 loadOrCreateSession 还是同一张会话）。 */
export async function clearMessages(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb().execute(
    "UPDATE ai_messages SET deleted_at = ?, updated_at = ? WHERE session_id = ? AND deleted_at IS NULL",
    [now, now, sessionId],
  );
}

function parsePayload(raw: string | null): MessagePayload | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as MessagePayload;
}
