// AI 对话的本地落库与读回：一张本机唯一会话 + 它的消息列表。
// 按规格 §4.5，这两个表永不参与同步；payload 只是 TEXT(JSON)，坏数据回落 null，不拖垮整个 AI 页。
import { getDb } from "@/db";
import type { UnresolvedNames } from "@/services/ai/filter";
import type { RecipeListItem } from "@/types";
import type { RecipeFilter } from "@/utils/recipeFilter";

export interface MessagePayload {
  filter: RecipeFilter | null;
  matched: number;
  items: RecipeListItem[];
  unresolved: UnresolvedNames;
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

/** 取本机唯一会话；没有就建一条。 */
export async function loadOrCreateSession(): Promise<string> {
  const db = getDb();
  // 万一被软删过就再建一条新的；正常路径永远命中同一行
  const rows = await db.select<{ id: string }[]>(
    "SELECT id FROM ai_sessions WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
  );
  if (rows[0]) return rows[0].id;

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.execute(
    "INSERT INTO ai_sessions (id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, NULL)",
    [id, now, now],
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
