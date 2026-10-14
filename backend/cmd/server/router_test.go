package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"wee-cook/backend/internal/config"
	"wee-cook/backend/internal/handler"
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
