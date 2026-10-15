# 同步与团队 · 后端实施计划

> ⚠️ **部分作废**：Task 3（团队）与 Task 8 里的团队鉴权已被 `2026-10-15-community-design.md` 取代并从代码里删除；其余任务继续有效。本文件保留为执行记录。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `backend/` 里从零建起 WeeCook 的可选自托管 Go 服务：账号、团队、增量同步、图片通道，全部有测试覆盖。

**Architecture:** 单一 Go 二进制 + PostgreSQL 16 + Redis 7，Docker Compose 自托管，迁移随启动自动执行。同步是「收增量 / 发增量」的中转：全局单调 `server_seq` 游标 + 按 `updated_at` 的 LWW + 软删墓碑 + 写事务全局 advisory lock 串行化。结构照抄姊妹项目 `D:\projects\my\wee-count`（`backend/`），去掉 AI / 账本 / 成员别名，把交易换成菜谱。

**Tech Stack:** Go 1.25 · chi v5 · pgx v5 · golang-migrate v4（iofs embed）· go-redis v9 · golang-jwt v5 · bcrypt · testcontainers-go（真库集成测试）

**Spec:** `docs/superpowers/specs/2026-10-14-sync-team-design.md`（执行前先读它，§7 是本计划的核心）

## Global Constraints

- Go 1.25；`interface{}` 一律写 `any`；善用 `slices` / `maps` / `min` / `max` / `clear`；能泛型就不要写重复的类型特定代码。
- 模块路径 `wee-cook/backend`，代码在 `backend/`。
- 每张业务表带 `id`、`updated_at`、`deleted_at`。**三张子表 `recipe_steps` / `recipe_ingredients` / `recipe_labels` 无 `deleted_at`**（AGENTS.md 已记录的确认例外）。
- 时间列一律 `TIMESTAMPTZ`，协议里一律 RFC3339（含 `.000Z` 微秒时区）。
- 错误响应形状固定 `{"error":"<message>"}`；`writeJSON` / `writeError` 照抄 `wee-count/backend/internal/handler/helpers.go`。
- **每个同步写事务的第一条语句**是 `SELECT pg_advisory_xact_lock(897753);`（常量名 `syncWriteLockID`）。
- 所有 merge 用 `FOR UPDATE` 锁已存在行，判断条件写 `!incoming.After(remote)`，**绝不用 `23505` 回退兜底**（PostgreSQL 事务内语句报错后事务即 aborted，回退在真库跑不通）。
- 测试优先：非 bugfix 的实现必须带测试，不可删改已有测试；真库测试用 testcontainers（需要本机 Docker）。
- 提交信息用中文，格式 `<类型>: <中文描述>`（如 `feat: 同步服务支持菜谱整条合并`）。

## Review Focus

写测试时逐条钉住下面这些「规格没明说、但真人一定会遇到」的输入或条件（每条的测试挂在括号里指出的任务上）：

1. **同一个用户在两台设备上离线各改一条菜谱**：另一台回来后，较新的那份留下来，较旧的那次改动无声消失，不能两边各留一份或合成半新半旧的怪东西（Task 5）。
2. **B 在 A 录了 50 道团队菜谱之后才加入团队**：B 必须看得到这 50 道（游标是全局一个数字，只按 `server_seq > 游标` 拉会全空而且不报错）（Task 6）。
3. **我的私人菜谱里用过的图片，被团队菜谱引用**（文件名相同、`files` 只有一行）：团队成员必须下载得到（Task 8）。
4. **客户端时钟比服务器快 10 分钟的设备**：它推的改动永远赢。这是 LWW 的已知限制，测试要钉住「比较用的是记录里存的 `updated_at`，不是服务器当前时间」，别让后来的人误以为服务端用了 `now()`（Task 5）。
5. **非作者推别人的菜谱**（伪造 `owner_id`、或改团队里别人的菜谱）：服务端必须整条跳过、不报 500、也不要把 `owner_id` 变成推送者（Task 5）。

---

### Task 1: Go 模块骨架 + 配置 + 迁移框架 + 初始表结构

**Files:**
- Create: `backend/go.mod`
- Create: `backend/cmd/server/main.go`
- Create: `backend/cmd/server/router.go`
- Create: `backend/internal/config/config.go`
- Create: `backend/internal/config/config_test.go`
- Create: `backend/internal/database/postgres.go`
- Create: `backend/internal/database/migrations/001_init.up.sql`
- Create: `backend/internal/database/migrations/001_init.down.sql`
- Create: `backend/internal/database/migrations_test.go`

**Interfaces:**
- Consumes: 无
- Produces:
  - `config.Load() (*Config, error)`；`Config` 字段 `DatabaseURL, RedisURL, RedisPassword, JWTSecret, Port, CORSAllowedOrigins []string, TrustProxy bool, FilesDir string, MaxFileBytes int64`
  - `database.NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error)`
  - `database.RunMigrations(databaseURL string) error`
  - `newRouter(cfg *config.Config, h handlers) http.Handler`（`handlers` 结构体此刻为空，后续任务往里加字段）

- [ ] **Step 1: 写失败的测试** `backend/internal/config/config_test.go`

```go
func TestLoadRequiresCoreEnv(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("REDIS_URL", "")
	t.Setenv("JWT_SECRET", "")
	_, err := config.Load()
	if err == nil {
		t.Fatal("期望缺少必填环境变量时报错")
	}
	for _, want := range []string{"DATABASE_URL", "REDIS_URL", "JWT_SECRET"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("错误信息里应提到 %s，实际：%v", want, err)
		}
	}
}

func TestLoadDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("REDIS_URL", "redis:6379")
	t.Setenv("JWT_SECRET", "s")
	cfg, err := config.Load()
	if err != nil { t.Fatal(err) }
	if cfg.Port != "8080" { t.Errorf("Port 默认值应是 8080，实际 %q", cfg.Port) }
	if cfg.MaxFileBytes != 5<<20 { t.Errorf("MaxFileBytes 默认值应是 5MB，实际 %d", cfg.MaxFileBytes) }
	if cfg.FilesDir != "/data/files" { t.Errorf("FilesDir 默认值应是 /data/files，实际 %q", cfg.FilesDir) }
	if !slices.Contains(cfg.CORSAllowedOrigins, "http://tauri.localhost") {
		t.Errorf("默认 CORS 必须含 http://tauri.localhost，实际 %v", cfg.CORSAllowedOrigins)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/config/ -run TestLoad -v`
Expected: FAIL（`package config is not in std` / 未定义 `config.Load`）

- [ ] **Step 3: 实现配置**

写 `backend/internal/config/config.go`：照抄 `wee-count/backend/internal/config/config.go` 的 `getEnv` / `getEnvBool` / `getEnvInt` / `parseCORSOrigins` / `defaultCORSOrigins`，删掉全部 `AI*` 字段，加两个：

```go
FilesDir     string // FILES_DIR，默认 /data/files
MaxFileBytes int64  // MAX_FILE_BYTES，默认 5<<20
```

`Load()` 的必填校验只留 `DATABASE_URL` / `REDIS_URL` / `JWT_SECRET`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/config/ -v`
Expected: PASS

- [ ] **Step 5: 写失败的迁移测试** `backend/internal/database/migrations_test.go`

用 testcontainers 起临时 Postgres（照抄 `wee-count/backend/internal/service/sync_integration_test.go` 里的容器启动辅助函数）：

```go
func TestMigrationsCreateAllTables(t *testing.T) {
	url := startPostgres(t)                 // 辅助函数：testcontainers + 返回连串
	if err := database.RunMigrations(url); err != nil { t.Fatalf("第一次迁移失败: %v", err) }
	if err := database.RunMigrations(url); err != nil { t.Fatalf("第二次迁移应幂等，却失败: %v", err) }

	pool, _ := database.NewPool(context.Background(), url)
	defer pool.Close()
	for _, table := range []string{
		"users", "teams", "team_members", "recipes", "recipe_steps",
		"recipe_ingredients", "recipe_labels", "ingredients", "units", "labels", "files",
	} {
		var exists bool
		if err := pool.QueryRow(context.Background(),
			"SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1)", table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists { t.Errorf("迁移后应存在表 %s", table) }
	}

	// 三张子表按规格不带 deleted_at（AGENTS.md 的确认例外）
	for _, table := range []string{"recipe_steps", "recipe_ingredients", "recipe_labels"} {
		var exists bool
		pool.QueryRow(context.Background(),
			"SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='deleted_at')", table).Scan(&exists)
		if exists { t.Errorf("%s 不应有 deleted_at 列", table) }
	}
}
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd backend && go test ./internal/database/ -run TestMigrationsCreateAllTables -v`
Expected: FAIL（无 `migrations` 目录 / 未定义 `RunMigrations`）

- [ ] **Step 7: 写 `001_init.up.sql`**

逐字按 spec §6.2。要点：`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`、`CREATE SEQUENCE IF NOT EXISTS global_server_seq`、`users` / `teams` / `team_members`（照抄 wee-count，`users.username` 唯一、`users.avatar_url TEXT`）、`recipes`（`id TEXT PK`、`owner_id UUID NOT NULL`、`team_id UUID NULL`、`deleted_at TIMESTAMPTZ NULL`、`server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')`）、三张子表（无 `server_seq`、无 `deleted_at`）、三张字典表（带 `server_seq`）、`files`（`name TEXT PK`、`owner_id`、`size`、`created_at`，**无 `team_id`**）。索引按 spec §6.2 末尾那行逐个建。

`001_init.down.sql` 反向 `DROP TABLE`（含 `DROP SEQUENCE`）。

- [ ] **Step 8: 跑测试确认通过**

Run: `cd backend && go test ./internal/database/ -run TestMigrationsCreateAllTables -v`
Expected: PASS

- [ ] **Step 9: 写 main.go / router.go 并跑 `go vet`**

`main.go`：`config.Load()` → 失败 `log.Fatal` → `database.RunMigrations` → `NewPool` → `NewRedisClient` → `newRouter` → `http.Server{Addr: ":" + cfg.Port}`（读超时 15s、写超时 60s，图片下载需要写超时宽一点）。

`router.go`：照抄 `wee-count/backend/cmd/server/router.go` 的骨架（`RealIP` 仅在 `cfg.TrustProxy` 时启用、`middleware.Logger`、`middleware.Recoverer`、`cors.Handler`），`handlers` 结构体此刻为空，`r.Route("/api/v1", ...)` 里只有 `r.Get("/healthz", ...)` 返回 `{"status":"ok"}`。

- [ ] **Step 10: 编译与静态检查**

Run: `cd backend && go build ./... && go vet ./...`
Expected: 无输出

- [ ] **Step 11: 提交**

```bash
git add backend
git commit -m "feat: 后端骨架、配置、迁移框架与初始表结构"
```

---

### Task 2: 鉴权（注册 / 登录 / refresh / me / profile）

**Files:**
- Create: `backend/internal/model/user.go`
- Create: `backend/internal/service/db.go`
- Create: `backend/internal/service/auth.go`
- Create: `backend/internal/service/auth_test.go`
- Create: `backend/internal/middleware/auth.go`
- Create: `backend/internal/middleware/auth_test.go`
- Create: `backend/internal/handler/helpers.go`
- Create: `backend/internal/handler/auth.go`
- Create: `backend/internal/handler/auth_test.go`
- Modify: `backend/cmd/server/router.go`（接线 `/auth/*`、`/me`、限流）

**Interfaces:**
- Consumes: Task 1 的 `config.Config`
- Produces:
  - `service.dbQuerier`（`Query` / `QueryRow` / `Exec`，签名照抄 `wee-count/backend/internal/service/sync.go`）
  - `service.NewAuthService(pool *pgxpool.Pool, jwtSecret string) *AuthService`
  - `AuthService.Register/Login/Refresh/GetMe/UpdateProfile`，签名照抄 wee-count
  - `service.ErrUsernameTaken` / `ErrInvalidLogin` / `ErrInvalidToken` / `ErrUserNotFound`
  - `middleware.AuthMiddleware(jwtSecret string) func(http.Handler) http.Handler`、`middleware.GetUserID(ctx) string`
  - `handler.NewAuthHandler(svc authService) *AuthHandler`；`handler.writeJSON` / `writeError`

- [ ] **Step 1: 写失败的测试** `backend/internal/service/auth_test.go`

```go
func TestRegisterRejectsDuplicateUsername(t *testing.T)   // 注入 fake dbQuerier，SELECT EXISTS 返回 true → ErrUsernameTaken
func TestRegisterCreatesOnlyUser(t *testing.T)            // 断言 fake 收到的 Exec 语句里**没有** ledgers（wee-cook 无账本抽象）
func TestLoginWrongPassword(t *testing.T)                 // bcrypt hash 不匹配 → ErrInvalidLogin，且错误文案不区分「用户不存在」
func TestRefreshRejectsAccessToken(t *testing.T)          // 用 typ=access 的 token 调 Refresh → ErrInvalidToken
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestRegister|TestLogin|TestRefresh' -v`
Expected: FAIL（包不存在 / 未定义 `AuthService`）

- [ ] **Step 3: 实现**

照抄 `wee-count/backend/internal/service/auth.go`、`internal/model/user.go`、`internal/middleware/auth.go`、`internal/handler/helpers.go`、`internal/handler/auth.go`，只做三处删减：

1. `model.AuthResponse` 删掉 `LedgerID` 字段。
2. `Register` 删掉建账本那段（`CreateLedger` / `ledgerID` / `tx.Commit` 前的三行）——只剩 `insertUser`，因此**不需要事务**，直接 `insertUser(ctx, s.pool, ...)`。
3. `MeResponse` 里删掉 `Ledgers` / `Teams`（团队列表由 Task 3 的 `GET /teams` 提供）。

`internal/service/db.go` 里放 `dbQuerier` 接口（从 `wee-count/internal/service/sync.go` 顶部原样搬过来）。`Refresh` 里 `login` 查个人账本那段一并删掉。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ ./internal/middleware/ ./internal/handler/ -v`
Expected: PASS

- [ ] **Step 5: 接线路由**（`backend/cmd/server/router.go`）

`handlers` 加 `auth *handler.AuthHandler`。按 spec §10.2 挂载：`POST /auth/refresh` 不限流；`POST /auth/login`、`POST /auth/register` 各按 IP 限流 10/min；受保护组用 `mw.AuthMiddleware(cfg.JWTSecret)` 包住 `GET /me`、`PUT /auth/profile`。`clientIPKey` 函数照抄 wee-count。

- [ ] **Step 6: 写路由测试并跑通**

`backend/cmd/server/router_test.go`：

```go
func TestAuthRoutesRequireAccessToken(t *testing.T) {
	// 用 typ=refresh 的合法签名 token 打 GET /me，期望 401（中间件拒绝非 access）
}
func TestLoginPathExistsWithoutToken(t *testing.T) {
	// POST /api/v1/auth/login 空 body → 400（而不是 401/404），证明路由已挂且在限流组外无需鉴权
}
```

Run: `cd backend && go test ./cmd/server/ -run TestAuth -v`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add backend
git commit -m "feat: 账号鉴权（注册、登录、刷新令牌、个人资料）"
```

---

### Task 3: 团队（创建 / 列表 / 邀请 / 加入 / 成员）

**Files:**
- Create: `backend/internal/model/team.go`
- Create: `backend/internal/service/authz.go`
- Create: `backend/internal/service/team.go`
- Create: `backend/internal/service/team_test.go`
- Create: `backend/internal/handler/team.go`
- Create: `backend/internal/handler/team_test.go`
- Modify: `backend/cmd/server/router.go`（接线 `/teams*`）

**Interfaces:**
- Consumes: Task 2 的 `dbQuerier`、`middleware.GetUserID`
- Produces:
  - `model.Team`（`ID, Name, CreatedBy string`，`CreatedAt, UpdatedAt time.Time`）、`model.TeamMember`（`UserID, Username, Nickname, Role string`，`AvatarURL *string`，`JoinedAt time.Time`，`MemberCount int` 仅列表用）
  - `service.ErrTeamNotFound` / `ErrNotTeamOwner` / `ErrInviteInvalid` / `ErrAlreadyMember` / `ErrNotTeamMember`
  - `service.canReadTeam(ctx, q dbQuerier, userID, teamID string) error`、`service.myTeamIDs(ctx, q dbQuerier, userID string) (map[string]bool, error)`（**Task 6 用它做可见范围过滤，Task 5 用它校验 `team_id` 合法性**）
  - `service.NewTeamService(pool *pgxpool.Pool, redis *redis.Client) *TeamService`
  - `TeamService.CreateTeam / ListMyTeams / CreateInvite / JoinByInvite / ListMembers`
  - `handler.NewTeamHandler(svc teamService) *TeamHandler`

- [ ] **Step 1: 写失败的测试** `backend/internal/service/team_test.go`

```go
func TestCreateTeamMakesCreatorOwner(t *testing.T)     // 断言插入 team_members 时 role='owner'
func TestCreateInviteRejectsNonOwner(t *testing.T)     // created_by != userID → ErrNotTeamOwner
func TestJoinByInviteRejectsWhenAlreadyMember(t *testing.T) // 断言 Redis 的 Del **没有被调用**（码不被白白烧掉）
func TestJoinByInviteExpiredCode(t *testing.T)         // redis.Nil → ErrInviteInvalid
func TestJoinByInviteConsumesCodeOnlyOnSuccess(t *testing.T) // 成员插入成功后才 Del
func TestListMembersRejectsNonMember(t *testing.T)     // 非成员 → ErrNotTeamMember（越权防护）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestCreateTeam -v`
Expected: FAIL（未定义 `TeamService`）

- [ ] **Step 3: 实现**

照抄 `wee-count/backend/internal/service/team.go` 与 `internal/handler/team.go`，改四处：

1. `CreateTeam` 只建 `teams` + `team_members`（owner）**两行**，不建账本；事务第一条语句仍是 `pg_advisory_xact_lock($syncWriteLockID)`——团队列表本身不进同步协议，但保持「所有写事务共用一把锁」这条不变量，省得以后加团队行的同步时忘了。**若实现后觉得这把锁在只写 teams 的事务上纯属多余，删掉它并在提交信息里说明**（这是留给实现者的判断，不必回来问）。
2. 删掉 `CreateTeamResponse` 里的 `SharedLedger`，只返回 `Team`。
3. 新增 `ListMyTeams(ctx, userID) ([]model.Team, error)`：`JOIN team_members`，带 `member_count`（`COUNT(*) OVER` 或子查询）。

   ```sql
   SELECT t.id, t.name, t.created_by, t.created_at, t.updated_at,
          (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id)
   FROM teams t JOIN team_members tm ON tm.team_id = t.id
   WHERE tm.user_id = $1 ORDER BY tm.joined_at ASC
   ```
4. `authz.go` 里照抄 `canReadTeam`，并新增：

   ```go
   // myTeamIDs 返回用户加入的全部团队 id，供同步服务的可见范围过滤与 team_id 合法性校验共用。
   func myTeamIDs(ctx context.Context, q dbQuerier, userID string) (map[string]bool, error)
   ```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -run 'TestCreate|TestJoin|TestListMembers' -v`
Expected: PASS

- [ ] **Step 5: 接线路由**

`handlers` 加 `team *handler.TeamHandler`；`GET /teams`、`POST /teams`、`POST /teams/{id}/invite`、`GET /teams/{id}/members` 走受保护组；`POST /teams/join` 额外套 `httprate.LimitBy(10, time.Minute, clientIPKey)`（6 位码的爆破面，注释照抄 wee-count 的说明）。

- [ ] **Step 6: 写路由测试并跑通**

`backend/cmd/server/router_test.go` 追加：

```go
func TestTeamRoutesRequireAuth(t *testing.T)  // 无 token 打 GET /api/v1/teams → 401
```

Run: `cd backend && go test ./cmd/server/ -v`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add backend
git commit -m "feat: 团队创建、邀请码加入、成员列表"
```

---

### Task 4: 同步——字典的 LWW 与同名合并

**Files:**
- Create: `backend/internal/model/dict.go`
- Create: `backend/internal/model/sync.go`
- Create: `backend/internal/service/sync.go`
- Create: `backend/internal/service/sync_test.go`

**Interfaces:**
- Consumes: Task 2 的 `dbQuerier`
- Produces:
  - `model.Ingredient{ID, Name string; CreatedAt, UpdatedAt time.Time; DeletedAt *time.Time}`、`model.Unit` 同形、`model.Label{ID, Name, Kind string; ...}`
  - `model.SyncRequest{LastServerSeq int64; LocalChanges SyncPayload}`、`model.SyncPayload{Ingredients []Ingredient; Units []Unit; Labels []Label; Recipes []Recipe; Files []FileRef}`
  - `model.FileRef{Name string; Size int64}`（Task 6 与 Task 8 都用它）
  - `service.NewSyncService(pool *pgxpool.Pool) *SyncService`
  - `service.mergeByKey(ctx, tx, incoming, keySQL, keyArgs, insert, update) error` 与 `mergeByKeyScoped`（照抄 wee-count）
  - `(*SyncService).mergeDict(ctx context.Context, tx dbQuerier, spec dictSpec, ent dictEntity) (effectiveID string, err error)`

- [ ] **Step 1: 写失败的测试** `backend/internal/service/sync_test.go`

用 fake `dbQuerier`（照 `wee-count/internal/service/sync_test.go` 的形状）：

```go
func TestMergeDictInsertsWhenAbsent(t *testing.T)
func TestMergeDictSkipsOlder(t *testing.T)          // incoming 不比 remote 新 → 不产生 UPDATE
func TestMergeDictMergesByNameIntoExistingID(t *testing.T)
	// 主键查不到，但同名行 id=Y 存在 → 返回 effectiveID == "Y"（X 被丢弃）
func TestMergeDictMatchesSoftDeletedRow(t *testing.T)
	// 同名行 deleted_at 非空也要命中并复活：不得插入第二条同名数据
func TestMergeDictLabelKeyIncludesKind(t *testing.T)
	// labels：同名但 kind 不同 → 不合并，existingID 返回自身 id
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestMergeDict -v`
Expected: FAIL（未定义 `mergeDict`）

- [ ] **Step 3: 实现**

`internal/model/dict.go`：三个结构体，字段与本地 SQLite 列一一对应（`json` tag 用 snake_case）。

`internal/service/sync.go` 里：

- 从 wee-count 原样搬 `dbQuerier` 之外的 `mergeByKey` / `mergeByKeyScoped` 与 `const syncWriteLockID = 897753`。
- 一张表驱动的字典合并（避免 ingredients / units 两份一模一样的代码）：

  ```go
  // dictSpec 把三张字典表的差异（表名、有没有 kind、列清单）集中在一处，
  // 合并逻辑只写一遍。labels 用 (name, kind) 作合并键，其余用 (name)。
  type dictSpec struct {
      table       string
      keyColumns  []string   // ["name"] 或 ["name","kind"]
      insertSQL   string
      updateSQL   string
  }
  ```

  三个 `dictSpec` 常量 + `func (s *SyncService) mergeDict(...) (string, error)`，流程照抄 wee-count 的 `lwwMergeTag`：先按 id 查 `updated_at`（`FOR UPDATE`）→ 没有就按键查（**不筛 `deleted_at`**）→ 命中就 UPDATE 旧行并返回旧 id → 都没有才 INSERT 返回自身 id。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -run TestMergeDict -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend
git commit -m "feat: 同步服务支持字典的 LWW 合并与同名去重"
```

---

### Task 5: 同步——菜谱的整条合并与归属校验

**Files:**
- Create: `backend/internal/model/recipe.go`
- Modify: `backend/internal/service/sync.go`
- Modify: `backend/internal/service/sync_test.go`

**Interfaces:**
- Consumes: Task 4 的 `mergeDict` / `mergeByKey`；Task 3 的 `myTeamIDs`
- Produces:
  - `model.RecipeStep{ID string; SortOrder int; Text string; ImagePath *string}`
  - `model.RecipeIngredient{ID, IngredientID string; Amount *float64; UnitID *string; SortOrder int}`
  - `model.Recipe{ID, OwnerID string; TeamID *string; Name string; CoverPath *string; CategoryID string; CreatedAt, UpdatedAt time.Time; DeletedAt *time.Time; Steps []RecipeStep; Ingredients []RecipeIngredient; LabelIDs []string}`
  - `(*SyncService).mergeRecipe(ctx context.Context, tx dbQuerier, userID string, teamSet map[string]bool, r model.Recipe) error`

- [ ] **Step 1: 写失败的测试** `backend/internal/service/sync_test.go`

```go
func TestMergeRecipeInsertsWithUploaderAsOwner(t *testing.T)
	// 请求里伪造 OwnerID="攻击者" → 落库 owner_id 必须是当前 userID
func TestMergeRecipeSkipsWhenNotOwner(t *testing.T)
	// 库里已有行 owner_id=别人 → 不 UPDATE、不报错（越权防护）
func TestMergeRecipeSkipsOlder(t *testing.T)
	// incoming.UpdatedAt 等于或早于 remote → 不产生任何 UPDATE（LWW 比较用记录里的时间，不用服务器 now()）
func TestMergeRecipeSkipsForeignTeam(t *testing.T)
	// TeamID 不在 teamSet 里 → 整条跳过
func TestMergeRecipeReplacesChildrenWholesale(t *testing.T)
	// 更新命中时：先 DELETE 三张子表里该 recipe_id 的行，再按 incoming 插入
func TestMergeRecipeRemapsIngredientReference(t *testing.T)
	// remap 里 ingredient_id X→Y：子行应写 Y
func TestMergeRecipeRemapsCategoryAndLabels(t *testing.T)
	// remap 里 label id X→Y：category_id 与 label_ids 都应写 Y，且 label_ids 去重
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestMergeRecipe -v`
Expected: FAIL（未定义 `mergeRecipe`）

- [ ] **Step 3: 实现**

`internal/model/recipe.go` 按上面的字段定义；`Recipe` 的三个子集合用 `json:"steps"` / `json:"ingredients"` / `json:"label_ids"`，`omitempty` 不加（空数组要能表达「清空」，与 wee-count 的 `tag_ids` 同一个坑）。

`sync.go` 里 `mergeRecipe` 的顺序：

1. 用 `remap map[string]string` 把 `CategoryID`、`LabelIDs`、每个 `Ingredients[i].IngredientID` / `UnitID` 重写成有效 id（**先重写再碰数据库**，同批次引用被合并掉的 id 会撞外键 23503、把整次同步回滚）。
2. `SELECT owner_id, updated_at FROM recipes WHERE id = $1 FOR UPDATE`
   - `pgx.ErrNoRows` → INSERT（`owner_id = userID`、`server_seq` 走列默认值）+ 子行 INSERT，然后 return。
   - 真实错误 → 透传。
   - `remoteOwner != userID` → return nil（跳过）。
   - `!r.UpdatedAt.After(remoteUpdatedAt)` → return nil。
   - `r.TeamID != nil && !teamSet[*r.TeamID]` → return nil。
   - 否则 UPDATE 父行（含 `deleted_at`、`server_seq = nextval('global_server_seq')`）→ `DELETE FROM recipe_steps|recipe_ingredients|recipe_labels WHERE recipe_id = $1` → 重新插入三组子行。
3. 子行插入用循环 `tx.Exec`，`label_ids` 用 `INSERT ... ON CONFLICT DO NOTHING`（同一批里重复的 label_id 不该让整批失败）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -run TestMergeRecipe -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend
git commit -m "feat: 同步服务支持菜谱整条合并与作者归属校验"
```

---

### Task 6: 同步——拉取（可见范围、游标、父行补齐、图片清单）

**Files:**
- Modify: `backend/internal/service/sync.go`
- Create: `backend/internal/service/sync_pull_test.go`

**Interfaces:**
- Consumes: Task 3 的 `myTeamIDs`；Task 5 的 `model.Recipe`
- Produces:
  - `(*SyncService).Sync(ctx context.Context, userID string, req model.SyncRequest) (*model.SyncResponse, error)`
  - `model.SyncResponse{ServerSeq int64; RemoteChanges model.SyncPayload}`
  - `(*SyncService).getRemoteChanges(ctx, q dbQuerier, userID string, sinceSeq int64) (model.SyncPayload, error)`
  - `(*SyncService).applyLocalChanges(ctx context.Context, userID string, req model.SyncPayload) error`

- [ ] **Step 1: 写失败的测试** `backend/internal/service/sync_pull_test.go`

用 fake `dbQuerier` 断言发出的 SQL 与参数（照 `wee-count` 的 fake 形状）：

```go
func TestRemoteRecipesFilteredToMyVisibleScope(t *testing.T)
	// 断言 recipes 查询带上了
	//   (owner_id = $me AND team_id IS NULL) OR team_id = ANY($teams)
	// 且私人菜谱不会被别的用户查到
func TestRemoteDictsHaveNoScopeFilter(t *testing.T)   // 三张字典表的增量查询不带 owner/team 条件
func TestBackfillAddsReferencedDictRows(t *testing.T)
	// 增量菜谱引用的分类/食材/单位这次没下发 → 必须按 id 反查补齐（否则客户端外键缺失卡死）
func TestFilesListedOnlyForReturnedRecipes(t *testing.T)
	// files 只列本次返回的菜谱引用到的、files 表里确实存在的文件名
func TestCursorIsSnapshotMax(t *testing.T)
	// 游标取的是同一快照内的 MAX(server_seq)，而不是任何一条记录的 seq
func TestSyncSkipsLocalChangesForInaccessibleTeam(t *testing.T)
	// 推来的菜谱 team_id 不属于我 → 跳过，且其余变更仍然提交
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestRemote -v`
Expected: FAIL（未定义 `Sync`）

- [ ] **Step 3: 实现**

照抄 `wee-count/internal/service/sync.go` 的 `Sync` 骨架，四处改动：

1. 可见范围不再从 `ledgers` 算，而是 `myTeamIDs(ctx, s.pool, userID)`。
2. 拉取查询：`recipes` 按上面那条 `owner_id / team_id` 条件过滤；三张字典表无过滤。菜谱要 JOIN 出子行——**别用 wee-count 那种 `array_agg`，直接三条独立查询**（`recipe_steps` / `recipe_ingredients` / `recipe_labels` 按 `recipe_id = ANY($1)`），然后在 Go 里组装进 `Recipe`。
3. `backfillReferenced`：照抄，但只补**字典**这一层（`category_id` / `ingredient_id` / `unit_id` / `label_ids` 引用的行），子行随菜谱走不需要补。
4. `applyLocalChanges`：写事务第一条语句是 advisory lock；顺序**必须是** ① 合并字典并收集 remap → ② 用 remap 重写菜谱里的引用 → ③ 合并菜谱。

`Sync` 的读阶段仍是 `REPEATABLE READ` + `ReadOnly` 事务，先读增量再取快照内的 `MAX(server_seq)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend
git commit -m "feat: 同步拉取按可见范围过滤、补齐父行与图片清单"
```

---

### Task 7: 同步 handler 与路由接线

**Files:**
- Create: `backend/internal/handler/sync.go`
- Create: `backend/internal/handler/sync_test.go`
- Modify: `backend/cmd/server/router.go`

**Interfaces:**
- Consumes: Task 6 的 `SyncService.Sync`
- Produces: `handler.NewSyncHandler(svc syncService) *SyncHandler`；`var maxSyncBodyBytes int64 = 32 << 20`（用 `var` 不用 `const`，测试要能改小）

- [ ] **Step 1: 写失败的测试** `backend/internal/handler/sync_test.go`

```go
func TestSyncRejectsOversizedBody(t *testing.T)   // 把 maxSyncBodyBytes 临时设成 64，发 >64 字节 → 400
func TestSyncRejectsBadJSON(t *testing.T)         // 400，且响应形状是 {"error": "..."}
func TestSyncServiceErrorIs500Not400(t *testing.T) // service 返回错误 → 500
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/handler/ -run TestSync -v`
Expected: FAIL

- [ ] **Step 3: 实现**

照抄 `wee-count/backend/internal/handler/sync.go`（`http.MaxBytesReader` + `middleware.GetUserID` + 错误映射）。差别：只有一条 `POST /sync`，没有 AI 相关的限流分组。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/handler/ -run TestSync -v`
Expected: PASS

- [ ] **Step 5: 接线路由并写路由测试**

`handlers` 加 `sync *handler.SyncHandler`，受保护组里挂 `r.Post("/sync", h.sync.Sync)`。

`backend/cmd/server/router_test.go` 追加：

```go
func TestSyncRequiresAuth(t *testing.T)  // 无 token → 401，且**没有**调用 service（用记录调用次数的假 service）
```

Run: `cd backend && go test ./cmd/server/ -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add backend
git commit -m "feat: 同步接口与路由接线"
```

---

### Task 8: 图片通道（上传 / 下载 / 引用反查鉴权）

**Files:**
- Create: `backend/internal/model/file.go`
- Create: `backend/internal/service/files.go`
- Create: `backend/internal/service/files_test.go`
- Create: `backend/internal/handler/files.go`
- Create: `backend/internal/handler/files_test.go`
- Modify: `backend/cmd/server/router.go`

**Interfaces:**
- Consumes: Task 1 的 `config.Config`（`FilesDir` / `MaxFileBytes`）；Task 2 的 `dbQuerier`
- Produces:
  - `service.validFileName(name string) bool`（`^[0-9a-fA-F-]{36}\.jpg$`，挡住路径穿越）
  - `service.NewFileService(pool *pgxpool.Pool, filesDir string, maxBytes int64) *FileService`
  - `FileService.Save(ctx context.Context, userID string, name string, r io.Reader) (size int64, err error)`
  - `FileService.CanRead(ctx context.Context, userID, name string) (bool, error)`
  - `FileService.Open(ctx context.Context, name string) (*os.File, int64, error)`
  - `handler.NewFileHandler(svc fileService) *FileHandler`

- [ ] **Step 1: 写失败的测试** `backend/internal/service/files_test.go`

真库测试（testcontainers，需要 `recipes` / `recipe_steps` 可写）：

```go
func TestCanReadPrivateFileOnlyForOwner(t *testing.T)
	// A 的私人菜谱引用 X → A 可读，B 不可读
func TestCanReadTeamFileForMembers(t *testing.T)
	// A 的团队菜谱引用 X → 同团队 B 可读，团队外 C 不可读
func TestCanReadFileReferencedByRecipeInAnotherBook(t *testing.T)
	// Review Focus ③：A 先在自己的私人菜谱用过 X，随后团队菜谱也引用 X（同一个文件名）
	// → 团队成员的 CanRead 必须为 true
func TestCanReadSoftDeletedRecipeFile(t *testing.T)  // 菜谱 deleted_at 非空，图仍可读
func TestCanReadUnknownFileIsFalse(t *testing.T)     // 没有任何菜谱引用 → false（孤儿图谁都读不了）
func TestValidFileName(t *testing.T)
	// 表驱动：合法 "3f2a...-....jpg" 通过；"../x.jpg"、"a/b.jpg"、"x.png"、空串 全部拒绝
func TestSaveRejectsOversizedFile(t *testing.T)      // 超 maxBytes → 错误，且磁盘上不留半个文件
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestCanRead|TestValidFileName|TestSaveRejects' -v`
Expected: FAIL

- [ ] **Step 3: 实现**

`canRead` 用 spec §8.1 那段 SQL 原文（`cover_path` 或 `recipe_steps.image_path` 命中，且菜谱在我可见范围内，**不筛 `deleted_at`**）。

`Save`：`name` 先过 `validFileName`；用 `io.Copy` 写到 `FILES_DIR/<name>.part` 再 `os.Rename`（半截文件不会以正式名出现）；超过 `maxBytes` 直接删掉临时文件并返回错误；只接受 JPEG（读前 3 字节判 `FF D8 FF`）；`INSERT INTO files ... ON CONFLICT (name) DO NOTHING`，已存在则返回库里记的 size（幂等）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -run 'TestCanRead|TestValidFileName|TestSaveRejects' -v`
Expected: PASS

- [ ] **Step 5: 写 handler 与路由**

`handler/files.go`：`POST /files` 从查询参数 `name` 取文件名（spec §8.1），`http.MaxBytesReader` 限制到 `MaxFileBytes`；`GET /files/{name}` 用 chi URL 参数，先 `validFileName`（不合法直接 404，别回 400 泄露路径规则）再 `CanRead`（false 回 404 而不是 403，不暴露「文件存在但你看不到」）。

路由：受保护组里挂 `r.Post("/files", h.file.Upload)`、`r.Get("/files/{name}", h.file.Download)`。

- [ ] **Step 6: 写 handler 测试并跑通**

```go
func TestUploadRejectsTraversalName(t *testing.T)   // ?name=../../etc/passwd → 404/400，且 FILES_DIR 外没有任何写入
func TestDownloadMissingFileIs404(t *testing.T)     // 引用不存在 → 404
func TestDownloadUnauthorizedIs404(t *testing.T)    // 存在但我不可读 → 404（不是 403）
```

Run: `cd backend && go test ./internal/handler/ -v`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add backend
git commit -m "feat: 图片上传下载与按引用反查的读权限"
```

---

### Task 9: 端到端集成测试（真 Postgres + 真 Redis）

**Files:**
- Create: `backend/internal/service/sync_integration_test.go`
- Create: `backend/cmd/server/router_e2e_test.go`

**Interfaces:**
- Consumes: 前面全部任务的接口
- Produces: 无新接口（只加测试）

- [ ] **Step 1: 写集成测试**（照抄 `wee-count/backend/internal/service/sync_integration_test.go` 的容器辅助与用例形状）

```go
func TestTwoDevicesConvergeOnRecipeEdit(t *testing.T)
	// Review Focus ①：A 的两台设备离线各改同一条 → 同步后两边都是较新的那份，且子行整组来自同一版本
func TestJoinTeamThenPullExistingRecipes(t *testing.T)
	// Review Focus ②：A 先推 5 条团队菜谱（记下 server_seq），B 从 last_server_seq=0 拉
	//   → 5 条都在。同时断言：若 B 用「加入前的旧游标」拉，则一条都拉不到
	//   —— 这条断言是 §9.4「加入团队后必须清游标」的根因钉子，别删
func TestNonOwnerCannotOverwriteRecipe(t *testing.T)
	// Review Focus ⑤：B 推 A 的菜谱（owner_id 伪造为 B）→ 服务端库里仍是 A 且内容未变
func TestConcurrentSyncTransactionsDoNotSkipChanges(t *testing.T)
	// 并发 10 个写事务 → 每条变更都被对方按 server_seq 单调拉到（advisory lock 的回归网）
func TestDictSameNameDedupesAcrossUsers(t *testing.T)
	// A 建「五花肉」，B 也建「五花肉」→ 库里只有一行，B 的菜谱引用被 remap 到 A 那一行
func TestPrivateRecipesInvisibleToOthers(t *testing.T)  // A 的私人菜谱不出现在 B 的增量里
```

- [ ] **Step 2: 跑测试确认失败（或先红后绿）**

Run: `cd backend && go test ./internal/service/ -run TestTwoDevices -v`
Expected: 首次运行 FAIL（用例还没写完整）；写完实现侧无改动，用例应全绿

- [ ] **Step 3: 补 router 层 e2e**

`backend/cmd/server/router_e2e_test.go`：真库 + 真 Redis，走完整 HTTP：

```go
func TestEndToEndRegisterTeamSync(t *testing.T)
	// 注册 A → 建队 → 邀请码 → 注册 B → join → A 推带封面的菜谱 → B 拉 → B 能下载封面
func TestEndToEndNonOwnerCannotEdit(t *testing.T)
	// B 推改 A 的菜谱 → 拉回来内容不变；B 的详情里 owner_id 仍是 A
```

- [ ] **Step 4: 全量验证**

Run: `cd backend && go test ./... 2>&1 | tail -20`
Expected: 全部 `ok`，无 `FAIL`

- [ ] **Step 5: 提交**

```bash
git add backend
git commit -m "test: 同步与团队的端到端集成测试"
```

---

### Task 10: 部署（Dockerfile / compose / 自托管文档）

**Files:**
- Create: `backend/Dockerfile`
- Create: `compose.yml`
- Create: `docs/SELF-HOSTING.md`
- Modify: `README.md`（只加一句指向自托管指南）
- Create: `.env.example`

**Interfaces:**
- Consumes: 全部环境变量（Task 1 的 `Config`）
- Produces: 无

- [ ] **Step 1: 写 Dockerfile**

多阶段：`golang:1.25-alpine` 构建（`CGO_ENABLED=0`，`-trimpath`）→ `gcr.io/distroless/static` 运行，`ENTRYPOINT ["/server"]`。`FILES_DIR=/data/files`。

- [ ] **Step 2: 写 compose.yml**

`api`（`ghcr.io/tuzkimo/wee-cook-api:latest`，端口 `8080:8080`，依赖 postgres/redis 健康）+ `postgres:16-alpine`（绑 `127.0.0.1:5432`，卷 `pgdata`）+ `redis:7-alpine`（绑 `127.0.0.1:6379`）+ 卷 `files:/data/files`。环境变量按 `wee-count/docs/SELF-HOSTING.md` 的写法：`DATABASE_URL` / `REDIS_URL` / `REDIS_PASSWORD` / `JWT_SECRET`（`${JWT_SECRET:?...}` 强制提供）/ `CORS_ALLOWED_ORIGINS`（默认 `http://tauri.localhost`）/ `TRUST_PROXY`（默认 false）。

- [ ] **Step 3: 真起一遍**

Run: `JWT_SECRET=test REDIS_PASSWORD=test docker compose up -d && sleep 8 && curl -s localhost:8080/api/v1/healthz`
Expected: `{"status":"ok"}`；`docker compose logs api | grep -i migrat` 里能看到迁移执行

- [ ] **Step 4: 写 `docs/SELF-HOSTING.md`**

结构照 `wee-count/docs/SELF-HOSTING.md`：后端是**可选**组件、不部署时 App 完全本地运行；两种部署方式（免克隆用公开镜像 / 克隆源码自建）；必填的两个变量；`TRUST_PROXY` 的安全说明（直连暴露时保持 false，否则 X-Forwarded-For 可被伪造绕过按 IP 限流）；升级方式（`docker compose pull && up -d`，迁移自动跑）；**数据与隐私说明**：服务器以明文保存菜谱与图片，自托管在你自己的机器上；图片存 `files` 卷，删菜谱不会删图（暂未做垃圾回收）。

- [ ] **Step 5: README 加一句**

在 README 的合适位置加一行：「想多设备同步、和家人共用菜谱？见 [自托管指南](docs/SELF-HOSTING.md)。」——**不要在 README 里写架构、表结构、环境变量**。

- [ ] **Step 6: 验证 compose 起停干净**

Run: `docker compose down && docker compose up -d && curl -s localhost:8080/api/v1/healthz && docker compose down`
Expected: 两次都是 `{"status":"ok"}`，`down` 后无残留容器

- [ ] **Step 7: 提交**

```bash
git add backend/Dockerfile compose.yml docs/SELF-HOSTING.md README.md .env.example
git commit -m "feat: 后端 Docker 镜像、compose 部署与自托管文档"
```

---

## 交付后的确认

后端的可用性验收在客户端计划的任务 9（真机/两实例端到端）。本计划结束时应当能做到：`docker compose up` + `curl` 跑通注册 → 建队 → 同步 的完整链路，`go test ./...` 全绿。
