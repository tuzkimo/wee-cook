# 社区共享 · 后端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `backend/` 里的「团队」整段删掉，换成「一个服务器 = 一个社区」：公开菜谱在线浏览、收藏、关注。

**Architecture:** 沿用现有的同步协议（`server_seq` + 游标 + LWW + 软删墓碑 + advisory lock + 子表整条替换）。`teams` / `team_members` 两张表与整套团队 REST 被删掉；`recipes.team_id` 换成 `is_public`，可见范围从「我的 ∪ 我的团队」换成「我的 ∪ 我收藏的（且仍公开）」。社区浏览、收藏、关注走新的 REST 接口；收藏写入时顺手推进该菜谱的 `server_seq`，客户端靠现有的增量拉取拿到正文。

**Tech Stack:** Go 1.25 + chi + pgx + PostgreSQL 16 + Redis 7（Redis 仅保留给 refresh token / 限流，团队邀请码那条 Redis 用法随团队一起删除）。

**Spec:** `docs/superpowers/specs/2026-10-15-community-design.md`

## Global Constraints

- 测试优先；不可删改与被删功能无关的测试。删除团队功能时，团队自己的测试一并删除是**规格要求**（已人工确认）。
- 布尔值端到端用 `0` / `1`：PostgreSQL 列 `SMALLINT`、Go `int16`、JSON number。
- 每张业务表带 `id` / `updated_at` / `deleted_at`。例外（已确认，见 `AGENTS.md` 与 spec §12）：`favorites` / `follows` 不带这三列。
- 迁移文件**直接改写** `001_init.up.sql` / `001_init.down.sql`，不叠新迁移。本地开发库需要删掉重建（开发数据可弃）。
- 服务端是权限的唯一裁决者：`owner_id` 一律取当前登录用户；社区接口只返回 `is_public = 1 AND deleted_at IS NULL`。
- 每个 Task 结束跑一次：`cd backend && go vet ./... && go test ./...`（集成测试需要 Docker，testcontainers 会自己起 PostgreSQL 容器）。

## Review Focus

- **取消公开之后再拉一次增量**：收藏者不能收到这条菜谱的正文、子行或图片，且 `favorite_recipe_ids` 里也不再有它。（spec §7.3 的隐私泄漏点，最要紧）
- **收藏一条 `server_seq` 早于对方游标的菜谱**：对方下一次同步必须拉得到它（这是旧版「加入团队要清游标」那个坑的替代品）。
- **收藏 / 取消收藏重复调用**：幂等，不重复占行、不报错。
- **社区列表里出现我自己的公开菜谱**：不该出现（同一个东西看两遍）。
- **`favorites` / `follows` 里的悬空引用**：菜谱或用户被删除后，列表与 `favorite_recipe_ids` 不能因此报错或返回半截数据。

---

### Task 1: 删掉团队，可见范围退回到「只有我自己」

**Files:**

- Modify: `backend/internal/database/migrations/001_init.up.sql`、`001_init.down.sql`
- Modify: `backend/internal/database/migrations_test.go`
- Modify: `backend/internal/model/recipe.go`
- Modify: `backend/internal/service/sync.go:159-222`（`mergeRecipe`）、`353-460`（`mergeLocalChanges` / `getRemoteChanges` / `recipesVisibleScope` / `queryRecipes`）
- Modify: `backend/cmd/server/router.go`、`backend/cmd/server/main.go`
- Modify: `backend/internal/service/sync_integration_test.go`、`sync_pull_test.go`、`sync_test.go`
- Modify: `backend/cmd/server/router_e2e_test.go`、`router_test.go`
- Delete: `backend/internal/model/team.go`、`backend/internal/service/team.go`、`team_test.go`、`backend/internal/handler/team.go`、`team_test.go`、`backend/internal/service/authz.go`

**Interfaces:**

- Consumes: 无（这是起点）。
- Produces: `model.Recipe` 不再有 `TeamID`，新增 `IsPublic int16 \`json:"is_public"\``（本 Task 只加字段，不参与同步逻辑，默认 0）；`recipesVisibleScope = "owner_id = $2"`；`queryRecipes(ctx, q dbQuerier, userID string, sinceSeq int64)`；`mergeRecipe(ctx, tx, userID string, remap map[string]string, r model.Recipe)`（去掉 `teamSet` 参数）。后续 Task 都在这个形状上改。

- [ ] **Step 1: 改迁移测试，跑出失败**

`migrations_test.go` 的表名列表改成 `users, recipes, recipe_steps, recipe_ingredients, recipe_labels, ingredients, units, labels, files`，再补三条断言：

```go
// teams 与 team_members 必须不存在了
if exists("teams") || exists("team_members") { t.Error("团队表应已删除") }
// recipes 带 is_public、不带 team_id
// SELECT data_type, is_nullable, column_default FROM information_schema.columns
//   WHERE table_name='recipes' AND column_name='is_public'  → smallint / NO / 0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/database/ -run TestMigrationsCreateAllTables -v`
Expected: FAIL —— `teams` 仍存在、`is_public` 不存在。

- [ ] **Step 3: 改写迁移**

`001_init.up.sql`：删 `CREATE TABLE teams`、`CREATE TABLE team_members`、`CREATE INDEX idx_team_members_user`；`recipes.team_id UUID REFERENCES teams(id)` 换成：

```sql
is_public SMALLINT NOT NULL DEFAULT 0,   -- 0 = 私有（默认），1 = 公开到社区
```

`001_init.down.sql` 同步删掉对应的 `DROP TABLE`。

- [ ] **Step 4: 删团队代码，改同步的归属校验**

- 删掉上面列出的六个文件；`router.go` 去掉 `h.team.*` 五条路由与 `handlers.team` 字段、`main.go` 去掉 `NewTeamService` / `NewTeamHandler` 的装配；`router_test.go` / `router_e2e_test.go` 里团队相关的用例删除。
- `service/sync.go`：
  - `mergeRecipe` 去掉 `teamSet` 参数与「团队归属先于一切数据库动作」那段拦截；INSERT / UPDATE 的列由 `team_id` 换成 `is_public`（值取 `r.IsPublic`——菜谱的主人就是当前用户，这个值是他的选择）。
  - `mergeLocalChanges` / `getRemoteChanges` 去掉 `myTeamIDs` 调用与 `teamSet` 传递。
  - `recipesVisibleScope` 改成 `owner_id = $2`，`queryRecipes` 的 `$3` 参数与 `slices` / `maps` 的 import 一起删掉。
  - `queryRecipes` 的 `SELECT` 列：`team_id` → `is_public`，`rows.Scan` 对应改。
- 集成测试：删 `TestJoinTeamThenPullExistingRecipes`；`syncRecipe` 辅助函数的 `teamID *string` 参数换成 `isPublic int16`。

- [ ] **Step 5: 跑全量测试**

Run: `cd backend && go build ./... && go test ./...`
Expected: 全绿（集成测试会起 PostgreSQL 容器）。

- [ ] **Step 6: Commit**

```bash
git add -A backend AGENTS.md
git commit -m "refactor: 删掉团队，同步可见范围退回到只有自己"
```

---

### Task 2: `favorites` / `follows` 表 + 可见范围与同步载荷改造

**Files:**

- Modify: `backend/internal/database/migrations/001_init.up.sql`、`001_init.down.sql`
- Modify: `backend/internal/model/recipe.go`、`model/sync.go`
- Modify: `backend/internal/service/sync.go`（`getRemoteChanges` / `pull` / `queryRecipes` / 新增 `favoriteRecipeIDs`）
- Modify: `backend/internal/database/migrations_test.go`
- Modify: `backend/internal/service/sync_integration_test.go`、`sync_pull_test.go`

**Interfaces:**

- Consumes: Task 1 的 `recipesVisibleScope` / `queryRecipes(...)` / `model.Recipe.IsPublic`。
- Produces:
  - `model.Recipe.OwnerNickname string \`json:"owner_nickname"\``
  - `model.SyncResponse.FavoriteRecipeIDs []string \`json:"favorite_recipe_ids"\``
  - `const recipesVisibleScope = "(owner_id = $2) OR id IN (SELECT f.recipe_id FROM favorites f JOIN recipes r2 ON r2.id = f.recipe_id WHERE f.user_id = $2 AND r2.is_public = 1 AND r2.deleted_at IS NULL)"`
  - `func (s *SyncService) favoriteRecipeIDs(ctx context.Context, q dbQuerier, userID string) ([]string, error)`

- [ ] **Step 1: 写失败的真库集成测试**

`sync_integration_test.go` 新增（沿用文件里已有的 `seedUser` / `startPostgres` 辅助）：

```go
func TestFavoritedPublicRecipeIsPulled(t *testing.T)      // A 公开一道菜并收藏，B 也收藏 → B 按增量拉得到正文
func TestUnpublishedRecipeBodyIsNotPulled(t *testing.T)   // A 取消公开 → 收藏者下一次增量里没有这条菜谱，也没有它的子行
func TestFavoriteRecipeIDsExcludeUnpublished(t *testing.T) // 取消公开后 FavoriteRecipeIDs 不含它；重新公开后又含
```

第二条是隐私回归网，断言必须落到 `resp.RemoteChanges.Recipes` 里**找不到该 id**，不能只断言 `FavoriteRecipeIDs`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestFavorited|TestUnpublished|TestFavoriteRecipeIDs' -v`
Expected: FAIL —— `favorites` 表不存在（`42P01`）。

- [ ] **Step 3: 加两张表**

```sql
-- 只由本人改写的订阅关系，不是业务实体：不带 id / updated_at / deleted_at（AGENTS.md 已确认的例外）
CREATE TABLE favorites (
    user_id    UUID NOT NULL REFERENCES users(id),
    recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, recipe_id)
);
CREATE TABLE follows (
    follower_id UUID NOT NULL REFERENCES users(id),
    followee_id UUID NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX idx_favorites_recipe ON favorites(recipe_id);
```

down.sql 里 `DROP TABLE`。

- [ ] **Step 4: 改同步的可见范围与载荷**

- `recipesVisibleScope` 按上面 Interfaces 里给的原文替换（子查询里内层用 `r2` 别名，避免与外层 `recipes r` 撞名）。
- `queryRecipes` 的 SQL 加 `LEFT JOIN users u ON u.id = r.owner_id`，`SELECT` 加 `r.is_public` 与 `u.nickname`，`rows.Scan` 对应加 `&r.IsPublic, &r.OwnerNickname`；列名全部加 `r.` 前缀。
- 新增 `favoriteRecipeIDs`：`SELECT f.recipe_id FROM favorites f JOIN recipes r ON r.id = f.recipe_id WHERE f.user_id = $1 AND r.is_public = 1 AND r.deleted_at IS NULL`，返回空切片而不是 nil。
- `pull` 在 `getRemoteChanges` 之后调 `favoriteRecipeIDs`，一起放进 `model.SyncResponse`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && go test ./...`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add backend
git commit -m "feat: 收藏与关注的表结构，同步可见范围改为我的加我收藏的"
```

---

### Task 3: 收藏 / 取消收藏（含 `server_seq` 推进）

**Files:**

- Create: `backend/internal/service/community.go`、`community_test.go`
- Modify: `backend/internal/service/sync_integration_test.go`

**Interfaces:**

- Consumes: `favorites` 表；`dbQuerier`（`service/db.go`）。
- Produces:
  - `type CommunityService struct`、`func NewCommunityService(pool *pgxpool.Pool) *CommunityService`
  - `var ErrRecipeNotVisible = errors.New("recipe not visible")`
  - `func (s *CommunityService) Favorite(ctx context.Context, userID, recipeID string) error`
  - `func (s *CommunityService) Unfavorite(ctx context.Context, userID, recipeID string) error`

- [ ] **Step 1: 写失败测试**

真库（复用 `files_test.go` 的容器辅助）：

```go
func TestFavoriteBumpsServerSeqSoLaggingClientsGetIt(t *testing.T)
// A 公开一道菜 → B 先同步一次（游标推过它的 server_seq）→ B 收藏它 →
// B 再用同一个游标同步，必须拿到这条菜谱的正文
func TestFavoriteIsIdempotent(t *testing.T)      // 连调两次，favorites 只有一行，不报错
func TestFavoritePrivateRecipeReturnsNotVisible(t *testing.T)
func TestUnfavoriteIsIdempotent(t *testing.T)    // 没收藏过也能调
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestFavorite|TestUnfavorite' -v`
Expected: FAIL —— `CommunityService` 未定义（编译错）。

- [ ] **Step 3: 实现**

一个事务里做三件事：

1. `SELECT 1 FROM recipes WHERE id = $1 AND is_public = 1 AND deleted_at IS NULL FOR SHARE`，查不到返回 `ErrRecipeNotVisible`；
2. `INSERT INTO favorites (user_id, recipe_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`；
3. `UPDATE recipes SET server_seq = nextval('global_server_seq') WHERE id = $1`。

第 3 步是 spec §7.4 那条规矩，必须写一行注释说明 `server_seq` 在这里也表示「可见性 / 订阅状态变了」。

`Unfavorite` 只做 `DELETE FROM favorites WHERE user_id = $1 AND recipe_id = $2`，不推进 `server_seq`（菜谱离开我的可见范围，正文不会再下发，本地靠 `favorite_recipe_ids` 对账消失）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -run 'TestFavorite|TestUnfavorite' -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: 收藏与取消收藏接口，收藏时推进该菜谱的 server_seq"
```

---

### Task 4: 关注与用户资料

**Files:**

- Create: `backend/internal/model/community.go`
- Modify: `backend/internal/service/community.go`、`community_test.go`

**Interfaces:**

- Consumes: `follows` 表、`CommunityService`。
- Produces:
  - `model.UserProfile{ ID, Nickname string; AvatarURL *string; Followed bool; PublicCount int }`（json：`id` / `nickname` / `avatar_url` / `followed` / `public_count`）
  - `var ErrSelfFollow = errors.New("cannot follow yourself")`、`ErrUserNotFound = errors.New("user not found")`
  - `func (s *CommunityService) Follow(ctx, followerID, followeeID string) error`
  - `func (s *CommunityService) Unfollow(ctx, followerID, followeeID string) error`
  - `func (s *CommunityService) Profile(ctx, viewerID, userID string) (*model.UserProfile, error)`

- [ ] **Step 1: 写失败测试**

```go
func TestFollowIsIdempotentAndProfileReflectsIt(t *testing.T) // 关注两次只一行；Profile(viewer=A, id=B).Followed == true
func TestFollowSelfReturnsErrSelfFollow(t *testing.T)
func TestFollowUnknownUserReturnsErrUserNotFound(t *testing.T)
func TestProfileCountsOnlyPublicRecipes(t *testing.T)         // 私有的不计进 PublicCount
func TestUnfollowIsIdempotent(t *testing.T)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestFollow|TestProfile|TestUnfollow' -v`
Expected: FAIL（编译错：方法未定义）。

- [ ] **Step 3: 实现**

`Follow`：`followerID == followeeID` → `ErrSelfFollow`；`SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)` 为假 → `ErrUserNotFound`；`INSERT ... ON CONFLICT DO NOTHING`。
`Unfollow`：`DELETE ... WHERE follower_id=$1 AND followee_id=$2`，幂等。
`Profile`：一条查询 `LEFT JOIN follows` 取昵称 / 头像 / 是否已关注，一条 `COUNT(*) FROM recipes WHERE owner_id=$1 AND is_public=1 AND deleted_at IS NULL` 取 `PublicCount`；用户不存在 → `ErrUserNotFound`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -run 'TestFollow|TestProfile|TestUnfollow' -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: 关注、取消关注与用户资料"
```

---

### Task 5: 社区列表与详情

**Files:**

- Modify: `backend/internal/model/community.go`
- Modify: `backend/internal/service/community.go`、`community_test.go`
- Modify: `backend/internal/service/sync.go`（把 `backfillReferenced` 复用给社区详情）

**Interfaces:**

- Consumes: `CommunityService`、`backfillReferenced`、`queryRecipes` 可用的同一个 `dbQuerier` 抽象。
- Produces:
  - `model.CommunityRecipe{ ID, Name string; CoverPath *string; AuthorID, AuthorNickname string; UpdatedAt time.Time; Favorited bool }`
  - `model.CommunityListOptions{ Limit, Offset int; AuthorID string; FollowedOnly bool }`
  - `func (s *CommunityService) ListPublicRecipes(ctx, viewerID string, opts model.CommunityListOptions) ([]model.CommunityRecipe, bool, error)`（第二个返回值是 `hasMore`）
  - `func (s *CommunityService) GetPublicRecipe(ctx, viewerID, recipeID string) (*model.SyncPayload, error)`（不存在 / 不可见 → `ErrRecipeNotVisible`）

- [ ] **Step 1: 写失败测试**

```go
func TestListExcludesOwnPublicRecipes(t *testing.T)
func TestListExcludesPrivateAndDeleted(t *testing.T)
func TestListFollowedOnlyReturnsOnlyFollowedAuthors(t *testing.T)
func TestListPaginationReportsHasMore(t *testing.T)      // limit=2，造 3 条 → 第一次 hasMore=true，第二次 false
func TestListMarksFavorited(t *testing.T)
func TestGetPublicRecipeReturnsDictRowsForOfflineRender(t *testing.T) // 引用了一条三天前建的食材，回包里必须带上它
func TestGetPublicRecipeOfPrivateReturnsNotVisible(t *testing.T)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestList|TestGetPublic' -v`
Expected: FAIL（编译错）。

- [ ] **Step 3: 实现**

- `ListPublicRecipes`：`WHERE r.owner_id <> $viewer AND r.is_public = 1 AND r.deleted_at IS NULL`，`author_id` 非空再加一条 `AND r.owner_id = $n`，`followed_only` 再加 `AND r.owner_id IN (SELECT followee_id FROM follows WHERE follower_id = $viewer)`；`LEFT JOIN users u` 取昵称，`LEFT JOIN favorites f ON f.recipe_id = r.id AND f.user_id = $viewer` 取 `favorited`；`ORDER BY r.updated_at DESC, r.id ASC`；`LIMIT limit+1`，多出来的那条用来算 `hasMore` 并丢弃。
- 参数规范化：`Limit <= 0` → 20，`Limit > 50` → 50，`Offset < 0` → 0。
- `GetPublicRecipe`：按 id 查出那一行（同样的公开条件），用 `queryRecipes` 同款的 `attachRecipeChildren` 补子行，装进一个 `model.SyncPayload`（字典三个数组给空切片），再调 `backfillReferenced` 补齐引用的字典行，最后 `queryFiles` 填 `Files`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -run 'TestList|TestGetPublic' -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: 社区公开菜谱的列表与详情"
```

---

### Task 6: 社区 HTTP 接口与路由接线

**Files:**

- Create: `backend/internal/handler/community.go`、`community_test.go`
- Modify: `backend/cmd/server/router.go`、`router_test.go`、`router_e2e_test.go`、`main.go`

**Interfaces:**

- Consumes: Task 3/4/5 的 `CommunityService` 方法与 `model` 类型。
- Produces: 六条受保护路由：

```
GET    /api/v1/community/recipes          ?limit=&offset=&author_id=&followed_only=
GET    /api/v1/community/recipes/{id}
GET    /api/v1/users/{id}
POST   /api/v1/favorites/{recipe_id}
DELETE /api/v1/favorites/{recipe_id}
POST   /api/v1/follows/{user_id}
DELETE /api/v1/follows/{user_id}
```

- [ ] **Step 1: 写失败的 handler 测试**

沿用 `handler/sync_test.go` 的 fake-service 形状：`communityService` 接口 + 注入 fake。

```go
func TestCommunityListRequiresAuth(t *testing.T)          // 无 token → 401
func TestCommunityListPassesQueryParams(t *testing.T)      // limit/offset/author_id/followed_only 传到 fake
func TestCommunityDetailNotVisibleIs404(t *testing.T)      // fake 返回 ErrRecipeNotVisible → 404
func TestFavoriteRecipeNotVisibleIs404(t *testing.T)
func TestFollowSelfIs400(t *testing.T)
func TestProfileUnknownUserIs404(t *testing.T)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/handler/ -run 'TestCommunity|TestFavorite|TestFollow|TestProfile' -v`
Expected: FAIL（编译错）。

- [ ] **Step 3: 实现 handler**

照 `handler/team.go`（已删，见 git 历史）的写法：`type communityService interface {...}`、`NewCommunityHandler(svc communityService)`、每个方法 `middleware.GetUserID(r.Context())` 取 uid，空则 401；`writeJSON` / `writeError` 输出；`followed_only` 用 `r.URL.Query().Get("followed_only") == "1"`；`limit` / `offset` 用 `strconv.Atoi`，解析失败按默认值处理（不报 400）。

- [ ] **Step 4: 接线路由**

`router.go` 的 `handlers` 结构体加 `community *handler.CommunityHandler`，在受保护分组里注册上面七条路由（`r.Get("/community/recipes", ...)` 等）。`main.go` 装配 `service.NewCommunityService(pool)`。
`router_e2e_test.go` 加一条：未带 token 打 `/api/v1/community/recipes` → 401。

- [ ] **Step 5: 跑全量测试**

Run: `cd backend && go build ./... && go test ./...`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add backend
git commit -m "feat: 社区浏览、收藏、关注的 HTTP 接口"
```

---

### Task 7: 图片读权限扩展到公开菜谱

**Files:**

- Modify: `backend/internal/service/files.go:52-71`（`CanRead`）
- Modify: `backend/internal/service/files_test.go`

**Interfaces:**

- Consumes: `recipes.is_public`。
- Produces: `CanRead` 的条件变成 `owner_id = $2` 或 `引用它的那条菜谱 is_public = 1 AND deleted_at IS NULL`。

- [ ] **Step 1: 写失败测试**

```go
func TestCanReadPublicRecipeImageByStranger(t *testing.T)  // B 能下载 A 公开菜谱引用的图
func TestCanReadPrivateRecipeImageByStrangerIsFalse(t *testing.T)
func TestCanReadDeletedPublicRecipeImageByStrangerIsFalse(t *testing.T)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestCanRead -v`
Expected: FAIL —— 公开菜谱的图对陌生人返回 false。

- [ ] **Step 3: 改 SQL**

```sql
AND (  r.owner_id = $2
    OR (r.is_public = 1 AND r.deleted_at IS NULL))
```

`CanRead` 的注释里原来那句「私人图被团队菜谱复用后队友也读得到」要改掉（没有团队了），保留「不筛 deleted_at：菜谱删了图也不至于取不回」这条针对作者的说明。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -run TestCanRead -v`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: 公开菜谱引用的图片对同服务器用户可读"
```

---

### Task 8: 文档与收尾

**Files:**

- Modify: `docs/SELF-HOSTING.md`
- Modify: `docs/开发者-同步与团队.md`（改名见下）

（`README.md` 的用户向说明在客户端计划的 Task 9，不在这里改。）

**Interfaces:**

- Consumes: 前面的全部改动。
- Produces: 与代码一致的文档；`docs/开发者-同步与社区.md`（由 `开发者-同步与团队.md` 改名而来）。

- [ ] **Step 1: 改开发者文档**

`git mv docs/开发者-同步与团队.md docs/开发者-同步与社区.md`，然后：

- 删掉「团队」一节与所有 `team_id` / `team_members` / 邀请码 / 加入后清游标的段落；
- 「可见范围」改成 `owner_id = 我 OR id ∈ 我收藏的（且仍公开）`；
- 补一节「社区与收藏」：公开开关、收藏写 REST、关注、`favorite_recipe_ids` 对账、`server_seq` 在收藏时被推进这条规矩。

- [ ] **Step 2: 改自托管文档**

`SELF-HOSTING.md` 里删掉团队相关的接口说明与示例，补一段社区模型的口径（菜谱默认私有、公开后同服务器可见、收藏与关注只走 REST）。

- [ ] **Step 3: 全量验证**

Run: `cd backend && go vet ./... && go test ./...`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: 自托管与开发者文档改成社区共享模型"
```
