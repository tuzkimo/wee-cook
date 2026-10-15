package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"wee-cook/backend/internal/middleware"
	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

// fakeCommunityService 实现 communityService，供 handler 层入参与错误映射测试注入。
// 指针接收：ListRecipes 用例要回读被传进来的 opts。
type fakeCommunityService struct {
	listOpts    model.CommunityListOptions
	listItems   []model.CommunityRecipe
	listHasMore bool
	listErr     error

	detailErr   error
	profileErr  error
	favoriteErr error
	followErr   error
}

func (f *fakeCommunityService) Favorite(context.Context, string, string) error {
	return f.favoriteErr
}

func (f *fakeCommunityService) Unfavorite(context.Context, string, string) error { return nil }

func (f *fakeCommunityService) Follow(context.Context, string, string) error { return f.followErr }

func (f *fakeCommunityService) Unfollow(context.Context, string, string) error { return nil }

func (f *fakeCommunityService) Profile(context.Context, string, string) (*model.UserProfile, error) {
	if f.profileErr != nil {
		return nil, f.profileErr
	}
	return &model.UserProfile{ID: "user-2"}, nil
}

func (f *fakeCommunityService) ListPublicRecipes(_ context.Context, _ string, opts model.CommunityListOptions) ([]model.CommunityRecipe, bool, error) {
	f.listOpts = opts
	return f.listItems, f.listHasMore, f.listErr
}

func (f *fakeCommunityService) GetPublicRecipe(context.Context, string, string) (*model.SyncPayload, error) {
	if f.detailErr != nil {
		return nil, f.detailErr
	}
	return &model.SyncPayload{}, nil
}

// communityRequest 构造已带鉴权身份的请求：不注入时 handler 会走 401 分支。
func communityRequest(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	return req.WithContext(context.WithValue(req.Context(), middleware.UserIDKey, "user-1"))
}

// 未登录（上下文里没有 uid）时列表必须 401，不能拿空 uid 去查库。
func TestCommunityListRequiresAuth(t *testing.T) {
	h := NewCommunityHandler(&fakeCommunityService{})
	rec := httptest.NewRecorder()
	h.ListRecipes(rec, httptest.NewRequest("GET", "/community/recipes", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录访问社区列表: got %d, want 401", rec.Code)
	}
}

// 四个查询参数必须原样传给 service（规范化由 service 负责，handler 不补默认值）。
func TestCommunityListPassesQueryParams(t *testing.T) {
	svc := &fakeCommunityService{}
	h := NewCommunityHandler(svc)
	rec := httptest.NewRecorder()
	h.ListRecipes(rec, communityRequest("GET", "/community/recipes?limit=5&offset=10&author_id=u-2&followed_only=1"))

	if rec.Code != http.StatusOK {
		t.Fatalf("列表: got %d, want 200；body: %s", rec.Code, rec.Body.String())
	}
	want := model.CommunityListOptions{Limit: 5, Offset: 10, AuthorID: "u-2", FollowedOnly: true}
	if svc.listOpts != want {
		t.Errorf("传给 service 的 opts = %+v, want %+v", svc.listOpts, want)
	}
}

// 不存在 / 未公开 / 已删都映射 404，不能漏成 500。
func TestCommunityDetailNotVisibleIs404(t *testing.T) {
	h := NewCommunityHandler(&fakeCommunityService{detailErr: service.ErrRecipeNotVisible})
	r := chi.NewRouter()
	r.Get("/community/recipes/{id}", h.GetRecipe)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, communityRequest("GET", "/community/recipes/r-1"))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("不可见菜谱详情: got %d, want 404；body: %s", rec.Code, rec.Body.String())
	}
}

// 收藏不可见的菜谱必须 404（幂等写入不掩盖可见性校验）。
func TestFavoriteRecipeNotVisibleIs404(t *testing.T) {
	h := NewCommunityHandler(&fakeCommunityService{favoriteErr: service.ErrRecipeNotVisible})
	r := chi.NewRouter()
	r.Post("/favorites/{recipe_id}", h.Favorite)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, communityRequest("POST", "/favorites/r-1"))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("收藏不可见菜谱: got %d, want 404；body: %s", rec.Code, rec.Body.String())
	}
}

// 关注自己映射 400，不是 500。
func TestFollowSelfIs400(t *testing.T) {
	h := NewCommunityHandler(&fakeCommunityService{followErr: service.ErrSelfFollow})
	r := chi.NewRouter()
	r.Post("/follows/{user_id}", h.Follow)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, communityRequest("POST", "/follows/user-1"))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("关注自己: got %d, want 400；body: %s", rec.Code, rec.Body.String())
	}
}

// 用户不存在映射 404。
func TestProfileUnknownUserIs404(t *testing.T) {
	h := NewCommunityHandler(&fakeCommunityService{profileErr: service.ErrUserNotFound})
	r := chi.NewRouter()
	r.Get("/users/{id}", h.GetProfile)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, communityRequest("GET", "/users/nobody"))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("未知用户资料: got %d, want 404；body: %s", rec.Code, rec.Body.String())
	}
}
