// AI 网络层：只 mock api 模块，验证形状转换与错误码映射（不发真请求）。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", () => ({
  hasBaseUrl: vi.fn(() => true),
  apiFetch: vi.fn(),
}));

import { apiFetch, hasBaseUrl } from "@/services/api";
import type { ApiResult } from "@/services/api";
import { AiError, callAiChat, fetchAiStatus } from "@/services/ai/transport";
import type { AiMessage, AiTool } from "@/services/ai/transport";

const hasBaseUrlMock = vi.mocked(hasBaseUrl);
const apiFetchMock = vi.mocked(apiFetch);

const messages: AiMessage[] = [
  { role: "system", content: "你是厨房助手" },
  { role: "user", content: "有什么快手菜" },
];
const tools: AiTool[] = [
  {
    type: "function",
    function: { name: "search_recipes", description: "按条件搜菜谱", parameters: { type: "object" } },
  },
];

function err(status: number, error: string): ApiResult<never> {
  return { ok: false, status, error };
}

beforeEach(() => {
  vi.clearAllMocks();
  hasBaseUrlMock.mockReturnValue(true);
});

describe("transport", () => {
  it("未配服务器地址时抛 no_server，且一个请求都不发", async () => {
    hasBaseUrlMock.mockReturnValue(false);

    await expect(fetchAiStatus()).rejects.toMatchObject({ code: "no_server" });
    await expect(callAiChat(messages, tools)).rejects.toMatchObject({ code: "no_server" });

    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("把服务端错误码原样搬进 AiError.code，未知码按状态码分档", async () => {
    apiFetchMock.mockResolvedValue(err(429, "ai_quota_exceeded"));
    await expect(callAiChat(messages, tools)).rejects.toMatchObject({ code: "ai_quota_exceeded" });

    apiFetchMock.mockResolvedValue(err(503, "ai_disabled"));
    await expect(fetchAiStatus()).rejects.toMatchObject({ code: "ai_disabled" });

    // 后台鉴权 401 的 body 不在码表内：是「没登录/凭据过期」，不能报成上游出错
    apiFetchMock.mockResolvedValue(err(401, "missing or invalid Authorization header"));
    await expect(fetchAiStatus()).rejects.toMatchObject({ code: "bad_request" });

    // 4xx 的其它未知码同样归 bad_request；5xx 未知码才归 ai_upstream_error
    apiFetchMock.mockResolvedValue(err(400, "invalid_request"));
    await expect(fetchAiStatus()).rejects.toMatchObject({ code: "bad_request" });

    apiFetchMock.mockResolvedValue(err(500, "internal_error"));
    await expect(fetchAiStatus()).rejects.toMatchObject({ code: "ai_upstream_error" });

    await expect(fetchAiStatus()).rejects.toBeInstanceOf(AiError);
  });

  it("拿不到 HTTP 响应（apiFetch 抛）时归成 unreachable", async () => {
    apiFetchMock.mockRejectedValue(new Error("请求超时"));
    await expect(fetchAiStatus()).rejects.toMatchObject({ code: "unreachable" });

    apiFetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(callAiChat(messages, tools)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("callAiChat 把 messages 与 tools 原样放进 body", async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });

    await callAiChat(messages, tools);

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/ai/chat");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ messages, tools }) });
  });

  it("callAiChat 返回归一化结果", async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        text: "推荐番茄炒蛋",
        tool_calls: [{ id: "c1", name: "search_recipes", arguments: "{}" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finish_reason: "stop",
      },
    });

    await expect(callAiChat(messages, tools)).resolves.toEqual({
      text: "推荐番茄炒蛋",
      tool_calls: [{ id: "c1", name: "search_recipes", arguments: "{}" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: "stop",
    });
  });

  it("fetchAiStatus 打 /api/v1/ai/status 并回状态", async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: { enabled: true, model: "gpt-4o-mini", host: "api.openai.com" },
    });

    await expect(fetchAiStatus()).resolves.toEqual({
      enabled: true,
      model: "gpt-4o-mini",
      host: "api.openai.com",
    });
    expect(apiFetchMock.mock.calls[0][0]).toBe("/api/v1/ai/status");
  });
});
