# 同步与团队 · 客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 WeeCook 在不登录时行为完全不变，登录后私人菜谱跨设备同步（含封面/步骤图），并能创建/加入家庭共用菜谱，且只有创建者能改删。

**Architecture:** 本地 SQLite 仍是唯一真相源，服务器只做「收增量 / 发增量 / 存图片」。业务表加 `owner_id` / `team_id` 表达归属，界面按「当前菜谱本」过滤，写入后进防抖队列，会话变在线时全扫推一次。API 客户端、令牌存储、同步骨架照抄姊妹项目 `D:\projects\my\wee-count`。

**Tech Stack:** Vue 3 + TypeScript（严格模式，禁 `any`）· Pinia · vue-router · Tauri 2（plugin-sql / plugin-fs / plugin-dialog / **plugin-store** 新增）· Vitest + happy-dom + `node:sqlite`（真 SQL 测试）

**Spec:** `docs/superpowers/specs/2026-10-14-sync-team-design.md`（§7 协议、§8 图片、§9 客户端行为是重点）

**前置：** 后端计划 `docs/superpowers/plans/2026-10-14-sync-backend.md` 必须先完成——本计划按它定下的接口契约写。

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**；组件与组合式函数照现有 `mePage` / `RecipeEdit` 的写法与 Tailwind 风格，不引入 UI 库。
- 测试优先：每个任务先写失败的测试再实现；**不可删改已有测试**（`src/db/__tests__/schema.test.ts`、`src/stores/__tests__/*` 是回归网）。
- 测试用真 SQL：`freshTestDb()`（`src/db/__tests__/sqliteTestDb.ts`）造库，`setDb(db)` 注入；网络用 `vi.stubGlobal("fetch", ...)`。
- 本地表一律 `deleted_at TEXT`（NULL = 未删除），**不用 `is_deleted`**；协议字段同名同义。
- 时间戳：写库与比较统一走 `toIsoTimestamp` / `compareTimestamp`（`src/services/sync.ts`，照抄 wee-count），杜绝 `"YYYY-MM-DD HH:MM:SS"` 与 RFC3339 混比。
- 未配置服务器地址（`hasBaseUrl() === false`）时**不得发起任何网络请求**，不得出现登录墙。
- 提交信息用中文，格式 `<类型>: <中文描述>`。

## Review Focus

写测试时逐条钉住下面这些「规格没明说、但真人一定会遇到」的输入或条件（括号里是挂测试的任务）：

1. **未登录、但服务器地址已配置且服务不可达**：App 必须正常录、正常看，同步失败只在界面上出一个不打扰的提示，绝不阻塞也不清空本地数据（Task 6）。
2. **同一台设备换人登录**（A 登出、B 登录）：绝不能把 A 的私人菜谱推成 B 的（Task 8）。
3. **登录时本地已有几百道菜谱与图片**：一张图传失败（超 5MB 或断网）时，菜谱整批不推、字典照推，本地一切照常（Task 7）。
4. **团队菜谱的图片在服务器上不存在**（当初上传失败/被清理）：客户端每日同步都试一次 404，不能无限重试刷屏，也不能因此卡住其它图片下载（Task 7）。
5. **改完一道菜立刻退出 App**：3 秒防抖的定时器还没烧，改动也不能丢——待推送队列必须已经落盘（Task 6）。

---

### Task 1: Tauri plugin-store 接入 + SQLite 迁移（归属列与上传记录表）

**Files:**
- Modify: `package.json`（加 `@tauri-apps/plugin-store`）
- Modify: `src-tauri/Cargo.toml`（加 `tauri-plugin-store = "2"`）
- Modify: `src-tauri/src/lib.rs`（`.plugin(tauri_plugin_store::Builder::default().build())`）
- Modify: `src-tauri/capabilities/default.json`（加 `"store:default"`）
- Modify: `src/db/index.ts`（DDL 加 `uploaded_files`；`migrateTables` 从空实现变成真迁移）
- Create: `src/db/__tests__/migrate.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `initTables(db)` 之后，`recipes` 有 `owner_id TEXT` / `team_id TEXT`（存量行为 NULL），并存在 `uploaded_files(name TEXT PRIMARY KEY, uploaded_at TEXT NOT NULL)`；`Db` 接口不变

- [ ] **Step 1: 写失败的测试** `src/db/__tests__/migrate.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { initTables } from "@/db";
import { makeTestDb } from "./sqliteTestDb";

describe("数据库迁移", () => {
  it("recipes 加上了归属两列", async () => {
    const { db } = await makeTestDb();
    await initTables(db);
    const cols = await db.select<{ name: string }[]>("PRAGMA table_info(recipes)");
    const names = cols.map((c) => c.name);
    expect(names).toContain("owner_id");
    expect(names).toContain("team_id");
  });

  it("uploaded_files 建出来了", async () => {
    const { db } = await makeTestDb();
    await initTables(db);
    const cols = await db.select<{ name: string }[]>("PRAGMA table_info(uploaded_files)");
    expect(cols.map((c) => c.name)).toEqual(["name", "uploaded_at"]);
  });

  it("重复执行不会因为列已存在而报错", async () => {
    const { db } = await makeTestDb();
    await initTables(db);
    await expect(initTables(db)).resolves.toBeUndefined();
  });

  it("迁移不丢存量数据", async () => {
    const { db } = await makeTestDb();
    // 先建旧结构（只有 recipes 的旧列），插一行，再跑 initTables
    await db.execute(
      `CREATE TABLE recipes (id TEXT PRIMARY KEY, name TEXT NOT NULL, cover_path TEXT,
        category_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`,
    );
    await db.execute(
      `INSERT INTO recipes (id, name, category_id, created_at, updated_at)
       VALUES ('r1', '红烧肉', 'c1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    await initTables(db);
    const rows = await db.select<{ id: string; owner_id: string | null }[]>(
      "SELECT id, owner_id FROM recipes",
    );
    expect(rows).toEqual([{ id: "r1", owner_id: null }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/db/__tests__/migrate.test.ts`
Expected: FAIL（`uploaded_files` 不存在 / `owner_id` 列缺失）

- [ ] **Step 3: 实现迁移**

`src/db/index.ts`：`DDL` 数组里加

```sql
CREATE TABLE IF NOT EXISTS uploaded_files (
  name        TEXT PRIMARY KEY,
  uploaded_at TEXT NOT NULL
)
```

`migrateTables(db)` 改成「按 `PRAGMA table_info` 判断缺哪列就补哪列」——`ALTER TABLE ... ADD COLUMN` 在列已存在时直接报错，所以**必须**先查再加，靠异常兜底会让「重复执行」变成不可测的隐性行为：

```ts
/** 表结构演进。每步先查 PRAGMA 再 ALTER：ALTER ADD COLUMN 重复执行会报错，不能用异常兜底。 */
async function migrateTables(db: Db): Promise<void> {
  const cols = await db.select<{ name: string }[]>("PRAGMA table_info(recipes)");
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("owner_id")) await db.execute("ALTER TABLE recipes ADD COLUMN owner_id TEXT");
  if (!names.has("team_id")) await db.execute("ALTER TABLE recipes ADD COLUMN team_id TEXT");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/db/`
Expected: 新用例 PASS，`schema.test.ts` 原有用例仍 PASS

- [ ] **Step 5: 装插件并接进 Tauri**

```bash
npm install @tauri-apps/plugin-store
cd src-tauri && cargo add tauri-plugin-store@2
```

`src-tauri/src/lib.rs` 加一行 `.plugin(tauri_plugin_store::Builder::default().build())`；`capabilities/default.json` 的 `permissions` 加 `"store:default"`。

- [ ] **Step 6: 验证 Rust 侧能编译**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json src-tauri src/db
git commit -m "feat: 接入 Tauri store 插件并为菜谱表加上归属列"
```

---

### Task 2: 网络与凭据基础（api / tokenStorage / settingsFile）

**Files:**
- Create: `src/services/tokenStorage.ts`
- Create: `src/services/settingsFile.ts`
- Create: `src/services/api.ts`
- Create: `src/services/__tests__/api.test.ts`
- Create: `src/services/__tests__/tokenStorage.test.ts`

**Interfaces:**
- Consumes: Task 1 的 plugin-store
- Produces:
  - `tokenStorage`: `readRefreshToken(userId)`, `writeRefreshToken(userId, token)`, `deleteRefreshToken(userId)` —— 全部 `Promise`
  - `settingsFile`: `readSetting<T>(key, parse): Promise<SettingRead<T>>`（`{kind:"found"|"absent"|"invalid"|"unavailable"}`）、`writeSetting(key, value, log): Promise<void>`、`deleteSetting(key, log): Promise<void>`
  - `api`: `setBaseUrl(url)`, `getBaseUrl()`, `hasBaseUrl()`, `baseUrlReady`, `authTokenReady`, `setTokens(userId, accessToken, refreshToken)`, `clearTokens()`, `apiFetch<T>(path, init?): Promise<ApiResult<T>>`, `User` / `AuthResponse` 类型，以及 `register` / `login` / `refreshSession` / `getMe` / `updateProfile` 的薄封装
  - `ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string }`

- [ ] **Step 1: 写失败的测试** `src/services/__tests__/api.test.ts`

```ts
describe("apiFetch", () => {
  it("没有配置地址时直接抛错，不发请求", async () => { /* fetch 未被调用 */ });
  it("baseUrl 去掉末尾斜杠", () => { /* setBaseUrl("http://x:8080///") → getBaseUrl() === "http://x:8080" */ });
  it("带 Authorization 头发请求并解析 JSON", async () => {});
  it("401 时只发一次 refresh（三个并发 401 共享同一次 refresh）", async () => {});
  it("refresh 也失败时清空凭据并返回 401", async () => {});
  it("超时 15 秒后 abort 并抛出", async () => { /* 用 vi.useFakeTimers 推进 */ });
  it("服务端 500 时不抛异常，返回 {ok:false,status:500}", async () => {});
});
```

`tokenStorage.test.ts`：`writeRefreshToken("u1", t)` 后 `readRefreshToken("u2")` 必须是 `null`（按用户隔离，防串号）。非 Tauri 环境（happy-dom）回落到 localStorage。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/__tests__/api.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

照抄 `wee-count/src/services/tokenStorage.ts`（含 `keyFor` 的按用户隔离注释）、`wee-count/src/services/settingsFile.ts`（三态 `SettingRead`，**逐字保留**「读不懂不要覆盖」那段逻辑——它是 setting 文件不被写坏的护栏）、`wee-count/src/services/api.ts` 的**骨架**：`baseUrl` + 响应式镜像、15s 超时 controller、401 单飞 refresh、`authTokenReady`。

三处删减：去掉 `TeamMember` 等 wee-count 特有类型；去掉 AI 相关导出；`AuthResponse` 里没有 `ledger_id`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/__tests__/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services
git commit -m "feat: 网络请求层、令牌存储与设置文件读写"
```

---

### Task 3: 登录 / 注册 / 会话恢复（auth store + 界面）

**Files:**
- Create: `src/stores/auth.ts`
- Create: `src/stores/__tests__/auth.test.ts`
- Create: `src/views/ServerConfig.vue`
- Create: `src/views/LoginPage.vue`
- Create: `src/views/__tests__/LoginPage.test.ts`
- Modify: `src/router/index.ts`（加 `/me/server`、`/me/login`）
- Modify: `src/views/MePage.vue`（加「多设备同步」入口与状态）

**Interfaces:**
- Consumes: Task 2 的 `api` / `tokenStorage` / `settingsFile`
- Produces `useAuthStore()`：
  - `mode: Ref<"guest" | "online">`、`isOnline: ComputedRef<boolean>`
  - `serverUser: Ref<api.User | null>`（`serverUserId` 为 `serverUser?.id ?? null`）
  - `nickname: Ref<string | null>`、`baseUrl: Ref<string | null>`
  - `lastSyncFailed: Ref<boolean>`、`lastSyncedTime: Ref<string | null>`
  - `restoreSession(): Promise<void>`、`login(baseUrl, username, password): Promise<void>`、`register(baseUrl, username, password, nickname): Promise<void>`、`logout(): Promise<void>`
  - `notifySyncComplete(): void`（同步完成后刷新 UI 的版本号）
- 持久化位置（plugin-store `settings.json`）：`server_url`、`server_user_id`、`server_username`、`server_nickname`

- [ ] **Step 1: 写失败的测试** `src/stores/__tests__/auth.test.ts`

```ts
it("登录成功后写入凭据与服务器地址", async () => {});
it("登录失败不改动已有凭据", async () => {});
it("冷启动 restoreSession 用 refresh token 换新 access", async () => {});
it("restoreSession 遇到服务不可达时进入 guest 态但不清本地数据与设置", async () => {});
it("logout 清掉凭据但保留 server_url（下次登录不用重填）", async () => {});
it("没有 server_url 时 isOnline 为 false 且不发任何请求", async () => {});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/auth.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 store**

照 `wee-count/src/stores/auth.ts` 的形状写**单账号版**：去掉 `meta` 表里的本地用户体系、本地密码与 `openUserDb`，保留三件事——`restoreSession`（读 settings 里的地址 + 该用户 id 的 refresh token，换新 access）、`login`/`register`（成功即写 settings 与 token，然后 `void performSync()`）、`logout`（`api.clearTokens()` + 删 refresh token + `resetSyncTimers()`，**不动 settings 里的 server_url，不清本地菜谱**）。

登录/注册/恢复会话成功之后统一调 `triggerFullPushAndSync()`（Task 8 提供）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/stores/__tests__/auth.test.ts`
Expected: PASS

- [ ] **Step 5: 写界面**

`ServerConfig.vue`：一个输入框（默认 `https://`）+ 「测试连接」（打 `GET /api/v1/healthz`）；地址存 settings。`LoginPage.vue`：用户名 / 密码 / 登录 / 注册两个按钮，错误文案用中文（`账号或密码不对`、`用户名已被占用`、`连不上服务器，检查地址和网络`）。两个页面都照 `RecipeEdit.vue` 的表单与按钮样式。

- [ ] **Step 6: 路由与 MePage 入口**

`router/index.ts` 加两条（`meta: { hideTab: true }`）。`MePage.vue` 加一块：「多设备同步」——未配置时显示「未开启」并跳 `/me/server`；已登录显示昵称、上次同步时间、同步失败时的「重试」按钮、以及登出。

- [ ] **Step 7: 跑全量测试与类型检查**

Run: `npm run test && npm run build`
Expected: 全绿、无类型错误

- [ ] **Step 8: 提交**

```bash
git add src/stores/auth.ts src/stores/__tests__/auth.test.ts src/views src/router
git commit -m "feat: 登录注册与会话恢复"
```

---

### Task 4: 团队（store + 创建 / 加入 / 成员界面）

**Files:**
- Create: `src/stores/team.ts`
- Create: `src/stores/__tests__/team.test.ts`
- Create: `src/views/TeamPage.vue`
- Create: `src/views/TeamJoinPage.vue`
- Create: `src/views/TeamMembersPage.vue`
- Create: `src/views/__tests__/TeamPage.test.ts`
- Modify: `src/router/index.ts`、`src/views/MePage.vue`

**Interfaces:**
- Consumes: Task 2 的 `api`；Task 6 的 `clearCursor`
- Produces `useTeamStore()`：
  - `teams: Ref<Team[]>`（`Team = { id: string; name: string; created_by: string; member_count: number }`）
  - `current: Ref<Team | null>`
  - `load(): Promise<void>`、`create(name: string): Promise<Team>`、`createInvite(teamId: string): Promise<string>`、`joinByCode(code: string): Promise<Team>`、`loadMembers(teamId: string): Promise<TeamMember[]>`
  - `isMemberOf(teamId: string): ComputedRef<boolean>`
- `TeamMember = { user_id: string; username: string; nickname: string; avatar_url: string | null; role: "owner" | "member" }`

- [ ] **Step 1: 写失败的测试** `src/stores/__tests__/team.test.ts`

```ts
it("load 未登录时不做任何网络请求", async () => {});
it("创建团队后列表里出现它并成为 current", async () => {});
it("加入成功后清空同步游标（否则拉不到加入前的存量菜谱）", async () => {
  // 先 setLastSyncedAtFor(uid, "128")，joinByCode 成功后 getLastSyncedAtFor(uid) 必须是 null
});
it("加入失败（码无效/已是成员）时不清游标", async () => {});
it("成员列表按接口返回渲染，不改动顺序", async () => {});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/team.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 store**

`load()` 打 `GET /api/v1/teams`（未登录直接 return）；`create`/`joinByCode` 成功后把返回的团队塞进 `teams` 并 `clearCursor(uid)`（spec §9.4）；`joinByCode` 之后触发一次 `performSync()`（全量重拉）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/stores/__tests__/team.test.ts`
Expected: PASS

- [ ] **Step 5: 写界面**

`TeamPage.vue`：我的团队列表（名字 + 成员数）+「创建家庭」；点进去到 `TeamMembersPage.vue`。`TeamJoinPage.vue`：6 位数字输入 + 「加入」。`TeamMembersPage.vue`：成员列表（昵称 + 角色徽标）+「邀请家人」（点开显示 6 位码与一句「24 小时内有效，让家人在这台手机之外输入它」）。

- [ ] **Step 6: 路由与入口**

路由加 `/me/team`、`/me/team/join`、`/me/team/:id`；`MePage` 加「我的家庭」入口（未登录时显示「先开启多设备同步」）。

- [ ] **Step 7: 跑全量测试与类型检查**

Run: `npm run test && npm run build`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add src/stores/team.ts src/stores/__tests__/team.test.ts src/views src/router
git commit -m "feat: 家庭团队的创建、邀请与成员列表"
```

---

### Task 5: 菜谱本切换、归属过滤与只读权限

**Files:**
- Create: `src/stores/book.ts`
- Create: `src/stores/__tests__/book.test.ts`
- Modify: `src/types/index.ts`（`Recipe` 加 `owner_id: string | null`、`team_id: string | null`；新增 `BookRef`）
- Modify: `src/stores/recipe.ts`（写入补归属、查询加可见范围、写入后 `enqueueSync`）
- Modify: `src/stores/ingredient.ts` / `src/stores/label.ts`（写入后 `enqueueSync`）
- Modify: `src/views/RecipeList.vue`（顶部菜谱本切换）
- Modify: `src/views/RecipeDetail.vue`（非作者隐藏编辑/删除）
- Modify: `src/views/__tests__/RecipeDetail.test.ts`（**新增用例，不改已有断言**）

**Interfaces:**
- Consumes: Task 3 的 `useAuthStore`；Task 4 的 `useTeamStore`
- Produces:
  - `useBookStore()`：`current: Ref<string | null>`（`null` = 我的菜谱；否则 teamId）、`setBook(id: string | null): Promise<void>`、`options: ComputedRef<BookRef[]>`、`restore(): Promise<void>`
  - `recipe.ts` 新增导出 `visibleRecipeFilter(): Promise<{ where: string; params: unknown[] }>`
  - `Recipe` 类型新增两个字段（供同步与权限判断共用）

- [ ] **Step 1: 写失败的测试** `src/stores/__tests__/recipeVisibility.test.ts`

```ts
it("未登录时列表不过滤，但别人的菜谱不可编辑", async () => {
  // 插两条：owner_id=null 与 owner_id="other"
  // list() 返回两条；canEdit("other 那条") === false
});
it("登录后只显示我的私人菜谱与我所在的团队菜谱", async () => {});
it("切换菜谱本只影响列表，不改数据", async () => {});
it("新增菜谱写入当前用户与当前菜谱本", async () => {
  // 私人本 → team_id null；团队本 → team_id 为该团队
});
it("未登录新增的菜谱 owner_id 与 team_id 都是 null", async () => {});
```

`book.test.ts`：`setBook` 持久化、重启后 `restore()` 读回、选中的团队已不存在时回落 `null`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/recipeVisibility.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现过滤与写入**

`recipe.ts` 里加一个集中表达的可见范围函数（**唯一一处**，列表/详情/搜索都调它）：

```ts
/**
 * 当前可见的菜谱范围（spec §9.1）：
 *   未登录 → 本地全部（不过滤），但可编辑范围另算（见 canEdit）
 *   已登录 → 我的私人菜谱 ∪ 我所在团队的菜谱
 * 返回的 sql 是一段可直接接在 WHERE 后面的条件（调方自行拼），params 顺序与其中的 ? 对应。
 */
export async function visibleRecipeFilter(): Promise<{ sql: string; params: unknown[] }>
```

`canEdit(recipe)`: 未登录 → `recipe.owner_id === null`；已登录 → `recipe.owner_id === 当前 serverUserId`。

写入路径：`create`/`update`/`remove` 之后调 `enqueueSync({ recipes: [该条完整形状] })`（`update` 与 `remove` 传同样的形状，`remove` 带 `deleted_at`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/stores/__tests__/`
Expected: 新用例 PASS，`recipe.test.ts` / `recipeFilter.test.ts` 原有用例仍 PASS

- [ ] **Step 5: 界面**

`RecipeList.vue`：顶部加一排菜谱本切换（「我的菜谱」+ 每个家庭），只在登录后出现；未登录不显示这一排。
`RecipeDetail.vue`：编辑/删除按钮改成 `v-if="canEdit(recipe)"`；不能编辑时页面照常显示（不是灰按钮，是根本没有）。

- [ ] **Step 6: 加界面测试**

`src/views/__tests__/RecipeDetail.test.ts` 追加（不动已有断言）：

```ts
it("别人的菜谱不渲染编辑与删除按钮", async () => {});
it("自己的菜谱渲染编辑与删除按钮", async () => {});
```

Run: `npm run test -- src/views/__tests__/RecipeDetail.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/types src/stores src/views
git commit -m "feat: 菜谱本切换、归属过滤与只读权限"
```

---

### Task 6: 同步核心（协议、队列、游标、合并、调度）

> **前置：本任务用到 Task 7 的 `syncFiles.ts`，所以先把 Task 7 做完再开始这里。** 它的编号靠后只是因为它是一个自包含的模块，实际依赖方向上它在前面。

**Files:**
- Create: `src/services/sync.ts`
- Create: `src/services/__tests__/sync.test.ts`
- Create: `src/services/__tests__/syncMerge.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `api`；Task 5 的 `visibleRecipeFilter` / `canEdit`；Task 7 的 `uploadPendingFiles` / `downloadMissingFiles`（见上面的前置说明）
- Produces:
  - `SyncPayload = { ingredients: Ingredient[]; units: Unit[]; labels: Label[]; recipes: RecipePayload[]; files: FileRef[] }`
  - `RecipePayload`：`Recipe` + `steps` + `ingredients` + `label_ids`
  - `toIsoTimestamp(v: string): string`、`compareTimestamp(a: string, b: string): number`
  - `enqueueSync(changes: Partial<SyncPayload>): void`
  - `performSync(): Promise<boolean>`
  - `applyRemoteChanges(remote: SyncPayload, db?: Db): Promise<void>`
  - `getLastSyncedAtFor(uid: string | null): string | null`、`setLastSyncedAtFor(uid, seq)`、`clearCursor(uid): void`
  - `resetSyncTimers()`、`clearPendingSync()`
  - 用户 id 来源：`getCurrentServerUserId(): string | null`（内部调 auth store）

- [ ] **Step 1: 写失败的测试** `src/services/__tests__/syncMerge.test.ts`

```ts
it("远端更新的行覆盖本地较旧的行（LWW）", async () => {});
it("远端更旧的行被跳过，本地不被回滚", async () => {});
it("相同 updated_at 时不重复写（幂等）", async () => {});
it("同名字典行合并：本地已有同名 X，收到 Y → 引用改指 Y 并删掉 X", async () => {
  // 断言 recipe_ingredients.ingredient_id、recipes.category_id、recipe_labels.label_id 都被改指
});
it("labels 的同名合并按 (name, kind)：同名不同 kind 不合并且不删行", async () => {});
it("菜谱的子行整组替换：远端步骤里没有的旧步骤本地必须消失", async () => {});
it("墓碑：远端 deleted_at 非空 → 本地列表里不再出现", async () => {});
it("比较时间戳前先归一化：\"2026-01-01 00:00:01\" 与 \"2026-01-01T00:00:00.000Z\" 能正确比大小", async () => {});
it("子行引用的食材/单位 id 在同一批 remote.recipes 里也要 remap", async () => {});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/__tests__/syncMerge.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `applyRemoteChanges`**

照抄 `wee-count/src/services/sync.ts` 的 `applyRemoteChanges`（字典的「同名先合并再插入」分支尤其照抄），按 spec §7.4 调整三处：合并键 `labels` 用 `(name, kind)`、菜谱子行整组 `DELETE` 再插、以及把同一批 `remote.recipes` 里子数组的引用也一起 remap。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/__tests__/syncMerge.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败的测试** `src/services/__tests__/sync.test.ts`

```ts
it("没有服务器地址时 enqueueSync 不入队也不发请求", async () => {});
it("队列按 uid 隔离并立刻落盘（Review Focus ⑤：定时器没烧完就退出 App 也不丢）", async () => {
  // enqueueSync 之后同步 localStorage 里应已有 pending_sync:<uid>；换一个 uid 读不到
});
it("游标按 uid 隔离", async () => {});
it("同一行重复入队只保留更新的一份", async () => {});
it("同步成功后游标推进到 server_seq 且 pending 清空", async () => {});
it("网络异常时改动回队并返回 false，游标不推进", async () => {});
it("服务端 500 时改动回队，界面能看到 lastSyncFailed", async () => {});
it("在途同步不会被重入，期间的新请求结束后补跑一次", async () => {});
it("未登录时 performSync 不发请求", async () => {});
it("Review Focus ①：服务不可达时本地读写照常，performSync 返回 false 且不清数据", async () => {});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: FAIL

- [ ] **Step 7: 实现同步主流程**

照抄 `wee-count/src/services/sync.ts` 的框架：`pendingByUid` + `pendingQueueKey(uid)` + `cursorKeyFor(uid)` 的隔离、`enqueueSync` 3 秒防抖、`scheduleRetry` 5s→10s→20s→60s、`performSync` 互斥 + `syncQueued`、`doSync` 里「成功后 `setLastSyncedAtFor` / 失败后 `mergeChanges(pendingFor(uid), changes)` 回队」。

本项目的差异（照 spec §9.3）：
- 首次同步（游标为 `null`）走 Task 8 的 `firstFullSync()`。
- 非首次同步前，`local_changes` 用 **Task 8 的 `collectPushPayload()`** 过滤出 `owner_id = 我` 的菜谱 + 全部字典行（而不是只推队列），队列仍保留（防重复入队）。
- 推送前调 `await uploadPendingFiles(changes)`；返回 `false` 时**把 `changes.recipes` 清空**只推字典（图没到位就不要让服务器出现没封面的菜谱）。
- 拉回后把 `remote.files` 交给 `downloadMissingFiles()`，**不 await 它的失败**（下载失败不影响菜谱落地）。

- [ ] **Step 8: 跑测试确认通过**

Run: `npm run test -- src/services/__tests__/`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add src/services/sync.ts src/services/__tests__
git commit -m "feat: 增量同步协议、待推送队列与 LWW 合并"
```

---

### Task 7: 图片上传与下载

**Files:**
- Create: `src/services/syncFiles.ts`
- Create: `src/services/__tests__/syncFiles.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `api`；Task 1 的 `uploaded_files` 表；现有 `src/services/imageStore.ts` 的 `setImageBaseDir` / 目录约定
- Produces:
  - `uploadPendingFiles(changes: SyncPayload): Promise<boolean>`（`true` = 全部成功或没有要传的）
  - `downloadMissingFiles(refs: FileRef[]): Promise<{ downloaded: number; failed: number }>`
  - `collectReferencedFileNames(changes: SyncPayload): string[]`（导出以便测试）
  - `FileRef = { name: string; size: number }`

- [ ] **Step 1: 写失败的测试** `src/services/__tests__/syncFiles.test.ts`

注入假的文件 IO（照 `imageStore.ts` 的 `ImageDeps` 注入缝写法）：

```ts
it("collectReferencedFileNames 收集封面与步骤图，去重，跳过 null", () => {});
it("已上传过的文件不再上传（uploaded_files 里有的跳过）", async () => {});
it("上传成功写 uploaded_files", async () => {});
it("Review Focus ③：任何一张图上传失败 → 返回 false，且失败的那张不进 uploaded_files", async () => {});
it("下载时本地已存在的文件跳过，不发请求", async () => {});
it("Review Focus ④：404 的文件不再重试（本轮记为失败即可），不阻塞其它文件", async () => {
  // 断言对同一 name 只发一次 GET，且其余文件照常下载
});
it("下载写入 $APPDATA/images/<name>，字节与响应一致", async () => {});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/__tests__/syncFiles.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

上传：`POST ${baseUrl}/api/v1/files?name=<encodeURIComponent(name)>`，`Content-Type: image/jpeg`，body 是 `readFile` 出来的字节；成功后 `INSERT OR REPLACE INTO uploaded_files (name, uploaded_at) VALUES (?, ?)`。
下载：串行（`for...of` + `await`），先查本地文件是否存在（`exists`），写盘用临时名再改名的同目录写法（半截文件不会以正式名出现）；失败只累加 `failed`，不抛。
`uploaded_files` 的查询在函数内做一次（`SELECT name FROM uploaded_files`），不要每个文件查一次。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/__tests__/syncFiles.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/syncFiles.ts src/services/__tests__/syncFiles.test.ts
git commit -m "feat: 图片上传与下载队列"
```

---

### Task 8: 存量数据认领、全扫推送与同步接线

**Files:**
- Create: `src/services/migration.ts`
- Create: `src/services/__tests__/migration.test.ts`
- Create: `src/services/__tests__/pushPayload.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `useAuthStore`；Task 5 的 `visibleRecipeFilter`；Task 6 的 `performSync` / `emptyPayload`
- Produces:
  - `claimOrphanRecipes(serverUserId: string): Promise<number>`（返回认领条数）
  - `collectPushPayload(): Promise<SyncPayload>`（`owner_id = 我` 的菜谱 + 全部字典行）
  - `firstFullSync(): Promise<void>`（认领 → 全扫推送 → 拉取 → 推进游标）
  - `triggerFullPushAndSync(): Promise<void>`（会话变在线时调用；内部先 `performSync()`，`firstFullSync` 已覆盖首次）
- 与 Task 6 的接线：`sync.ts` 的 `doSync` 在游标为 `null` 时改为调用 `firstFullSync()` 并直接返回；`collectPushPayload` 由 `sync.ts` 在每次推送前调用。

- [ ] **Step 1: 写失败的测试** `src/services/__tests__/migration.test.ts`

```ts
it("认领只动 owner_id 为 NULL 的行", async () => {
  // 库里三条：null / "other" / "me" → 认领后只有 null 那条变成 "me"
});
it("认领是幂等的：第二次调用返回 0", async () => {});
it("Review Focus ②：换人登录时不认领别人的菜谱，也不把别人的推上去", async () => {
  // A 认领后断开，B 登录 → collectPushPayload() 里没有 A 的菜谱
});
it("collectPushPayload 只含 owner_id = 我 的菜谱", async () => {});
it("collectPushPayload 带上全部字典行与子行", async () => {});
it("登出期间录的菜（owner_id 为 NULL）重新登录后被推上去（全扫补推）", async () => {});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/__tests__/migration.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`claimOrphanRecipes`：`UPDATE recipes SET owner_id = ?, updated_at = ? WHERE owner_id IS NULL`，返回受影响行数（`plugin-sql` 的 `execute` 返回 `{ rowsAffected }`；若拿不到就改为先 `SELECT COUNT(*)`）。
`collectPushPayload`：按 spec §9.3 组装 `{ ingredients, units, labels, recipes, files: [] }`，菜谱要带上 `deleted_at IS NULL OR deleted_at IS NOT NULL` 的**全部**自己名下菜谱（软删的墓碑也必须推，否则删不掉）。
`firstFullSync`：`claimOrphanRecipes` → `collectPushPayload` → `uploadPendingFiles` → `POST /sync`（游标传 0）→ `applyRemoteChanges` → `setLastSyncedAtFor(uid, server_seq)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/__tests__/migration.test.ts`
Expected: PASS

- [ ] **Step 5: 接线到 auth store**

`useAuthStore` 的 `login` / `register` / `restoreSession` 成功后：`await triggerFullPushAndSync()`（内部：先 `void performSync()`，再 `void useTeamStore().load()`）。失败不抛出（登录本身已成功，同步失败只置 `lastSyncFailed`）。

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `npm run test && npm run build`
Expected: 全绿、无类型错误

- [ ] **Step 7: 提交**

```bash
git add src/services/migration.ts src/services/__tests__ src/stores/auth.ts
git commit -m "feat: 存量菜谱认领、全扫推送与同步接线"
```

---

### Task 9: 端到端联调与文档

**Files:**
- Modify: `README.md`（用户视角一段：怎么开启同步、怎么建家庭）
- Create: `docs/开发者-同步与团队.md`（架构摘要、表结构、协议形状、常见问题排查）

**Interfaces:**
- Consumes: 全部
- Produces: 无新接口

- [ ] **Step 1: 起后端**

Run: `JWT_SECRET=dev-test REDIS_PASSWORD=dev-test docker compose up -d && curl -s localhost:8080/api/v1/healthz`
Expected: `{"status":"ok"}`

- [ ] **Step 2: 桌面端两个实例联调**

两个 Tauri 实例（不同 `$APPDATA`，或一台真机 + 桌面端），地址填 `http://localhost:8080`。逐步跑：

1. A 注册 → 录一条带封面的私人菜谱 → 确认同步成功（MePage 显示上次同步时间）。
2. A 建家庭「我家」→ 复制 6 位邀请码。
3. B 注册 → 输入邀请码加入 → **B 能看到 A 加入前录的团队菜谱**（回归 §9.4）。
4. A 录一条团队菜谱（带封面）→ B 看到，封面能显示（说明图片通道通了）。
5. B 打开 A 的菜谱详情 → **没有编辑与删除按钮**。
6. B 断网 → 录一条私人菜谱 + 改字典 → 恢复网络 → 同步后 A 看不到 B 的私人菜谱。
7. A 的两台设备（桌面 + 真机同一账号）：各改同一条菜谱 → 同步后两边都是较新的那份。

- [ ] **Step 3: Android 真机验证**

Run: `npm run tauri android dev`
Expected: 真机上能登录、能同步、能下载封面（真机的 CORS 与明文 HTTP 与桌面 dev 不同，必须在真机上过一遍；若用 `http://` 明文地址需要 Tauri 的明文流量配置，按官方做法在 `tauri.conf.json` / Android manifest 里放开开发用地址，**只放开开发地址，不要全局放开明文**）。

- [ ] **Step 4: 写文档**

`README.md` 只加用户视角内容（怎么开启同步、怎么建家庭、邀请码怎么用、不开启同步时一切照旧）。开发者细节写进 `docs/开发者-同步与团队.md`：表结构、协议形状、LWW 与游标规则、加入团队要清游标的原因、图片通道、已知限制（时钟偏差、LWW 丢改动不提示、不做图片回收、团队不能解散/退出）。

- [ ] **Step 5: 全量验证**

Run: `npm run test && npm run build && cargo check --manifest-path src-tauri/Cargo.toml && (cd backend && go test ./...)`
Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
git add README.md docs
git commit -m "docs: 补充同步与团队的用户说明与开发者文档"
```
