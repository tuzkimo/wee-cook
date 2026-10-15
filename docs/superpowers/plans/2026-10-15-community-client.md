# 社区共享 · 客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把客户端的「团队 / 菜谱本」整段删掉，换成「一个服务器 = 一个社区」：我的菜谱默认私有，可一键公开；别人的公开菜谱在线浏览、可收藏（落本地离线和可看）、可关注。

**Architecture:** 沿用现有同步核心（`applyRemoteChanges` 的 LWW 与子行整组替换、按 uid 隔离的队列与游标、3 秒防抖与指数退避）。删掉 `team_id` 与菜谱本；本地新增 `is_public` / `owner_nickname` 两列和 `favorite_recipes` / `local_accounts` 两张表。社区浏览走新的 REST 接口，拿到的是与 `/sync` 的 `remote_changes` 同形状的载荷，直接喂给 `applyRemoteChanges` 落库，详情页因此零改动。对账规则：每次同步后本地只保留「我的菜谱 + 我收藏的」，其余别人的副本清掉；`local_accounts` 白名单保护「本机上另一个账号自己的菜谱」不被误删。

**Tech Stack:** Vue 3 + TypeScript（严格模式，禁止 `any`）+ Pinia + Vite + Tauri 2 + `@tauri-apps/plugin-sql`（SQLite）+ Vitest。

**Spec:** `docs/superpowers/specs/2026-10-15-community-design.md`
**后端计划（先做）:** `docs/superpowers/plans/2026-10-15-community-backend.md`

## Global Constraints

- TypeScript 严格模式，禁止 `any`；不可删改与被删功能无关的测试。删除团队 / 菜谱本自己的测试是**规格要求**（已人工确认）。
- 布尔值端到端用 `0` / `1` 整数（SQLite `INTEGER` → TS `number`），不做 `boolean` 转换。
- 未登录时的行为必须与今天一致：不出登录墙、不发任何网络请求、本地功能不受影响。
- 每张业务表带 `id` / `updated_at` / `deleted_at`。例外（已确认，见 `AGENTS.md` 与 spec §12）：`favorite_recipes` / `local_accounts` 不带这三列。
- 每个 Task 结束跑一次：`npm run test && npm run build`。
- 测试库一律用 `src/db/__tests__/sqliteTestDb.ts` 的 `freshTestDb()`（真 SQLite），不要 mock SQL。

## Review Focus

- **同一台手机上换账号**：A 登录同步一次，不能把 B 留在本机的菜谱删掉（B 的游标已经推过，删了就再也拉不回来）。`local_accounts` 就是为这条存在，最要紧。
- **登出之后**：本地缓存着的别人的公开菜谱不能混进「我的菜谱」列表。
- **刚点收藏就被在途同步的旧快照覆盖**：收藏不能闪一下消失。
- **作者取消公开 / 我取消收藏 / 作者删菜谱**：三种情况下本地那份都要消失。
- **离线**：收藏按钮不可用（灰着）；离线看已收藏的菜谱时，封面、作者昵称、食材名都要在（图片与字典行都已落本地）。
- **社区接口挂掉**：菜谱页的「我的菜谱」段落照常显示，只有社区段落显示加载失败。

---

### Task 1: 删掉团队与菜谱本，可见范围退回到「我自己的」

**Files:**

- Delete: `src/stores/team.ts`、`src/stores/book.ts`、`src/stores/__tests__/team.test.ts`、`src/stores/__tests__/book.test.ts`、`src/views/TeamPage.vue`、`src/views/TeamJoinPage.vue`、`src/views/TeamMembersPage.vue`、`src/views/__tests__/TeamPage.test.ts`
- Modify: `src/router/index.ts`、`src/types/index.ts`、`src/stores/recipe.ts`、`src/services/migration.ts`、`src/stores/auth.ts`、`src/views/RecipeList.vue`、`src/views/MePage.vue`
- Modify (tests): `src/stores/__tests__/recipeVisibility.test.ts`、`src/views/__tests__/RecipeList.test.ts`、`src/views/__tests__/MePage.test.ts`、`src/views/__tests__/placeholderPages.test.ts`、`src/services/__tests__/migration.test.ts`

**Interfaces:**

- Consumes: 无（起点）。
- Produces:
  - `visibleRecipeFilter(): Promise<{ sql: string; params: unknown[] }>` —— 未登录 `1=1`；登录 `owner_id = ?`（Task 4 再把未登录那条改细）。
  - `canEdit(recipe: Recipe): boolean` —— 不变（`owner_id === 我`，未登录时 `owner_id === null`）。
  - `currentOwnership(): { owner_id: string | null }` —— 去掉 `team_id`。
  - `src/types/index.ts` 的 `Recipe` 去掉 `team_id`、`BookRef` 删除。

- [ ] **Step 1: 先把测试改成新预期，跑出失败**

- `recipeVisibility.test.ts`：删「登录后只显示我的私人菜谱与我所在的团队菜谱」「切换菜谱本只影响列表，不改数据」「断网冷启动：有 uid 的团队缓存时，家人菜谱仍在可见范围里」；「新增菜谱写入当前用户与当前菜谱本」改成「新增菜谱写入当前用户」；断言里不再出现 `team_id`。
- `RecipeList.test.ts`：删菜谱本切换器的用例；`MePage.test.ts` 与 `placeholderPages.test.ts`：删「我的家庭」入口相关的用例。
- 新增一条：`it("登录后可见范围只有 owner_id = 我", ...)`——`visibleRecipeFilter()` 的 `sql` 恰好是 `"owner_id = ?"`，`params` 是 `[uid]`。

Run: `npx vitest run src/stores/__tests__/recipeVisibility.test.ts`
Expected: FAIL（`team_id` 相关的旧断言对着新代码跑不通 / 引用已删模块）。

- [ ] **Step 2: 删文件、改代码**

- 删掉上面列出的文件；`router/index.ts` 去掉三条 `/me/team*` 路由与 import。
- `src/stores/recipe.ts`：删 `useTeamStore` / `useBookStore` 的 import；`visibleRecipeFilter` 按上面的新实现；`currentOwnership` 只返回 `{ owner_id: uid }`；`create` 的 INSERT 去掉 `team_id` 列与参数（`is_public` 在 Task 3 加）；`fetchAll` 去掉 `book` 那段 `team_id = ?` 条件。
- `src/services/migration.ts`：删 `useTeamStore` 的 import 与 `triggerFullPushAndSync` 末尾的 `await useTeamStore().load()`。
- `src/stores/auth.ts`：`logout()` 里删掉 `import("@/stores/team")` 与 `useTeamStore().reset()` 这一段（`Promise.all` 只剩 `resetSyncTimers`）。
- `src/views/RecipeList.vue`：删菜谱本切换器的模板与 `book` 相关代码，`onMounted` 只留 `store.fetchAll()`。
- `src/views/MePage.vue`：删「我的家庭」两个入口。
- `src/services/sync.ts`：删 `clearCursor`（只有团队加入用过它）——先 grep 确认没有别的调用点。

- [ ] **Step 3: 跑全量测试与类型检查**

Run: `npm run test && npm run build`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: 客户端删掉团队与菜谱本，可见范围只有自己的菜谱"
```

---

### Task 2: 本地 schema — `is_public` / `owner_nickname` / `favorite_recipes` / `local_accounts`

**Files:**

- Modify: `src/db/index.ts`
- Test: `src/db/__tests__/schema.test.ts`、`src/db/__tests__/migrate.test.ts`

**Interfaces:**

- Consumes: Task 1 的干净 schema。
- Produces: `recipes` 多两列 `is_public INTEGER NOT NULL DEFAULT 0`、`owner_nickname TEXT`；不再有 `team_id`；新表 `favorite_recipes(recipe_id TEXT PRIMARY KEY)`、`local_accounts(user_id TEXT PRIMARY KEY)`。

- [ ] **Step 1: 写失败测试**

`migrate.test.ts` 里现有的是「旧库 → 跑 initTables → 新列出现」的形状。照它加：

```ts
it("旧库升级后 recipes 带 is_public 与 owner_nickname", ...)      // PRAGMA table_info 断言两列存在
it("旧库升级后 team_id 列被删掉", ...)                            // 先手工建带 team_id 的 recipes，再 initTables，断言列没了
it("favorite_recipes 与 local_accounts 建了出来", ...)            // sqlite_master 里能查到
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/db/__tests__/migrate.test.ts`
Expected: FAIL —— 两列与两张表都不存在。

- [ ] **Step 3: 改 `src/db/index.ts`**

- `DDL` 里 `recipes` 建表语句加 `is_public INTEGER NOT NULL DEFAULT 0` 与 `owner_nickname TEXT`；两张新表按上面 Interfaces 的原样加进去。
- `migrateTables`：

```ts
if (!names.has("is_public")) await db.execute("ALTER TABLE recipes ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0");
if (!names.has("owner_nickname")) await db.execute("ALTER TABLE recipes ADD COLUMN owner_nickname TEXT");
// 旧库（未发布的团队版）留下的列：SQLite 3.35+ 支持 DROP COLUMN，两个运行时都够新
if (names.has("team_id")) await db.execute("ALTER TABLE recipes DROP COLUMN team_id");
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/db/`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/db
git commit -m "feat: 本地表加 is_public 与 owner_nickname，新增收藏与本机账号表"
```

---

### Task 3: 协议载荷与公开开关的写入路径

**Files:**

- Modify: `src/types/index.ts`、`src/services/sync.ts`、`src/stores/recipe.ts`、`src/views/RecipeEdit.vue`
- Test: `src/services/__tests__/syncMerge.test.ts`、`src/stores/__tests__/recipe.test.ts`、`src/views/__tests__/RecipeEdit.test.ts`

**Interfaces:**

- Consumes: Task 2 的列。
- Produces:
  - `Recipe` 加 `is_public: number`、`owner_nickname: string | null`。
  - `RecipeInput` 加 `is_public: number`。
  - `SyncResponse` 加 `favorite_recipe_ids: string[]`（接口类型是 `sync.ts` 里的 `interface SyncResponse`）。
  - `applyRemoteChanges` 写入这两列；`buildRecipePayload` 带上它们（`RecipePayload extends Recipe`，字段自动跟着走）。

- [ ] **Step 1: 写失败测试**

`syncMerge.test.ts` 新增：

```ts
it("远端菜谱的 is_public 与 owner_nickname 落到本地", ...)
it("我推上去的菜谱载荷带 is_public", ...)   // 用 recipePayloadFor 造一条公开菜谱，断言 payload.is_public === 1
```

`recipe.test.ts` 与 `RecipeEdit.test.ts` 新增：

```ts
it("新建菜谱默认 is_public = 0", ...)
it("编辑时能改成公开（is_public 随输入写入父行）", ...)
it("公开开关默认关，打开保存后 is_public = 1", ...)   // RecipeEdit.test.ts
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/__tests__/syncMerge.test.ts src/stores/__tests__/recipe.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `sync.ts` 的 `applyRemoteChanges` 菜谱那段：INSERT / UPDATE 的列表加 `is_public`、`owner_nickname`，值取 `r.is_public ?? 0`、`r.owner_nickname ?? null`。
- `sync.ts` 的 `SyncResponse` 接口加 `favorite_recipe_ids: string[]`（本 Task 只改类型，`doSync` 里的对账接线在 Task 4）。
- `src/stores/recipe.ts`：`create` 的 INSERT 带 `is_public`（取 `input.is_public`）；`bumpParent` 的 UPDATE 加 `is_public = ?`；`requireNameAndCategory` 不动。
  **注意**：归属列（`owner_id`）仍然只在 `create` 时写，`update` 不碰 —— 与今天同一条规矩。
- `src/views/RecipeEdit.vue`：加一个「公开到社区」开关（`data-test="recipe-public"`，Tailwind 沿用现有表单样式），初值取 `detail?.recipe.is_public === 1`，提交时进 `RecipeInput`。开关跟写入路径一起做，因为它就是这个字段的写入界面。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test && npm run build`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 菜谱的公开标记进协议、写入路径与编辑页"
```

---

### Task 4: 本机账号登记、收藏对账与未登录可见范围

**Files:**

- Modify: `src/services/sync.ts`、`src/services/migration.ts`、`src/stores/recipe.ts`
- Create: `src/services/__tests__/syncReconcile.test.ts`
- Test: `src/stores/__tests__/recipeVisibility.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `local_accounts` / `favorite_recipes`；Task 3 的 `favorite_recipe_ids`。
- Produces:
  - `export async function registerLocalAccount(uid: string, db: Db = getDb()): Promise<void>`（`INSERT OR IGNORE INTO local_accounts`）
  - `export async function reconcileFavorites(uid: string, favoriteIds: string[], db: Db = getDb()): Promise<void>`
  - `export function bumpFavoriteOps(): void`、`export function favoriteOpsEpoch(): number`
  - `visibleRecipeFilter()` 未登录分支改成 `(owner_id IS NULL OR owner_id IN (SELECT user_id FROM local_accounts) OR id IN (SELECT recipe_id FROM favorite_recipes))`

- [ ] **Step 1: 写失败测试**

`syncReconcile.test.ts`（用 `freshTestDb()`，手工塞行再断言）：

```ts
it("整表替换收藏集合：旧收藏被换掉", ...)
it("清掉既不是我本机账号、又没被收藏的别人的菜谱（含子行）", ...)
it("本机上另一个账号自己的菜谱不被清掉（多账号回归）", ...)   // local_accounts 里有 B，行 owner_id = B → 保留
it("我自己的菜谱不被清掉", ...)
it("收藏操作版本变了就跳过本轮对账", ...)                    // bumpFavoriteOps() 之后调 reconcileFavorites，收藏集合原样不动
```

`recipeVisibility.test.ts`：

```ts
it("未登录只显示本机自己的菜谱与收藏的菜谱，不显示别人的缓存副本", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/__tests__/syncReconcile.test.ts`
Expected: FAIL（函数未定义）。

- [ ] **Step 3: 实现**

- `registerLocalAccount`：`INSERT OR IGNORE INTO local_accounts (user_id) VALUES (?)`。
- `migration.ts` 的 `triggerFullPushAndSync`：`claimOrphanRecipes` 之前先 `await registerLocalAccount(uid)`（必须在 `performSync` 之前，对账要用）。
- `reconcileFavorites` 按 spec §7.2 三步：版本没变才执行 → `DELETE FROM favorite_recipes` + 逐条插入 → 清理 SQL：

```sql
DELETE FROM recipes
WHERE owner_id IS NOT NULL AND owner_id <> ?
  AND owner_id NOT IN (SELECT user_id FROM local_accounts)
  AND id NOT IN (SELECT recipe_id FROM favorite_recipes)
```

  清理前先取这些 id 的子行删除（`recipe_steps` / `recipe_ingredients` / `recipe_labels`，后两者 SQLite 侧没有 `ON DELETE CASCADE`）。
- 版本保护：`let favoriteOps = 0;`（模块级内存，不持久化）。`reconcileFavorites` 入口采样一次，采完立刻做两段删除之前再比一次；不一致就整段 return（不推进任何本地状态）。`doSync` 里 `reconcileFavorites` 之后若版本又变了，再 `enqueueSync({})` 触发一轮补跑。
- `visibleRecipeFilter` 未登录分支按 Interfaces 里给的原文；登录分支**保持** `owner_id = ?`（我收藏的别人的菜谱不显示在「我的」里，由社区与收藏两个筛选负责）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 本机账号登记、收藏对账与缓存清理"
```

---

### Task 5: 社区接口封装与 store

**Files:**

- Create: `src/services/community.ts`、`src/stores/community.ts`、`src/services/__tests__/community.test.ts`、`src/stores/__tests__/community.test.ts`
- Modify: `src/services/sync.ts`（导出一个缓存入口）

**Interfaces:**

- Consumes: `apiFetch`（`src/services/api.ts`）、`applyRemoteChanges` 与 Task 4 的 `bumpFavoriteOps`。
- Produces:
  - `sync.ts` 新增 `export async function cacheCommunityChanges(changes: SyncPayload, db: Db = getDb()): Promise<void>` —— 内部 `applyRemoteChanges` + 复用私有 `rememberAndDownloadFiles`（本 Task 把它的作用域从私有改成可被本函数调用即可，不导出）。
  - `services/community.ts` 的类型与函数：

```ts
export interface CommunityRecipe {
  id: string; name: string; cover_path: string | null;
  author_id: string; author_nickname: string;
  updated_at: string; favorited: boolean;
}
export interface CommunityPage { items: CommunityRecipe[]; has_more: boolean }
export interface UserProfile {
  id: string; nickname: string; avatar_url: string | null;
  followed: boolean; public_count: number;
}
export function listCommunityRecipes(params: { limit: number; offset: number; followedOnly?: boolean; authorId?: string }): Promise<CommunityPage>
export function fetchCommunityRecipe(id: string): Promise<SyncPayload>   // GET /community/recipes/{id} 的响应体
export function favoriteRecipe(id: string): Promise<void>
export function unfavoriteRecipe(id: string): Promise<void>
export function fetchUserProfile(id: string): Promise<UserProfile>
export function followUser(id: string): Promise<void>
export function unfollowUser(id: string): Promise<void>
```

  - `stores/community.ts`：`items`（`CommunityRecipe[]`）、`hasMore`、`loading`、`error`、`followedOnly`；`load(reset?: boolean)`、`openRecipe(id: string): Promise<string>`（拉详情 → `cacheCommunityChanges` → 返回 id 供路由跳转）、`favorite(id)` / `unfavorite(id)`（成功后就地更新 `items` 里那条的 `favorited`，并插删本地 `favorite_recipes` 行、`bumpFavoriteOps()`、`enqueueSync({})`）、`profile(id)` / `follow(id)` / `unfollow(id)`。

- [ ] **Step 1: 写失败测试**

`services/__tests__/community.test.ts`：`vi.mock("@/services/api")`，断言每个函数的 URL、方法、查询参数拼装正确（`followed_only=1`、`author_id`、`limit` / `offset`）。

`stores/__tests__/community.test.ts`（mock api 层 + 真 SQLite）：

```ts
it("openRecipe 把详情落本地，返回 id", ...)        // 断言 recipes / 子行 / 字典行都进库了
it("load 累积翻页，has_more 决定按钮显不显示", ...)
it("load 失败时 error 有值、items 保留上一次的结果", ...)
it("favorite 成功后本地收藏集合里有它、items 里的 favorited 变 true", ...)
it("favorite 失败（断网）时不改本地状态", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/__tests__/community.test.ts src/stores/__tests__/community.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

- `services/community.ts` 全部走 `apiFetch<T>(path, { method })`，不做重试、不吞异常（调用方的 store 负责错误状态）。
- `stores/community.ts` 照 `stores/recipe.ts` 的形状写（`defineStore` + 显式 pinia 兜底 `useCommunityStore()`，原因见 `stores/auth.ts` 顶部的注释）。
- 收藏的本地写入顺序：先 `POST` 成功 → 再写本地（保证失败不留脏状态）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/services/__tests__/community.test.ts src/stores/__tests__/community.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 社区浏览接口与 store"
```

---

### Task 6: 详情页的快捷公开开关

**Files:**

- Modify: `src/views/RecipeDetail.vue`
- Test: `src/views/__tests__/RecipeDetail.test.ts`

**Interfaces:**

- Consumes: Task 3 的 `RecipeInput.is_public` 与 `recipe.ts` 的写入路径。
- Produces: 我的菜谱详情页一个快捷开关（`data-test="recipe-public-toggle"`），点一下即时改 `is_public` 并 `enqueueSync`。编辑页的开关已经在 Task 3 做完。

- [ ] **Step 1: 写失败测试**

```ts
it("我的菜谱详情页能一键公开，父行 is_public 变 1", ...)
it("别人的菜谱没有公开开关（也没有编辑/删除）", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/RecipeDetail.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`v-if="canEdit(detail.recipe)"` 的开关；点击调 `store.update(id, { ...当前输入, is_public: 反转 })`（沿用编辑页那条写入路径，不新开一条 UPDATE）。**取消公开不弹二次确认**（spec §9.2：收藏关系不清，重新公开会自动回到对方手上，是可撤销的动作）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/RecipeDetail.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/views
git commit -m "feat: 菜谱详情页的快捷公开开关"
```

---

### Task 7: 菜谱页的筛选与社区段落

**Files:**

- Create: `src/components/CommunityFeed.vue`、`src/components/__tests__/CommunityFeed.test.ts`
- Modify: `src/views/RecipeList.vue`、`src/stores/recipe.ts`
- Test: `src/views/__tests__/RecipeList.test.ts`

**Interfaces:**

- Consumes: Task 5 的 `useCommunityStore()`；Task 4 的 `visibleRecipeFilter`。
- Produces:
  - `recipe.ts` 新增 `store.favorites: Ref<RecipeListItem[]>` 与 `fetchFavorites(): Promise<void>`（查询 `id IN (SELECT recipe_id FROM favorite_recipes)`，其余 JOIN 与 `fetchAll` 一致）。
  - `RecipeList.vue` 顶部四个 chip：`data-test="tab-all|tab-mine|tab-fav|tab-follow"`，默认 `all`。
  - `CommunityFeed.vue`：自己拉 `communityStore.load()`，显示 loading / 失败重试 / 空状态 / 「加载更多」，每条点击 → `communityStore.openRecipe(id)` → `router.push('/recipe/' + id)`。

- [ ] **Step 1: 写失败测试**

```ts
// RecipeList.test.ts
it("默认「全部」：我的菜谱在上，社区段落在下", ...)
it("社区接口失败时只社区段落显示失败，我的菜谱照常显示", ...)
it("「收藏」只显示本地收藏的菜谱", ...)
it("「关注」把 followed_only=1 传给社区 store", ...)
// CommunityFeed.test.ts
it("点一条公开菜谱：先落库再跳详情", ...)
it("加载更多按 has_more 显隐", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/RecipeList.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- 两段各自渲染，**不做合并排序**（spec §9.1 的反目标：社区挂了不能拖垮我的菜谱）。
- 「全部」= 我的段落（`store.recipes`，沿用现有搜索与筛选） + 社区段落（`CommunityFeed`）。
- 「我的」只渲染我的段落；「收藏」渲染 `store.favorites` 的段落；「关注」只渲染社区段落并置 `followedOnly = true`。
- 社区列表项显示：菜名、作者昵称、已收藏则一个星标（`favorited`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/RecipeList.test.ts src/components/__tests__/CommunityFeed.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 菜谱页的社区段落与筛选"
```

---

### Task 8: 用户页、作者昵称与收藏按钮

**Files:**

- Create: `src/views/UserPage.vue`、`src/views/__tests__/UserPage.test.ts`
- Modify: `src/router/index.ts`、`src/views/RecipeDetail.vue`
- Test: `src/views/__tests__/RecipeDetail.test.ts`

**Interfaces:**

- Consumes: Task 5 的 `communityStore.profile/follow/unfollow/favorite/unfavorite`、`openRecipe`。
- Produces: 路由 `{ path: "/user/:id", name: "user", component: UserPage, meta: { hideTab: true } }`；用户页显示昵称、公开菜谱数、关注/取消关注按钮、ta 的公开菜谱列表（点击进详情）；详情页在「别人的菜谱」时显示作者昵称（`data-test="recipe-author"`，可点进用户页）与收藏按钮（`data-test="recipe-favorite"`，已收藏显示「已收藏」）。

- [ ] **Step 1: 写失败测试**

```ts
// UserPage.test.ts
it("显示昵称与公开菜谱数", ...)
it("点关注后按钮变「取消关注」，再点回到未关注", ...)
it("加载失败显示失败与重试", ...)
// RecipeDetail.test.ts
it("别人的菜谱显示作者昵称，点它进 /user/:id", ...)
it("离线时收藏按钮不可用（disabled）", ...)
it("收藏成功后按钮显示已收藏", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/UserPage.test.ts src/views/__tests__/RecipeDetail.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- 详情页作者昵称取本地 `detail.recipe.owner_nickname`（离线也显示得出，spec §11.12），不是每次都发请求。
- 「离线」的判据用现有的在线状态（`auth.isOnline`）+ 一次请求失败的兜底：`favorite` 失败时把按钮恢复原状并提示，不静默。
- 用户页与收藏按钮的请求都要求在线；断网时按钮 `disabled`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test && npm run build`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 用户页、作者昵称与收藏按钮"
```

---

### Task 9: README 用户说明与手动验证

**Files:**

- Modify: `README.md`
- Modify: `docs/recipe-crud-status.md`（若里面提到团队）

**Interfaces:**

- Consumes: 全部改动。
- Produces: 与代码一致的用户向文档。

- [ ] **Step 1: 改 README**

「多设备同步与家庭共享」一节改成「多设备同步与社区共享」：不再提邀请码与菜谱本；改成「菜谱默认只有自己看得到，想给别人看就在菜谱页勾上『公开到社区』；别人的公开菜谱在菜谱页的社区段落里，可以收藏（收藏后离线也能看），也可以关注某个人」。限制清单同步更新（不做评论 / 通知 / 粉丝数 / 搜索）。

- [ ] **Step 2: 手动端到端（两个账号打同一台后端）**

按 spec §13 的七步走一遍，重点两条：

1. B 收藏一条菜谱后，在 B 的第二台设备（或清库重装）上能看到它；
2. C 账号在 B 之后登录同一台手机：C 同步后 B 留在本机的菜谱一条都没少。

Android 真机也跑一遍（CORS 与明文 HTTP 的表现与桌面 dev 不同）。

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: README 改成社区共享说明"
```
