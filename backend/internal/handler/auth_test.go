package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"wee-cook/backend/internal/middleware"
	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

// fakeAuthService implements the handler's authService interface for tests
// that need to exercise the service-error mapping paths (e.g. enumeration).
type fakeAuthService struct {
	registerErr error
	getMeErr    error
}

func (f fakeAuthService) Register(_ context.Context, _ model.RegisterRequest) (*model.AuthResponse, error) {
	return nil, f.registerErr
}

func (f fakeAuthService) Login(_ context.Context, _ model.LoginRequest) (*model.AuthResponse, error) {
	return nil, nil
}

func (f fakeAuthService) Refresh(_ context.Context, _ model.RefreshRequest) (*model.AuthResponse, error) {
	return nil, nil
}

func (f fakeAuthService) GetMe(_ context.Context, _ string) (*service.MeResponse, error) {
	return nil, f.getMeErr
}

func (f fakeAuthService) UpdateProfile(_ context.Context, _ string, _ model.UpdateProfileRequest) (*model.User, error) {
	return nil, nil
}

func TestRegisterHandler_InvalidJSON(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBufferString("not json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRegisterHandler_MissingFields(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{"username": "testuser"})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestLoginHandler_MissingFields(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/login", h.Login)

	body, _ := json.Marshal(map[string]string{"username": "testuser"})
	req := httptest.NewRequest("POST", "/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRefreshHandler_MissingToken(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/refresh", h.Refresh)

	body, _ := json.Marshal(map[string]string{})
	req := httptest.NewRequest("POST", "/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRegister_EnumerationResistant(t *testing.T) {
	h := &AuthHandler{svc: fakeAuthService{registerErr: service.ErrUsernameTaken}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{"username": "taken", "password": "secret"})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Errorf("expected 409, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "already") {
		t.Errorf("response leaks account existence: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "username unavailable") {
		t.Errorf("expected generic message, got %s", rec.Body.String())
	}
}

func TestRegisterHandler_UsernameTooLong(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	// 51 字符 = users 表 VARCHAR(50) 上限 + 1，必须在进入 INSERT 前拦成 400，
	// 而不是撞 SQLSTATE 22001 变成 500。
	body, _ := json.Marshal(map[string]string{
		"username": strings.Repeat("a", 51),
		"password": "secret",
	})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRegisterHandler_NicknameTooLong(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{
		"username": "ok",
		"password": "secret",
		"nickname": strings.Repeat("n", 51),
	})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

// 边界按 rune 计：50 字符放行；26 个汉字（78 字节）也必须放行，
// len() 数字节会把后者误判超长。
func TestRegisterHandler_NameAtRuneLimitAccepted(t *testing.T) {
	h := &AuthHandler{svc: fakeAuthService{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{
		"username": strings.Repeat("a", 50),
		"password": "secret",
		"nickname": strings.Repeat("汉", 26),
	})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d", rec.Code)
	}
}

// 服务器库被重建后，token 仍有效但用户行已不在：/me 必须回 401（不是 500），
// 客户端据此走「401 → refresh → 401 → 登出重新注册」的自愈链。
func TestMeHandler_UserNotFoundReturns401(t *testing.T) {
	h := &AuthHandler{svc: fakeAuthService{getMeErr: service.ErrUserNotFound}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /me", h.Me)

	req := httptest.NewRequest("GET", "/me", nil)
	req = req.WithContext(context.WithValue(req.Context(), middleware.UserIDKey, "ghost"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

// bcrypt 对 >72 字节口令返回 ErrPasswordTooLong，必须在进 service 前拦成 400，
// 否则会被包成 500（客户端以为是服务器故障而不是「密码太长」）。
func TestRegisterHandler_PasswordTooLong(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{
		"username": "ok",
		"password": strings.Repeat("a", 73),
	})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestUpdateProfileHandler_NicknameTooLong(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /auth/profile", h.UpdateProfile)

	body, _ := json.Marshal(map[string]string{"nickname": strings.Repeat("n", 51)})
	req := httptest.NewRequest("PUT", "/auth/profile", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}
