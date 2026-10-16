package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"wee-cook/backend/internal/config"
	"wee-cook/backend/internal/handler"
	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

const testJWTSecret = "test-secret"

// newAuthRouter 用真实 newRouter 挂载路由，只把 service 置空：
// 这两条用例只走中间件与 handler 的入参校验，不碰数据库。
func newAuthRouter() http.Handler {
	cfg := &config.Config{JWTSecret: testJWTSecret}
	return newRouter(cfg, handlers{auth: handler.NewAuthHandler(nil)})
}

func mintTestToken(t *testing.T, typ string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "user-1",
		"typ": typ,
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(time.Hour).Unix(),
	})
	s, err := tok.SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("签名失败: %v", err)
	}
	return s
}

// refresh token（typ=refresh）不得访问受保护路由。
// 断言响应体而非仅状态码：只有 "invalid token type" 才能唯一证明
// AuthMiddleware 真的挂在 /me 上（路由没挂时是 404）。
func TestAuthRoutesRequireAccessToken(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+mintTestToken(t, "refresh"))
	rec := httptest.NewRecorder()
	newAuthRouter().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("refresh token 访问 /me: got %d, want 401", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("invalid token type")) {
		t.Errorf("响应体应含 invalid token type（证明 AuthMiddleware 在链上）；实际: %s", rec.Body.String())
	}
}

// /auth/login 无需 token 即应可达：空 body 走到 handler 的 JSON 解析 → 400
// （401/404 都说明路由没挂或误挂了鉴权）。
func TestLoginPathExistsWithoutToken(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewBufferString(""))
	rec := httptest.NewRecorder()
	newAuthRouter().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("空 body 的 /auth/login: got %d, want 400", rec.Code)
	}
}

// fakeSyncService 记录调用次数：用来证明未鉴权请求在中间件就被拦下，没漏到 service。
type fakeSyncService struct{ calls int }

func (f *fakeSyncService) Sync(context.Context, string, model.SyncRequest) (*model.SyncResponse, error) {
	f.calls++
	return &model.SyncResponse{}, nil
}

// /sync 必须在受保护组内：无 token 时 401（404 说明路由没注册），
// 且请求不能触达 service（鉴权在 handler 之前生效）。
//
// 只断状态码不够：SyncHandler 自己也会在 userID 为空时返回同形状的 401，
// 所以路由挪出受保护组后该用例依然全绿。必须断响应体来自 AuthMiddleware。
func TestSyncRequiresAuth(t *testing.T) {
	svc := &fakeSyncService{}
	cfg := &config.Config{JWTSecret: testJWTSecret}
	r := newRouter(cfg, handlers{sync: handler.NewSyncHandler(svc)})

	req := httptest.NewRequest("POST", "/api/v1/sync", bytes.NewBufferString(`{}`))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 访问 /sync: got %d, want 401", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("missing or invalid Authorization header")) {
		t.Errorf("401 应来自 AuthMiddleware（证明 /sync 在受保护组内）；实际: %s", rec.Body.String())
	}
	if svc.calls != 0 {
		t.Errorf("未通过鉴权的请求不应触达 service；calls=%d", svc.calls)
	}
}

// /files 必须在受保护组内：无 token 时 401 且 401 来自 AuthMiddleware。
// 路由挪出受保护组时这里会变成 handler 自己的 400/404，本用例即变红。
func TestFileRoutesRequireAuth(t *testing.T) {
	cfg := &config.Config{JWTSecret: testJWTSecret}
	// 这个用例只验路由与中间件，碰不到 service：pool 置空即可
	r := newRouter(cfg, handlers{file: handler.NewFileHandler(service.NewFileService(nil, "", 0))})

	for _, rt := range []struct{ method, path string }{
		{"POST", "/api/v1/files?name=x.jpg"},
		{"GET", "/api/v1/files/x.jpg"},
	} {
		req := httptest.NewRequest(rt.method, rt.path, nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: got %d, want 401", rt.method, rt.path, rec.Code)
			continue
		}
		if !bytes.Contains(rec.Body.Bytes(), []byte("missing or invalid Authorization header")) {
			t.Errorf("%s %s: 401 应来自 AuthMiddleware；实际: %s", rt.method, rt.path, rec.Body.String())
		}
	}
}

// fakeAIService 永远返回成功：AI 路由用例只验路由与限流，不碰上游。
type fakeAIService struct{}

func (fakeAIService) Enabled() bool { return true }
func (fakeAIService) Model() string { return "test-model" }
func (fakeAIService) Host() string  { return "test-host" }

func (fakeAIService) Chat(context.Context, service.AIChatRequest) (*service.AIChatResponse, error) {
	return &service.AIChatResponse{Text: "ok"}, nil
}

// newAIRouter 用真实 newRouter 挂上 AI 路由。限流值由用例显式给出：
// 分钟级与日配额要分别验证，且不能依赖 config.Load 的默认值。
func newAIRouter(rateLimit, dailyLimit int) http.Handler {
	cfg := &config.Config{
		JWTSecret:    testJWTSecret,
		AIRateLimit:  rateLimit,
		AIDailyLimit: dailyLimit,
	}
	return newRouter(cfg, handlers{ai: handler.NewAIHandler(fakeAIService{})})
}

func doAIChat(t *testing.T, r http.Handler, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/v1/ai/chat", bytes.NewBufferString(`{"messages":[]}`))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func doAIStatus(t *testing.T, r http.Handler, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/v1/ai/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

// 两条 AI 路由都必须在受保护组内：无 token 时 401 且 401 来自 AuthMiddleware。
// 只断状态码不够 —— 路由没挂是 404，挪出受保护组会变成 handler 自己的响应。
func TestAIRoutesRequireAuth(t *testing.T) {
	r := newAIRouter(10, 10)

	for _, rt := range []struct{ method, path string }{
		{"GET", "/api/v1/ai/status"},
		{"POST", "/api/v1/ai/chat"},
	} {
		req := httptest.NewRequest(rt.method, rt.path, bytes.NewBufferString(`{}`))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: got %d, want 401", rt.method, rt.path, rec.Code)
			continue
		}
		if !bytes.Contains(rec.Body.Bytes(), []byte("missing or invalid Authorization header")) {
			t.Errorf("%s %s: 401 应来自 AuthMiddleware；实际: %s", rt.method, rt.path, rec.Body.String())
		}
	}
}

// 分钟级必须在外层、日配额在内层。两层限流器都设成 1，同一分钟内第二次请求由谁拒
// 决定了嵌套顺序：httprate 的 Retry-After 是窗口长度本身，60 = 分钟级先响，
// 86400 = 日配额先响（说明顺序反了，日配额会被分钟级拒掉的请求吃掉）。
func TestAIChatMinuteLimiterFiresBeforeDailyQuota(t *testing.T) {
	r := newAIRouter(1, 1)
	token := mintTestToken(t, "access")

	rec := doAIChat(t, r, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("第一次应放行，got %d", rec.Code)
	}
	rec2 := doAIChat(t, r, token)
	if rec2.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429", rec2.Code)
	}
	if got := rec2.Header().Get("Retry-After"); got != "60" {
		t.Errorf("Retry-After 应是分钟窗口长度 60（证明分钟级在外层），实际 %q", got)
	}
	if !bytes.Contains(rec2.Body.Bytes(), []byte("ai_rate_limited")) {
		t.Errorf("429 响应体应是 JSON ai_rate_limited；实际: %s", rec2.Body.String())
	}
}

// /ai/status 不吃日配额：客户端要拿它决定是否展示隐私说明卡，
// 让它吃配额等于一次状态轮询就能在零 AI 调用下耗尽用户的日额度。
func TestAIStatusDoesNotConsumeDailyQuota(t *testing.T) {
	r := newAIRouter(10, 1)
	token := mintTestToken(t, "access")

	for i := 0; i < 3; i++ {
		if rec := doAIStatus(t, r, token); rec.Code != http.StatusOK {
			t.Fatalf("第 %d 次 /ai/status 应 200，got %d", i+1, rec.Code)
		}
	}
	if rec := doAIChat(t, r, token); rec.Code != http.StatusOK {
		t.Fatalf("/ai/chat 的日配额应仍是完整的 1 次，got %d", rec.Code)
	}
}

// 分钟级限流器只建一个实例、两端点共用：各建一个会让 /ai/* 每分钟总量静默翻倍。
func TestAIStatusAndChatShareOneMinuteLimiter(t *testing.T) {
	r := newAIRouter(1, 10)
	token := mintTestToken(t, "access")

	if rec := doAIStatus(t, r, token); rec.Code != http.StatusOK {
		t.Fatalf("/ai/status 第一次应 200，got %d", rec.Code)
	}
	rec := doAIChat(t, r, token)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("/ai/status 用掉分钟额度后 /ai/chat 应 429，got %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "60" {
		t.Errorf("Retry-After 应是分钟窗口长度 60，实际 %q", got)
	}
}

// 日配额的 429 必须用日配额自己的 handler（带 quota_exceeded 文案）：
// 两个 WithLimitHandler 接反时，客户端会把额度耗尽可能当成分钟级限流去盲目重试。
func TestAIChatDailyQuotaUsesQuotaHandler(t *testing.T) {
	r := newAIRouter(100, 1)
	token := mintTestToken(t, "access")

	if rec := doAIChat(t, r, token); rec.Code != http.StatusOK {
		t.Fatalf("第一次应放行，got %d", rec.Code)
	}
	rec := doAIChat(t, r, token)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("ai_quota_exceeded")) {
		t.Errorf("日配额 429 响应体应是 ai_quota_exceeded；实际: %s", rec.Body.String())
	}
	if got := rec.Header().Get("Retry-After"); got != "86400" {
		t.Errorf("Retry-After 应是日窗口长度 86400，实际 %q", got)
	}
}

// 七条社区路由全部必须在受保护组内：无 token 时 401，且 401 来自 AuthMiddleware。
// 漏挂一条会变成 404（路由不存在），挪出受保护组会走到 handler 自己的 401，
// 后者没有 AuthMiddleware 的响应体，本用例靠 body 区分两者。
func TestCommunityRoutesRequireAuth(t *testing.T) {
	cfg := &config.Config{JWTSecret: testJWTSecret}
	// 只验路由与中间件，鉴权在 handler 之前拦下，碰不到 service
	r := newRouter(cfg, handlers{community: handler.NewCommunityHandler(service.NewCommunityService(nil))})

	for _, rt := range []struct{ method, path string }{
		{"GET", "/api/v1/community/recipes"},
		{"GET", "/api/v1/community/recipes/r-1"},
		{"GET", "/api/v1/users/u-1"},
		{"POST", "/api/v1/favorites/r-1"},
		{"DELETE", "/api/v1/favorites/r-1"},
		{"POST", "/api/v1/follows/u-2"},
		{"DELETE", "/api/v1/follows/u-2"},
	} {
		req := httptest.NewRequest(rt.method, rt.path, nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: got %d, want 401", rt.method, rt.path, rec.Code)
			continue
		}
		if !bytes.Contains(rec.Body.Bytes(), []byte("missing or invalid Authorization header")) {
			t.Errorf("%s %s: 401 应来自 AuthMiddleware；实际: %s", rt.method, rt.path, rec.Body.String())
		}
	}
}
