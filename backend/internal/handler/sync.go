package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"wee-cook/backend/internal/middleware"
	"wee-cook/backend/internal/model"
)

// syncService 抽象 SyncHandler 依赖的 service 方法，便于 handler 层单测注入 fake。
type syncService interface {
	Sync(ctx context.Context, userID string, req model.SyncRequest) (*model.SyncResponse, error)
}

type SyncHandler struct {
	svc syncService
}

// 同步请求体上限。全量首同步会上传本地全部数据，故比 auth/team 的 1MB 宽松得多；
// 但仍必须设限，否则任何注册用户可用超大 body 打满服务端内存并在写事务内长时间
// 独占全局 advisory 写锁，串行化所有用户的同步（横向 DoS）。
// 用 var 而非 const，便于测试用小值触发超限分支。
var maxSyncBodyBytes int64 = 32 << 20 // 32MB

func NewSyncHandler(svc syncService) *SyncHandler {
	return &SyncHandler{svc: svc}
}

func (h *SyncHandler) Sync(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxSyncBodyBytes)

	var req model.SyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("sync bad request for user %s: %v", userID, err)
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	resp, err := h.svc.Sync(r.Context(), userID, req)
	if err != nil {
		log.Printf("sync error for user %s: %v", userID, err)
		writeError(w, http.StatusInternalServerError, "sync failed")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}
