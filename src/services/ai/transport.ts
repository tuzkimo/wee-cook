// AI 对话的网络层：客户端只跟自家后端说话（/api/v1/ai/status、/api/v1/ai/chat），
// 不直连上游、不碰 API key。只做 HTTP 形状转换与错误码映射，不读 settings / DB。
import { apiFetch, hasBaseUrl } from "@/services/api";
import type { ApiResult } from "@/services/api";

export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 块数组由 `agent.buildUserContent` 组装，transport 只透传：不拆、不拼、不重排 */
export type AiContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: AiContent;
  tool_call_id?: string;
  tool_calls?: AiToolCall[];
}

export interface AiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AiChatResult {
  text: string;
  tool_calls: AiToolCall[];
  usage: AiUsage;
  finish_reason: string;
}

export interface AiStatus {
  enabled: boolean;
  model: string;
  host: string;
}

export type AiErrorCode =
  | "no_server"
  | "unreachable"
  | "ai_disabled"
  | "ai_upstream_auth"
  | "ai_rate_limited"
  | "ai_quota_exceeded"
  | "ai_upstream_timeout"
  | "ai_unreachable"
  | "ai_upstream_error"
  | "bad_request";

/** 服务端可能原样下发的码；表外的码按状态码分档（见 `toAiError`）。 */
const KNOWN_CODES = new Set<string>([
  "ai_disabled",
  "ai_upstream_auth",
  "ai_rate_limited",
  "ai_quota_exceeded",
  "ai_upstream_timeout",
  "ai_unreachable",
  "ai_upstream_error",
  "bad_request",
]);

export class AiError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode) {
    super(code);
    this.name = "AiError";
    this.code = code;
  }
}

/**
 * 表外的码按状态码分档：4xx 是请求/凭据问题（含后台鉴权 401 的
 * "missing or invalid Authorization header"），报成上游出错会误导用户；5xx 才归上游。
 */
function toAiError(status: number, code: string): AiError {
  if (KNOWN_CODES.has(code)) return new AiError(code as AiErrorCode);
  if (status >= 400 && status < 500) return new AiError("bad_request");
  return new AiError("ai_upstream_error");
}

/** 后端 `AI_TIMEOUT` 默认 120s（视觉推理较慢），客户端多留 30s 余量：
 * 不能比服务端先撒手，否则用户看到「连不上服务器」、服务端还在等上游。 */
const AI_CHAT_TIMEOUT_MS = 150_000;

/** 未配地址时一个请求都不发；拿不到 HTTP 响应归 unreachable；服务端答了就按其错误码抛。 */
async function request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  if (!hasBaseUrl()) throw new AiError("no_server");

  let res: ApiResult<T>;
  try {
    res = await apiFetch<T>(path, init, timeoutMs);
  } catch {
    throw new AiError("unreachable");
  }

  if (!res.ok) throw toAiError(res.status, res.error);
  // 200 但 body 不是 JSON（代理吐 HTML 等）：apiFetch 的 data 是 undefined，不是空对象
  if (res.data === undefined) throw new AiError("ai_upstream_error");
  return res.data;
}

export async function fetchAiStatus(): Promise<AiStatus> {
  return await request<AiStatus>("/api/v1/ai/status");
}

export async function callAiChat(messages: AiMessage[], tools: AiTool[]): Promise<AiChatResult> {
  const data = await request<AiChatResult>(
    "/api/v1/ai/chat",
    {
      method: "POST",
      body: JSON.stringify({ messages, tools }),
    },
    AI_CHAT_TIMEOUT_MS,
  );
  // 后端 Go 侧 tool_calls 为 nil 时下发 null，其余字段用零值兜底
  return {
    text: data.text ?? "",
    tool_calls: data.tool_calls ?? [],
    usage: data.usage,
    finish_reason: data.finish_reason ?? "",
  };
}
