package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"wee-cook/backend/internal/middleware"
	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

// teamService 抽象 TeamHandler 依赖的 service 方法，便于 handler 层单测注入 fake。
type teamService interface {
	CreateTeam(ctx context.Context, userID, name string) (*service.CreateTeamResponse, error)
	ListMyTeams(ctx context.Context, userID string) ([]model.Team, error)
	CreateInvite(ctx context.Context, userID, teamID string) (string, error)
	JoinByInvite(ctx context.Context, userID, code string) (*service.CreateTeamResponse, error)
	ListMembers(ctx context.Context, userID, teamID string) ([]model.TeamMember, error)
}

type TeamHandler struct {
	svc teamService
}

func NewTeamHandler(svc teamService) *TeamHandler {
	return &TeamHandler{svc: svc}
}

// teams.name 是 VARCHAR(100)，Postgres 按字符（码点）计长，所以按 rune 判长——
// 与 auth.go 的 maxNameRunes 同理，用 len 会把 34 个汉字误判为超长。
const maxTeamNameRunes = 100

type createTeamRequest struct {
	Name string `json:"name"`
}

func (h *TeamHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB 上限，防超大 body DoS
	var req createTeamRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "team name is required")
		return
	}
	if utf8.RuneCountInString(req.Name) > maxTeamNameRunes {
		writeError(w, http.StatusBadRequest, "team name too long")
		return
	}

	resp, err := h.svc.CreateTeam(r.Context(), userID, req.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create team")
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

func (h *TeamHandler) List(w http.ResponseWriter, r *http.Request) {
	teams, err := h.svc.ListMyTeams(r.Context(), middleware.GetUserID(r.Context()))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list teams")
		return
	}
	writeJSON(w, http.StatusOK, teams)
}

type inviteResponse struct {
	InviteCode string `json:"invite_code"`
	ExpiresIn  int    `json:"expires_in"`
}

func (h *TeamHandler) Invite(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	teamID := chi.URLParam(r, "id")

	code, err := h.svc.CreateInvite(r.Context(), userID, teamID)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrTeamNotFound):
			writeError(w, http.StatusNotFound, "team not found")
		case errors.Is(err, service.ErrNotTeamOwner):
			writeError(w, http.StatusForbidden, "only team owner can create invite")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}

	writeJSON(w, http.StatusOK, inviteResponse{
		InviteCode: code,
		ExpiresIn:  86400,
	})
}

type joinRequest struct {
	InviteCode string `json:"invite_code"`
}

func (h *TeamHandler) Join(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req joinRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.InviteCode == "" {
		writeError(w, http.StatusBadRequest, "invite_code is required")
		return
	}

	resp, err := h.svc.JoinByInvite(r.Context(), userID, req.InviteCode)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrInviteInvalid):
			writeError(w, http.StatusBadRequest, "invalid or expired invite code")
		case errors.Is(err, service.ErrAlreadyMember):
			writeError(w, http.StatusConflict, "already a member of this team")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *TeamHandler) Members(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	teamID := chi.URLParam(r, "id")

	members, err := h.svc.ListMembers(r.Context(), userID, teamID)
	if err != nil {
		if errors.Is(err, service.ErrNotTeamMember) {
			writeError(w, http.StatusForbidden, "not a team member")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to list members")
		return
	}
	writeJSON(w, http.StatusOK, members)
}
