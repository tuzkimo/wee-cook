package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"wee-cook/backend/internal/service"
)

// aiService 抽象 AIHandler 依赖的方法，便于 handler 层单测注入 fake。
type aiService interface {
	Enabled() bool
	Model() string
	Host() string
	Chat(ctx context.Context, req service.AIChatRequest) (*service.AIChatResponse, error)
}

type AIHandler struct {
	svc aiService
}

// 编译期确认包内接口与真实 service 逐字一致。
var _ aiService = (*service.AIService)(nil)

func NewAIHandler(svc aiService) *AIHandler {
	return &AIHandler{svc: svc}
}

// maxAIBodyBytes 是 /ai/chat 请求体上限。var 而非 const：测试改小它来验 413。
var maxAIBodyBytes int64 = 12 << 20

type aiStatusResponse struct {
	Enabled bool   `json:"enabled"`
	Model   string `json:"model"`
	Host    string `json:"host"`
}

func (h *AIHandler) Status(w http.ResponseWriter, r *http.Request) {
	resp := aiStatusResponse{Enabled: h.svc.Enabled()}
	// 未启用时不泄露上游配置。
	if resp.Enabled {
		resp.Model = h.svc.Model()
		resp.Host = h.svc.Host()
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *AIHandler) Chat(w http.ResponseWriter, r *http.Request) {
	if !h.svc.Enabled() {
		writeError(w, http.StatusServiceUnavailable, "ai_disabled")
		return
	}

	// 全局 ReadTimeout 15s / WriteTimeout 60s 会掐断 120s 的上游等待与移动网络下的大 body（规格 §6）。
	// 只在本 handler 内解除，不动全局值。
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	r.Body = http.MaxBytesReader(w, r.Body, maxAIBodyBytes)
	var req service.AIChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "request_too_large")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}

	resp, err := h.svc.Chat(r.Context(), req)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrAIUpstreamAuth):
			writeError(w, http.StatusBadGateway, "ai_upstream_auth")
		case errors.Is(err, service.ErrAIRateLimited):
			writeError(w, http.StatusTooManyRequests, "ai_rate_limited")
		case errors.Is(err, service.ErrAIUpstreamTimeout):
			writeError(w, http.StatusGatewayTimeout, "ai_upstream_timeout")
		case errors.Is(err, service.ErrAIUnreachable):
			writeError(w, http.StatusBadGateway, "ai_unreachable")
		case errors.Is(err, service.ErrAIUpstreamError):
			writeError(w, http.StatusBadGateway, "ai_upstream_error")
		default:
			writeError(w, http.StatusInternalServerError, "internal_error")
		}
		return
	}
	writeJSON(w, http.StatusOK, resp)
}
