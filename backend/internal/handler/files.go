package handler

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"

	"github.com/go-chi/chi/v5"

	"wee-cook/backend/internal/middleware"
	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

// fileService 抽象 FileHandler 依赖的 service 方法，便于 handler 层单测注入 fake。
type fileService interface {
	MaxBytes() int64
	Save(ctx context.Context, userID, name string, r io.Reader) (int64, error)
	CanRead(ctx context.Context, userID, name string) (bool, error)
	Open(ctx context.Context, name string) (*os.File, int64, error)
}

type FileHandler struct {
	svc fileService
}

func NewFileHandler(svc fileService) *FileHandler {
	return &FileHandler{svc: svc}
}

// Upload 收裸二进制，文件名走查询参数（spec §8.1）：客户端本地已按这个名字落盘、
// 菜谱里引的也是这个名字，服务端只校验形状。
func (h *FileHandler) Upload(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	name := r.URL.Query().Get("name")

	// 读取前就设上限：service 自己也有计数上限，这里挡的是「超大 body 被读进来」本身
	r.Body = http.MaxBytesReader(w, r.Body, h.svc.MaxBytes())

	// 幂等命中（同名已存在）等提前返回时一行都不读 body；若不 drain，net/http 在
	// 剩余 body >256KB 时会直接放弃读取并关连接，客户端还在写体、收不到这个响应，
	// 重传就永远卡在这张图。r.Body 已被 MaxBytesReader 限住，drain 不会无界读。
	defer func() { _, _ = io.Copy(io.Discard, r.Body) }()

	size, err := h.svc.Save(r.Context(), userID, name, r.Body)
	switch {
	case errors.Is(err, service.ErrInvalidFileName):
		writeError(w, http.StatusBadRequest, "invalid file name")
	case errors.Is(err, service.ErrNotJPEG):
		writeError(w, http.StatusBadRequest, "file must be a jpeg")
	case errors.Is(err, service.ErrFileTooLarge), isBodyTooLarge(err):
		writeError(w, http.StatusRequestEntityTooLarge, "file too large")
	case err != nil:
		log.Printf("upload file %q for user %s: %v", name, userID, err)
		writeError(w, http.StatusInternalServerError, "upload failed")
	default:
		writeJSON(w, http.StatusOK, model.FileRef{Name: name, Size: size})
	}
}

// isBodyTooLarge 认 http.MaxBytesReader 超限时返回的错误；它一路被 service 用 %w 包上来，
// errors.As 能穿透，据此回 413 而不是 500。
func isBodyTooLarge(err error) bool {
	var tooLarge *http.MaxBytesError
	return errors.As(err, &tooLarge)
}

// Download 的失败一律 404：名称不合法不回 400（不泄露路径规则），不可读不回 403
// （不暴露「文件存在但你看不到」）。
func (h *FileHandler) Download(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	name := chi.URLParam(r, "name")

	ok, err := h.svc.CanRead(r.Context(), userID, name)
	if err != nil {
		log.Printf("download file %q for user %s: %v", name, userID, err)
		writeError(w, http.StatusInternalServerError, "download failed")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	f, size, err := h.svc.Open(r.Context(), name)
	if err != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	if _, err := io.Copy(w, f); err != nil {
		log.Printf("stream file %q: %v", name, err)
	}
}
