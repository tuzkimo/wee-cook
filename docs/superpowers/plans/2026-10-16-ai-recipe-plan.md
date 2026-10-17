# AI 菜谱助手 · 第 1 刀：后端管道 + 客户端聊天检索

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 `/ai` 用一句话（系统输入法语音或打字）说出需求，AI 把它翻译成本地筛选条件，在本地库上跑出菜谱卡片。

**Architecture:** 后端新增一条无状态 AI 代理管道（`/api/v1/ai/chat` + `/ai/status`），只做协议归一化与转发，**不读一行菜谱数据**；客户端负责 prompt 组装、工具调用编排、名字→id 解析，全部检索跑在本地的 `filterRecipes()` 内存纯函数上。AI 结果通过 `recipeFilter` store 与筛选页共用同一条路径，用户能自己验证。

**Tech Stack:** Go 1.25 / chi v5 / httprate（后端）；Vue 3 + TypeScript 严格模式 / Pinia / vitest + happy-dom / node:sqlite（客户端）。

**Spec:** `docs/superpowers/specs/2026-10-16-ai-recipe-design.md`（下称**规格**）。本计划实现规格 §10 的第 1、2 刀。

**不在本计划内**：规格 §10 第 3、4 刀（长截图收录、Android 分享目标、长图分段、`create_recipe_draft`、预填编辑页）另出一份计划。本计划结束时截图入口**不应存在**，不要提前留钩子。

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**（规格 + `AGENTS.md`）
- **不重构无关代码，不修改未被明确要求的文件**（`AGENTS.md`）
- 非 bugfix 类功能必须附带单元测试，**不可删改已有测试**；已有断言与新规格直接冲突时，经人工确认才可改（`AGENTS.md`）
- 本地新增的 `ai_sessions` / `ai_messages` 是业务表，按 `AGENTS.md` 带 `id` / `updated_at` / `deleted_at`，但**永不参与同步**
- `AI_API_KEY` **绝对不进 `config.Load()` 的必填校验**；缺它时服务必须能正常启动（规格 §6）
- 后端日志只记 `user_id` / 耗时 / `prompt_tokens` / `completion_tokens` / `finish_reason` / 上游状态码，**不记 messages 内容**（规格 §6）
- `AI_MODEL` 默认 **`deepseek-flash`**，不是 `deepseek-chat`（后者不接受 `image_url`）
- `maxAIBodyBytes = 12 << 20`；`AI_TIMEOUT` 默认 `120s`；`AI_MAX_TOKENS` 默认 1024；`AI_RATE_LIMIT` 默认 20/分钟；`AI_DAILY_LIMIT` 默认 200/天
- 限流**按 userID**，且必须在 `AuthMiddleware` **之后**注册；**分钟级在外层、日配额在内层**；`/ai/status` **不吃日配额**；分钟级限流器**只建一个实例、两个端点共用**
- 客户端只跟自家后端说话，**不直连上游**；`hasBaseUrl() === false` 时**一个网络请求都不发**
- 测试命令：客户端 `npm run test`；后端 `cd backend && go test ./...`；类型检查 `npm run build`

## Review Focus

这五类输入/失败模式是规格隐含、但任何单任务的测试都不会自动覆盖的。每条都在它归属的任务里有对应断言：

1. **未配服务器地址**（`hasBaseUrl() === false`）时打开 AI 页或点发送 —— 必须一个请求都不发，页面说清「先连接服务器」，而不是「加载失败」→ Task 9 / 15
2. **未登录但地址已配** —— `/ai/status` 回 401，页面**不得**把它当成「AI 未启用」而永久藏掉入口 → Task 9
3. **后端 `AI_API_KEY` 为空、客户端 opt-in 已开** —— 入口隐藏，页面不报错，也不显示隐私说明卡（拿不到 `host`）→ Task 3 / 9
4. **模型返回不存在的工具名，或 `arguments` 不是合法 JSON** —— 不得抛到界面；回一条 tool 错误让模型纠正一次，仍失败则降级成普通文本 → Task 13
5. **同步边界** —— `ai_sessions` / `ai_messages` 的任何一行都不得上行 → Task 6

---

### Task 1: 后端 AI 配置段

**Files:**
- Modify: `backend/internal/config/config.go`
- Test: `backend/internal/config/config_test.go`（追加用例，不动已有两条）

**Interfaces:**
- Consumes: 无
- Produces:
  - `Config` 新增字段 `AIAPIKey string`、`AIBaseURL string`、`AIModel string`、`AIMaxTokens int`、`AITimeout time.Duration`、`AIRateLimit int`、`AIDailyLimit int`
  - `func (c *Config) AIEnabled() bool`
  - 包内常量 `defaultAIBaseURL = "https://api.deepseek.com/v1"`、`defaultAIModel = "deepseek-flash"`、`defaultAIMaxTokens = 1024`、`defaultAITimeout = 120 * time.Second`、`defaultAIRateLimit = 20`、`defaultAIDailyLimit = 200`

- [ ] **Step 1: 写失败的测试**

追加到 `backend/internal/config/config_test.go`：

```go
func TestLoadAIDefaultsDoNotBlockStartup(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis:6379")
	t.Setenv("JWT_SECRET", "s")
	t.Setenv("AI_API_KEY", "")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("没配 AI 时不该启动失败: %v", err)
	}
	if cfg.AIEnabled() {
		t.Error("AI_API_KEY 为空时 AIEnabled() 应为 false")
	}
	if cfg.AIModel != "deepseek-flash" {
		t.Errorf("AIModel 默认必须是 deepseek-flash（deepseek-chat 不接受图片），实际 %q", cfg.AIModel)
	}
	if cfg.AIBaseURL != "https://api.deepseek.com/v1" {
		t.Errorf("AIBaseURL 默认值不符，实际 %q", cfg.AIBaseURL)
	}
	if cfg.AIMaxTokens != 1024 {
		t.Errorf("AIMaxTokens 默认应是 1024，实际 %d", cfg.AIMaxTokens)
	}
	if cfg.AITimeout != 120*time.Second {
		t.Errorf("AITimeout 默认应是 120s，实际 %v", cfg.AITimeout)
	}
	if cfg.AIRateLimit != 20 {
		t.Errorf("AIRateLimit 默认应是 20，实际 %d", cfg.AIRateLimit)
	}
	if cfg.AIDailyLimit != 200 {
		t.Errorf("AIDailyLimit 默认应是 200，实际 %d", cfg.AIDailyLimit)
	}
}

func TestLoadAIEnvOverrides(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis:6379")
	t.Setenv("JWT_SECRET", "s")
	t.Setenv("AI_API_KEY", "sk-x")
	t.Setenv("AI_BASE_URL", "https://example.com/v1/")
	t.Setenv("AI_MODEL", "qwen-vl-max")
	t.Setenv("AI_MAX_TOKENS", "256")
	t.Setenv("AI_TIMEOUT", "90s")
	t.Setenv("AI_RATE_LIMIT", "5")
	t.Setenv("AI_DAILY_LIMIT", "9")

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.AIEnabled() {
		t.Error("配了 AI_API_KEY 后 AIEnabled() 应为 true")
	}
	if cfg.AIModel != "qwen-vl-max" || cfg.AIMaxTokens != 256 || cfg.AIRateLimit != 5 ||
		cfg.AIDailyLimit != 9 || cfg.AITimeout != 90*time.Second {
		t.Errorf("AI 环境变量没被读入: %+v", cfg)
	}
}

func TestLoadAIInvalidTimeoutFallsBack(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis:6379")
	t.Setenv("JWT_SECRET", "s")
	t.Setenv("AI_TIMEOUT", "不是时长")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AITimeout != 120*time.Second {
		t.Errorf("非法 AI_TIMEOUT 应回落默认值，实际 %v", cfg.AITimeout)
	}
}
```

文件顶部 import 需补 `"time"`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/config/ -run TestLoadAI -v`
Expected: FAIL —— `cfg.AIModel undefined` 等编译错误

- [ ] **Step 3: 实现**

在 `config.go` 的 `Config` 结构体末尾加七个字段，风格照 `FilesDir` / `MaxFileBytes`（行尾 `// KEY，默认 X` 注释）。在 `Load()` 里按同样风格赋值。新增常量块与 `AIEnabled()`。

`AI_TIMEOUT` 需要新助手 `getEnvDuration(key string, fallback time.Duration) time.Duration`：`time.ParseDuration`，空值 / 解析失败 / `<= 0` 一律回落 fallback（照 `getEnvInt` 的注释风格说明为什么静默回落）。

**`AI_*` 一个都不许加进 `missing` 切片。**

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/config/ -v`
Expected: PASS（含原有的 `TestLoadRequiresCoreEnv`、`TestLoadDefaults`）

- [ ] **Step 5: 提交**

```bash
git add backend/internal/config/config.go backend/internal/config/config_test.go
git commit -m "feat(后端): AI 配置段，全部可选不阻塞启动"
```

---

### Task 2: AIService —— 上游适配与错误映射

**Files:**
- Create: `backend/internal/service/ai.go`
- Test: `backend/internal/service/ai_test.go`

**Interfaces:**
- Consumes: `config.Config`（Task 1 的七个字段）
- Produces:
  - `type AIMessage struct { Role string; Content string; ToolCallID string; ToolCalls []AIToolCall }`，JSON tag 依次为 `role` / `content,omitempty` / `tool_call_id,omitempty` / `tool_calls,omitempty`
  - `type AIToolCall struct { ID string; Name string; Arguments string }`，tag `id` / `name` / `arguments`（**扁平形状，与客户端一致**）
  - `type AITool struct { Type string; Function AIToolFunction }`；`type AIToolFunction struct { Name string; Description string; Parameters json.RawMessage }`
  - `type AIChatRequest struct { Messages []AIMessage; Tools []AITool }`
  - `type AIUsage struct { PromptTokens int; CompletionTokens int; TotalTokens int }`
  - `type AIChatResponse struct { Text string; ToolCalls []AIToolCall; Usage AIUsage; FinishReason string }`
  - 哨兵错误：`ErrAIUpstreamAuth`、`ErrAIRateLimited`、`ErrAIUpstreamTimeout`、`ErrAIUnreachable`、`ErrAIUpstreamError`
  - `func NewAIService(cfg *config.Config) *AIService`
  - `func (s *AIService) Enabled() bool`、`func (s *AIService) Model() string`、`func (s *AIService) Host() string`
  - `func (s *AIService) Chat(ctx context.Context, req AIChatRequest) (*AIChatResponse, error)`

- [ ] **Step 1: 写失败的测试**

`backend/internal/service/ai_test.go`。用 `httptest.NewServer` 当假上游，并把 `AIBaseURL` 指向它。核心用例：

```go
// 哨兵：role + tool_calls 的消息发到上游时，键集不得多出 content（content 变 null 会被上游拒）
func TestAIChatForwardsToolCallMessageWithoutContentKey(t *testing.T)

// 字符串 content 原样透传（老路径零回归）
func TestAIChatPassesStringContentThrough(t *testing.T)

// 上游嵌套形状 → 归一化扁平形状
func TestAIChatNormalizesUpstreamResponse(t *testing.T)

// 请求体里带上 model 与 max_tokens
func TestAIChatSendsModelAndMaxTokens(t *testing.T)

// 401/403→ErrAIUpstreamAuth；429→ErrAIRateLimited；500→ErrAIUpstreamError
// 上游 sleep 超过 AITimeout→ErrAIUpstreamTimeout；baseURL 指向已关闭的 server→ErrAIUnreachable
func TestAIChatMapsUpstreamErrors(t *testing.T)

func TestAIServiceHost(t *testing.T)  // Host() == "api.deepseek.com"
```

第一条用例的断言方式是**读上游收到的原始 JSON**：

```go
// 假上游把 body 解成 map[string]any 存下来，测试逐键断
msgs := captured["messages"].([]any)
first := msgs[0].(map[string]any)
if _, has := first["content"]; has {
	t.Errorf("role+tool_calls 的消息不得带 content 键，实际键集 %v", keysOf(first))
}
if len(keysOf(first)) != 2 { /* 只应有 role / tool_calls */ }
```

上游返回体（`TestAIChatNormalizesUpstreamResponse`）用：

```json
{"choices":[{"message":{"content":"找到 1 道","tool_calls":[
  {"id":"call_1","type":"function","function":{"name":"search_recipes","arguments":"{\"ingredients\":[\"五花肉\"]}"}}]},
  "finish_reason":"tool_calls"}],
 "usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}
```

断言 `resp.Text == "找到 1 道"`、`resp.ToolCalls[0] == AIToolCall{ID:"call_1", Name:"search_recipes", Arguments:"{\"ingredients\":[\"五花肉\"]}"}`、`resp.Usage.TotalTokens == 12`、`resp.FinishReason == "tool_calls"`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestAI -v`
Expected: FAIL —— 编译错误（`undefined: AIService`）

- [ ] **Step 3: 实现**

`AIService` 持 `apiKey / baseURL / model / maxTokens` 与 `client *http.Client{Timeout: cfg.AITimeout}`。

`Chat` 的三段：
1. **组上游请求**：`{model, messages, tools, max_tokens}`。`messages` 不是直接序列化入参 —— 需要一个包内函数把扁平 `AIToolCall` 转成上游嵌套的 `{id, type: "function", function: {name, arguments}}`，**并保证 `content` 为空时不出现在 JSON 里**。`tools` 原样透传（客户端给的形状与上游一致）。
2. **调用**：`http.NewRequestWithContext`，`Authorization: Bearer <apiKey>`。非 2xx 时按状态码映射哨兵错误；`err` 是 `context.DeadlineExceeded` / `net.Error` 超时 → `ErrAIUpstreamTimeout`；其它网络错 → `ErrAIUnreachable`。**上游原始错误体一律不下发**（可能含 key 片段）。
3. **归一化**：`choices[0].message` → `AIChatResponse`，嵌套 `tool_calls` 展平。`content` 可能是 `null`，用 `*string` 或 `json.RawMessage` 接，不要让它把整个解析搞崩。

日志：在 `Chat` 里记 `slog`/`log` 一行，含耗时、`usage`、`finish_reason`、上游状态码，**不含 messages 与工具结果**。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -run TestAI -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/service/ai.go backend/internal/service/ai_test.go
git commit -m "feat(后端): AIService 上游适配、协议归一化与错误映射"
```

---

### Task 3: AIHandler —— `/ai/chat` 与 `/ai/status`

**Files:**
- Create: `backend/internal/handler/ai.go`
- Test: `backend/internal/handler/ai_test.go`

**Interfaces:**
- Consumes: Task 2 的全部类型与哨兵错误
- Produces:
  - `type aiService interface { Enabled() bool; Model() string; Host() string; Chat(context.Context, service.AIChatRequest) (*service.AIChatResponse, error) }`（**包内私有**，供测试注入假实现）
  - `func NewAIHandler(svc aiService) *AIHandler`
  - `func (h *AIHandler) Chat(w http.ResponseWriter, r *http.Request)`
  - `func (h *AIHandler) Status(w http.ResponseWriter, r *http.Request)`
  - 包级 `var maxAIBodyBytes int64 = 12 << 20`（**必须是 `var`**，测试要改小它验 413）

- [ ] **Step 1: 写失败的测试**

`backend/internal/handler/ai_test.go`，仿 `community_test.go` 的 `fakeCommunityService` 形状写一个 `fakeAIService`。

```go
func TestAIStatusReportsEnabledModelAndHost(t *testing.T)      // 启用 → {"enabled":true,"model":"deepseek-flash","host":"api.deepseek.com"}
func TestAIStatusWhenDisabled(t *testing.T)                    // 未启用 → {"enabled":false,"model":"","host":""}
func TestAIChatWhenDisabledReturns503(t *testing.T)            // 错误码 ai_disabled，不是 404
func TestAIChatMapsServiceErrorsToCodes(t *testing.T)          // 表驱动，见下
func TestAIChatBodyTooLargeReturns413(t *testing.T)            // 见下
```

错误映射表（每行断言状态码 + `{"error": "<code>"}`）：

| 假 service 返回 | 状态码 | code |
|---|---|---|
| `service.ErrAIUpstreamAuth` | 502 | `ai_upstream_auth` |
| `service.ErrAIRateLimited` | 429 | `ai_rate_limited` |
| `service.ErrAIUpstreamTimeout` | 504 | `ai_upstream_timeout` |
| `service.ErrAIUnreachable` | 502 | `ai_unreachable` |
| `service.ErrAIUpstreamError` | 502 | `ai_upstream_error` |

第二条（体积）：测试内 `old := maxAIBodyBytes; maxAIBodyBytes = 64; defer func(){ maxAIBodyBytes = old }()`，发 100 字节的 body，断言 **413**（断言不是 400 —— 两者容易写混，这条用例就是拦这个）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/handler/ -run TestAI -v`
Expected: FAIL —— 编译错误

- [ ] **Step 3: 实现**

`Chat` 的骨架：

```go
func (h *AIHandler) Chat(w http.ResponseWriter, r *http.Request) {
	if !h.svc.Enabled() {
		writeError(w, http.StatusServiceUnavailable, "ai_disabled")
		return
	}
	// 全局 ReadTimeout 15s / WriteTimeout 60s 会掐断 120s 的上游等待与移动网络下的大 body
	// （规格 §6）。只在本 handler 内解除，不动全局值。
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	r.Body = http.MaxBytesReader(w, r.Body, maxAIBodyBytes)
	var req service.AIChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		// *http.MaxBytesError → 413；其余 → 400
	}
	resp, err := h.svc.Chat(r.Context(), req)
	// errors.Is 链映射到 writeError(...)
	writeJSON(w, http.StatusOK, resp)
}
```

`Status` 返回 `{"enabled":..., "model":..., "host":...}`；**未启用时 `model` 与 `host` 都返回空串**（不泄露配置）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/handler/ -v`
Expected: PASS（含既有社区 / 鉴权 / 文件用例）

- [ ] **Step 5: 提交**

```bash
git add backend/internal/handler/ai.go backend/internal/handler/ai_test.go
git commit -m "feat(后端): AI 代理 handler，含体积闸门与 handler 级超时解除"
```

---

### Task 4: 路由与限流

**Files:**
- Modify: `backend/cmd/server/router.go`（`handlers` 结构体 + `newRouter`）
- Modify: `backend/cmd/server/main.go`（构造 service 与 handler）
- Test: `backend/cmd/server/router_test.go`（追加用例）

**Interfaces:**
- Consumes: `handler.NewAIHandler`（Task 3）、`config.Config`（Task 1）
- Produces: `handlers` 结构体新增字段 `ai *handler.AIHandler`；两条路由 `GET /api/v1/ai/status`、`POST /api/v1/ai/chat`

- [ ] **Step 1: 写失败的测试**

追加到 `router_test.go`（复用已有的 `mintTestToken` / `testJWTSecret` / `newRouter`）：

```go
// 五、两条 AI 路由都必须在受保护组内
func TestAIRoutesRequireAuth(t *testing.T)

// 分钟级在外、日配额在内：两分钟窗口与一天窗口都设成 1，第二次请求必须被分钟级拒
//（Retry-After 是窗口长度本身：60 = 分钟级先响，86400 = 顺序反了）
func TestAIChatMinuteLimiterFiresBeforeDailyQuota(t *testing.T)

// /ai/status 不吃日配额：日配额设 1，连探三次状态都 200，之后 /ai/chat 仍能用一次
func TestAIStatusDoesNotConsumeDailyQuota(t *testing.T)

// 分钟级限流器只有一个实例、两端点共用：/ai/status 用掉额度后 /ai/chat 应 429
func TestAIStatusAndChatShareOneMinuteLimiter(t *testing.T)
```

`TestAIChatMinuteLimiterFiresBeforeDailyQuota` 的关键断言：

```go
rec := doAIChat(t, r, token)   // 第一次
if rec.Code != http.StatusOK { t.Fatalf("第一次应放行，got %d", rec.Code) }
rec2 := doAIChat(t, r, token)  // 同一分钟内第二次
if rec2.Code != http.StatusTooManyRequests { t.Fatalf("got %d, want 429", rec2.Code) }
if got := rec2.Header().Get("Retry-After"); got != "60" {
	t.Errorf("Retry-After 应是分钟窗口长度 60（证明分钟级在外层），实际 %q", got)
}
```

构造路由时要注入一个**永远返回成功**的 `fakeAIService`（在 `router_test.go` 里定义，形状与 Task 3 的假实现一致）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./cmd/server/ -run TestAI -v`
Expected: FAIL —— 404 / 编译错误

- [ ] **Step 3: 实现**

`router.go` 的受保护组内追加：

```go
// AI（规格 §6.3）：两条限流都必须在 AuthMiddleware 之后，否则 GetUserID 为空、所有人共用一个桶。
// 顺序：分钟级在外、日配额在内 —— httprate 只在自己放行时计数，日配额在外会被「被分钟级拒掉的请求」吃掉。
// 分钟级限流器只建一个实例、两端点共用 —— 各建一个会让 /ai/* 每分钟总量静默翻倍。
minuteKey := func(r *http.Request) (string, error) { return mw.GetUserID(r.Context()), nil }
minuteLimit := httprate.LimitBy(cfg.AIRateLimit, time.Minute, minuteKey)
dailyLimit := httprate.LimitBy(cfg.AIDailyLimit, 24*time.Hour, minuteKey)

r.Group(func(r chi.Router) {
	r.Use(minuteLimit)
	// status 不吃日配额：客户端要拿它决定是否展示隐私说明卡，
	// 让它吃配额等于一次状态轮询就能在零 AI 调用下耗尽用户的日额度。
	r.Get("/ai/status", h.ai.Status)
	r.Group(func(r chi.Router) {
		r.Use(dailyLimit)
		r.Post("/ai/chat", h.ai.Chat)
	})
})
```

两条限流的 429 响应体默认是**纯文本**，要 `httprate.WithLimitHandler` 改成 `{"error":"ai_rate_limited"}` / `{"error":"ai_quota_exceeded"}`。

`main.go`：`aiSvc := service.NewAIService(cfg)`，在 `handlers{...}` 里加 `ai: handler.NewAIHandler(aiSvc)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./cmd/server/ -v`
Expected: PASS（含既有 `TestSyncRequiresAuth` 等）

- [ ] **Step 5: 提交**

```bash
git add backend/cmd/server/router.go backend/cmd/server/main.go backend/cmd/server/router_test.go
git commit -m "feat(后端): AI 路由与双层限流，按 userID 且状态探针不占日配额"
```

---

### Task 5: 部署配置与自托管文档

**Files:**
- Modify: `backend/.env.example`
- Modify: `compose.yml`（仓库根目录）
- Modify: `docs/SELF-HOSTING.md`

**Interfaces:**
- Consumes: Task 1 的全部环境变量名与默认值
- Produces: 无代码接口

- [ ] **Step 1: 改 `.env.example`**

追加 AI 段，逐项写清默认值。必须写明两条与「默认值写错就没功能」直接相关的注释：

```
# 模型必须同时支持 tool calls 与 image_url 图片输入。
# deepseek-flash（V4.1-Flash）两者都支持；deepseek-chat 不支持图片。
AI_MODEL=deepseek-flash
```

- [ ] **Step 2: 改 `compose.yml`**

按文件里现有的变量透传风格加 `AI_*`，**一律用 `${VAR:-}` 空默认**（绝不能是 `JWT_SECRET` 那种 `${VAR:?}`）—— 不配 AI 也必须能起来。

- [ ] **Step 3: 改 `docs/SELF-HOSTING.md`**

加「启用 AI」一节：变量表（变量 / 默认值 / 说明）、两条限流的口径（按用户、进程内存滑动窗口、多实例时按实例计）、以及一段「换供应商 / 换模型要重新核对什么」——**直接引用规格 §6.1 的四条清单**，不要另写一份。

- [ ] **Step 4: 验证**

Run: `cd backend && go build ./... && cd .. && grep -n "AI_API_KEY\|AI_MODEL" compose.yml docs/SELF-HOSTING.md backend/.env.example`
Expected: `go build` 无输出；grep 三处都能看到 `AI_MODEL=deepseek-flash` 与 `${AI_API_KEY:-}`

- [ ] **Step 5: 提交**

```bash
git add backend/.env.example compose.yml docs/SELF-HOSTING.md
git commit -m "docs: AI 自托管配置与换供应商核查清单"
```

---

### Task 6: 本地会话与消息表

**Files:**
- Modify: `src/db/index.ts`（`DDL` 数组末尾）
- Modify: `src/db/__tests__/schema.test.ts`（追加用例）
- Modify: `src/services/__tests__/sync.test.ts`（追加一条哨兵用例）

**Interfaces:**
- Consumes: 无
- Produces: 两张表 `ai_sessions(id, created_at, updated_at, deleted_at)`、`ai_messages(id, session_id, role, content, payload, prompt_version, created_at, updated_at, deleted_at)`

- [ ] **Step 1: 写失败的测试**

追加到 `schema.test.ts`：

```ts
const AI_TABLES = ["ai_sessions", "ai_messages"];

it("AI 会话与消息两张表都建出来了", async () => {
  const { db } = await freshTestDb();
  const rows = await db.select<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const names = rows.map((row) => row.name);
  for (const table of AI_TABLES) expect(names, table).toContain(table);
});

it("AI 两张表按业务表规则带 id/updated_at/deleted_at", async () => {
  const { db } = await freshTestDb();
  for (const table of AI_TABLES) {
    const columns = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
    const names = columns.map((column) => column.name);
    expect(names, table).toContain("id");
    expect(names, table).toContain("updated_at");
    expect(names, table).toContain("deleted_at");
  }
});
```

追加到 `sync.test.ts`（**Review Focus 第 5 条**）：

```ts
it("上行载荷的键集被钉死，AI 会话表不许混进来", () => {
  expect(Object.keys(emptyPayload()).sort()).toEqual([
    "files", "ingredients", "labels", "recipes", "units",
  ]);
});
```

（若 `sync.test.ts` 尚未 import `emptyPayload`，补 import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/db/__tests__/schema.test.ts src/services/__tests__/sync.test.ts`
Expected: FAIL —— `ai_sessions` 不在表名列表里

- [ ] **Step 3: 实现**

在 `src/db/index.ts` 的 `DDL` 数组末尾加两条 `CREATE TABLE IF NOT EXISTS`，注释写明「**永不参与同步**（规格 §4.5）；带三列是按 AGENTS.md 的业务表规则」。`ai_messages.payload` 是 `TEXT`。加一条 `CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id)`。

**`migrateTables` 不用动**：两张是新表，`CREATE TABLE IF NOT EXISTS` 对老库同样生效。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/db/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/db/index.ts src/db/__tests__/schema.test.ts src/services/__tests__/sync.test.ts
git commit -m "feat(数据): AI 会话与消息两张本地表，不进同步"
```

---

### Task 7: `session.ts` —— 会话落库与读回

**Files:**
- Create: `src/services/ai/session.ts`
- Test: `src/services/ai/__tests__/session.test.ts`

**Interfaces:**
- Consumes: Task 6 的两张表
- Produces:
  - `export interface StoredMessage { id: string; role: "user" | "assistant"; content: string; payload: MessagePayload | null; createdAt: string }`
  - `export interface MessagePayload { filter: RecipeFilter | null; matched: number; items: RecipeListItem[]; unresolved: UnresolvedNames }`
  - `export async function loadOrCreateSession(): Promise<string>` —— 返回本机唯一会话的 id（不存在就建一条）
  - `export async function appendMessage(sessionId: string, msg: StoredMessage): Promise<void>`
  - `export async function loadMessages(sessionId: string): Promise<StoredMessage[]>`
  - `export async function clearMessages(sessionId: string): Promise<void>` —— 软删

  会话粒度：**每设备单会话**（规格 §2 引用的主规格决策「每账本单会话」在这里退化为「单会话」，本 App 没有账本概念）。

- [ ] **Step 1: 写失败的测试**

`src/services/ai/__tests__/session.test.ts`，用真 SQLite：

```ts
import { setDb } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import { appendMessage, clearMessages, loadMessages, loadOrCreateSession } from "@/services/ai/session";
```

四个用例：

```ts
it("首次取会话会建一条，再取返回同一个 id", async () => { /* 两次 loadOrCreateSession() 相等 */ });
it("消息读写往返整份相等（含 payload）", async () => { /* appendMessage → loadMessages，逐字段比 */ });
it("payload 为 null 的消息也能原样读回", async () => { /* 纯文本回答 */ });
it("clearMessages 后读回为空，但表里的行还在（软删）", async () => {
  // loadMessages 返回 []，且直接查库 SELECT COUNT(*) 仍 > 0
});
```

`beforeEach` 里 `setDb((await freshTestDb()).db)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/session.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`crypto.randomUUID()` 生成 id，`new Date().toISOString()` 作时间戳（照 `stores/recipe.ts` 的写法）。`payload` 用 `JSON.stringify` / `JSON.parse`，解析失败时回落 `null` 而不是抛（坏数据不该让整个 AI 页打不开）。所有查询带 `deleted_at IS NULL`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/ai/session.ts src/services/ai/__tests__/session.test.ts
git commit -m "feat(AI): 会话与消息的本地读写"
```

---

### Task 8: `transport.ts` —— 与自家后端说话

**Files:**
- Create: `src/services/ai/transport.ts`
- Test: `src/services/ai/__tests__/transport.test.ts`

**Interfaces:**
- Consumes: `apiFetch` / `ApiResult` / `hasBaseUrl`（`src/services/api.ts`）
- Produces:
  - `export interface AiMessage { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; tool_calls?: AiToolCall[] }`
  - `export interface AiToolCall { id: string; name: string; arguments: string }`
  - `export interface AiTool { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }`
  - `export interface AiUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }`
  - `export interface AiChatResult { text: string; tool_calls: AiToolCall[]; usage: AiUsage; finish_reason: string }`
  - `export interface AiStatus { enabled: boolean; model: string; host: string }`
  - `export class AiError extends Error { code: AiErrorCode }`，`type AiErrorCode = "no_server" | "unreachable" | "ai_disabled" | "ai_upstream_auth" | "ai_rate_limited" | "ai_quota_exceeded" | "ai_upstream_timeout" | "ai_unreachable" | "ai_upstream_error" | "bad_request"`
  - `export async function fetchAiStatus(): Promise<AiStatus>`
  - `export async function callAiChat(messages: AiMessage[], tools: AiTool[]): Promise<AiChatResult>`

- [ ] **Step 1: 写失败的测试**

`vi.mock("@/services/api")`，照 `stores/__tests__/community.test.ts` 的 mock 写法。

```ts
it("未配服务器地址时抛 no_server，且一个请求都不发", async () => {
  // hasBaseUrl mock 返回 false
  await expect(fetchAiStatus()).rejects.toMatchObject({ code: "no_server" });
  expect(apiFetchMock).not.toHaveBeenCalled();
});
it("把服务端错误码原样搬进 AiError.code", async () => {
  // apiFetch 返回 { ok:false, status:429, error:"ai_quota_exceeded" }
});
it("拿不到 HTTP 响应（apiFetch 抛）时归成 unreachable", async () => {
  // apiFetch rejects new Error("请求超时")
});
it("callAiChat 把 messages 与 tools 原样放进 body", async () => { /* 断言 apiFetch 的第二个参数 */ });
it("callAiChat 返回归一化结果", async () => { /* text / tool_calls / usage / finish_reason 逐字段 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/transport.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

先判 `hasBaseUrl()`：false 直接抛 `AiError("no_server")`，**不调用 `apiFetch`**（Review Focus 第 1 条）。再 `try { await apiFetch(...) } catch { throw new AiError("unreachable") }`。`res.ok === false` 时把 `res.error` 当 code 抛 `AiError`；未知 code 归 `"ai_upstream_error"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/ai/transport.ts src/services/ai/__tests__/transport.test.ts
git commit -m "feat(AI): 后端代理的客户端封装与错误码"
```

---

### Task 9: 隐私开关 + `aiSettings` store + 「我的」页区块

**Files:**
- Create: `src/services/ai/privacy.ts`
- Create: `src/stores/aiSettings.ts`
- Modify: `src/views/MePage.vue`
- Test: `src/services/ai/__tests__/privacy.test.ts`、`src/stores/__tests__/aiSettings.test.ts`

**Interfaces:**
- Consumes: `readSetting` / `writeSetting`（`src/services/settingsFile.ts`）、`fetchAiStatus` / `AiError`（Task 8）、`useAuthStore`（`src/stores/auth.ts`）
- Produces:
  - `src/services/ai/privacy.ts`：`export async function readAiSendingEnabled(): Promise<boolean>`（默认 `false`）、`export async function writeAiSendingEnabled(value: boolean): Promise<void>`
  - `src/stores/aiSettings.ts`：
    - `sendingEnabled: Ref<boolean>`
    - `status: Ref<AiStatus | null>`
    - `tabVisible: ComputedRef<boolean>`
    - `load(): Promise<void>` —— 读开关 + 探一次 `/ai/status`
    - `setSendingEnabled(value: boolean): Promise<void>`
    - `canShowPrivacyCard: ComputedRef<boolean>` —— 仅当 `status?.host` 非空

- [ ] **Step 1: 写失败的测试**

`privacy.test.ts`：默认 `false`；写入 `true` 后读回 `true`；写入的键名是 `aiSendingEnabled`。

`aiSettings.test.ts`：`vi.mock("@/services/ai/transport")` 与 `vi.mock("@/services/ai/privacy")`。

```ts
it("opt-in 关着时入口隐藏", ...)
it("opt-in 开着、后端明确回 enabled:false 时入口隐藏", ...)
it("opt-in 开着、探活失败时入口仍然可见", async () => {
  // transport.fetchAiStatus rejects new AiError("unreachable")
  // tabVisible === true（把「探不到」当成「没启用」，一次断网就永久藏掉入口）
})
it("未登录导致 /ai/status 回 401 时入口仍然可见", async () => {
  // rejects new AiError("bad_request")（服务端答了 401，apiFetch 把 body.error 当 code）
  // tabVisible === true  ← Review Focus 第 2 条
})
it("后端禁用时不给看隐私说明卡（拿不到 host 就不能让人同意）", ...)
it("配了服务器地址时 load() 会探一次状态并写进 status", ...)
```

**Review Focus 第 3 条**也在这里：

```ts
it("后端 AI_API_KEY 为空、客户端 opt-in 已开：入口隐藏且不抛错", async () => {
  // status = { enabled:false, model:"", host:"" }，sendingEnabled = true
  // tabVisible === false，canShowPrivacyCard === false，load() 不 reject
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/privacy.test.ts src/stores/__tests__/aiSettings.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`privacy.ts` 照 `src/services/sync*.ts` 里已有的 settingsFile 调用姿势写（`SettingLogContext` 的 tag/label/action 是中文短语）。

`aiSettings.ts` 的三态规则，一行搞定：

```ts
const tabVisible = computed(() => sendingEnabled.value && status.value?.enabled !== false)
```

`load()`：先读开关；`hasBaseUrl()` 为假时**不探活**（`status` 保持 `null`）；否则 `try { status.value = await fetchAiStatus() } catch { status.value = null }` —— **任何失败都保持 `null`（未知态），不置 false**。

`MePage.vue`：在同步条下方加一个隐私区块。开关文案点明「开启后提问与菜谱名称、食材会发送到 `<host>`」。**`canShowPrivacyCard` 为假时，开关置灰不可点**，并显示一行说明（拿不到 host 就不能让用户同意）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/ && npm run build`
Expected: 全绿；`npm run build` 的 `vue-tsc` 无错误

- [ ] **Step 5: 提交**

```bash
git add src/services/ai/privacy.ts src/stores/aiSettings.ts src/views/MePage.vue \
  src/services/ai/__tests__/privacy.test.ts src/stores/__tests__/aiSettings.test.ts
git commit -m "feat(我的): AI 隐私开关与三态入口可见性"
```

---

### Task 10: `App.vue` 的 AI tab 三态显隐

**Files:**
- Modify: `src/App.vue`
- Modify: `src/__tests__/App.test.ts`

**Interfaces:**
- Consumes: `useAiSettingsStore`（Task 9）
- Produces: 无

- [ ] **Step 1: 改测试**

`App.test.ts` 现在断言「三个 tab」。**默认 opt-in 关闭 ⇒ AI tab 不该出现**，所以既有两条断言必须改（这是与新规格直接冲突，属于 `AGENTS.md` 允许的例外，但要在 commit message 里写明）：

```ts
it("opt-in 未开启时不渲染 AI tab", () => {
  expect(mountApp().findAll("nav a").map((t) => t.text())).toEqual(["菜谱", "我的"]);
});

it("opt-in 开启且后端启用时渲染三个 tab", () => {
  // 把 aiSettings store 的 sendingEnabled 置 true、status 置 { enabled:true, ... }
  expect(tabs().map((t) => t.text())).toEqual(["菜谱", "AI", "我的"]);
});
```

「当前路径的 tab 是主色」那条要改成按**开启后**的索引断言（`tabs[1]` 仍是 AI），或显式把 opt-in 打开再断。

`mountApp` 要挂 `createPinia()`；`vi.mock("@/services/ai/transport")` 与 `vi.mock("@/services/ai/privacy")`，避免真去读 settings.json / 发请求。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/__tests__/App.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`TABS` 改成 computed：AI 项按 `aiSettings.tabVisible` 过滤，其余不动。`onMounted` 里 `void aiSettings.load()`。

**`/ai` 路由本身保留**（直接输地址仍可进），只有 tab 受控 —— 藏 tab 不等于把功能锁死。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/__tests__/App.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/App.vue src/__tests__/App.test.ts
git commit -m "feat(外壳): AI tab 按 opt-in 与后端状态三态显隐（既有三 tab 断言随规格更新）"
```

---

### Task 11: `filter.ts` —— 字典读取与名字解析

**Files:**
- Create: `src/services/ai/filter.ts`
- Test: `src/services/ai/__tests__/filter.test.ts`

> 文件名照规格 §5 的模块清单（写的是 `filter.ts`）。字典读取也放这里 —— 规格里没有单列 `dict.ts`，而「读字典」与「用字典把名字换成 id」是同一件事的两半。

**Interfaces:**
- Consumes: Task 6 的表、`getDb()`
- Produces:
  - `export interface DictEntry { id: string; name: string }`
  - `export interface Dict { categories: DictEntry[]; tags: DictEntry[]; ingredients: DictEntry[] }`
  - `export async function loadDict(): Promise<Dict>`
  - `export interface UnresolvedNames { categories: string[]; tags: string[]; ingredients: string[] }`
  - `export interface ResolvedFilter { filter: RecipeFilter; unresolved: UnresolvedNames }`
  - `export function resolveFilter(args: SearchRecipesArgs, dict: Dict): ResolvedFilter`（**纯函数**）

  归属：`SearchRecipesArgs`、`validateSearchArgs`、`resolveFilter`、`loadDict` 都在本文件；Task 13 的 `agent.ts` 只引用它们，不重复定义。

  - `export interface SearchRecipesArgs { keyword?: string; categories?: string[]; labels?: string[]; ingredients?: string[] }`
  - `export type ValidateResult = { ok: true; args: SearchRecipesArgs } | { ok: false; error: string }`
  - `export function validateSearchArgs(raw: string): ValidateResult` —— 入参是模型给的 `arguments` **原文**（JSON 字符串）

- [ ] **Step 1: 写失败的测试**

```ts
it("loadDict 只取未软删的，按分类/标签/食材分三桶", async () => { /* freshTestDb + 插几条 */ });

it("解析顺序：精确 → 唯一包含 → 多命中给候选 → 零命中归未落定", () => {
  // 精确："五花肉" 命中
  // 唯一包含："五花" 命中"五花肉"
  // 多命中："肉" 同时是"五花肉"与"肉末"的子串 ⇒ 归 unresolved
  // 零命中："洋蓟" ⇒ unresolved
});

it("trim 与全角空格都要吃掉", () => { /* " 五花肉 "、"\u3000五花肉" */ });

it("校验：非法类型 / 空对象 / 多余字段", () => {
  // validateSearchArgs('{"categories":"家常菜"}')  —— categories 必须是数组
  // validateSearchArgs('{"keyword":123}')
  // validateSearchArgs('不是 JSON')  → ok:false
  // validateSearchArgs('{}')          → ok:true，全空
  // validateSearchArgs('{"nope":1}')  → ok:true（多余字段忽略，不报错）
});

it("解析结果里的 filter 是空的 RecipeFilter 形状，关键词原样带过", () => {
  // resolveFilter({keyword:"红烧"}, emptyDict) → filter.keyword === "红烧"
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/filter.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

`loadDict()` 三条 `SELECT id, name FROM ... WHERE deleted_at IS NULL ORDER BY name`（`labels` 带 `AND kind = 'category'` / `'tag'`）。

`resolveFilter`：先把每个名字过一遍匹配，命中的收 id、没命中的收进 `unresolved`。返回的 `filter` 用 `emptyFilter()` 打底再填（`categoryIds` / `tagIds` / `ingredientIds` / `keyword`）。

匹配规则写在文件顶部注释里，明确「**不猜**：多命中一律归未落定，交给用户或让模型重说」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/ai/filter.ts src/services/ai/__tests__/filter.test.ts
git commit -m "feat(AI): 字典读取、工具参数校验与名字归一"
```

---

### Task 12: `prompt.ts` —— system prompt

**Files:**
- Create: `src/services/ai/prompt.ts`
- Test: `src/services/ai/__tests__/prompt.test.ts`

**Interfaces:**
- Consumes: `Dict`（Task 11）
- Produces:
  - `export const PROMPT_VERSION = "ai-recipe-v1"`
  - `export function buildSystemPrompt(dict: Dict, today: string): string` —— `today` 是 `YYYY-MM-DD` 本地日，由调用方传（**不要在函数里读时钟**，否则测不了）

- [ ] **Step 1: 写失败的测试**

```ts
it("prompt 里只有分类名与标签名，没有 id、没有食材全量", () => {
  const p = buildSystemPrompt(dict, "2026-10-16");
  expect(p).toContain("家常菜");
  expect(p).toContain("下饭");
  expect(p).not.toContain("ing-1");   // 不给 id
  expect(p).not.toContain("五花肉");  // 不给食材全量（库可能上千条）
});

it("prompt 里带上今天日期", () => { expect(p).toContain("2026-10-16"); });

it("prompt 里有禁止清单的三条硬约束", () => {
  // 不得编造菜谱 / 不得声称已收录 / 不得输出 id
});

it("prompt 明说四维之外的条件筛不了，要做不到就直说别丢条件", () => {
  // 「半小时能做的」「简单的」「三人份的」筛不了
});

it("prompt 里有 search_recipes 的 few-shot", () => { /* 「找有五花肉的菜」 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

按规格 §7.1 组装五段。`dict.categories` / `dict.tags` 拼成一行名字列表（**只给名字与类型，不给 id**；分类带上「支出/收入」这类区分在本 App 不存在，跳过）。few-shot 至少四条，其中一条是「直接答不调工具」。**能力缺口那段必须写进去**（规格 §7.1）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/ai/prompt.ts src/services/ai/__tests__/prompt.test.ts
git commit -m "feat(AI): system prompt 与版本号"
```

---

### Task 13: `agent.ts` —— 编排循环与 `search_recipes`

**Files:**
- Create: `src/services/ai/agent.ts`
- Test: `src/services/ai/__tests__/agent.test.ts`

**Interfaces:**
- Consumes: `callAiChat` / `AiMessage` / `AiTool`（Task 8）、`resolveFilter` / `validateSearchArgs` / `Dict` / `UnresolvedNames`（Task 11）、`buildSystemPrompt`（Task 12）、`filterRecipes` / `RecipeFilter`（`src/utils/recipeFilter.ts`）
- Produces:
  - `export const SEARCH_TOOL: AiTool` —— 工具名 `search_recipes`
  - `export interface AgentDeps { dict: Dict; today: string; loadItems(): Promise<RecipeListItem[]> }`
  - `export interface AgentOutcome { text: string; filter: RecipeFilter | null; resolved: { matched: number; items: RecipeListItem[] } | null; unresolved: UnresolvedNames | null; messages: AiMessage[] }`
  - `export async function runAgent(userText: string, history: AiMessage[], deps: AgentDeps): Promise<AgentOutcome>`

- [ ] **Step 1: 写失败的测试**

`vi.mock("@/services/ai/transport")`。

```ts
it("模型直接答话（没调工具）：filter 为 null，text 原样带出", ...)

it("模型调 search_recipes：本地跑 filterRecipes，返回卡片与真实命中数", async () => {
  // loadItems 返回 3 条，其中 1 条食材是五花肉
  // 模型 arguments = {"ingredients":["五花肉"]}
  // outcome.resolved.matched === 1，items[0].recipe.name === "红烧肉"
});

it("matched 与 applied 都来自本地，模型说什么都不影响", async () => {
  // 模型 text 里瞎说「找到 99 道」，matched 仍是 1
});

it("工具名不存在时回一条 tool 错误并让模型纠正一次，不抛到界面", ...)   // Review Focus 第 4 条

it("arguments 不是合法 JSON 时同上", ...)                              // Review Focus 第 4 条

it("纠正后仍然失败：降级成普通文本，不抛错", ...)

it("名字解析不出时 unresolved 带出原始名字，且 filter 里不含它", ...)

it("历史消息原样进上下文，不重排、不改写", ...)
```

**注意最后一条**：本计划不发图片。`AiMessage.content` 在本计划里是 `string`，第 2 份计划要把它放宽到「字符串或内容块数组」—— 那是**那时候的改动**，现在不要提前挖坑（不改类型、不加 `image` 可选字段）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/agent.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`SEARCH_TOOL.function.parameters` 是 JSON Schema，四个可选字段：

```ts
{
  type: "object",
  properties: {
    keyword:   { type: "string", description: "菜名关键词" },
    categories:{ type: "array", items: { type: "string" }, description: "分类名，只能从给的名字里选" },
    labels:    { type: "array", items: { type: "string" }, description: "标签名，只能从给的名字里选" },
    ingredients:{ type: "array", items: { type: "string" }, description: "食材名" },
  },
}
```

`runAgent` 的循环（**最多两轮**，第二轮是纠错轮）：

1. 组 `messages`：`[{role:"system",content:buildSystemPrompt(dict,today)}, ...history, {role:"user",content:userText}]`
2. `callAiChat(messages, [SEARCH_TOOL])`
3. 无 `tool_calls` ⇒ 直接返回 `{ text, filter: null, resolved: null, unresolved: null, messages }`
4. 有 `tool_calls` ⇒ 只处理**第一个** `search_recipes`：`validateSearchArgs` → `resolveFilter` → `deps.loadItems()` → `filterRecipes`；把结果压成一段摘要 JSON（**必须含 `matched`、`items[].name/category/tags/ingredients`、`unresolved`、`applied`**，规格 §4.2）。**`matched` 是本地真实命中数，`items` 最多 10 条**（规格 §4.2：卡片列表看不完）—— 两者都不是模型能影响的作为 `tool` 消息回给模型
5. 工具名不认识 / JSON 非法 ⇒ 回一条 `tool` 错误消息（`{"error":"bad_arguments"}` 之类），**再调一次**；第二次仍失败 ⇒ 返回 `{ text: <兜底的普通文本>, ... }`，不抛

第一轮就成功时，把模型第二轮的回答当 `text`；第二轮仍只调工具而没答话 ⇒ `text` 留空串，界面只渲染卡片。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/ai/agent.ts src/services/ai/__tests__/agent.test.ts
git commit -m "feat(AI): 编排循环、search_recipes 工具与一轮纠错"
```

---

### Task 14: `aiChat` store

**Files:**
- Create: `src/stores/aiChat.ts`
- Test: `src/stores/__tests__/aiChat.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `session.ts`、Task 8 的 transport、Task 13 的 `runAgent`、Task 11 的 `loadDict`
- Produces:
  - `export interface ChatMessage { id: string; role: "user" | "assistant"; text: string; filter: RecipeFilter | null; items: RecipeListItem[]; matched: number; unresolved: UnresolvedNames | null }`
  - store 暴露：`messages: Ref<ChatMessage[]>`、`sending: Ref<boolean>`、`error: Ref<string | null>`、`load(): Promise<void>`、`send(text: string): Promise<void>`、`clear(): Promise<void>`、`openInFilter(filter: RecipeFilter): void`

- [ ] **Step 1: 写失败的测试**

`vi.mock("@/services/ai/agent")`、`vi.mock("@/services/ai/session")`、`vi.mock("@/services/ai/filter")`。

```ts
it("load 把历史消息读进 messages，顺序不变", ...)
it("send：先插 user 消息再插 assistant 消息，两条都落库", ...)
it("sending 期间重复 send 被拒（不并发两次请求）", ...)
it("send 失败时把错误文案写进 error，messages 里不留半条 assistant 消息", ...)
it("clear 清空 messages 并软删库里的行", ...)
it("openInFilter 把 filter apply 进 recipeFilter store", async () => {
  // Review Focus：这是「AI 的结果你能自己验」的机制，必须与手点漏斗走同一个 store
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/aiChat.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`load()`：`loadOrCreateSession()` → `loadMessages()` → 映射成 `ChatMessage[]`（`payload` 里的 filter/items/matched/unresolved 直接展开）。

`send(text)`：`sending.value` 守卫 → 插 user 消息 → `loadDict()` → `runAgent(...)` → 插 assistant 消息 → 两条 `appendMessage` 落库。错误路径：把 `AiError` 的 code 映射成中文文案（`no_server` → 「还没配置服务器地址」、`ai_disabled` → 「服务器的 AI 未启用」、`ai_quota_exceeded` → 「今日 AI 次数已用完」等）写进 `error`。

`openInFilter(filter)` 调 `useRecipeFilterStore().apply(filter)` —— **不要**在这里 `router.push`，跳转留给视图层（store 不依赖 router）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/stores/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/stores/aiChat.ts src/stores/__tests__/aiChat.test.ts
git commit -m "feat(AI): 聊天 store 与错误文案映射"
```

---

### Task 15: `AiPage` 与聊天组件

**Files:**
- Modify: `src/views/AiPage.vue`（替换 12 行的占位）
- Create: `src/components/ai/ChatBubble.vue`
- Create: `src/components/ai/ChatComposer.vue`
- Test: `src/views/__tests__/AiPage.test.ts`、`src/components/ai/__tests__/ChatComposer.test.ts`

**Interfaces:**
- Consumes: `useAiChatStore`（Task 14）、`useAiSettingsStore`（Task 9）、`useRecipeFilterStore`、`useRouter`（`vue-router`）
- Produces:
  - `ChatBubble.vue` props `{ message: ChatMessage }`；渲染文本 + （有 `filter` 时）结果卡片列表 + 「在筛选页继续改」按钮 + （有 `unresolved` 时）一行「没找到：xxx」
  - `ChatComposer.vue` props `{ disabled: boolean; sending: boolean }`，emit `{ send: [text: string] }`

- [ ] **Step 1: 写失败的测试**

```ts
it("opt-in 未开启时显示说明与入口，输入区禁用", ...)          // Review Focus 第 1/3 条
it("未配服务器地址时说的是「先连接服务器」，不是「加载失败」", ...)  // Review Focus 第 1 条
it("说明卡里写明聊天记录是明文存在本机的", ...)                // 规格 §7.3
it("发送后消息渲染成气泡，卡片用 RecipeCard", ...)
it("点「在筛选页继续改」会 apply 进 recipeFilter 并跳到 /", ...)
it("有未落定名字时渲染一行提示，且不把它们放进 filter", ...)
it("搜索无结果时给空态文案，不跳转", ...)                     // 规格 §8：库里没找到，去社区逛逛？
it("后端 AI_API_KEY 为空时不展示说明卡、也没有开启入口", ...)   // Review Focus 第 3 条

// ChatComposer
it("空字符串或纯空白不发", ...)
it("disabled 或 sending 时输入框与发送按钮都不可用", ...)
it("发送后清空输入框", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/views/__tests__/AiPage.test.ts src/components/ai/`
Expected: FAIL

- [ ] **Step 3: 实现**

`AiPage.vue`：`AppHeader title="AI"` + 消息流（自身滚动）+ 底部固定输入区。

- 首次进入若 `canShowPrivacyCard` 为真且 opt-in 未开，显示一次性说明卡，文案必须含三件：发送到哪个域名（`status.host`）、命中的菜谱名称与食材会上行、**聊天记录是明文存在本机上的**（规格 §7.3）。开启按钮写 `writeAiSendingEnabled(true)`
- `canShowPrivacyCard` 为假时**不展示说明卡、也不给开启入口**（拿不到 host 就不该让人同意）
- 结果卡片**复用 `src/components/RecipeCard.vue`**，点击进 `/recipe/:id`
- 「在筛选页继续改」按钮：`aiChat.openInFilter(msg.filter)` 然后 `router.push("/")` —— **跳转在这里做，不在 store 里**（Task 14 的 store 不依赖 router）
- `matched === 0` 时不渲染卡片列表，改渲染一行空态（库里没找到，去社区逛逛）
- 输入区用 `useKeyboardInset()`（安卓软键盘顶掉输入框是必踩的坑），理由与 `RefSheet` / `FilterPage` 一致
- 失败文案从 store 的 `error` 渲染成一条可关闭的提示条

- [ ] **Step 4: 跑测试与类型检查**

Run: `npm run test && npm run build`
Expected: 全绿，`vue-tsc` 无错误

- [ ] **Step 5: 手动验收（桌面端）**

`npm run tauri dev`，在「我的 → AI 菜谱助手」打开开关，回到 `/ai` 问一句「找有五花肉的菜」。确认：
1. 卡片出现在气泡里，点进去是详情页
2. 点「在筛选页继续改」后列表页顶部筛选条写着同样的条件
3. 首次启动未配服务器地址时输入区禁用，文案是「先连接服务器」

- [ ] **Step 6: 提交**

```bash
git add src/views/AiPage.vue src/components/ai src/views/__tests__/AiPage.test.ts
git commit -m "feat(AI): 聊天页与检索结果卡片"
```

---

## 收尾

- [x] 跑全套：`npm run test && npm run build && cd backend && go test ./... && go vet ./...`
- [x] 对着规格 §9 的 17 条测试清单核一遍覆盖（属于本计划的是第 2、4、9、10、11、13、14、15、16、17 条；第 1、3、5、6、7、8、12 条属后续刀——第 12 条 block-array content 本刀不适用，因为 `AiMessage.content` 仍是 string）
- [x] 更新 `docs/SELF-HOSTING.md`：确认「启用 AI」一节与最终实现一致
  - §9.17 的 8 MiB 看门用例已由 `backend/internal/handler/ai_test.go` 覆盖；桌面/真机手动验收（tauri dev）待人工执行
