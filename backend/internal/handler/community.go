package handler

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"wee-cook/backend/internal/middleware"
	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

// communityService 抽象 CommunityHandler 依赖的 service 方法，便于 handler 层单测注入 fake。
type communityService interface {
	Favorite(ctx context.Context, userID, recipeID string) error
	Unfavorite(ctx context.Context, userID, recipeID string) error
	Follow(ctx context.Context, followerID, followeeID string) error
	Unfollow(ctx context.Context, followerID, followeeID string) error
	Profile(ctx context.Context, viewerID, userID string) (*model.UserProfile, error)
	ListPublicRecipes(ctx context.Context, viewerID string, opts model.CommunityListOptions) ([]model.CommunityRecipe, bool, error)
	GetPublicRecipe(ctx context.Context, viewerID, recipeID string) (*model.SyncPayload, error)
}

type CommunityHandler struct {
	svc communityService
}

func NewCommunityHandler(svc communityService) *CommunityHandler {
	return &CommunityHandler{svc: svc}
}

// communityListResponse 与客户端约定的 CommunityPage 一致：has_more 由服务层多取一条算出。
type communityListResponse struct {
	Items   []model.CommunityRecipe `json:"items"`
	HasMore bool                    `json:"has_more"`
}

// uidOrUnauthorized 取登录身份，缺失时写 401 并返回 false。
// 受保护分组已挡一层，这里再挡一次是为了让 handler 脱离中间件也不至于拿空 uid 查库。
func uidOrUnauthorized(w http.ResponseWriter, r *http.Request) (string, bool) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return "", false
	}
	return userID, true
}

func (h *CommunityHandler) ListRecipes(w http.ResponseWriter, r *http.Request) {
	userID, ok := uidOrUnauthorized(w, r)
	if !ok {
		return
	}

	q := r.URL.Query()
	// limit / offset 解析失败按 0 交给 service：真正的规范化（上限 / 默认值）只在 service 一处。
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))

	items, hasMore, err := h.svc.ListPublicRecipes(r.Context(), userID, model.CommunityListOptions{
		Limit:        limit,
		Offset:       offset,
		AuthorID:     q.Get("author_id"),
		FollowedOnly: q.Get("followed_only") == "1",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list community recipes")
		return
	}

	writeJSON(w, http.StatusOK, communityListResponse{Items: items, HasMore: hasMore})
}

func (h *CommunityHandler) GetRecipe(w http.ResponseWriter, r *http.Request) {
	userID, ok := uidOrUnauthorized(w, r)
	if !ok {
		return
	}

	payload, err := h.svc.GetPublicRecipe(r.Context(), userID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, service.ErrRecipeNotVisible) {
			writeError(w, http.StatusNotFound, "recipe not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load recipe")
		return
	}

	writeJSON(w, http.StatusOK, payload)
}

func (h *CommunityHandler) GetProfile(w http.ResponseWriter, r *http.Request) {
	viewerID, ok := uidOrUnauthorized(w, r)
	if !ok {
		return
	}

	profile, err := h.svc.Profile(r.Context(), viewerID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, service.ErrUserNotFound) {
			writeError(w, http.StatusNotFound, "user not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load profile")
		return
	}

	writeJSON(w, http.StatusOK, profile)
}

func (h *CommunityHandler) Favorite(w http.ResponseWriter, r *http.Request) {
	userID, ok := uidOrUnauthorized(w, r)
	if !ok {
		return
	}

	if err := h.svc.Favorite(r.Context(), userID, chi.URLParam(r, "recipe_id")); err != nil {
		if errors.Is(err, service.ErrRecipeNotVisible) {
			writeError(w, http.StatusNotFound, "recipe not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to favorite recipe")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *CommunityHandler) Unfavorite(w http.ResponseWriter, r *http.Request) {
	userID, ok := uidOrUnauthorized(w, r)
	if !ok {
		return
	}

	if err := h.svc.Unfavorite(r.Context(), userID, chi.URLParam(r, "recipe_id")); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unfavorite recipe")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *CommunityHandler) Follow(w http.ResponseWriter, r *http.Request) {
	userID, ok := uidOrUnauthorized(w, r)
	if !ok {
		return
	}

	if err := h.svc.Follow(r.Context(), userID, chi.URLParam(r, "user_id")); err != nil {
		switch {
		case errors.Is(err, service.ErrSelfFollow):
			writeError(w, http.StatusBadRequest, "cannot follow yourself")
		case errors.Is(err, service.ErrUserNotFound):
			writeError(w, http.StatusNotFound, "user not found")
		default:
			writeError(w, http.StatusInternalServerError, "failed to follow user")
		}
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *CommunityHandler) Unfollow(w http.ResponseWriter, r *http.Request) {
	userID, ok := uidOrUnauthorized(w, r)
	if !ok {
		return
	}

	if err := h.svc.Unfollow(r.Context(), userID, chi.URLParam(r, "user_id")); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unfollow user")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
