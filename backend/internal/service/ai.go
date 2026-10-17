package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"wee-cook/backend/internal/config"
	mw "wee-cook/backend/internal/middleware"
)

// 哨兵错误：handler（Task 3）据此映射客户端状态码。上游原始错误体一律不下发——
// 它可能含 key 片段，只保留状态码语义。
var (
	ErrAIUpstreamAuth    = errors.New("ai upstream auth failed")
	ErrAIRateLimited     = errors.New("ai upstream rate limited")
	ErrAIUpstreamTimeout = errors.New("ai upstream timeout")
	ErrAIUnreachable     = errors.New("ai upstream unreachable")
	ErrAIUpstreamError   = errors.New("ai upstream error")
)

// AIMessage 是客户端与后端之间的归一化消息形状。Content 用 json.RawMessage：
// 既可承载纯字符串，也可承载 OpenAI 兼容的内容块数组（文本 + 图片），后端只透传不解析。
type AIMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	ToolCalls  []AIToolCall    `json:"tool_calls,omitempty"`
}

// AIToolCall 是扁平形状，与客户端一致；发往上游时才转成嵌套的 {id,type,function}。
type AIToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type AITool struct {
	Type     string         `json:"type"`
	Function AIToolFunction `json:"function"`
}

type AIToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// AIChatRequest 是客户端请求的归一化形状，handler 直接解码到它。
type AIChatRequest struct {
	Messages []AIMessage `json:"messages"`
	Tools    []AITool    `json:"tools"`
}

type AIUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// AIChatResponse 由 handler 直接写回客户端，字段名与客户端类型对齐。
type AIChatResponse struct {
	Text         string       `json:"text"`
	ToolCalls    []AIToolCall `json:"tool_calls"`
	Usage        AIUsage      `json:"usage"`
	FinishReason string       `json:"finish_reason"`
}

// upstreamMessage 是发往 OpenAI 兼容上游的消息形状：tool_calls 为嵌套结构。
// Content 带 omitempty —— role + tool_calls 的消息不能出现 content 键，
// 显式的 content:null 会被上游拒（这是本层唯一一处真正的形状转换）。
// 透传是语义等价，不保证字节原样：json.Marshal 会 compact 空白并对 <>& 做 HTML 转义。
type upstreamMessage struct {
	Role       string             `json:"role"`
	Content    json.RawMessage    `json:"content,omitempty"`
	ToolCallID string             `json:"tool_call_id,omitempty"`
	ToolCalls  []upstreamToolCall `json:"tool_calls,omitempty"`
}

type upstreamToolCall struct {
	ID       string                   `json:"id"`
	Type     string                   `json:"type"`
	Function upstreamToolCallFunction `json:"function"`
}

type upstreamToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type upstreamRequest struct {
	Model     string            `json:"model"`
	Messages  []upstreamMessage `json:"messages"`
	Tools     []AITool          `json:"tools,omitempty"`
	MaxTokens int               `json:"max_tokens"`
}

// upstreamResponse 只取用得到的字段。content 可能是 null，用 *string 接，别让它把整个解析搞崩。
type upstreamResponse struct {
	Choices []struct {
		Message struct {
			Content   *string `json:"content"`
			ToolCalls []struct {
				ID       string `json:"id"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

// AIService 是 AI 代理管道的上游适配层：只做协议归一化与转发，不读一行菜谱数据。
type AIService struct {
	apiKey    string
	baseURL   string
	model     string
	maxTokens int
	client    *http.Client
}

func NewAIService(cfg *config.Config) *AIService {
	return &AIService{
		apiKey:    cfg.AIAPIKey,
		baseURL:   strings.TrimRight(cfg.AIBaseURL, "/"),
		model:     cfg.AIModel,
		maxTokens: cfg.AIMaxTokens,
		// Transport 保持 nil ⇒ 用 http.DefaultTransport ⇒ 自动遵循 HTTP_PROXY / HTTPS_PROXY / NO_PROXY。
		// 自托管时上游常需经代理访问（见 docs/SELF-HOSTING.md）；换成自定义 Transport 且不设 Proxy
		// 会让代理静默失效，表现为 ai_unreachable。
		client: &http.Client{Timeout: cfg.AITimeout},
	}
}

func (s *AIService) Enabled() bool { return s.apiKey != "" }

func (s *AIService) Model() string { return s.model }

// Host 返回上游主机名，供日志用。baseURL 解析失败返回空串，不 panic。
func (s *AIService) Host() string {
	u, err := url.Parse(s.baseURL)
	if err != nil {
		return ""
	}
	return u.Host
}

func (s *AIService) Chat(ctx context.Context, req AIChatRequest) (*AIChatResponse, error) {
	userID := mw.GetUserID(ctx)
	body, err := json.Marshal(upstreamRequest{
		Model:     s.model,
		Messages:  upstreamMessages(req.Messages),
		Tools:     req.Tools,
		MaxTokens: s.maxTokens,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal ai request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build ai request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+s.apiKey)

	start := time.Now()
	// 日志只记 user_id、耗时、用量、finish_reason、状态码，不记 messages 与工具结果。
	resp, err := s.client.Do(httpReq)
	if err != nil {
		// Client.Timeout 触发时错误是 *url.Error，用 os.IsTimeout 兜住；显式 deadline 用 errors.Is。
		if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
			log.Printf("AI 上游超时：user_id=%s host=%s 耗时=%s", userID, s.Host(), since(start))
			return nil, ErrAIUpstreamTimeout
		}
		log.Printf("AI 上游不可达：user_id=%s host=%s 耗时=%s", userID, s.Host(), since(start))
		return nil, ErrAIUnreachable
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 错误体读了就丢：可能含 key 片段，绝不转发给客户端。
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		log.Printf("AI 上游返回非 2xx：user_id=%s host=%s status=%d 耗时=%s", userID, s.Host(), resp.StatusCode, since(start))
		return nil, mapUpstreamStatus(resp.StatusCode)
	}

	var raw upstreamResponse
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		log.Printf("AI 上游响应解析失败：user_id=%s host=%s status=%d 耗时=%s", userID, s.Host(), resp.StatusCode, since(start))
		return nil, ErrAIUpstreamError
	}
	if len(raw.Choices) == 0 {
		log.Printf("AI 上游响应没有 choices：user_id=%s host=%s status=%d 耗时=%s", userID, s.Host(), resp.StatusCode, since(start))
		return nil, ErrAIUpstreamError
	}

	choice := raw.Choices[0]
	out := &AIChatResponse{
		ToolCalls:    make([]AIToolCall, 0, len(choice.Message.ToolCalls)),
		FinishReason: choice.FinishReason,
		Usage: AIUsage{
			PromptTokens:     raw.Usage.PromptTokens,
			CompletionTokens: raw.Usage.CompletionTokens,
			TotalTokens:      raw.Usage.TotalTokens,
		},
	}
	if choice.Message.Content != nil {
		out.Text = *choice.Message.Content
	}
	for _, tc := range choice.Message.ToolCalls {
		out.ToolCalls = append(out.ToolCalls, AIToolCall{ID: tc.ID, Name: tc.Function.Name, Arguments: tc.Function.Arguments})
	}

	log.Printf("AI 调用完成：user_id=%s host=%s status=%d 耗时=%s prompt_tokens=%d completion_tokens=%d finish_reason=%s",
		userID, s.Host(), resp.StatusCode, since(start), out.Usage.PromptTokens, out.Usage.CompletionTokens, out.FinishReason)
	return out, nil
}

// upstreamMessages 把归一化的扁平消息转成上游嵌套形状。
func upstreamMessages(msgs []AIMessage) []upstreamMessage {
	out := make([]upstreamMessage, 0, len(msgs))
	for _, m := range msgs {
		// 字面 null 与缺键在上游眼里不等价：content:null 会被拒，所以归一成零值让 omitempty 省掉这个键。
		content := m.Content
		if len(content) == 0 || string(content) == "null" {
			content = nil
		}
		um := upstreamMessage{Role: m.Role, Content: content, ToolCallID: m.ToolCallID}
		for _, tc := range m.ToolCalls {
			um.ToolCalls = append(um.ToolCalls, upstreamToolCall{
				ID:   tc.ID,
				Type: "function",
				Function: upstreamToolCallFunction{
					Name:      tc.Name,
					Arguments: tc.Arguments,
				},
			})
		}
		out = append(out, um)
	}
	return out
}

func mapUpstreamStatus(status int) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return ErrAIUpstreamAuth
	case http.StatusTooManyRequests:
		return ErrAIRateLimited
	default:
		return ErrAIUpstreamError
	}
}

func since(start time.Time) time.Duration { return time.Since(start).Round(time.Millisecond) }
