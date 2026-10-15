// 这个文件走**完整 HTTP + 真 Postgres**：用生产的 `newRouter` 装配真实 service，
// 容器里跑真实迁移。补的是单测（各 handler/service 的 fake）覆盖不到的结构洞：
// 跨层接线（认证 → 同步 → 图片）与同步链路的真 SQL。
//
// 判别力来源（“改哪一行能让它红”）：
//
//	B 改不动 A 的菜谱      ← sync.go mergeRecipe 的 owner_id 校验
//	B 看不到 A 的菜谱      ← sync.go recipesVisibleScope（只有作者本人）
//	自己能下到封面        ← files.go 的 CanRead 反查 SQL
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"wee-cook/backend/internal/config"
	"wee-cook/backend/internal/database"
	"wee-cook/backend/internal/handler"
	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

type e2eEnv struct {
	pool *pgxpool.Pool
}

var (
	e2eOnce  sync.Once
	e2eValue *e2eEnv
	e2eErr   error
)

// e2eSetup 只在包内第一次需要时起容器：postgres（跑迁移）。
func e2eSetup() (*e2eEnv, error) {
	ctx := context.Background()

	pg, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("test"),
		postgres.WithUsername("test"),
		postgres.WithPassword("test"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		return nil, fmt.Errorf("启动 postgres 容器: %w", err)
	}
	dsn, err := pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		return nil, fmt.Errorf("取 postgres 连接串: %w", err)
	}
	if err := database.RunMigrations(dsn); err != nil {
		return nil, fmt.Errorf("跑迁移: %w", err)
	}
	pool, err := database.NewPool(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("建 postgres 连接池: %w", err)
	}
	return &e2eEnv{pool: pool}, nil
}

// newE2ERouter 用生产的 newRouter 装配真 service。FILES_DIR 用每个用例自己的临时目录。
func newE2ERouter(t *testing.T) (*e2eEnv, http.Handler) {
	t.Helper()
	e2eOnce.Do(func() { e2eValue, e2eErr = e2eSetup() })
	if e2eErr != nil {
		t.Fatalf("e2e 环境不可用: %v", e2eErr)
	}
	env := e2eValue

	dir := t.TempDir() // t.TempDir 已建好目录（生产由 main 的 MkdirAll 负责）
	cfg := &config.Config{JWTSecret: testJWTSecret, FilesDir: dir, MaxFileBytes: 5 << 20}
	router := newRouter(cfg, handlers{
		auth:      handler.NewAuthHandler(service.NewAuthService(env.pool, testJWTSecret)),
		sync:      handler.NewSyncHandler(service.NewSyncService(env.pool)),
		file:      handler.NewFileHandler(service.NewFileService(env.pool, dir, 5<<20)),
		community: handler.NewCommunityHandler(service.NewCommunityService(env.pool)),
	})
	return env, router
}

func e2eDo(t *testing.T, h http.Handler, method, path, token string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body)) // nil body → 0 字节
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func e2eDecode(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, v any) {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("HTTP %d, want %d；响应体: %s", rec.Code, wantStatus, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("响应不是合法 JSON: %v；响应体: %s", err, rec.Body.String())
	}
}

func e2ePostJSON(t *testing.T, h http.Handler, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("序列化请求体失败: %v", err)
	}
	return e2eDo(t, h, "POST", path, token, raw)
}

// e2eRegister 注册一个全新用户，返回 token / user id / username。
func e2eRegister(t *testing.T, h http.Handler) (token, userID, username string) {
	t.Helper()
	username = "e2e-" + uuid.NewString()
	var resp model.AuthResponse
	e2eDecode(t, e2ePostJSON(t, h, "/api/v1/auth/register", "", model.RegisterRequest{
		Username: username, Password: "pw-123456", Nickname: username,
	}), http.StatusCreated, &resp)
	if resp.AccessToken == "" || resp.User.ID == "" {
		t.Fatalf("注册响应缺少 access_token 或 user.id: %+v", resp)
	}
	return resp.AccessToken, resp.User.ID, username
}

func e2eFindRecipe(recipes []model.Recipe, id string) *model.Recipe {
	for i := range recipes {
		if recipes[i].ID == id {
			return &recipes[i]
		}
	}
	return nil
}

func e2eSync(t *testing.T, h http.Handler, token string, req model.SyncRequest) model.SyncResponse {
	t.Helper()
	var resp model.SyncResponse
	e2eDecode(t, e2ePostJSON(t, h, "/api/v1/sync", token, req), http.StatusOK, &resp)
	return resp
}

// TestEndToEndRegisterSyncUploadDownload：注册 → 上传封面 → 推菜谱 → 从 0 全量拉回 → 下载封面。
func TestEndToEndRegisterSyncUploadDownload(t *testing.T) {
	_, h := newE2ERouter(t)
	token, userID, _ := e2eRegister(t, h)

	// 传封面（裸二进制 + 查询参数文件名）
	cover := uuid.NewString() + ".jpg"
	img := make([]byte, 128)
	copy(img, []byte{0xFF, 0xD8, 0xFF}) // JPEG 魔数即可，Save 不解析内容
	var uploaded model.FileRef
	e2eDecode(t, e2eDo(t, h, "POST", "/api/v1/files?name="+url.QueryEscape(cover), token, img),
		http.StatusOK, &uploaded)
	if uploaded.Name != cover || uploaded.Size != int64(len(img)) {
		t.Errorf("上传响应 = %+v, want name=%s size=%d", uploaded, cover, len(img))
	}

	// 推一条引用该封面的菜谱
	recipeID := "r-" + uuid.NewString()
	now := time.Now().UTC()
	coverRef := cover
	var pushed model.SyncResponse
	e2eDecode(t, e2ePostJSON(t, h, "/api/v1/sync", token, model.SyncRequest{
		LocalChanges: model.SyncPayload{Recipes: []model.Recipe{{
			ID: recipeID, Name: "端到端菜谱", CoverPath: &coverRef,
			CreatedAt: now, UpdatedAt: now,
			Steps: []model.RecipeStep{}, Ingredients: []model.RecipeIngredient{}, LabelIDs: []string{},
		}}},
	}), http.StatusOK, &pushed)
	if pushed.ServerSeq <= 0 {
		t.Errorf("推送后 server_seq = %d, want > 0", pushed.ServerSeq)
	}

	// 从 0 全量拉，必须看到自己的菜谱（owner_id 由服务端赋值）
	pulled := e2eSync(t, h, token, model.SyncRequest{LastServerSeq: 0})
	got := e2eFindRecipe(pulled.RemoteChanges.Recipes, recipeID)
	if got == nil {
		t.Fatalf("拉取应看到自己推的菜谱 %s", recipeID)
	}
	if got.OwnerID != userID {
		t.Errorf("菜谱 owner_id = %s, want %s", got.OwnerID, userID)
	}
	if got.CoverPath == nil || *got.CoverPath != cover {
		t.Errorf("菜谱 cover_path = %v, want %s", got.CoverPath, cover)
	}

	// 用同步体里的文件名下载封面：可见性由「我的菜谱引用了它」决定
	rec := e2eDo(t, h, "GET", "/api/v1/files/"+cover, token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("下载封面: HTTP %d, want 200；响应体: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), img) {
		t.Errorf("下载到的封面与上传的字节不一致（%d vs %d 字节）", rec.Body.Len(), len(img))
	}
}

// TestEndToEndNonOwnerCannotEdit：B 拿 A 的菜谱 id 与伪造的 owner_id 去覆盖 → A 拉回来内容与归属原样；
// 可见范围只有作者本人，B 拉不到 A 的菜谱。
func TestEndToEndNonOwnerCannotEdit(t *testing.T) {
	_, h := newE2ERouter(t)
	tokenA, userA, _ := e2eRegister(t, h)
	tokenB, userB, _ := e2eRegister(t, h)

	recipeID := "r-" + uuid.NewString()
	now := time.Now().UTC()
	original := model.Recipe{
		ID: recipeID, Name: "A的原始菜谱",
		CreatedAt: now.Add(-time.Hour), UpdatedAt: now.Add(-time.Hour),
		Steps:       []model.RecipeStep{{ID: "st-a", SortOrder: 0, Text: "A的步骤"}},
		Ingredients: []model.RecipeIngredient{}, LabelIDs: []string{},
	}
	e2eSync(t, h, tokenA, model.SyncRequest{
		LocalChanges: model.SyncPayload{Recipes: []model.Recipe{original}},
	})

	// B 伪造 owner_id 与更晚的时间去覆盖
	forged := original
	forged.Name = "被B篡改"
	forged.OwnerID = userB
	forged.UpdatedAt = now
	forged.Steps = []model.RecipeStep{{ID: "st-b", SortOrder: 0, Text: "B的步骤"}}
	e2eSync(t, h, tokenB, model.SyncRequest{
		LocalChanges: model.SyncPayload{Recipes: []model.Recipe{forged}},
	})

	// A 拉回来：内容与归属原样
	forA := e2eFindRecipe(e2eSync(t, h, tokenA, model.SyncRequest{LastServerSeq: 0}).RemoteChanges.Recipes, recipeID)
	if forA == nil {
		t.Fatalf("A 应能看到自己的菜谱 %s", recipeID)
	}
	if forA.Name != "A的原始菜谱" {
		t.Errorf("A 拉到的名字 = %q, want A的原始菜谱（越权改名生效了）", forA.Name)
	}
	if forA.OwnerID != userA {
		t.Errorf("A 拉到的 owner_id = %s, want A(%s)", forA.OwnerID, userA)
	}
	if len(forA.Steps) != 1 || forA.Steps[0].ID != "st-a" {
		t.Errorf("A 拉到的步骤 = %+v, want [st-a]（越权改了子行）", forA.Steps)
	}

	// 可见范围只有作者本人：B 拉不到 A 的菜谱
	if forB := e2eFindRecipe(e2eSync(t, h, tokenB, model.SyncRequest{LastServerSeq: 0}).RemoteChanges.Recipes, recipeID); forB != nil {
		t.Errorf("B 不该看到 A 的菜谱，实际: %+v", forB)
	}
}

// 社区列表未带 token 必须 401：证明 /community/recipes 真的挂在受保护组里（404 说明没挂）。
func TestEndToEndCommunityRequiresAuth(t *testing.T) {
	_, h := newE2ERouter(t)

	rec := e2eDo(t, h, "GET", "/api/v1/community/recipes", "", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 token 访问社区列表: got %d, want 401；响应体: %s", rec.Code, rec.Body.String())
	}
}
