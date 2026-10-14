package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

// fakeTeamService 实现 teamService，供 handler 层错误映射与入参校验的测试注入。
type fakeTeamService struct {
	inviteErr  error
	joinErr    error
	membersErr error
	teams      []model.Team
}

func (fakeTeamService) CreateTeam(context.Context, string, string) (*service.CreateTeamResponse, error) {
	return &service.CreateTeamResponse{Team: model.Team{ID: "team-1", Name: "家", MemberCount: 1}}, nil
}

func (f fakeTeamService) ListMyTeams(context.Context, string) ([]model.Team, error) {
	return f.teams, nil
}

func (f fakeTeamService) CreateInvite(context.Context, string, string) (string, error) {
	if f.inviteErr != nil {
		return "", f.inviteErr
	}
	return "123456", nil
}

func (f fakeTeamService) JoinByInvite(context.Context, string, string) (*service.CreateTeamResponse, error) {
	if f.joinErr != nil {
		return nil, f.joinErr
	}
	return &service.CreateTeamResponse{Team: model.Team{ID: "team-1"}}, nil
}

func (f fakeTeamService) ListMembers(context.Context, string, string) ([]model.TeamMember, error) {
	if f.membersErr != nil {
		return nil, f.membersErr
	}
	return []model.TeamMember{}, nil
}

func TestCreateTeamHandler_MissingName(t *testing.T) {
	h := &TeamHandler{svc: fakeTeamService{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams", h.Create)

	req := httptest.NewRequest("POST", "/teams", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestCreateTeamHandler_NameTooLong(t *testing.T) {
	h := &TeamHandler{svc: fakeTeamService{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams", h.Create)

	// 101 个字符 = teams.name VARCHAR(100) 上限 + 1，必须在进入 INSERT 前拦成 400，
	// 而不是撞 SQLSTATE 22001 变成 500。
	body, _ := json.Marshal(map[string]string{"name": strings.Repeat("x", 101)})
	req := httptest.NewRequest("POST", "/teams", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

// 长度按 rune 计：60 个汉字（180 字节）没超 VARCHAR(100)，用 len 数字节会被误拦。
func TestCreateTeamHandler_MultibyteNameAccepted(t *testing.T) {
	h := &TeamHandler{svc: fakeTeamService{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams", h.Create)

	body, _ := json.Marshal(map[string]string{"name": strings.Repeat("家", 60)})
	req := httptest.NewRequest("POST", "/teams", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d", rec.Code)
	}
}

func TestJoinHandler_MissingCode(t *testing.T) {
	h := &TeamHandler{svc: fakeTeamService{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams/join", h.Join)

	req := httptest.NewRequest("POST", "/teams/join", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestJoinHandler_InvalidCode(t *testing.T) {
	h := &TeamHandler{svc: fakeTeamService{joinErr: service.ErrInviteInvalid}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams/join", h.Join)

	body, _ := json.Marshal(map[string]string{"invite_code": "999999"})
	req := httptest.NewRequest("POST", "/teams/join", bytes.NewBuffer(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "invalid or expired invite code") {
		t.Errorf("expected invite error message, got %s", rec.Body.String())
	}
}

func TestInviteHandler_NonOwnerForbidden(t *testing.T) {
	h := &TeamHandler{svc: fakeTeamService{inviteErr: service.ErrNotTeamOwner}}
	r := chi.NewRouter()
	r.Post("/teams/{id}/invite", h.Invite)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("POST", "/teams/team-1/invite", nil))

	if rec.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rec.Code)
	}
}

// 越权防护：非成员看成员列表必须 403，而不是把成员名单漏出去。
func TestMembersHandler_NonMemberForbidden(t *testing.T) {
	h := &TeamHandler{svc: fakeTeamService{membersErr: service.ErrNotTeamMember}}
	r := chi.NewRouter()
	r.Get("/teams/{id}/members", h.Members)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("GET", "/teams/team-1/members", nil))

	if rec.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rec.Code)
	}
}

// 没有团队时应回 200 + []（不是 404、也不是空 500），客户端可直接遍历。
func TestListTeamsHandler_EmptyArray(t *testing.T) {
	h := &TeamHandler{svc: fakeTeamService{teams: []model.Team{}}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /teams", h.List)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/teams", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Errorf("expected [], got %s", rec.Body.String())
	}
}

// 非 UUID 的 {id} 打真实 handler+service 链路：必须映射成 404/403，而不是 Postgres
// SQLSTATE 22P02 漏出来的 500。service 在解析 id 时便短路返回，所以这里的 nil 依赖
// （pool/redis 不参与这条路径）是安全的；若校验被删，nil db 会直接 panic 把测试打红。
func TestTeamRoutes_NonUUIDTeamID(t *testing.T) {
	h := NewTeamHandler(service.NewTeamService(nil, nil))
	r := chi.NewRouter()
	r.Post("/teams/{id}/invite", h.Invite)
	r.Get("/teams/{id}/members", h.Members)

	cases := []struct {
		name, method, path string
		want               int
	}{
		{"invite", http.MethodPost, "/teams/not-a-uuid/invite", http.StatusNotFound},
		{"members", http.MethodGet, "/teams/not-a-uuid/members", http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
			if rec.Code != tc.want {
				t.Errorf("非 UUID 的团队 id 应返回 %d，got %d（body %s）", tc.want, rec.Code, rec.Body.String())
			}
		})
	}
}
