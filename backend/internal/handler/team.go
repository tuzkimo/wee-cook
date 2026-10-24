package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"wee-cook/backend/internal/middleware"
	"wee-cook/backend/internal/service"
)

// teams.name 是 VARCHAR(100)，按码点计长。
const maxTeamNameRunes = 100

// teamService 抽象 TeamHandler 依赖的 service 方法，便于 handler 层单测注入 fake。
type teamService interface {
	List(ctx context.Context, userID string) ([]service.TeamSummary, error)
	Create(ctx context.Context, userID, name string) (service.TeamSummary, error)
	Invite(ctx context.Context, userID, teamID string) (string, error)
	Join(ctx context.Context, userID, code string) (service.TeamSummary, error)
	Rename(ctx context.Context, userID, teamID, name string) error
	Members(ctx context.Context, userID, teamID string) ([]service.TeamMember, error)
	RemoveMember(ctx context.Context, userID, teamID, targetID string) error
	Leave(ctx context.Context, userID, teamID string) error
	Transfer(ctx context.Context, userID, teamID, targetID string) error
	Dissolve(ctx context.Context, userID, teamID string) error
}

type TeamHandler struct {
	svc teamService
}

func NewTeamHandler(svc teamService) *TeamHandler {
	return &TeamHandler{svc: svc}
}

// teamNameRequest 是建团 / 改名共用的请求体。
type teamNameRequest struct {
	Name string `json:"name"`
}

type joinTeamRequest struct {
	Code string `json:"code"`
}

type transferTeamRequest struct {
	UserID string `json:"user_id"`
}

func (h *TeamHandler) List(w http.ResponseWriter, r *http.Request) {
	teams, err := h.svc.List(r.Context(), userIDOf(r))
	if err != nil {
		writeTeamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": teams})
}

func (h *TeamHandler) Create(w http.ResponseWriter, r *http.Request) {
	name, ok := decodeTeamName(w, r)
	if !ok {
		return
	}
	team, err := h.svc.Create(r.Context(), userIDOf(r), name)
	if err != nil {
		writeTeamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, team)
}

func (h *TeamHandler) Rename(w http.ResponseWriter, r *http.Request) {
	name, ok := decodeTeamName(w, r)
	if !ok {
		return
	}
	if err := h.svc.Rename(r.Context(), userIDOf(r), chi.URLParam(r, "id"), name); err != nil {
		writeTeamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *TeamHandler) Invite(w http.ResponseWriter, r *http.Request) {
	code, err := h.svc.Invite(r.Context(), userIDOf(r), chi.URLParam(r, "id"))
	if err != nil {
		writeTeamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}

func (h *TeamHandler) Join(w http.ResponseWriter, r *http.Request) {
	var req joinTeamRequest
	if !decodeTeamBody(w, r, &req) {
		return
	}
	if req.Code == "" {
		writeError(w, http.StatusBadRequest, "code is required")
		return
	}
	team, err := h.svc.Join(r.Context(), userIDOf(r), req.Code)
	if err != nil {
		writeTeamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, team)
}

func (h *TeamHandler) Members(w http.ResponseWriter, r *http.Request) {
	members, err := h.svc.Members(r.Context(), userIDOf(r), chi.URLParam(r, "id"))
	if err != nil {
		writeTeamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members})
}

func (h *TeamHandler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.RemoveMember(r.Context(), userIDOf(r), chi.URLParam(r, "id"), chi.URLParam(r, "userId")); err != nil {
		writeTeamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *TeamHandler) Leave(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Leave(r.Context(), userIDOf(r), chi.URLParam(r, "id")); err != nil {
		writeTeamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *TeamHandler) Transfer(w http.ResponseWriter, r *http.Request) {
	var req transferTeamRequest
	if !decodeTeamBody(w, r, &req) {
		return
	}
	if req.UserID == "" {
		writeError(w, http.StatusBadRequest, "user_id is required")
		return
	}
	if err := h.svc.Transfer(r.Context(), userIDOf(r), chi.URLParam(r, "id"), req.UserID); err != nil {
		writeTeamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *TeamHandler) Dissolve(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Dissolve(r.Context(), userIDOf(r), chi.URLParam(r, "id")); err != nil {
		writeTeamError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// userIDOf 取中间件放入的当前用户；AuthMiddleware 已拦下未登录请求，这里只做兜底。
func userIDOf(r *http.Request) string { return middleware.GetUserID(r.Context()) }

// decodeTeamBody 读 JSON 请求体（1MB 上限，与 auth 一致）。
func decodeTeamBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

// decodeTeamName 读并校验团队名：空 / 超长都 400（前端也拦，但服务端是唯一裁决者）。
func decodeTeamName(w http.ResponseWriter, r *http.Request) (string, bool) {
	var req teamNameRequest
	if !decodeTeamBody(w, r, &req) {
		return "", false
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return "", false
	}
	if utf8.RuneCountInString(req.Name) > maxTeamNameRunes {
		writeError(w, http.StatusBadRequest, "name too long")
		return "", false
	}
	return req.Name, true
}

// writeTeamError 把 service 的哨兵错误映射成 HTTP 状态：越权 403、不存在 404、其余业务错误 400。
func writeTeamError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrTeamNotFound):
		writeError(w, http.StatusNotFound, "team not found")
	case errors.Is(err, service.ErrNotTeamOwner), errors.Is(err, service.ErrNotTeamMember):
		writeError(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, service.ErrInviteInvalid):
		writeError(w, http.StatusBadRequest, "invite_invalid")
	case errors.Is(err, service.ErrOwnerCannotLeave):
		writeError(w, http.StatusBadRequest, "owner_cannot_leave")
	case errors.Is(err, service.ErrCannotRemoveOwner):
		writeError(w, http.StatusBadRequest, "cannot_remove_owner")
	case errors.Is(err, service.ErrNotMemberTarget):
		writeError(w, http.StatusBadRequest, "not_member")
	default:
		writeError(w, http.StatusInternalServerError, "team operation failed")
	}
}
