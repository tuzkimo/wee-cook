# 团队与共享库存 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「社区」换成「团队」，让菜谱、库存、字典都按范围（个人 / 每个家庭）隔离并同步，库存升为底栏独立标签页。

**Architecture:** 单库 + `scope_id` 范围列（`p:<uid>` / `t:<teamId>` / `p:local`）隔离五类数据；一次同步拉回「我的个人范围 ∪ 我加入的全部团队」；团队走 REST 不进同步载荷。后端在 `recipes` / 字典三表 / 两张库存表上用 `team_id` + `owner_id` 表达同一个范围，字典同名合并只在同范围内发生。

**Tech Stack:** Vue 3 + TS + Pinia + Tauri 2 + SQLite（`@tauri-apps/plugin-sql`）；Go 1.25 + chi + pgx + PostgreSQL 16 + Redis 7。

**Spec:** `docs/superpowers/specs/2026-10-24-team-inventory-design.md`

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**；非 bugfix 功能必须带单元测试，已有断言只有在「与新规格直接冲突」时才可改（本计划 §14 列出的清单是唯一授权范围）。
- 本地库：未发布，**直接改 DDL，删掉本地 `weecook.db` 重来**，不写兼容迁移。
- 后端：`deleted_at` 表示软删；同步写事务必须先 `pg_advisory_xact_lock(897753)`；LWW 一律比较 `updated_at`，不用 `now()`；子表整组替换。
- 时间戳统一 ISO 8601 UTC（`toIsoTimestamp` / `compareTimestamp`）；日期字段 `produced_at` / `expires_at` 是 `YYYY-MM-DD` 文本。
- 库存余量**永远派生**（批次数量 − 未删除使用记录），不落列。
- 图片通道、`uploaded_files`、AI 模块不改。
- commit message 用中文，符合 `feat(库存): …` 的既有风格。

## Review Focus

1. **切范围后的三处列表**：菜谱页 / 库存页 / 字典选择器都只出现当前范围的行；详情页直接输 URL 也取不到别的范围（Task 6、8、9 的测试钉住）。
2. **建团 / 入团后能看到入团前的存量**：A 先录 5 道，B 入团后必须看得到（Task 10 的「清游标」测试 + Task 15 的手动清单第 7 条）。
3. **认领时字典同名合并**：游客录的「生抽」认领后不能变成账号范围里的第二条同名食材，引用不能断（Task 11）。
4. **登出即隐藏**：认领后 `p:local` 为空，登出界面空态，再登录数据都在（Task 11、12 的测试 + 手动清单第 8 条）。
5. **两个家庭同名食材不合并**：服务端 merge 的查询不带范围，两个团队的「生抽」就会被并成一条（Task 2、3 的越权/隔离用例）。

---

## 阶段 A：后端

### Task 1: 迁移——团队表、范围列、库存两表，删社区表

**Files:**
- Modify: `backend/internal/database/migrations/001_init.up.sql`、`001_init.down.sql`
- Modify: `backend/internal/database/migrations_test.go`

**Interfaces:**
- Produces: 表 `teams(id UUID, name, created_by, created_at, updated_at, deleted_at)`、`team_members(team_id, user_id, role, joined_at, PK(team_id,user_id))`、`inventory_batches` / `inventory_usages`（列见 spec §7.2）；`ingredients` / `units` / `labels` 各多 `team_id UUID NULL` + `owner_id UUID`；`recipes.team_id`，删除 `recipes.is_public`、`favorites`、`follows`。

- [ ] **Step 1: 改现有迁移断言到目标结构（先红）**

在 `migrations_test.go` 里：`tableExists` 断言加上 `teams`、`team_members`、`inventory_batches`、`inventory_usages`，去掉 `favorites`、`follows`；`recipeColumn` 断言有 `team_id`、没有 `is_public`；新增 `columnExists(ctx, t, pool, table, column)` 辅助，断言 `ingredients.team_id` / `ingredients.owner_id` 存在。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/database/`
Expected: FAIL（`teams` 不存在）

- [ ] **Step 3: 改写 `001_init.up.sql`**

按 spec §7.2 写目标结构的完整 SQL：恢复 `teams` / `team_members`；字典三表在 `CREATE TABLE` 里直接带 `team_id` / `owner_id`；`recipes` 用 `team_id UUID REFERENCES teams(id)` 取代 `is_public`；新增两张库存表（`used_at`、没有 `created_at`）；索引按 spec §7.2 的清单。`001_init.down.sql` 同步（drop 顺序：库存 → 字典 → 子表 → recipes → team_members → teams → users）。数据库迁移由 API 启动时 `iofs` 执行，单文件原地改写。

- [ ] **Step 4: 跑测试**

Run: `cd backend && go test ./internal/database/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/database
git commit -m "feat(同步): 迁移加回团队表、范围列与库存两表，删社区表"
```

---

### Task 2: 范围解析 + 字典按范围合并（服务端）

**Files:**
- Modify: `backend/internal/service/sync.go`
- Test: `backend/internal/service/sync_test.go`（纯函数）、`backend/internal/service/sync_integration_test.go`（真库）

**Interfaces:**
- Produces:
  - `func parseScope(scopeID string) (teamID string, personalUser string, err error)`：`t:<uuid>` → `(id, "", nil)`；`p:<uuid>` → `("", id, nil)`；其他 → error。
  - `type scope struct { TeamID *string; OwnerID string }`
  - `func (s *SyncService) resolveScope(ctx context.Context, q dbQuerier, userID, scopeID string) (scope, error)`：个人范围要求 `personalUser == userID`；团队范围要求 `userID` 是该团队未解散团队的成员（`team_members JOIN teams ... deleted_at IS NULL`）。
  - `func scopeWhere(scope scope, argOffset int) (string, []any)`：团队 → `"team_id = $N"`；个人 → `"team_id IS NULL AND owner_id = $N"`。
  - `dictEntity` 合并签名改为 `mergeDict(ctx, tx, spec, scope, ent)`，同键查询与 UPDATE 都带范围。

- [ ] **Step 1: 写失败测试**

`sync_test.go` 加表驱动 `TestParseScope`：`"t:abc"` → team，`"p:abc"` → personal，`""` / `"x:abc"` / `"t:"` → error。真库测试加 `TestMergeDictScopedSameName`：两个团队各推一个 `id` 不同、`name` 都是「生抽」的食材，断言库里两行都在、`team_id` 各自正确、返回的 effective id 等于自己。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestParseScope|TestMergeDictScopedSameName'`
Expected: FAIL（`parseScope` 未定义）

- [ ] **Step 3: 实现**

`parseScope` 用 `strings.CutPrefix`。`resolveScope` 个人分支只比 `userID`，团队分支一条 `EXISTS` 查询。`mergeDict` 的同键查询在 `WHERE name = $n` 之外拼上 `scopeWhere(...)`；`INSERT` 时把 `team_id` / `owner_id` 写进去（personal 的 `owner_id` 就是 scope.OwnerID；团队的 `owner_id` 取当前用户）。`mergeOneDict` 把 scope 透传下去。

- [ ] **Step 4: 跑测试**

Run: `cd backend && go test ./internal/service/ -run 'TestParseScope|TestMergeDictScopedSameName' && go test ./internal/service/`
Expected: PASS（原有合并用例一起绿）

- [ ] **Step 5: 提交**

```bash
git add backend/internal/service
git commit -m "feat(同步): 字典合并按范围隔离，新增范围解析"
```

---

### Task 3: 同步载荷与菜谱范围（服务端）

**Files:**
- Modify: `backend/internal/model/sync.go`、`model/recipe.go`、`model/dict.go`
- Modify: `backend/internal/service/sync.go`
- Modify: `backend/internal/handler/sync.go`
- Test: `backend/internal/service/sync_test.go`、`sync_pull_test.go`、`sync_integration_test.go`

**Interfaces:**
- Consumes: Task 2 的 `parseScope` / `resolveScope` / `scopeWhere`。
- Produces:
  - `model.Recipe` 去掉 `IsPublic`，加 `TeamID *string`；`model.Ingredient/Unit/Label` 加 `ScopeID string \`json:"scope_id"\``；`model.SyncPayload` 加 `InventoryBatches []model.InventoryBatch`、`InventoryUsages []model.InventoryUsage`（类型在 Task 4 定义前，本任务先只加菜谱与字典的 `scope_id`，两个数组留到 Task 4）。
  - `recipesVisibleScope` 改成 `((r.team_id IS NULL AND r.owner_id = $2) OR r.team_id IN (SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id = tm.team_id AND t.deleted_at IS NULL WHERE tm.user_id = $2))`。

- [ ] **Step 1: 写失败测试（真库）**

`sync_integration_test.go` 加 `TestRecipeScopeIsolation`：成员 B 推一条 `scope_id = "p:<A>"` 的菜谱 → 不落库；推 `scope_id = "t:<T>"`（B 是成员）→ 落库且 `team_id = T`；A 的同团队另一条菜谱出现在 B 的拉取结果里；B 的私人菜谱不出现在 A 的拉取结果里。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestRecipeScopeIsolation`
Expected: FAIL（`scope_id` 未解析）

- [ ] **Step 3: 实现**

`mergeLocalChanges` 里每条菜谱先 `resolveScope` 再 `mergeRecipe`（新增参数 `scope scope`）；`mergeRecipe` 的 INSERT 写 `team_id`，UPDATE 前比对库里 `team_id`（用 `IS DISTINCT FROM`），不一致直接跳过；可见范围 SQL 与 `scanRecipeRow`（去掉 `is_public`，加 `team_id`）同步改；`handler/sync.go` 去掉 `favorite_recipe_ids`，`SyncResponse` 删该字段。

- [ ] **Step 4: 跑测试**

Run: `cd backend && go test ./internal/service/ ./internal/handler/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal
git commit -m "feat(同步): 菜谱按范围收发，可见范围换成个人与团队"
```

---

### Task 4: 库存进同步（服务端）

**Files:**
- Create: `backend/internal/model/inventory.go`
- Create: `backend/internal/service/inventory.go`
- Modify: `backend/internal/model/sync.go`、`backend/internal/service/sync.go`
- Test: `backend/internal/service/sync_integration_test.go`

**Interfaces:**
- Produces:
  - `model.InventoryBatch{ID, ScopeID, OwnerID, IngredientID, Amount, UnitID *string, ProducedAt *string, ShelfLifeDays *int, ExpiresAt *string, CreatedAt, UpdatedAt time.Time, DeletedAt *time.Time}`、`model.InventoryUsage{ID, ScopeID, OwnerID, RecipeID, BatchID, Amount, UsedAt, UpdatedAt time.Time, DeletedAt *time.Time}`（JSON 字段照 spec §8.1）。
  - `func (s *SyncService) mergeBatch(ctx, tx, userID string, scope scope, b model.InventoryBatch) error`：LWW；INSERT 写 `owner_id = userID`；UPDATE 保留原 `owner_id`，`team_id` 不一致跳过。
  - `func (s *SyncService) insertUsage(ctx, tx, userID string, scope scope, u model.InventoryUsage) error`：`INSERT ... ON CONFLICT (id) DO NOTHING`；先 `SELECT team_id FROM inventory_batches WHERE id = $1`（**不筛 deleted_at**）校验批次存在且 `team_id` 与 scope 一致，否则跳过。
  - `func queryBatches(ctx, q, userID string, sinceSeq int64)`、`func queryUsages(...)`、`func backfillInventoryDicts(...)`。

- [ ] **Step 1: 写失败测试（真库）**

`sync_integration_test.go` 加三个用例：
1. `TestInventoryBatchLWW`：同 id 两次推送，`updated_at` 新的赢；软删墓碑生效；更新不覆盖 `owner_id`。
2. `TestUsageAppendOnlyIdempotent`：同 id 推两次只有一行；指向已软删批次仍落库；指向不存在的批次被跳过；`team_id` 与批次不一致被跳过。
3. `TestInventoryScopeIsolation`：非成员推团队批次被跳过；A 的私人批次不出现在 B 的拉取里。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestInventory|TestUsage'`
Expected: FAIL（未定义）

- [ ] **Step 3: 实现**

按 Interfaces 写 `service/inventory.go`；`SyncPayload` 两个数组加回（含 `ScopeID`）；`mergeLocalChanges` 在菜谱之后处理两个数组；`getRemoteChanges` 查两个数组并 `backfillInventoryDicts`（把批次引用的 `ingredient_id` / `unit_id` 补进 `payload.Ingredients` / `payload.Units`）；`maxServerSeqSQL` 扩到六表。

- [ ] **Step 4: 跑测试**

Run: `cd backend && go test ./internal/service/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal
git commit -m "feat(同步): 库存批次按范围 LWW、使用记录只增不清"
```

---

### Task 5: 团队 service / handler / 路由

**Files:**
- Create: `backend/internal/model/team.go`、`backend/internal/service/team.go`、`backend/internal/handler/team.go`
- Test: `backend/internal/service/team_test.go`、`backend/internal/handler/team_test.go`
- Modify: `backend/cmd/server/router.go`、`backend/cmd/server/router_test.go`、`backend/cmd/server/main.go`

**Interfaces:**
- Produces（service）：
  - `type TeamSummary struct { ID, Name, Role string; MemberCount int }`
  - `type TeamMember struct { UserID, Nickname, Username, Role string }`
  - `NewTeamService(pool *pgxpool.Pool, rdb inviteRedis) *TeamService`，`inviteRedis` 是 `Get/Set/Del(ctx, ...)` 的窄接口（照 wee-count，测试注入 fake）。
  - `List(ctx, userID) ([]TeamSummary, error)`、`Create(ctx, userID, name) (TeamSummary, error)`、`Invite(ctx, userID, teamID) (string, error)`、`Join(ctx, userID, code) (TeamSummary, error)`、`Rename(ctx, userID, teamID, name) error`、`Members(ctx, userID, teamID) ([]TeamMember, error)`、`RemoveMember(ctx, userID, teamID, target) error`、`Leave(ctx, userID, teamID) error`、`Transfer(ctx, userID, teamID, target) error`、`Dissolve(ctx, userID, teamID) error`。
  - 错误哨兵：`ErrTeamNotFound`、`ErrNotTeamOwner`、`ErrNotTeamMember`、`ErrInviteInvalid`、`ErrOwnerCannotLeave`、`ErrCannotRemoveOwner`、`ErrNotMemberTarget`。
- Produces（handler / 路由）：spec §9 的九个端点；`POST /teams/join` 走 `httprate.LimitBy(10, time.Minute, clientIPKey)`；`GET /teams` 的可见范围 = `team_members JOIN teams WHERE deleted_at IS NULL`。

- [ ] **Step 1: 写失败测试**

`team_test.go`（fake `dbQuerier` + fake redis）：建团队写两行（teams + owner 成员）；邀请码存 `invite:<6位>` 24h；加入成功才删码；第二次加入不重复插成员；非 owner 改名 / 邀请 / 移除 / 转让 / 解散都返回 `ErrNotTeamOwner`；owner 直接退出返回 `ErrOwnerCannotLeave`；转让后原 owner 变 member、目标变 owner；移除自己返回 `ErrCannotRemoveOwner`；解散后 `List` 不再返回它。`router_test.go` 断言 `/teams/ls` 形状的目标路由都注册且 `/teams/join` 在登录限流组里。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestTeam && go test ./cmd/server/`
Expected: FAIL（未定义）

- [ ] **Step 3: 实现**

按 Interfaces 实现；所有「owner 操作」先查 `team_members.role`；`Transfer` 用事务内两条 UPDATE；`Dissolve` 写 `deleted_at`；`Create` 不碰 `server_seq`（团队不进同步载荷）。handler 按现有 `handler/auth.go` 的写法取 `middleware.UserID(ctx)`、写 JSON、映射错误码（403 / 404 / 400）。`main.go` 装配 `NewTeamService(pool, redis)`。

- [ ] **Step 4: 跑测试**

Run: `cd backend && go test ./...`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend
git commit -m "feat(团队): 建团、邀请码入组、改名、移除、退出、转让、解散"
```

---

### Task 6: 后端删社区 + 图片读权限改范围

**Files:**
- Delete: `backend/internal/model/community.go`、`backend/internal/service/community.go`、`backend/internal/service/community_test.go`、`backend/internal/handler/community.go`、`backend/internal/handler/community_test.go`
- Modify: `backend/cmd/server/router.go`、`router_test.go`、`router_e2e_test.go`、`main.go`
- Modify: `backend/internal/service/files.go`、`files_test.go`

**Interfaces:**
- Produces: `FileService.CanRead` 的可见范围 = `(r.team_id IS NULL AND r.owner_id = $2) OR r.team_id IN (visible_teams)`（可见团队定义与 Task 3 一致）。

- [ ] **Step 1: 改测试（先红）**

`files_test.go`：把「公开菜谱的图非作者也能读」改成「团队成员能读队友菜谱的图」「非成员读不到」「个人菜谱的图只有本人能读」。`router_test.go` / `router_e2e_test.go`：删 `/community/*`、`/favorites/*`、`/follows/*`、`/users/{id}` 断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestFile && go test ./cmd/server/`
Expected: FAIL

- [ ] **Step 3: 实现**

删社区三个文件与路由、`main.go` 装配；`CanRead` 换 SQL；`CommunityHandler` 引用全部清除。

- [ ] **Step 4: 跑测试**

Run: `cd backend && go test ./...`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend
git commit -m "refactor(后端): 删除社区接口，图片读权限改按团队可见范围"
```

---

## 阶段 B：客户端范围模型

> **这一阶段是一个原子改动**：本地表结构、字典 / 菜谱 / 库存 store、同步载荷互相依赖，中间态全量 `npm run test` 不会全绿。每个任务的验收标准是「本任务列出的测试文件通过 + `npx vitest run src/stores src/services/__tests__` 现有用例不新增失败」；**全量绿的门在 Task 11 结束**（Task 12 起恢复正常：任务结束即可全绿）。

### Task 7: 本地 DDL 换范围模型

**Files:**
- Modify: `src/db/index.ts`
- Modify: `src/db/__tests__/schema.test.ts`、`src/db/__tests__/migrate.test.ts`

**Interfaces:**
- Produces:
  - 五张表（`recipes`、`ingredients`、`units`、`labels`、`inventory_batches`、`inventory_usages`）各带 `scope_id TEXT NOT NULL`；`inventory_batches` / `inventory_usages` 另带 `owner_id TEXT`。
  - 唯一索引：`idx_ingredients_scope_name(scope_id, name) WHERE deleted_at IS NULL`、`idx_units_scope_name`、`idx_labels_scope_name_kind(scope_id, name, kind)`。
  - `teams(id, name, role, member_count)` 表。
  - 删 `favorite_recipes`、`local_accounts`、`recipes.is_public`。

- [ ] **Step 1: 写失败测试**

`schema.test.ts`：断言 `PRAGMA table_info` 里有 `scope_id`（六张表）与 `owner_id`（两张库存表）；断言 `is_public` 不在 `recipes` 上；断言两个范围可以各插一个同名食材、同范围插第二个报 UNIQUE；断言 `teams` 表存在。`migrate.test.ts`：删收藏 / 本机账号断言，加「老库没有 `scope_id` 时补上默认 `p:local`」。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/db/__tests__`
Expected: FAIL

- [ ] **Step 3: 实现**

按 spec §7.1 改 `DDL`：`scope_id` 直接写进 `CREATE TABLE`（不给默认值，NOT NULL 由插入方保证）；`migrateTables` 保留 owner_id / owner_nickname / owner_avatar_url / 老 `team_id` 清理，新增 `scope_id` 与库存 `owner_id` 的补列（`DEFAULT 'p:local'`）。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/db/__tests__`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/db
git commit -m "feat(范围): 本地表加 scope_id，字典唯一键改成按范围"
```

---

### Task 8: 范围服务与字典 store 按范围

**Files:**
- Create: `src/services/scope.ts`、`src/services/__tests__/scope.test.ts`
- Modify: `src/stores/refStore.ts`、`src/stores/label.ts`
- Test: `src/stores/__tests__/refStore.test.ts`、`src/stores/__tests__/label.test.ts`

**Interfaces:**
- Produces（`src/services/scope.ts`，不 import 任何 store，避免循环依赖）：
  - `export const LOCAL_SCOPE = "p:local"`
  - `export function personalScope(userId: string): string`
  - `export function teamScope(teamId: string): string`
  - `export function scopeFor(userId: string | null, teamId: string | null): string`
  - `export const activeScope = ref<string>(LOCAL_SCOPE)`；`export function setActiveScope(next: string): void`
- Produces（stores）：`createRefStore` / `useLabelStore` 的所有查询、`add`、`assertNameFree`、`countRecipes`、`countStocked` 都带 `scope_id = activeScope.value`；插入写 `scope_id`。

- [ ] **Step 1: 写失败测试**

`scope.test.ts`：`scopeFor(null, null) === "p:local"`、`scopeFor("u1", null) === "p:u1"`、`scopeFor("u1", "t1") === "t:t1"`。`refStore.test.ts` 加「两个范围各有一个「鸡蛋」互不冲突；`fetchAll` 只返回当前范围；同范围重名报错」。`label.test.ts` 加同构的一条。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/__tests__/scope.test.ts src/stores/__tests__/refStore.test.ts src/stores/__tests__/label.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`scope.ts` 四函数 + 一个 ref。`refStore.ts`：所有 SQL 加 `scope_id = ?`（`assertNameFree` 的 `WHERE`、`fetchAll` 的主表条件、`USAGE_COUNTS` 子查询里加 `AND r.scope_id = ?`），INSERT 带 `scope_id`；`countStocked` 加 `scope_id = ?`。`label.ts` 同构（`USAGE_COUNTS` 变成接受范围参数的函数 `usageCountsSql(scope)`）。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/stores src/services/__tests__/scope.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/scope.ts src/services/__tests__/scope.test.ts src/stores
git commit -m "feat(范围): 字典按当前范围读写，新增范围服务"
```

---

### Task 9: 菜谱 store 按范围，删收藏

**Files:**
- Modify: `src/types/index.ts`、`src/stores/recipe.ts`
- Test: `src/stores/__tests__/recipe.test.ts`、`src/stores/__tests__/recipeVisibility.test.ts`

**Interfaces:**
- Produces: `Recipe` 去掉 `is_public`、加 `scope_id: string`；`RecipeInput` 去掉 `is_public`；`visibleRecipeFilter(): Promise<{ sql: "scope_id = ?"; params: [string] }>`；`canEdit(recipe)` 只看 `owner_id`。
- Removes: `RecipeStore.favorites`、`fetchFavorites()`。

- [ ] **Step 1: 改测试（先红）**

`recipeVisibility.test.ts`：把「社区可见性」用例换成「切范围后只看到该范围的菜谱」「未登录只看到 `p:local`」「团队里别人建的菜谱可见但 `canEdit` 为 false」。`recipe.test.ts`：`create` 写入 `scope_id = activeScope`，删掉 `is_public` 相关断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/recipe.test.ts src/stores/__tests__/recipeVisibility.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`visibleRecipeFilter` 返回 `{ sql: "scope_id = ?", params: [activeScope.value] }`；`getDetail` 的可见性条件同理（删掉社区缓存分支）；`create` / `bumpParent` 去掉 `is_public`、写入 `scope_id`；删 `favorites` / `fetchFavorites`。

同时把全部测试夹具里的 `is_public` 删掉、给构造 `Recipe` 的地方补 `scope_id: LOCAL_SCOPE`——`grep -rn "is_public" src` 必须清零（`src/services/ai/__tests__`、`src/views/__tests__`、`src/utils/__tests__`、`src/stores/__tests__` 都有；夹具缺字段会直接类型报错）。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/stores`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/types src/stores
git commit -m "feat(范围): 菜谱按范围读写，删除收藏"
```

---

### Task 10: 库存 store 按范围 + 归属

**Files:**
- Modify: `src/types/index.ts`、`src/stores/inventory.ts`
- Test: `src/stores/__tests__/inventory.test.ts`

**Interfaces:**
- Produces: `InventoryBatch` / `InventoryUsage` 加 `scope_id: string`，两者的批次 / 记录加 `owner_id: string | null`；`addBatch` 写 `scope_id = activeScope.value`、`owner_id = auth.serverUserId`；`commitCook` 写使用记录带 `scope_id`（批次的范围）与 `owner_id`；新增 `batchPayload(id): Promise<InventoryBatch | null>` 与 `usagePayloads(ids: string[]): Promise<InventoryUsage[]>`（从库里重读整行，供 `enqueueSync`）。

- [ ] **Step 1: 写失败测试**

`inventory.test.ts` 加：两个范围各录一批同食材批次，`fetchAll` 只返回当前范围；`remainingByIngredient` 不跨范围；`commitCook` 只能扣当前范围的批次，写入的 `inventory_usages` 行 `scope_id` = 批次范围、`owner_id` = 当前 uid；`addBatch` 写入的批次 `owner_id` 正确。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/inventory.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`fetchAll` 的 SQL 加 `AND b.scope_id = ?`；`addBatch` / `commitCook` 的 INSERT 加两列；`commitCook` 用 `activeScope.value` 与 `useAuthStore().serverUserId`（store 内已有 auth 的用法先例，参照 `recipe.ts`）。写库后调 `enqueueSync`：`addBatch` / `removeBatch` 入队 `batchPayload(id)`，`commitCook` 入队 `usagePayloads(写入的 id 列表)`。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/stores/__tests__/inventory.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/types src/stores
git commit -m "feat(库存): 批次与使用记录带范围与归属"
```

---

### Task 11: 客户端同步——载荷、落地、算范围

**Files:**
- Modify: `src/services/sync.ts`、`src/services/__tests__/syncMerge.test.ts`、`src/services/__tests__/sync.test.ts`
- Delete: `src/services/__tests__/syncReconcile.test.ts`

**Interfaces:**
- Produces: `SyncPayload` 加 `inventory_batches` / `inventory_usages`；`PENDING_KEYS` 六类；`applyRemoteChanges` 处理两个新数组；`collectPushPayload` 按「我的范围集合」收集；`localScopeIds(db, uid): Promise<string[]>`（个人 + `teams` 表里的团队）；`clearSyncCursorFor(uid)`。
- Removes: `reconcileFavorites`、`registerLocalAccount`、`bumpFavoriteOps`、`favoriteOpsEpoch`、`cacheCommunityChanges`、`deleteCachedOtherRecipes`、`favorite_recipe_ids`。

- [ ] **Step 1: 写失败测试**

`syncMerge.test.ts`：删 `is_public` 断言；加「批次行 LWW（旧的不覆盖新的）」「软删墓碑落库」「使用记录 `INSERT OR IGNORE`（同 id 只一行）」「字典同名合并不跨范围（`p:a` 与 `p:b` 各一个「生抽」都保留）」「remap 把 `inventory_batches.ingredient_id` 改指」。`sync.test.ts`：加「`collectPushPayload` 只收 `owner_id = 我` 的菜谱 / 批次 / 使用记录」「`localScopeIds` 返回个人范围 + teams 表里的团队」。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/__tests__/sync`
Expected: FAIL

- [ ] **Step 3: 实现**

`SyncPayload` / `emptyPayload` / `PENDING_KEYS` / `mergeChanges`（两类新行都按 `id` + `updated_at` 去重，使用记录用 `used_at` 兜底）扩到六类；`applyRemoteChanges` 加批次 LWW 分支与 `INSERT OR IGNORE` 使用记录分支；字典 `findDupSql` 加 `scope_id = ?`；`collectPushPayload` 用 `localScopeIds` 过滤三个数组；删除收藏相关函数与字段。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/services/__tests__/sync*`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services
git commit -m "feat(同步): 载荷带库存，字典去重带范围，删除收藏对账"
```

---

### Task 12: 认领（游客范围 → 账号范围）

**Files:**
- Modify: `src/services/migration.ts`、`src/services/__tests__/migration.test.ts`

**Interfaces:**
- Produces: `claimLocalScope(userId: string, db?: Db): Promise<void>`，替代 `claimOrphanRecipes`；`triggerFullPushAndSync` 里改为 `await claimLocalScope(uid)`，删掉 `registerLocalAccount`。

- [ ] **Step 1: 写失败测试**

`migration.test.ts` 改写为：`p:local` 的菜谱 / 批次 / 使用记录在认领后 `scope_id` 变成 `p:<uid>`、`owner_id` 补上；认领后 `p:local` 里没有剩余行（登出即空态的前提）；目标范围已有同名食材时，游客那条被删、引用被改指（`recipe_ingredients` 与 `inventory_batches` 两个方向都断言）；第二次调用是空操作。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/__tests__/migration.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

三张字典表逐个：查 `scope_id = 'p:local'` 的行，按合并键（ingredients / units 用 `name`，labels 用 `name + kind`）在 `scope_id = personalScope(uid)` 里找同名行，有则执行 repoint SQL（与 `sync.ts` 的 `repointSql` 同一组）再 `DELETE` 游客行；然后五张表各一条 `UPDATE ... SET scope_id = ? WHERE scope_id = 'p:local'`，菜谱 / 批次 / 使用记录同时 `owner_id = COALESCE(owner_id, ?)`。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/services/__tests__/migration.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services
git commit -m "feat(认领): 游客范围整批并入账号范围，字典同名合并"
```

---

### Task 13: 客户端删社区

**Files:**
- Delete: `src/components/CommunityFeed.vue`、`src/components/__tests__/CommunityFeed.test.ts`、`src/views/UserPage.vue`、`src/views/__tests__/UserPage.test.ts`、`src/stores/community.ts`、`src/stores/__tests__/community.test.ts`、`src/services/community.ts`、`src/services/__tests__/community.test.ts`
- Modify: `src/views/RecipeList.vue`、`RecipeDetail.vue`、`RecipeEdit.vue`、`src/components/RecipeCard.vue`、`src/router/index.ts`
- Test: `src/views/__tests__/RecipeList.test.ts`、`RecipeDetail.test.ts`、`RecipeEdit.test.ts`、`components/__tests__/RecipeCard.test.ts`、`router/__tests__/routes.test.ts`

**Interfaces:**
- Produces: 菜谱页没有 tab 行、没有社区段落；路由删 `/user/:id`。

- [ ] **Step 1: 改测试（先红）**

`RecipeList.test.ts`：删四个 tab / 收藏 / 社区段落用例，加「只渲染当前范围的列表」「空态文案随范围变」。`RecipeDetail.test.ts` / `RecipeEdit.test.ts`：删收藏 / 公开开关用例。`RecipeCard.test.ts`：删收藏星标 / 关注断言。`routes.test.ts`：删 `/user/:id` 断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views src/components src/router`
Expected: FAIL

- [ ] **Step 3: 实现**

删文件；`RecipeList.vue` 去掉 tab 状态、社区段落、`loadFavorites`、作者解析里社区那支；`RecipeDetail.vue` 删收藏按钮 / 公开开关 / 用户页跳转；`RecipeEdit.vue` 删公开开关；`RecipeCard.vue` 删星标与关注入口；`router/index.ts` 删 `/user/:id` 与 import。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/views src/components src/router`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A src
git commit -m "refactor(社区): 删除公开、收藏、关注与用户页"
```

---

## 阶段 C：团队客户端

### Task 14: 团队 API 与 store

**Files:**
- Create: `src/services/team.ts`、`src/stores/team.ts`
- Test: `src/stores/__tests__/team.test.ts`

**Interfaces:**
- Produces（`services/team.ts`，全部走 `apiFetch`）：`fetchTeams()`、`createTeam(name)`、`joinTeam(code)`、`renameTeam(id, name)`、`fetchMembers(id)`、`createInvite(id)`、`removeMember(id, userId)`、`leaveTeam(id)`、`transferOwner(id, userId)`、`dissolveTeam(id)`，返回类型用 `TeamSummary` / `TeamMember`（定义在 `src/types`）。
- Produces（`stores/team.ts`）：`teams`、`currentTeamId`、`scopeId`（computed，来自 `scopeFor(auth.serverUserId, currentTeamId)`）、`load()`、`switchTo(id | null)`、`create(name)`、`join(code)`、`rename`、`members`、`invite`、`removeMember`、`leave`、`transfer`、`dissolve`、`resetFor(uid: string | null)`。
  - `create` / `join`：`load()` → `switchTo(newId)` → `clearSyncCursorFor(uid)` → `requestSyncNow()`。
  - `leave` / `removeMember(self)` / `dissolve`：若当前范围是它 → `switchTo(null)`；然后 `load()`。
  - `resetFor`：`DELETE FROM teams`；`currentTeamId = null`；持久化键 `current_team:<uid>`。
  - 每次 `currentTeamId` 变化都调 `setActiveScope(scopeId.value)` 并刷新 `recipe.fetchAll()`、`inventory.fetchAll()`、`ingredient/unit/label.fetchAll()`。

- [ ] **Step 1: 写失败测试**

`team.test.ts`（mock `services/team.ts` + 内存 SQLite）：`load` 整表替换 `teams` 表；`create` 后 `currentTeamId` = 新团队、游标被清、`activeScope` = `t:<id>`；`join` 同构；`leave` 当前团队后回落 `null` 且 `activeScope` = `p:<uid>`；`resetFor` 清空缓存与当前范围；未登录时 `create` 抛「先连接服务器」。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/team.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`services/team.ts` 十个薄封装（照现有 `apiFetch` 用法）；`stores/team.ts` 按 Interfaces 实现；`clearSyncCursorFor` 在 Task 11 已存在。`load` 用 `DELETE FROM teams` + 逐条 INSERT。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/stores/__tests__/team.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/team.ts src/stores/team.ts src/stores/__tests__/team.test.ts
git commit -m "feat(团队): 团队列表缓存与切换范围"
```

---

### Task 15: 团队页面、切换器、库存标签页

**Files:**
- Create: `src/views/TeamListPage.vue`、`src/views/TeamMembersPage.vue`、`src/components/TeamSwitcher.vue`
- Test: `src/views/__tests__/TeamListPage.test.ts`、`src/views/__tests__/TeamMembersPage.test.ts`
- Modify: `src/views/InventoryPage.vue`、`src/views/RecipeList.vue`、`src/views/MePage.vue`、`src/router/index.ts`、`src/App.vue`
- Test（改）：`src/views/__tests__/InventoryPage.test.ts`、`MePage.test.ts`、`router/__tests__/routes.test.ts`

**Interfaces:**
- Produces: 路由 `/me/teams`（`team-list`）、`/me/teams/:id`（`team-members`），都 `hideTab`；`/inventory` 去掉 `hideTab`；底栏 `TABS` = 菜谱 / 库存 / AI(条件) / 我的；`TeamSwitcher` 用 `useTeamStore()`，`data-test="team-switcher"`，选项 `data-test="team-option"`（「我的菜谱」+ 每个团队）；未登录（`auth.serverUserId === null`）时整块不渲染（只有一个范围，没有可切的）。

- [ ] **Step 1: 写失败测试**

新测试：`TeamListPage` 列出团队、点「创建」调 `create`、点「加入」调 `join`；`TeamMembersPage` 在 owner 视角显示「改名 / 邀请码 / 移除 / 转让 / 解散」，member 视角只显示「退出」；自己的行没有移除按钮。改测试：`InventoryPage` 断言有 `team-switcher` 且切换后调 `fetchAll`；`MePage` 断言有「我的团队」行、没有「食材库存」行；`routes.test.ts` 断言两条团队路由与 `/inventory` 不再是 `hideTab`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views src/router`
Expected: FAIL

- [ ] **Step 3: 实现**

三个新文件按 spec §10.2 的形态写（复用 `AppHeader` / `ConfirmDialog` / 现有 row 样式）；`InventoryPage` 页头下方加 `TeamSwitcher` 并从 store 读范围；`RecipeList` 页头加 `TeamSwitcher`；`MePage` 删库存行、加团队行；`App.vue` 加库存 tab（图标 `Package` 或 `Boxes`）；路由按 Interfaces。

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/views src/router && npm run build`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src
git commit -m "feat(团队): 团队页与范围切换器，库存升为底栏标签"
```

---

## 阶段 D：收尾

### Task 16: 登录时序接线、文档与全量验证

**Files:**
- Modify: `src/stores/auth.ts`（`login` / `register` / `restoreSession` / `logout` 四处）
- Modify: `docs/开发者-同步与社区.md` → 改名为 `docs/开发者-同步与团队.md`、`docs/SELF-HOSTING.md`
- Test: `src/stores/__tests__/auth.test.ts`

**Interfaces:**
- Consumes: `useTeamStore().load()` / `resetFor(uid)`、`claimLocalScope`、`triggerFullPushAndSync`。
- Produces: 会话变在线 → `await team.load()` 后再 `triggerFullPushAndSync()`；登出 → `team.resetFor(null)`。

- [ ] **Step 1: 写失败测试**

`auth.test.ts` 加：登录成功后先调用 `team.load()` 再触发同步（用调用顺序断言）；登出调用 `resetFor(null)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/auth.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现（含文档）**

在三个会话成功路径与登出路径接线（`triggerPostSessionSync` 内部先 `await useTeamStore().load()`，失败不抛）。文档：`docs/开发者-同步与社区.md` 改名为 `docs/开发者-同步与团队.md` 并改写社区段落为团队与范围说明；`docs/SELF-HOSTING.md` 删社区段落、加团队说明（建团、邀请码 24h、多家庭共用一台服务器的意义）。

- [ ] **Step 4: 全量验证**

```bash
npm run test
npm run build
cargo check
cd backend && go test ./...
```
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(团队): 登录后先刷团队缓存再同步，更新开发者文档"
```

---

## 手动验证（执行者按 spec §15 的十条逐条跑）

本机 `docker compose up` + 两个 Tauri 实例（两个不同 `$APPDATA`），Android 真机跑一遍底栏四标签与切换器。
