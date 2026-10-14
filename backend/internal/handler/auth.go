package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"unicode/utf8"

	"wee-cook/backend/internal/middleware"
	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

// authService 抽象 AuthHandler 依赖的 service 方法，便于 handler 层单测
// 注入 mock 以覆盖错误映射路径（如账号枚举话术）。
type authService interface {
	Register(ctx context.Context, req model.RegisterRequest) (*model.AuthResponse, error)
	Login(ctx context.Context, req model.LoginRequest) (*model.AuthResponse, error)
	Refresh(ctx context.Context, req model.RefreshRequest) (*model.AuthResponse, error)
	GetMe(ctx context.Context, userID string) (*service.MeResponse, error)
	UpdateProfile(ctx context.Context, userID string, req model.UpdateProfileRequest) (*model.User, error)
}

// users.username / users.nickname 是 VARCHAR(50)，Postgres 按字符（码点）计长。
// 用 utf8.RuneCountInString 而不是 len：len 数字节，26 个汉字会被误判为超长。
const maxNameRunes = 50

// bcrypt 的口令上限是 72 字节（GenerateFromPassword 超过即返 ErrPasswordTooLong），
// 提前拦成 400，否则会被包成 500，让客户端误以为是服务器故障。
const maxPasswordBytes = 72

func nameTooLong(s string) bool { return utf8.RuneCountInString(s) > maxNameRunes }

type AuthHandler struct {
	svc authService
}

func NewAuthHandler(svc authService) *AuthHandler {
	return &AuthHandler{svc: svc}
}

func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB 上限，防超大 body DoS
	var req model.RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password are required")
		return
	}
	if nameTooLong(req.Username) || nameTooLong(req.Nickname) {
		writeError(w, http.StatusBadRequest, "username or nickname too long")
		return
	}
	if len(req.Password) > maxPasswordBytes {
		writeError(w, http.StatusBadRequest, "password too long")
		return
	}

	resp, err := h.svc.Register(r.Context(), req)
	if errors.Is(err, service.ErrUsernameTaken) {
		writeError(w, http.StatusConflict, "username unavailable")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req model.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password are required")
		return
	}

	resp, err := h.svc.Login(r.Context(), req)
	if errors.Is(err, service.ErrInvalidLogin) {
		writeError(w, http.StatusUnauthorized, "invalid username or password")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req model.RefreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.RefreshToken == "" {
		writeError(w, http.StatusBadRequest, "refresh_token is required")
		return
	}

	resp, err := h.svc.Refresh(r.Context(), req)
	if errors.Is(err, service.ErrInvalidToken) || errors.Is(err, service.ErrUserNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid or expired refresh token")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	resp, err := h.svc.GetMe(r.Context(), userID)
	if errors.Is(err, service.ErrUserNotFound) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *AuthHandler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req model.UpdateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Nickname != nil && nameTooLong(*req.Nickname) {
		writeError(w, http.StatusBadRequest, "nickname too long")
		return
	}
	user, err := h.svc.UpdateProfile(r.Context(), userID, req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, user)
}
