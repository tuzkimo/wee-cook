package service

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"wee-cook/backend/internal/database"
)

// 图片的读权限完全由「有没有一条我的菜谱引用了它」这条 SQL 决定（spec §8.1），
// fake querier 无法表达「同一个文件名被多条菜谱引用」这类语义，
// 所以这一组用例起真 postgres。容器由一个 sync.Once 里的池共用，各用例用随机 UUID 的
// id / 文件名，互不干扰（迁移只需跑一次）。
var (
	filesTestPoolOnce sync.Once
	filesTestPool     *pgxpool.Pool
	filesTestPoolErr  error
)

func filesTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	filesTestPoolOnce.Do(func() {
		ctx := context.Background()
		pg, err := postgres.Run(ctx, "postgres:16-alpine",
			postgres.WithDatabase("test"),
			postgres.WithUsername("test"),
			postgres.WithPassword("test"),
			postgres.BasicWaitStrategies(),
		)
		if err != nil {
			filesTestPoolErr = err
			return
		}
		dsn, err := pg.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			filesTestPoolErr = err
			return
		}
		if err := database.RunMigrations(dsn); err != nil {
			filesTestPoolErr = err
			return
		}
		pool, err := database.NewPool(ctx, dsn)
		if err != nil {
			filesTestPoolErr = err
			return
		}
		filesTestPool = pool
	})
	if filesTestPoolErr != nil {
		t.Fatalf("测试数据库不可用: %v", filesTestPoolErr)
	}
	return filesTestPool
}

// --- seed 辅助：只填 canRead 关心的列，其余留默认 ---

func seedUser(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (username, nickname, password_hash) VALUES ($1, '测试', 'x') RETURNING id`,
		"u-"+uuid.NewString()).Scan(&id); err != nil {
		t.Fatalf("插入用户失败: %v", err)
	}
	return id
}

// seedRecipe 插入一条菜谱；coverPath 为 nil 表示无封面，deleted 决定 deleted_at。
func seedRecipe(t *testing.T, pool *pgxpool.Pool, ownerID string, coverPath *string, deleted bool) string {
	t.Helper()
	var deletedAt *time.Time
	if deleted {
		now := time.Now()
		deletedAt = &now
	}
	id := "r-" + uuid.NewString()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO recipes (id, owner_id, is_public, name, cover_path, category_id, created_at, updated_at, deleted_at)
		VALUES ($1, $2, 0, '红烧肉', $3, 'cat-1', NOW(), NOW(), $4)`,
		id, ownerID, coverPath, deletedAt); err != nil {
		t.Fatalf("插入菜谱失败: %v", err)
	}
	return id
}

// seedPublicRecipe 在 seedRecipe 之上把 is_public 置 1。不改 seedRecipe 签名：它有十几个调用点，
// 大部分在清单外的文件里，加参数会牵动它们。
func seedPublicRecipe(t *testing.T, pool *pgxpool.Pool, ownerID string, coverPath *string, deleted bool) string {
	t.Helper()
	id := seedRecipe(t, pool, ownerID, coverPath, deleted)
	if _, err := pool.Exec(context.Background(), `UPDATE recipes SET is_public = 1 WHERE id = $1`, id); err != nil {
		t.Fatalf("置为公开失败: %v", err)
	}
	return id
}

func seedStepImage(t *testing.T, pool *pgxpool.Pool, recipeID, imagePath string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO recipe_steps (id, recipe_id, sort_order, image_path) VALUES ($1, $2, 0, $3)`,
		"s-"+uuid.NewString(), recipeID, imagePath); err != nil {
		t.Fatalf("插入步骤失败: %v", err)
	}
}

func assertCanRead(t *testing.T, svc *FileService, userID, name string, want bool) {
	t.Helper()
	got, err := svc.CanRead(context.Background(), userID, name)
	if err != nil {
		t.Fatalf("CanRead(%s) 出错: %v", name, err)
	}
	if got != want {
		t.Errorf("CanRead(%s) = %v, want %v", name, got, want)
	}
}

func newFileService(t *testing.T) (*FileService, *pgxpool.Pool) {
	t.Helper()
	pool := filesTestDB(t)
	return NewFileService(pool, t.TempDir(), 5<<20), pool
}

func newFileName() string { return uuid.NewString() + ".jpg" }

// --- 读权限 ---

func TestCanReadPrivateFileOnlyForOwner(t *testing.T) {
	svc, pool := newFileService(t)
	a := seedUser(t, pool)
	b := seedUser(t, pool)
	file := newFileName()
	// 通过步骤图引用（覆盖 recipe_steps.image_path 分支）
	seedStepImage(t, pool, seedRecipe(t, pool, a, nil, false), file)

	assertCanRead(t, svc, a, file, true)
	assertCanRead(t, svc, b, file, false)
}

// 可见性跟着「引用它的那条菜谱」走，不看 files 的 owner_id：同一个文件名先被 A 的菜谱引用，
// 随后又被 B 的菜谱引用，B 也必须读得到——这条钉子防的是
// 「只认第一次引用它的那条菜谱 / 只认 files 的归属」那类实现。
func TestCanReadFileReferencedByLaterRecipe(t *testing.T) {
	svc, pool := newFileService(t)
	a := seedUser(t, pool)
	b := seedUser(t, pool)

	file := newFileName()
	seedRecipe(t, pool, a, &file, false) // 先被 A 的菜谱引用
	bRecipe := seedRecipe(t, pool, b, nil, false)
	seedStepImage(t, pool, bRecipe, file) // 随后又被 B 的菜谱引用

	assertCanRead(t, svc, b, file, true)
	assertCanRead(t, svc, a, file, true)
}

func TestCanReadSoftDeletedRecipeFile(t *testing.T) {
	svc, pool := newFileService(t)
	a := seedUser(t, pool)
	file := newFileName()
	seedRecipe(t, pool, a, &file, true)

	assertCanRead(t, svc, a, file, true)
}

// 公开菜谱是共享给「同一个服务器上的所有登录用户」的，图片必须跟着菜谱走（spec §5 / §8）。
func TestCanReadPublicRecipeImageByStranger(t *testing.T) {
	svc, pool := newFileService(t)
	a := seedUser(t, pool)
	b := seedUser(t, pool)
	file := newFileName()
	seedPublicRecipe(t, pool, a, &file, false)

	assertCanRead(t, svc, a, file, true)
	assertCanRead(t, svc, b, file, true)
}

func TestCanReadPrivateRecipeImageByStrangerIsFalse(t *testing.T) {
	svc, pool := newFileService(t)
	a := seedUser(t, pool)
	b := seedUser(t, pool)
	file := newFileName()
	// 走步骤图引用，把公开条件也钉在 recipe_steps 那条分支上
	seedStepImage(t, pool, seedRecipe(t, pool, a, nil, false), file)

	assertCanRead(t, svc, b, file, false)
}

// deleted_at 只筛公开那条分支：公开菜谱删了，陌生人读不到；作者仍读得到。
func TestCanReadDeletedPublicRecipeImageByStrangerIsFalse(t *testing.T) {
	svc, pool := newFileService(t)
	a := seedUser(t, pool)
	b := seedUser(t, pool)
	file := newFileName()
	seedPublicRecipe(t, pool, a, &file, true)

	assertCanRead(t, svc, a, file, true)
	assertCanRead(t, svc, b, file, false)
}

func TestCanReadUnknownFileIsFalse(t *testing.T) {
	svc, pool := newFileService(t)
	a := seedUser(t, pool)

	// 没有任何菜谱引用：孤儿图谁都读不了
	assertCanRead(t, svc, a, newFileName(), false)
}

func TestValidFileName(t *testing.T) {
	const valid = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.jpg"
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"合法", valid, true},
		{"大写十六进制", "3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B.jpg", true},
		{"路径穿越", "../x.jpg", false},
		{"带目录", "a/b.jpg", false},
		{"Windows 分隔符", `..\x.jpg`, false},
		{"非 jpg", "x.png", false},
		{"后缀大写", "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.JPG", false},
		{"uuid 短一位", "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5.jpg", false},
		{"空串", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := validFileName(c.in); got != c.want {
				t.Errorf("validFileName(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

// jpegBytes 造一个长度可控的假 JPEG：Save 只认前三个字节是 FF D8 FF，不解析内容。
func jpegBytes(n int) []byte {
	b := make([]byte, n)
	copy(b, []byte{0xFF, 0xD8, 0xFF})
	return b
}

func TestSaveRejectsOversizedFile(t *testing.T) {
	pool := filesTestDB(t)
	dir := t.TempDir()
	owner := seedUser(t, pool)
	svc := NewFileService(pool, dir, 8)

	_, err := svc.Save(context.Background(), owner, newFileName(), bytes.NewReader(jpegBytes(100)))
	if !errors.Is(err, ErrFileTooLarge) {
		t.Fatalf("超限应返回 ErrFileTooLarge，实际: %v", err)
	}
	// 半截文件不能以正式名或 .part 的形式留下
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("超限后 FILES_DIR 应无残留，实际: %v", entries)
	}
}

func TestSaveRejectsNonJPEG(t *testing.T) {
	pool := filesTestDB(t)
	dir := t.TempDir()
	owner := seedUser(t, pool)
	svc := NewFileService(pool, dir, 5<<20)

	_, err := svc.Save(context.Background(), owner, newFileName(), bytes.NewReader([]byte("这不是 JPEG")))
	if !errors.Is(err, ErrNotJPEG) {
		t.Fatalf("非 JPEG 应返回 ErrNotJPEG，实际: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("拒绝后 FILES_DIR 应无残留，实际: %v", entries)
	}
}

// 幂等：同名再传不覆盖磁盘、不重复登记，返回库里记的 size（spec §8.1）。
func TestSaveSameNameIsIdempotent(t *testing.T) {
	pool := filesTestDB(t)
	dir := t.TempDir()
	owner := seedUser(t, pool)
	svc := NewFileService(pool, dir, 5<<20)
	name := newFileName()

	first := jpegBytes(64)
	size, err := svc.Save(context.Background(), owner, name, bytes.NewReader(first))
	if err != nil {
		t.Fatalf("首次上传失败: %v", err)
	}
	if size != int64(len(first)) {
		t.Fatalf("size = %d, want %d", size, len(first))
	}

	sizeAgain, err := svc.Save(context.Background(), owner, name, bytes.NewReader(jpegBytes(128)))
	if err != nil {
		t.Fatalf("重传同名文件应成功（幂等），实际: %v", err)
	}
	if sizeAgain != size {
		t.Errorf("重传应返回库里记的 size %d，实际 %d", size, sizeAgain)
	}

	onDisk, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("读盘上文件失败: %v", err)
	}
	if !bytes.Equal(onDisk, first) {
		t.Error("重传不得覆盖已落盘的文件")
	}
}

// 库里有行但盘上文件没了（rename 成功、INSERT 前进程挂掉，或卷被清空）：这次上传要把文件补回来，
// 而不是永远 404。
func TestSaveRestoresMissingDiskFile(t *testing.T) {
	pool := filesTestDB(t)
	dir := t.TempDir()
	owner := seedUser(t, pool)
	svc := NewFileService(pool, dir, 5<<20)
	name := newFileName()

	if _, err := svc.Save(context.Background(), owner, name, bytes.NewReader(jpegBytes(64))); err != nil {
		t.Fatalf("首次上传失败: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, name)); err != nil {
		t.Fatal(err)
	}

	size, err := svc.Save(context.Background(), owner, name, bytes.NewReader(jpegBytes(64)))
	if err != nil {
		t.Fatalf("磁盘缺文件时应重新落盘，实际: %v", err)
	}
	if size != 64 {
		t.Errorf("size = %d, want 64", size)
	}
	if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
		t.Errorf("重新上传后文件应回到盘上: %v", err)
	}
}

// Open 是磁盘层的最后一道防线：名称不合法时绝不允许拼进文件路径。
func TestOpenRejectsInvalidName(t *testing.T) {
	svc, pool := newFileService(t)
	owner := seedUser(t, pool)

	if _, _, err := svc.Open(context.Background(), "../x.jpg"); err == nil {
		t.Error("非法文件名必须被 Open 拒绝")
	}
	// 名称形状不对时 CanRead 直接为 false（handler 据此回 404，而不是 500）
	assertCanRead(t, svc, owner, "../x.jpg", false)
}
