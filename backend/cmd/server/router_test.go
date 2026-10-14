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

// fakeTeamService 只实现 handler.teamService 需要的方法（结构化满足未导出接口），
// 让路由测试不碰数据库也能走到 handler。
type fakeTeamService struct{}

func (fakeTeamService) CreateTeam(context.Context, string, string) (*service.CreateTeamResponse, error) {
	return &service.CreateTeamResponse{}, nil
}

func (fakeTeamService) ListMyTeams(context.Context, string) ([]model.Team, error) {
	return []model.Team{}, nil
}

func (fakeTeamService) CreateInvite(context.Context, string, string) (string, error) {
	return "123456", nil
}

func (fakeTeamService) JoinByInvite(context.Context, string, string) (*service.CreateTeamResponse, error) {
	return &service.CreateTeamResponse{}, nil
}

func (fakeTeamService) ListMembers(context.Context, string, string) ([]model.TeamMember, error) {
	return []model.TeamMember{}, nil
}

func newTeamRouter() http.Handler {
	cfg := &config.Config{JWTSecret: testJWTSecret}
	return newRouter(cfg, handlers{
		auth: handler.NewAuthHandler(nil),
		team: handler.NewTeamHandler(fakeTeamService{}),
	})
}

// 所有 /teams 路由都必须在受保护组内：无 token 时 401（404 说明路由没注册，
// 401 才证明它挂在 AuthMiddleware 后面）。
func TestTeamRoutesRequireAuth(t *testing.T) {
	routes := []struct{ method, path string }{
		{"GET", "/api/v1/teams"},
		{"POST", "/api/v1/teams"},
		{"POST", "/api/v1/teams/team-1/invite"},
		{"GET", "/api/v1/teams/team-1/members"},
		{"POST", "/api/v1/teams/join"},
	}

	for _, rt := range routes {
		req := httptest.NewRequest(rt.method, rt.path, nil)
		rec := httptest.NewRecorder()
		newTeamRouter().ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: got %d, want 401", rt.method, rt.path, rec.Code)
			continue
		}
		if !bytes.Contains(rec.Body.Bytes(), []byte("missing or invalid Authorization header")) {
			t.Errorf("%s %s: 401 应来自 AuthMiddleware；实际: %s", rt.method, rt.path, rec.Body.String())
		}
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

// /teams/join 是 6 位邀请码的爆破面：同一 IP 超过 10 次/分钟必须 429。
func TestJoinRouteIsRateLimitedPerIP(t *testing.T) {
	r := newTeamRouter()
	token := mintTestToken(t, "access")

	for i := 1; i <= 11; i++ {
		req := httptest.NewRequest("POST", "/api/v1/teams/join", bytes.NewBufferString(`{"invite_code":"123456"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		want := http.StatusOK
		if i == 11 {
			want = http.StatusTooManyRequests
		}
		if rec.Code != want {
			t.Errorf("第 %d 次 join: got %d, want %d", i, rec.Code, want)
		}
	}
}
