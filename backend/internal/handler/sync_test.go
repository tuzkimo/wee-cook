package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"wee-cook/backend/internal/middleware"
	"wee-cook/backend/internal/model"
)

// fakeSyncService 实现 syncService，供 handler 层错误映射的测试注入。
type fakeSyncService struct {
	err   error
	calls int
}

func (f *fakeSyncService) Sync(_ context.Context, _ string, _ model.SyncRequest) (*model.SyncResponse, error) {
	f.calls++
	return &model.SyncResponse{}, f.err
}

// syncRequest 构造已带鉴权身份的请求：handler 会先查 GetUserID，缺失时直接 401，
// 不注入的话 body 校验分支根本走不到。
func syncRequest(body string) *http.Request {
	req := httptest.NewRequest("POST", "/sync", bytes.NewBufferString(body))
	return req.WithContext(context.WithValue(req.Context(), middleware.UserIDKey, "user-1"))
}

func serveSync(t *testing.T, svc syncService, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := NewSyncHandler(svc)
	rec := httptest.NewRecorder()
	h.Sync(rec, syncRequest(body))
	return rec
}

// 超过 maxSyncBodyBytes 的请求必须在解析前被 MaxBytesReader 拦成 400。
// body 用合法 JSON 且长于上限：若没装上限流（限的是解析失败），本用例不会因为
// 「反正 JSON 是坏的」而误绿——那样测的就是解析错误而不是体积上限。
func TestSyncRejectsOversizedBody(t *testing.T) {
	old := maxSyncBodyBytes
	maxSyncBodyBytes = 64
	defer func() { maxSyncBodyBytes = old }()

	validButOversized := `{"last_server_seq":1234567890,"local_changes":{"ingredients":[],"units":[],"labels":[],"recipes":[],"files":[]}}`
	if len(validButOversized) <= int(maxSyncBodyBytes) {
		t.Fatalf("测试数据必须大于上限：len=%d, limit=%d", len(validButOversized), maxSyncBodyBytes)
	}

	svc := &fakeSyncService{}
	rec := serveSync(t, svc, validButOversized)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("超大 body: got %d, want 400", rec.Code)
	}
	if svc.calls != 0 {
		t.Errorf("超限请求不应触达 service；calls=%d", svc.calls)
	}
}

func TestSyncRejectsBadJSON(t *testing.T) {
	svc := &fakeSyncService{}
	rec := serveSync(t, svc, "not json")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("坏 JSON: got %d, want 400", rec.Code)
	}

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("错误响应必须是 JSON 对象: %v，实际: %s", err, rec.Body.String())
	}
	if len(body) != 1 || body["error"] == "" {
		t.Errorf("错误响应形状应为 {\"error\":\"...\"}，实际: %s", rec.Body.String())
	}
	if svc.calls != 0 {
		t.Errorf("坏 JSON 不应触达 service；calls=%d", svc.calls)
	}
}

// service 失败是服务端问题（500），不能被当成客户端 400：
// 否则客户端会把可重试的服务端故障当请求错误丢弃，数据永远同步不上。
func TestSyncServiceErrorIs500Not400(t *testing.T) {
	svc := &fakeSyncService{err: errors.New("boom")}
	rec := serveSync(t, svc, `{}`)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("service 报错: got %d, want 500", rec.Code)
	}
	if svc.calls != 1 {
		t.Errorf("service 应被调用一次；calls=%d", svc.calls)
	}
}
