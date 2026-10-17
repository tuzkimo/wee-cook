package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"wee-cook/backend/internal/service"
)

// fakeAIService 实现 aiService，供 handler 层入参、透传与错误映射测试注入。
// model / host 即使 enabled=false 也照常返回，用来证明 handler 未启用时会抹掉配置。
type fakeAIService struct {
	enabled  bool
	model    string
	host     string
	chatResp *service.AIChatResponse
	chatErr  error

	gotReq service.AIChatRequest
}

func (f *fakeAIService) Enabled() bool { return f.enabled }
func (f *fakeAIService) Model() string { return f.model }
func (f *fakeAIService) Host() string  { return f.host }

func (f *fakeAIService) Chat(_ context.Context, req service.AIChatRequest) (*service.AIChatResponse, error) {
	f.gotReq = req
	return f.chatResp, f.chatErr
}

func aiChatRequest(body string) *http.Request {
	return httptest.NewRequest("POST", "/ai/chat", strings.NewReader(body))
}

// errorCode 读出 writeError 写的 {"error": "<code>"}。
func errorCode(t *testing.T, body []byte) string {
	t.Helper()
	var v struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("响应不是合法 JSON: %v；body: %s", err, body)
	}
	return v.Error
}

func TestAIStatusReportsEnabledModelAndHost(t *testing.T) {
	h := NewAIHandler(&fakeAIService{enabled: true, model: "deepseek-flash", host: "api.deepseek.com"})
	rec := httptest.NewRecorder()
	h.Status(rec, httptest.NewRequest("GET", "/ai/status", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("启用时查询状态: got %d, want 200；body: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Enabled bool   `json:"enabled"`
		Model   string `json:"model"`
		Host    string `json:"host"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("状态响应解析失败: %v；body: %s", err, rec.Body.String())
	}
	if !got.Enabled || got.Model != "deepseek-flash" || got.Host != "api.deepseek.com" {
		t.Errorf("状态 = %+v, want enabled=true model=deepseek-flash host=api.deepseek.com", got)
	}
}

// 未启用时 model / host 必须为空串，不能泄露上游配置。
func TestAIStatusWhenDisabled(t *testing.T) {
	h := NewAIHandler(&fakeAIService{enabled: false, model: "deepseek-flash", host: "api.deepseek.com"})
	rec := httptest.NewRecorder()
	h.Status(rec, httptest.NewRequest("GET", "/ai/status", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("未启用时查询状态: got %d, want 200；body: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Enabled bool   `json:"enabled"`
		Model   string `json:"model"`
		Host    string `json:"host"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("状态响应解析失败: %v；body: %s", err, rec.Body.String())
	}
	if got.Enabled || got.Model != "" || got.Host != "" {
		t.Errorf("未启用状态 = %+v, want enabled=false model=\"\" host=\"\"", got)
	}
}

// 未启用返回 503 + ai_disabled，不是 404。
func TestAIChatWhenDisabledReturns503(t *testing.T) {
	h := NewAIHandler(&fakeAIService{enabled: false})
	rec := httptest.NewRecorder()
	h.Chat(rec, aiChatRequest(`{"messages":[{"role":"user","content":"你好"}]}`))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("未启用时聊天: got %d, want 503；body: %s", rec.Code, rec.Body.String())
	}
	if code := errorCode(t, rec.Body.Bytes()); code != "ai_disabled" {
		t.Errorf("错误码 = %q, want ai_disabled", code)
	}
}

// 哨兵错误经 %w 包装后仍要命中 errors.Is，映射到约定状态码与错误码。
func TestAIChatMapsServiceErrorsToCodes(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"上游鉴权失败", service.ErrAIUpstreamAuth, http.StatusBadGateway, "ai_upstream_auth"},
		{"上游限流", service.ErrAIRateLimited, http.StatusTooManyRequests, "ai_rate_limited"},
		{"上游超时", service.ErrAIUpstreamTimeout, http.StatusGatewayTimeout, "ai_upstream_timeout"},
		{"上游不可达", service.ErrAIUnreachable, http.StatusBadGateway, "ai_unreachable"},
		{"上游错误", service.ErrAIUpstreamError, http.StatusBadGateway, "ai_upstream_error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewAIHandler(&fakeAIService{enabled: true, chatErr: fmt.Errorf("包裹: %w", tc.err)})
			rec := httptest.NewRecorder()
			h.Chat(rec, aiChatRequest(`{"messages":[]}`))

			if rec.Code != tc.status {
				t.Fatalf("状态码: got %d, want %d；body: %s", rec.Code, tc.status, rec.Body.String())
			}
			if code := errorCode(t, rec.Body.Bytes()); code != tc.code {
				t.Errorf("错误码 = %q, want %q", code, tc.code)
			}
		})
	}
}

// 超过体积上限必须 413，不能落成 400（decoder 错误分类容易写混）。
func TestAIChatBodyTooLargeReturns413(t *testing.T) {
	old := maxAIBodyBytes
	maxAIBodyBytes = 64
	defer func() { maxAIBodyBytes = old }()

	h := NewAIHandler(&fakeAIService{enabled: true})
	rec := httptest.NewRecorder()
	h.Chat(rec, aiChatRequest(`{"messages":[{"role":"user","content":"`+strings.Repeat("x", 100)+`"}]}`))

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超大请求体: got %d, want 413；body: %s", rec.Code, rec.Body.String())
	}
}

// 默认 12 MiB 上限必须放行一个 8 MiB 的合法请求（规格 §9.17）：只有「调小后 413」盖不住这一半，
// 上限、MaxBytesReader 与解码器三者任一错位都会在小 body 用例下静默通过。
func TestAIChatDefaultBodyLimitAllows8MiB(t *testing.T) {
	svc := &fakeAIService{enabled: true, chatResp: &service.AIChatResponse{Text: "ok"}}
	h := NewAIHandler(svc)
	body := `{"messages":[{"role":"user","content":"` + strings.Repeat("x", 8<<20) + `"}]}`
	rec := httptest.NewRecorder()
	h.Chat(rec, aiChatRequest(body))

	if rec.Code != http.StatusOK {
		t.Fatalf("默认上限下 8 MiB 合法请求: got %d, want 200；body: %s", rec.Code, rec.Body.String())
	}
	if len(svc.gotReq.Messages) != 1 {
		t.Errorf("传给 service 的请求 = %d 条消息, want 1", len(svc.gotReq.Messages))
	}
}

// 正常请求：请求体解码进 service.AIChatRequest，成功响应原样写回。
func TestAIChatSuccessWritesNormalizedResponse(t *testing.T) {
	svc := &fakeAIService{enabled: true, chatResp: &service.AIChatResponse{Text: "hi", FinishReason: "stop"}}
	h := NewAIHandler(svc)
	rec := httptest.NewRecorder()
	h.Chat(rec, aiChatRequest(`{"messages":[{"role":"user","content":"你好"}]}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("正常聊天: got %d, want 200；body: %s", rec.Code, rec.Body.String())
	}
	if len(svc.gotReq.Messages) != 1 || string(svc.gotReq.Messages[0].Content) != `"你好"` {
		t.Errorf("传给 service 的请求 = %+v, want 一条 content=你好", svc.gotReq)
	}
	var got service.AIChatResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("响应解析失败: %v；body: %s", err, rec.Body.String())
	}
	if got.Text != "hi" || got.FinishReason != "stop" {
		t.Errorf("响应 = %+v, want text=hi finish_reason=stop", got)
	}
}
