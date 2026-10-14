// 这个文件走**完整 HTTP + 真 Postgres + 真 Redis**：用生产的 `newRouter` 装配真实 service，
// 容器里跑真实迁移，邀请码真的落 Redis。补的是单测（各 handler/service 的 fake）覆盖不到的
// 结构洞：跨层接线（认证 → 团队 → 同步 → 图片）与团队 REST 链路的真 SQL。
//
// 判别力来源（“改哪一行能让它红”）：
//
//	GET /teams 的 member_count   ← team.go 的 ListMyTeams 子查询；(建队 1 / 入队 2)
//	GET /teams/{id}/members      ← team.go 的 ListMembers + canReadTeam 真 SQL
//	B 能下到封面                  ← files.go 的 CanRead 反查 SQL（团队菜谱引用即放行）
//	B 改不动 A 的菜谱             ← sync.go mergeRecipe 的 owner_id 校验（team 校验会先放行）
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"wee-cook/backend/internal/config"
	"wee-cook/backend/internal/database"
	"wee-cook/backend/internal/handler"
	"wee-cook/backend/internal/model"
	"wee-cook/backend/internal/service"
)

type e2eEnv struct {
	pool      *pgxpool.Pool
	redisAddr string
}

var (
	e2eOnce  sync.Once
	e2eValue *e2eEnv
	e2eErr   error
)

// e2eSetup 只在包内第一次需要时起容器：postgres（跑迁移）+ redis。
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

	redisAddr, err := startRedisContainer(ctx)
	if err != nil {
		return nil, err
	}
	return &e2eEnv{pool: pool, redisAddr: redisAddr}, nil
}

func startRedisContainer(ctx context.Context) (string, error) {
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "redis:7-alpine",
			ExposedPorts: []string{"6379/tcp"},
			WaitingFor:   wait.ForListeningPort("6379/tcp").WithStartupTimeout(2 * time.Minute),
		},
		Started: true,
	})
	if err != nil {
		return "", fmt.Errorf("启动 redis 容器: %w", err)
	}
	host, err := c.Host(ctx)
	if err != nil {
		return "", fmt.Errorf("取 redis host: %w", err)
	}
	port, err := c.MappedPort(ctx, "6379/tcp")
	if err != nil {
		return "", fmt.Errorf("取 redis 端口: %w", err)
	}
	return net.JoinHostPort(host, port.Port()), nil
}

// newE2ERouter 用生产的 newRouter 装配真 service。FILES_DIR 用每个用例自己的临时目录。
func newE2ERouter(t *testing.T) (*e2eEnv, http.Handler) {
	t.Helper()
	e2eOnce.Do(func() { e2eValue, e2eErr = e2eSetup() })
	if e2eErr != nil {
		t.Fatalf("e2e 环境不可用: %v", e2eErr)
	}
	env := e2eValue

	redisClient, err := database.NewRedisClient(env.redisAddr, "")
	if err != nil {
		t.Fatalf("连接 redis 失败: %v", err)
	}
	t.Cleanup(func() { _ = redisClient.Close() })

	dir := t.TempDir() // t.TempDir 已建好目录（生产由 main 的 MkdirAll 负责）
	cfg := &config.Config{JWTSecret: testJWTSecret, FilesDir: dir, MaxFileBytes: 5 << 20}
	router := newRouter(cfg, handlers{
		auth: handler.NewAuthHandler(service.NewAuthService(env.pool, testJWTSecret)),
		team: handler.NewTeamHandler(service.NewTeamService(env.pool, redisClient)),
		sync: handler.NewSyncHandler(service.NewSyncService(env.pool)),
		file: handler.NewFileHandler(service.NewFileService(env.pool, dir, 5<<20)),
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

type e2eTeam struct {
	teamID    string
	tokenA    string
	userA     string
	usernameA string
	tokenB    string
	userB     string
	usernameB string
}

// e2eTwoMemberTeam 走完整团队 REST 链路：注册 A → 建队 → GET /teams 查 member_count=1 →
// owner 发邀请码（真 Redis）→ 注册 B → join（member_count=2）→ GET /teams/{id}/members 两人。
func e2eTwoMemberTeam(t *testing.T, h http.Handler) e2eTeam {
	t.Helper()

	tokenA, userA, usernameA := e2eRegister(t, h)

	var created struct {
		Team model.Team `json:"team"`
	}
	e2eDecode(t, e2ePostJSON(t, h, "/api/v1/teams", tokenA, map[string]string{"name": "端到端家庭"}),
		http.StatusCreated, &created)
	teamID := created.Team.ID
	if teamID == "" {
		t.Fatalf("建队响应缺少 team.id: %+v", created)
	}
	if created.Team.MemberCount != 1 {
		t.Errorf("刚建队的 member_count = %d, want 1", created.Team.MemberCount)
	}

	// GET /teams 的 member_count 也必须是 1（真 SQL 的子查询）
	var teams []model.Team
	e2eDecode(t, e2eDo(t, h, "GET", "/api/v1/teams", tokenA, nil), http.StatusOK, &teams)
	if got := e2eTeamByID(teams, teamID); got == nil {
		t.Fatalf("GET /teams 里没有刚建的团队 %s", teamID)
	} else if got.MemberCount != 1 {
		t.Errorf("GET /teams member_count = %d, want 1", got.MemberCount)
	}

	// owner 发邀请码（真 Redis 落键）
	var invite struct {
		InviteCode string `json:"invite_code"`
	}
	e2eDecode(t, e2eDo(t, h, "POST", "/api/v1/teams/"+teamID+"/invite", tokenA, nil), http.StatusOK, &invite)
	if invite.InviteCode == "" {
		t.Fatalf("邀请码为空")
	}

	// 注册 B 并用邀请码加入
	tokenB, userB, usernameB := e2eRegister(t, h)
	var joined struct {
		Team model.Team `json:"team"`
	}
	e2eDecode(t, e2ePostJSON(t, h, "/api/v1/teams/join", tokenB,
		map[string]string{"invite_code": invite.InviteCode}), http.StatusOK, &joined)
	if joined.Team.MemberCount != 2 {
		t.Errorf("join 响应的 member_count = %d, want 2", joined.Team.MemberCount)
	}

	// 加入后 GET /teams 的 member_count 变 2
	e2eDecode(t, e2eDo(t, h, "GET", "/api/v1/teams", tokenA, nil), http.StatusOK, &teams)
	if got := e2eTeamByID(teams, teamID); got == nil {
		t.Fatalf("GET /teams 里找不到团队 %s", teamID)
	} else if got.MemberCount != 2 {
		t.Errorf("加入后 GET /teams member_count = %d, want 2", got.MemberCount)
	}

	// GET /teams/{id}/members 必须同时列出 A 与 B
	var members []model.TeamMember
	e2eDecode(t, e2eDo(t, h, "GET", "/api/v1/teams/"+teamID+"/members", tokenA, nil), http.StatusOK, &members)
	if len(members) != 2 {
		t.Errorf("成员数 = %d, want 2（A 与 B）", len(members))
	}
	usernames := map[string]bool{}
	for _, m := range members {
		usernames[m.Username] = true
	}
	if !usernames[usernameA] || !usernames[usernameB] {
		t.Errorf("成员列表 %v 应同时包含 %s 与 %s", usernames, usernameA, usernameB)
	}

	return e2eTeam{
		teamID: teamID, tokenA: tokenA, userA: userA, usernameA: usernameA,
		tokenB: tokenB, userB: userB, usernameB: usernameB,
	}
}

func e2eTeamByID(teams []model.Team, id string) *model.Team {
	for i := range teams {
		if teams[i].ID == id {
			return &teams[i]
		}
	}
	return nil
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

// TestEndToEndRegisterTeamSync：注册 A → 建队 → 邀请码 → 注册 B → join → A 推带封面的团队菜谱
// → B 拉到 → B 能下载封面。团队 REST 链路的真库/真 Redis 覆盖在这里（见 e2eTwoMemberTeam）。
func TestEndToEndRegisterTeamSync(t *testing.T) {
	_, h := newE2ERouter(t)
	team := e2eTwoMemberTeam(t, h)

	// A 传封面（裸二进制 + 查询参数文件名）
	cover := uuid.NewString() + ".jpg"
	img := make([]byte, 128)
	copy(img, []byte{0xFF, 0xD8, 0xFF}) // JPEG 魔数即可，Save 不解析内容
	var uploaded model.FileRef
	e2eDecode(t, e2eDo(t, h, "POST", "/api/v1/files?name="+url.QueryEscape(cover), team.tokenA, img),
		http.StatusOK, &uploaded)
	if uploaded.Name != cover || uploaded.Size != int64(len(img)) {
		t.Errorf("上传响应 = %+v, want name=%s size=%d", uploaded, cover, len(img))
	}

	// A 推一条引用该封面的团队菜谱
	recipeID := "r-" + uuid.NewString()
	now := time.Now().UTC()
	coverRef := cover
	var pushed model.SyncResponse
	e2eDecode(t, e2ePostJSON(t, h, "/api/v1/sync", team.tokenA, model.SyncRequest{
		LocalChanges: model.SyncPayload{Recipes: []model.Recipe{{
			ID: recipeID, Name: "端到端菜谱", TeamID: &team.teamID, CoverPath: &coverRef,
			CreatedAt: now, UpdatedAt: now,
			Steps: []model.RecipeStep{}, Ingredients: []model.RecipeIngredient{}, LabelIDs: []string{},
		}}},
	}), http.StatusOK, &pushed)
	if pushed.ServerSeq <= 0 {
		t.Errorf("推送后 server_seq = %d, want > 0", pushed.ServerSeq)
	}

	// B 从 0 全量拉，必须看到 A 的菜谱（owner_id 由服务端赋值）
	pulled := e2eSync(t, h, team.tokenB, model.SyncRequest{LastServerSeq: 0})
	got := e2eFindRecipe(pulled.RemoteChanges.Recipes, recipeID)
	if got == nil {
		t.Fatalf("B 拉取应看到 A 推的团队菜谱 %s", recipeID)
	}
	if got.OwnerID != team.userA {
		t.Errorf("菜谱 owner_id = %s, want A(%s)", got.OwnerID, team.userA)
	}
	if got.CoverPath == nil || *got.CoverPath != cover {
		t.Errorf("菜谱 cover_path = %v, want %s", got.CoverPath, cover)
	}

	// B 用同步体里的文件名下载封面：可见性由「团队菜谱引用了它」决定
	rec := e2eDo(t, h, "GET", "/api/v1/files/"+cover, team.tokenB, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("B 下载封面: HTTP %d, want 200；响应体: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), img) {
		t.Errorf("下载到的封面与上传的字节不一致（%d vs %d 字节）", rec.Body.Len(), len(img))
	}
}

// TestEndToEndNonOwnerCannotEdit：B 推改 A 的菜谱 → 拉回来内容不变；B 的详情里 owner_id 仍是 A。
func TestEndToEndNonOwnerCannotEdit(t *testing.T) {
	_, h := newE2ERouter(t)
	team := e2eTwoMemberTeam(t, h)

	recipeID := "r-" + uuid.NewString()
	now := time.Now().UTC()
	original := model.Recipe{
		ID: recipeID, Name: "A的原始菜谱", TeamID: &team.teamID,
		CreatedAt: now.Add(-time.Hour), UpdatedAt: now.Add(-time.Hour),
		Steps:       []model.RecipeStep{{ID: "st-a", SortOrder: 0, Text: "A的步骤"}},
		Ingredients: []model.RecipeIngredient{}, LabelIDs: []string{},
	}
	e2eSync(t, h, team.tokenA, model.SyncRequest{
		LocalChanges: model.SyncPayload{Recipes: []model.Recipe{original}},
	})

	// B（团队成员，team 校验会放行）伪造 owner_id 与更晚的时间去覆盖
	forged := original
	forged.Name = "被B篡改"
	forged.OwnerID = team.userB
	forged.UpdatedAt = now
	forged.Steps = []model.RecipeStep{{ID: "st-b", SortOrder: 0, Text: "B的步骤"}}
	e2eSync(t, h, team.tokenB, model.SyncRequest{
		LocalChanges: model.SyncPayload{Recipes: []model.Recipe{forged}},
	})

	// B 拉回来：内容与归属都是 A 的
	forB := e2eFindRecipe(e2eSync(t, h, team.tokenB, model.SyncRequest{LastServerSeq: 0}).RemoteChanges.Recipes, recipeID)
	if forB == nil {
		t.Fatalf("B 应能看到团队菜谱 %s", recipeID)
	}
	if forB.Name != "A的原始菜谱" {
		t.Errorf("B 拉到的名字 = %q, want A的原始菜谱（越权改名生效了）", forB.Name)
	}
	if forB.OwnerID != team.userA {
		t.Errorf("B 拉到的 owner_id = %s, want A(%s)", forB.OwnerID, team.userA)
	}
	if len(forB.Steps) != 1 || forB.Steps[0].ID != "st-a" {
		t.Errorf("B 拉到的步骤 = %+v, want [st-a]（越权改了子行）", forB.Steps)
	}

	// A 拉回来也一样
	forA := e2eFindRecipe(e2eSync(t, h, team.tokenA, model.SyncRequest{LastServerSeq: 0}).RemoteChanges.Recipes, recipeID)
	if forA == nil {
		t.Fatalf("A 应能看到自己的菜谱 %s", recipeID)
	}
	if forA.Name != "A的原始菜谱" || forA.OwnerID != team.userA {
		t.Errorf("A 拉回来内容被改: name=%q owner_id=%s", forA.Name, forA.OwnerID)
	}
}
