package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"

	"wee-cook/backend/internal/middleware"
	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

// fakeFileService 实现 fileService，供 handler 层错误映射的测试注入。
type fakeFileService struct {
	maxBytes   int64
	saveSize   int64
	saveErr    error
	saveName   string
	canRead    bool
	canReadErr error
	openFile   *os.File
	openSize   int64
	openErr    error
}

func (f *fakeFileService) MaxBytes() int64 { return f.maxBytes }

func (f *fakeFileService) Save(_ context.Context, _, name string, _ io.Reader) (int64, error) {
	f.saveName = name
	return f.saveSize, f.saveErr
}

func (f *fakeFileService) CanRead(context.Context, string, string) (bool, error) {
	return f.canRead, f.canReadErr
}

func (f *fakeFileService) Open(context.Context, string) (*os.File, int64, error) {
	return f.openFile, f.openSize, f.openErr
}

// fileRequest 构造带鉴权身份的请求；name 非空时同时挂上 chi 的 URL 参数。
func fileRequest(method, target, name string, body []byte) *http.Request {
	req := httptest.NewRequest(method, target, bytes.NewReader(body))
	ctx := context.WithValue(req.Context(), middleware.UserIDKey, "u-1")
	if name != "" {
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("name", name)
		ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	}
	return req.WithContext(ctx)
}

// TestUploadRejectsTraversalName 用真 FileService（不是 fake）才能钉住「拒绝发生在落盘之前」。
// pool 传 nil：合法实现的名称校验早于任何 DB 访问，若实现把顺序反过来，这里会立刻 panic 而不是误绿。
func TestUploadRejectsTraversalName(t *testing.T) {
	dir := t.TempDir()
	h := NewFileHandler(service.NewFileService(nil, dir, 1<<20))

	rec := httptest.NewRecorder()
	h.Upload(rec, fileRequest("POST", "/api/v1/files?name="+url.QueryEscape("../../etc/passwd"), "", []byte{0xFF, 0xD8, 0xFF}))

	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusNotFound {
		t.Errorf("带路径的文件名必须被拒绝，实际状态码: %d", rec.Code)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("FILES_DIR 里不该有任何写入，实际: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(dir, "..", "..", "etc")); err == nil {
		t.Error("不得在 FILES_DIR 之外创建路径")
	}
}

func TestUploadSuccess(t *testing.T) {
	svc := &fakeFileService{maxBytes: 1 << 20, saveSize: 1234}
	h := NewFileHandler(svc)

	rec := httptest.NewRecorder()
	h.Upload(rec, fileRequest("POST", "/api/v1/files?name=x.jpg", "", []byte{0xFF, 0xD8, 0xFF}))

	if rec.Code != http.StatusOK {
		t.Fatalf("上传成功应回 200，实际: %d", rec.Code)
	}
	var got model.FileRef
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("响应不是预期的 JSON: %v（body=%s）", err, rec.Body.String())
	}
	if got.Name != "x.jpg" || got.Size != 1234 {
		t.Errorf("响应 = %+v, want name=x.jpg size=1234", got)
	}
}

// MaxBytesReader 超限时返回 *http.MaxBytesError，service 用 %w 包着传上来，handler 必须
// 认出来映射成 413 而不是 500。
func TestUploadOversizedBodyIs413(t *testing.T) {
	svc := &fakeFileService{
		maxBytes: 8,
		saveErr:  fmt.Errorf("write temp file: %w", &http.MaxBytesError{Limit: 8}),
	}
	h := NewFileHandler(svc)

	rec := httptest.NewRecorder()
	h.Upload(rec, fileRequest("POST", "/api/v1/files?name=x.jpg", "", []byte{0xFF, 0xD8, 0xFF}))

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("超限 body 应回 413，实际: %d", rec.Code)
	}
}

// 库里有行、盘上没文件：Open 报错，同样 404（spec §8.1）。
func TestDownloadMissingFileIs404(t *testing.T) {
	svc := &fakeFileService{canRead: true, openErr: os.ErrNotExist}
	h := NewFileHandler(svc)

	rec := httptest.NewRecorder()
	h.Download(rec, fileRequest("GET", "/api/v1/files/x.jpg", "x.jpg", nil))

	if rec.Code != http.StatusNotFound {
		t.Errorf("磁盘缺文件应回 404，实际: %d", rec.Code)
	}
}

func TestDownloadUnauthorizedIs404(t *testing.T) {
	svc := &fakeFileService{canRead: false}
	h := NewFileHandler(svc)

	rec := httptest.NewRecorder()
	h.Download(rec, fileRequest("GET", "/api/v1/files/x.jpg", "x.jpg", nil))

	// 404 而不是 403：不暴露「文件存在但你看不到」
	if rec.Code != http.StatusNotFound {
		t.Errorf("不可读应回 404，实际: %d", rec.Code)
	}
}

func TestDownloadSuccess(t *testing.T) {
	content := []byte{0xFF, 0xD8, 0xFF, 0x11, 0x22}
	path := filepath.Join(t.TempDir(), "x.jpg")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	h := NewFileHandler(&fakeFileService{canRead: true, openFile: f, openSize: int64(len(content))})
	rec := httptest.NewRecorder()
	h.Download(rec, fileRequest("GET", "/api/v1/files/x.jpg", "x.jpg", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("可读文件应回 200，实际: %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Errorf("Content-Type = %q, want image/jpeg", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), content) {
		t.Errorf("响应体 = %v, want %v", rec.Body.Bytes(), content)
	}
}
