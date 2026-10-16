package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"wee-cook/backend/internal/config"
)

// aiTestConfig 造一份指向假上游的配置。超时给足，避免慢机器上正常用例被判定超时。
func aiTestConfig(baseURL string) *config.Config {
	return &config.Config{
		AIAPIKey:    "test-key",
		AIBaseURL:   baseURL,
		AIModel:     "test-model",
		AIMaxTokens: 512,
		AITimeout:   5 * time.Second,
	}
}

// newFakeUpstream 起一个假上游：把请求体解码成 map 存进 captured（可为 nil），
// 再按 status/body 回复。captured 让用例能逐键检查后端真正发出去的 JSON。
func newFakeUpstream(t *testing.T, status int, body string, captured *map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if captured != nil {
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Errorf("上游收到的不是合法 JSON: %v (%s)", err, raw)
			}
			*captured = m
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func keysOf(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// 第一条也是最重要的一条：role + tool_calls 的消息发到上游时不得出现 content 键，
// content:null 会被上游拒。断言方式是读上游收到的原始 JSON 键集。
func TestAIChatForwardsToolCallMessageWithoutContentKey(t *testing.T) {
	var captured map[string]any
	srv := newFakeUpstream(t, http.StatusOK,
		`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`, &captured)
	svc := NewAIService(aiTestConfig(srv.URL))

	_, err := svc.Chat(context.Background(), AIChatRequest{Messages: []AIMessage{
		{Role: "assistant", ToolCalls: []AIToolCall{{ID: "call_1", Name: "search_recipes", Arguments: `{"q":"x"}`}}},
		{Role: "tool", Content: "[]", ToolCallID: "call_1"},
	}})
	if err != nil {
		t.Fatalf("Chat 失败: %v", err)
	}

	msgs, ok := captured["messages"].([]any)
	if !ok || len(msgs) != 2 {
		t.Fatalf("上游 messages 形状不对: %v", captured["messages"])
	}
	first := msgs[0].(map[string]any)
	if _, has := first["content"]; has {
		t.Errorf("role+tool_calls 的消息不得带 content 键，实际键集 %v", keysOf(first))
	}
	if got := keysOf(first); len(got) != 2 {
		t.Errorf("只应有 role / tool_calls 两个键，实际键集 %v", got)
	}

	// 扁平的 AIToolCall 必须转成上游的嵌套形状。
	tcs, ok := first["tool_calls"].([]any)
	if !ok || len(tcs) != 1 {
		t.Fatalf("上游 tool_calls 形状不对: %v", first["tool_calls"])
	}
	call := tcs[0].(map[string]any)
	if call["type"] != "function" {
		t.Errorf("上游 tool_call.type 应为 function，实际 %v", call["type"])
	}
	fn, ok := call["function"].(map[string]any)
	if !ok || fn["name"] != "search_recipes" || fn["arguments"] != `{"q":"x"}` {
		t.Errorf("tool_call.function 归一化不对: %v", call["function"])
	}
}

// 老的纯字符串路径零回归：content 原样透传，不该被工具消息的改造影响。
func TestAIChatPassesStringContentThrough(t *testing.T) {
	var captured map[string]any
	srv := newFakeUpstream(t, http.StatusOK,
		`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`, &captured)
	svc := NewAIService(aiTestConfig(srv.URL))

	if _, err := svc.Chat(context.Background(), AIChatRequest{Messages: []AIMessage{
		{Role: "system", Content: "你是菜谱助手"},
		{Role: "user", Content: "红烧肉怎么做"},
	}}); err != nil {
		t.Fatalf("Chat 失败: %v", err)
	}

	msgs := captured["messages"].([]any)
	first := msgs[0].(map[string]any)
	if first["role"] != "system" || first["content"] != "你是菜谱助手" {
		t.Errorf("system 消息透传不对: %v", first)
	}
	second := msgs[1].(map[string]any)
	if second["role"] != "user" || second["content"] != "红烧肉怎么做" {
		t.Errorf("user 消息透传不对: %v", second)
	}
}

// 上游嵌套形状 → 归一化扁平形状。
func TestAIChatNormalizesUpstreamResponse(t *testing.T) {
	srv := newFakeUpstream(t, http.StatusOK, `{"choices":[{"message":{"content":"找到 1 道","tool_calls":[
  {"id":"call_1","type":"function","function":{"name":"search_recipes","arguments":"{\"ingredients\":[\"五花肉\"]}"}}]},
  "finish_reason":"tool_calls"}],
 "usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`, nil)
	svc := NewAIService(aiTestConfig(srv.URL))

	resp, err := svc.Chat(context.Background(), AIChatRequest{Messages: []AIMessage{{Role: "user", Content: "hi"}}})
	if err != nil {
		t.Fatalf("Chat 失败: %v", err)
	}
	if resp.Text != "找到 1 道" {
		t.Errorf("Text = %q，想要 找到 1 道", resp.Text)
	}
	want := AIToolCall{ID: "call_1", Name: "search_recipes", Arguments: `{"ingredients":["五花肉"]}`}
	if len(resp.ToolCalls) != 1 || resp.ToolCalls[0] != want {
		t.Errorf("ToolCalls = %+v，想要 %+v", resp.ToolCalls, want)
	}
	if resp.Usage.TotalTokens != 12 {
		t.Errorf("Usage.TotalTokens = %d，想要 12", resp.Usage.TotalTokens)
	}
	if resp.FinishReason != "tool_calls" {
		t.Errorf("FinishReason = %q，想要 tool_calls", resp.FinishReason)
	}
}

// content 可能是 null，不能让整个解析崩掉。
func TestAIChatHandlesNullContent(t *testing.T) {
	srv := newFakeUpstream(t, http.StatusOK,
		`{"choices":[{"message":{"content":null},"finish_reason":"stop"}]}`, nil)
	svc := NewAIService(aiTestConfig(srv.URL))

	resp, err := svc.Chat(context.Background(), AIChatRequest{Messages: []AIMessage{{Role: "user", Content: "hi"}}})
	if err != nil {
		t.Fatalf("content 为 null 时 Chat 不该失败: %v", err)
	}
	if resp.Text != "" || len(resp.ToolCalls) != 0 {
		t.Errorf("content 为 null 应归一化成空文本，实际 %+v", resp)
	}
}

// 请求体里带上 model 与 max_tokens（都来自服务端配置，不信任客户端）。
func TestAIChatSendsModelAndMaxTokens(t *testing.T) {
	var captured map[string]any
	srv := newFakeUpstream(t, http.StatusOK,
		`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`, &captured)
	svc := NewAIService(aiTestConfig(srv.URL))

	if _, err := svc.Chat(context.Background(), AIChatRequest{Messages: []AIMessage{{Role: "user", Content: "hi"}}}); err != nil {
		t.Fatalf("Chat 失败: %v", err)
	}
	if captured["model"] != "test-model" {
		t.Errorf("model = %v，想要 test-model", captured["model"])
	}
	if captured["max_tokens"] != float64(512) {
		t.Errorf("max_tokens = %v，想要 512", captured["max_tokens"])
	}
}

// 状态码 / 网络错误 → 哨兵错误；上游原始错误体一律不下发。
func TestAIChatMapsUpstreamErrors(t *testing.T) {
	cases := []struct {
		name   string
		status int
		want   error
	}{
		{"401 鉴权失败", http.StatusUnauthorized, ErrAIUpstreamAuth},
		{"403 鉴权失败", http.StatusForbidden, ErrAIUpstreamAuth},
		{"429 限流", http.StatusTooManyRequests, ErrAIRateLimited},
		{"500 上游错误", http.StatusInternalServerError, ErrAIUpstreamError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := newFakeUpstream(t, tc.status, `{"error":{"message":"sk-secret-leak"}}`, nil)
			svc := NewAIService(aiTestConfig(srv.URL))

			_, err := svc.Chat(context.Background(), AIChatRequest{Messages: []AIMessage{{Role: "user", Content: "hi"}}})
			if !errors.Is(err, tc.want) {
				t.Errorf("err = %v，想要 %v", err, tc.want)
			}
		})
	}
}

// 上游 sleep 超过 AITimeout → ErrAIUpstreamTimeout。
func TestAIChatMapsUpstreamTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(500 * time.Millisecond)
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	t.Cleanup(srv.Close)

	cfg := aiTestConfig(srv.URL)
	cfg.AITimeout = 100 * time.Millisecond
	svc := NewAIService(cfg)

	if _, err := svc.Chat(context.Background(), AIChatRequest{Messages: []AIMessage{{Role: "user", Content: "hi"}}}); !errors.Is(err, ErrAIUpstreamTimeout) {
		t.Errorf("err = %v，想要 %v", err, ErrAIUpstreamTimeout)
	}
}

// baseURL 指向已关闭的 server → ErrAIUnreachable。
func TestAIChatMapsUnreachableUpstream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()

	svc := NewAIService(aiTestConfig(url))
	if _, err := svc.Chat(context.Background(), AIChatRequest{Messages: []AIMessage{{Role: "user", Content: "hi"}}}); !errors.Is(err, ErrAIUnreachable) {
		t.Errorf("err = %v，想要 %v", err, ErrAIUnreachable)
	}
}

func TestAIServiceHost(t *testing.T) {
	svc := NewAIService(&config.Config{AIAPIKey: "k", AIBaseURL: "https://api.deepseek.com/v1"})
	if got := svc.Host(); got != "api.deepseek.com" {
		t.Errorf("Host() = %q，想要 api.deepseek.com", got)
	}

	// 尾斜杠不影响 Host 与拼接（Task 1 的测试夹具就是带尾斜杠的形状）。
	svc = NewAIService(&config.Config{AIAPIKey: "k", AIBaseURL: "https://example.com/v1/"})
	if got := svc.Host(); got != "example.com" {
		t.Errorf("Host() = %q，想要 example.com", got)
	}

	// 解析失败返回空串，不 panic。
	svc = NewAIService(&config.Config{AIAPIKey: "k", AIBaseURL: "://bad"})
	if got := svc.Host(); got != "" {
		t.Errorf("非法 baseURL 的 Host() = %q，想要空串", got)
	}
}

// 尾斜杠不许拼出 //chat/completions。
func TestAIChatDoesNotDoubleSlashWithTrailingSlash(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`))
	}))
	t.Cleanup(srv.Close)

	svc := NewAIService(aiTestConfig(srv.URL + "/v1/"))
	if _, err := svc.Chat(context.Background(), AIChatRequest{Messages: []AIMessage{{Role: "user", Content: "hi"}}}); err != nil {
		t.Fatalf("Chat 失败: %v", err)
	}
	if gotPath != "/v1/chat/completions" {
		t.Errorf("上游路径 = %q，想要 /v1/chat/completions", gotPath)
	}
}

// Enabled 与 Model 对齐配置。
func TestAIServiceEnabledAndModel(t *testing.T) {
	svc := NewAIService(aiTestConfig("https://example.com/v1"))
	if !svc.Enabled() {
		t.Error("配了 key 时 Enabled() 应为 true")
	}
	if svc.Model() != "test-model" {
		t.Errorf("Model() = %q，想要 test-model", svc.Model())
	}
	if off := NewAIService(&config.Config{AIModel: "m"}); off.Enabled() {
		t.Error("没配 key 时 Enabled() 应为 false")
	}
}
