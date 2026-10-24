package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"wee-cook/backend/internal/service"
)

// fakeTeam 是只为错误映射服务的假实现：每个方法返回 sendErr。
type fakeTeam struct {
	sendErr error
	created bool
}

func (f *fakeTeam) List(context.Context, string) ([]service.TeamSummary, error) {
	return []service.TeamSummary{{ID: "t-1", Name: "自己家", Role: "owner", MemberCount: 1}}, f.sendErr
}

func (f *fakeTeam) Create(_ context.Context, _, name string) (service.TeamSummary, error) {
	f.created = name != ""
	return service.TeamSummary{ID: "t-1", Name: name, Role: "owner", MemberCount: 1}, f.sendErr
}

func (f *fakeTeam) Invite(context.Context, string, string) (string, error) {
	return "123456", f.sendErr
}
func (f *fakeTeam) Join(context.Context, string, string) (service.TeamSummary, error) {
	return service.TeamSummary{ID: "t-1", Role: "member"}, f.sendErr
}
func (f *fakeTeam) Rename(context.Context, string, string, string) error { return f.sendErr }
func (f *fakeTeam) Members(context.Context, string, string) ([]service.TeamMember, error) {
	return []service.TeamMember{{UserID: "u-1", Nickname: "我", Username: "me", Role: "owner"}}, f.sendErr
}
func (f *fakeTeam) RemoveMember(context.Context, string, string, string) error { return f.sendErr }
func (f *fakeTeam) Leave(context.Context, string, string) error                { return f.sendErr }
func (f *fakeTeam) Transfer(context.Context, string, string, string) error     { return f.sendErr }
func (f *fakeTeam) Dissolve(context.Context, string, string) error             { return f.sendErr }

// teamRequest 发一条带 userID 的请求（AuthMiddleware 在生产链上负责放这个值）。
func teamRequest(t *testing.T, h http.HandlerFunc, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	rec := httptest.NewRecorder()
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "t-1")
	rctx.URLParams.Add("userId", "u-2")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	req.Header.Set("Content-Type", "application/json")
	h(rec, req)
	return rec
}

// 越权 403、不存在 404、其余业务错误 400：客户端靠状态码决定是「找 owner」还是「重试」。
func TestTeamErrorMapping(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
		code string
	}{
		{"不是 owner", service.ErrNotTeamOwner, http.StatusForbidden, "forbidden"},
		{"不是成员", service.ErrNotTeamMember, http.StatusForbidden, "forbidden"},
		{"团队不存在", service.ErrTeamNotFound, http.StatusNotFound, "team not found"},
		{"邀请码失效", service.ErrInviteInvalid, http.StatusBadRequest, "invite_invalid"},
		{"owner 不能退出", service.ErrOwnerCannotLeave, http.StatusBadRequest, "owner_cannot_leave"},
		{"不能移除 owner", service.ErrCannotRemoveOwner, http.StatusBadRequest, "cannot_remove_owner"},
		{"目标不是成员", service.ErrNotMemberTarget, http.StatusBadRequest, "not_member"},
		{"未知错误", context.DeadlineExceeded, http.StatusInternalServerError, "team operation failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := NewTeamHandler(&fakeTeam{sendErr: c.err})
			rec := teamRequest(t, h.Dissolve, "DELETE", "/api/v1/teams/t-1", "")
			if rec.Code != c.want {
				t.Fatalf("状态码 = %d, want %d；响应体: %s", rec.Code, c.want, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), c.code) {
				t.Errorf("响应体应含 %q，实际: %s", c.code, rec.Body.String())
			}
		})
	}
}

func TestTeamListReturnsTeams(t *testing.T) {
	h := NewTeamHandler(&fakeTeam{})
	rec := teamRequest(t, h.List, "GET", "/api/v1/teams", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, want 200；响应体: %s", rec.Code, rec.Body.String())
	}
	for _, want := range []string{`"teams"`, `"自己家"`, `"owner"`, `"member_count":1`} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("响应体缺 %s；实际: %s", want, rec.Body.String())
		}
	}
}

// 团队名空 / 超长都是 400，且不触达 service（nameTooLong 的边界 100 码点）。
func TestTeamCreateValidatesName(t *testing.T) {
	svc := &fakeTeam{}
	h := NewTeamHandler(svc)

	rec := teamRequest(t, h.Create, "POST", "/api/v1/teams", `{"name":""}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("空名字: got %d, want 400", rec.Code)
	}
	rec = teamRequest(t, h.Create, "POST", "/api/v1/teams", `{"name":"`+strings.Repeat("家", 101)+`"}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("超长名字: got %d, want 400", rec.Code)
	}
	if svc.created {
		t.Error("校验失败的请求不该触达 service")
	}
}
