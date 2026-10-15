package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// 客户端生成的文件名形状：<uuid>.jpg。用形状而不是文件系统检查来挡路径穿越——
// 字符集只有 [0-9a-fA-F-] 加固定后缀，路径分隔符、`..`、其他后缀在正则这一关就出不去。
var fileNamePattern = regexp.MustCompile(`^[0-9a-fA-F-]{36}\.jpg$`)

func validFileName(name string) bool { return fileNamePattern.MatchString(name) }

var (
	ErrInvalidFileName = errors.New("invalid file name")
	ErrNotJPEG         = errors.New("not a jpeg")
	ErrFileTooLarge    = errors.New("file too large")
)

// jpegMagic 是 JPEG 的 SOI + 首个标记字节，只看这三字节就够（spec §8.1）。
var jpegMagic = []byte{0xFF, 0xD8, 0xFF}

type FileService struct {
	pool     *pgxpool.Pool
	filesDir string
	maxBytes int64
}

func NewFileService(pool *pgxpool.Pool, filesDir string, maxBytes int64) *FileService {
	return &FileService{pool: pool, filesDir: filesDir, maxBytes: maxBytes}
}

// MaxBytes 是单文件上限，供 handler 用 http.MaxBytesReader 在读取前就拦下超大 body。
func (s *FileService) MaxBytes() int64 { return s.maxBytes }

func (s *FileService) path(name string) string { return filepath.Join(s.filesDir, name) }

// CanRead 的可见性来自「引用它的菜谱」反查（spec §8.1 的 SQL 原文）：files 表不参与鉴权，
// 只看有没有一条「我的」菜谱引用了它，或那条菜谱是公开且未删除的（公开 = 共享给同服务器
// 所有登录用户，spec §5）。deleted_at 只筛公开那条分支：自己的菜谱删了图也不至于取不回。
// 名称形状不对直接 false——没有任何菜谱能引用这种名字，
// 回 false 让 handler 统一走 404，也不暴露路径规则。
func (s *FileService) CanRead(ctx context.Context, userID, name string) (bool, error) {
	if !validFileName(name) {
		return false, nil
	}
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM recipes r
			WHERE (r.cover_path = $1
			       OR EXISTS (SELECT 1 FROM recipe_steps s WHERE s.recipe_id = r.id AND s.image_path = $1))
			  AND (  r.owner_id = $2
			      OR (r.is_public = 1 AND r.deleted_at IS NULL)))
	`, name, userID).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("check file readability: %w", err)
	}
	return ok, nil
}

// Save 落盘并登记。幂等：同名文件已在库里登记且仍在盘上 → 直接返回库里记的 size，
// 不覆盖磁盘、不重复占空间（客户端文件名是它本地生成的 uuid，同名即同内容）。
func (s *FileService) Save(ctx context.Context, userID, name string, r io.Reader) (int64, error) {
	if !validFileName(name) {
		return 0, ErrInvalidFileName
	}
	if size, ok, err := s.storedSize(ctx, name); err != nil {
		return 0, err
	} else if ok {
		return size, nil
	}

	// 魔数不通过就连临时文件都不建
	head := make([]byte, 3)
	if _, err := io.ReadFull(r, head); err != nil || !bytes.Equal(head, jpegMagic) {
		return 0, ErrNotJPEG
	}

	// 先写 .part 再 rename：任何失败路径下，半截文件都不会以正式名出现。
	// 临时名带随机后缀：并发同名首传各写各的临时文件，os.Rename 仍是唯一的原子发布点，
	// 不会互相截断，也不会把对方未写完的文件发布成正式名。
	partPath := s.path(name) + "." + uuid.NewString() + ".part"
	f, err := os.Create(partPath)
	if err != nil {
		return 0, fmt.Errorf("create temp file: %w", err)
	}
	defer os.Remove(partPath) // rename 成功后 .part 已不存在，这里是空操作
	defer f.Close()

	// LimitReader 多放 1 字节：刚好等于上限不算超限，多读到的那一个字节才说明超了
	size, err := io.Copy(f, io.MultiReader(bytes.NewReader(head), io.LimitReader(r, s.maxBytes+1)))
	if err != nil {
		return 0, fmt.Errorf("write temp file: %w", err)
	}
	if err := f.Close(); err != nil {
		return 0, fmt.Errorf("close temp file: %w", err)
	}
	if size > s.maxBytes {
		return 0, ErrFileTooLarge
	}
	if err := os.Rename(partPath, s.path(name)); err != nil {
		return 0, fmt.Errorf("rename temp file: %w", err)
	}

	// ON CONFLICT DO NOTHING：并发重传时另一个请求先登记了，就不回行，改读库里已记的 size
	err = s.pool.QueryRow(ctx,
		`INSERT INTO files (name, owner_id, size) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING RETURNING size`,
		name, userID, size).Scan(&size)
	if errors.Is(err, pgx.ErrNoRows) {
		err = s.pool.QueryRow(ctx, `SELECT size FROM files WHERE name = $1`, name).Scan(&size)
	}
	if err != nil {
		return 0, fmt.Errorf("register file: %w", err)
	}
	return size, nil
}

// storedSize 报告同名文件是否已登记且仍在盘上。库里有行但盘上文件没了（rename 成功、
// INSERT 前进程挂掉）视为没存过，让这次上传把文件补上。
func (s *FileService) storedSize(ctx context.Context, name string) (int64, bool, error) {
	var size int64
	err := s.pool.QueryRow(ctx, `SELECT size FROM files WHERE name = $1`, name).Scan(&size)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("query stored file: %w", err)
	}
	if _, err := os.Stat(s.path(name)); err != nil {
		return 0, false, nil
	}
	return size, true, nil
}

// Open 打开图片文件，交给 handler 写回响应体。名称不合法或文件不存在都返回错误
// （库里有行、盘上没文件时也是错误，由 handler 映射成 404）。
func (s *FileService) Open(_ context.Context, name string) (*os.File, int64, error) {
	if !validFileName(name) {
		return nil, 0, ErrInvalidFileName
	}
	f, err := os.Open(s.path(name))
	if err != nil {
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, info.Size(), nil
}
