# 一起做饭 · 制作记录（真实体）设计

2026-11-01 · 状态：已实施

本文件只写三件事：**冷启动范围恢复的修复**、**制作记录成为真实体**、**库存页展示扣减记录并能跳到制作详情**。
库存的余量派生、按批次扣减、范围隔离、同步协议骨架继续有效，详见
`2026-10-24-inventory-design.md` 与 `2026-10-24-team-inventory-design.md`（下文简称库存 spec / 团队 spec）。

---

## 1. 要解决什么

实机验证后有三个问题：

1. **冷启动落在「我的菜谱」。** 已加入团队、上次也选中了团队，但每次打开 App 显示的都是个人范围；切到库存页再切回来才正常。
2. **制作历史看不到。** 点「制作」直接进消耗表单，确认后只留一句「已记录」，之后再也查不到这次做过什么。用户希望：点「制作」→ 先看这道菜的制作流水 → 右上角新增才进表单。
3. **扣减记录不可追溯。** 库存页只显示批次余量，看不到「这 200 g 是被哪次制作扣掉的」，更点不进去。

库存 spec 当时把「制作历史列表」列为非目标，并写明「一次制作不建会话表、不加 `cook_id`，将来要撤销时再加」。现在用户明确要做，且要在此之上继续扩展（每次制作拍照、写心得），所以这次把它做成**真实体**。

**成功的样子**：打开 App 直接落在上次选的团队；点某道菜的「制作」看到它历次制作（时间、扣了哪些食材）；库存里展开「五花肉」能看到「红烧肉 · 11-01 18:20 · 200 g」，点进去就是那次制作的详情。

---

## 2. 目标 / 非目标 / 反目标

**目标**

- 冷启动恢复「上次选中的团队」，且不依赖用户去点别的页面。
- `cook_records` 成为真实体（本地 + 服务端），`inventory_usages` 通过 `cook_id` 归属于一条制作记录。
- 一次确认制作 = 一条 `cook_records`；**表单可提交但实际一行都没扣成**（库存为空 / 全不够）也留下记录，详情页显示「这次没有扣任何库存」，与「表单说过已记录」一致。「所有行都填 0」仍不可提交（`canConfirm` 不改）。
- 制作记录跟着同步走：一条记录 + 它的使用记录都要能到别的设备、别的家庭成员手机上。
- 库存页：展开食材时按需加载并展示该食材的扣减记录，点击进入同一条制作记录的详情页。
- 记录详情页从两个入口进来内容一致：按菜谱看（该菜谱的某次）与按食材看（某食材被哪次扣过）。
- **每条记录显示「谁做的」**：自己做的用当前账号的昵称与头像，队友做的用服务端派生的 `owner_nickname` / `owner_avatar_url` 两列（照菜谱的同一套做法），离线也能看。

**非目标（本轮不做）**

- 撤销 / 回滚某次制作（`cook_records` 带 `deleted_at`，为将来留位，但本轮不写任何软删入口）。
- 每次制作的照片与心得（将来加列 / 加子表，本轮不预留列）。
- 制作记录的分页 / 筛选 / 编辑。
- 把「补记过去某天做的菜」做成显式 UI（表单里 `created_at` 仍是确认那一刻）。

**反目标**

- 为了展示历史把余量改成落列（会与批次/使用记录对不上，库存 spec §4.2 的底线）。
- 用 `recipe_id + used_at` 归组（时间戳不是身份，将来拍照/心得/撤销都需要稳定主键）。

---

## 3. 已定方案

### 3.1 方案选择（已由用户拍板）

- **A（弃）** 用 `recipe_id + used_at` 在读取侧归组：零迁移，但一次制作没有身份，将来加照片 / 心得 / 撤销都要返工。
- **B（选定）** 新增 `cook_records` 表，`inventory_usages` 加 `cook_id`：一次制作一条记录，扩展点天然存在。代价是本地表结构 + 服务端迁移 + 同步载荷各改一处。
  用户明确表示现在还在开发阶段、未正式使用，数据可以清，所以不需要为老数据迁移 / 回填做兼容设计。

### 3.2 冷启动范围恢复（问题 1 的根因与修法）

冷启动顺序：`main.ts` 先 mount → 页面 `onMounted` → 之后才 `restoreSession()`。
于是 `RecipeList` 挂载时 `team.load()` 拿不到 uid 直接返回、`restoreCurrentTeam()` 也空跑；
会话恢复成功后 `triggerPostSessionSync()` 只调 `team.load()`，而 `load()` 在「没选团队 + 活动范围还是 `p:local`」时把范围切到个人，从不读取 localStorage 里保存的团队。所以每次冷启动都落在「我的菜谱」。
切到库存页时 `InventoryPage` 又调了一次 `restoreCurrentTeam()`，那时会话已就绪 —— 这就是「点别的页面再切回来就正常」。

**修法一**：把「恢复上次选中的团队」并进 `team.load()`（会话恢复路径本来就会调它），读法与 `restoreCurrentTeam` 共用同一个 `savedTeamId(uid)`：

```
load():
  拉 /teams → 缓存
  保存的团队还在列表里 && 当前没选团队 → switchTo(saved)
  当前团队已不在列表                    → switchTo(null)
  没保存过 && 活动范围还是 p:local      → 切到个人范围 + 重查（保持现有行为）
```

`restoreCurrentTeam()` 保留（供页面挂载时兜底）。`auth.ts` 一行不改。

**修法二（同一根因的另一半）**：`restoreCurrentTeam()` 目前在团队列表为空时会把保存的团队从 localStorage **删掉**（`switchTo(null)` → `persistCurrentTeam()` → `removeItem`）。页面挂载时 `load().catch()` 会吞掉断网 / 超时，于是 `/teams` 抖一次就永久丢掉用户的选择 —— 光修 `load()` 还会间歇复发。

所以加一个「列表真的拉成功过」的标记 `teamsLoadedFor: string | null`（成功 `load()` 后置为 uid，`resetFor` 清空）。`restoreCurrentTeam()`：列表没拉到就**不动**已保存的选择、不落 `null`；只把仍是 `p:local` 的活动范围切到个人范围（否则认领后是一屏空态），重查。列表拉到之后才按现有逻辑恢复 / 回落。

---

## 4. 数据模型

### 4.1 本地 SQLite（`src/db/index.ts`）

新表：

```sql
CREATE TABLE IF NOT EXISTS cook_records (
  id          TEXT PRIMARY KEY,
  scope_id    TEXT NOT NULL,
  owner_id    TEXT,              -- 记录者；未登录为 NULL（游客范围）
  recipe_id   TEXT NOT NULL,     -- 不加外键：同步会物理删字典、软删菜谱（沿用库存两表的取舍）
  owner_nickname   TEXT,         -- 服务端派生，本机新建时为 NULL（显示时用当前账号），与 recipes 同构
  owner_avatar_url TEXT,
  created_at  TEXT NOT NULL,     -- 制作发生时间（= 本次使用记录的 used_at）
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
```

- `inventory_usages` 加 `cook_id TEXT`（新库写在 CREATE TABLE 里，老库走 `addColumnIfMissing`）。
- 索引：`cook_records(scope_id)`、`cook_records(recipe_id, created_at)`、`inventory_usages(cook_id)`。
- 老库里已有 `cook_id IS NULL` 的使用记录：照旧参与余量计算，但**不出现在制作记录与扣减记录里**（没有记录可归）。开发阶段数据可清，不做回填。
- `created_at` 就是制作时间：本轮没有「补记」需求，不再加 `cooked_at`；将来真需要再加列。

### 4.2 服务端（`backend/internal/database/migrations/002_cook_records.up.sql`）

```sql
CREATE TABLE cook_records (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id),
    team_id UUID REFERENCES teams(id),
    recipe_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ,
    server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);
ALTER TABLE inventory_usages ADD COLUMN cook_id TEXT;
-- cook_records 与 recipes 一样，不存作者昵称 / 头像：只在响应里由 LEFT JOIN users 派生。
-- 客户端推送时带上这两列也不落库（mergeCookRecord 只读 id / scope / recipe_id / 时间）。
CREATE INDEX idx_cook_records_server_seq ON cook_records(server_seq);
CREATE INDEX idx_cook_records_team ON cook_records(team_id);
CREATE INDEX idx_cook_records_recipe ON cook_records(recipe_id);
CREATE INDEX idx_inventory_usages_cook ON inventory_usages(cook_id);
```

`cook_id` 允许 NULL 只为兼容已存在的开发库；新写入一律带值。down 迁移：删索引、删列、删表。

服务端形状与 `inventory_batches` 同构：`team_id + owner_id` 表达范围、`server_seq` 增量、`created_at` 由客户端给（制作发生时间）。**参与 LWW**（`updated_at` 比较），因为它将来会被编辑（心得）。使用记录仍只增不清。

---

## 5. 同步

- 本地 `src/services/sync.ts`：`SyncPayload` / `emptyPayload` / `PENDING_KEYS` 加 `cook_records`；`applyRemoteChanges` 里按 LWW 合并（照抄 `inventory_batches` 分支，但不做字典 remap —— 它不引用字典）；**LWW 跳过分支仍要刷新 `owner_nickname` / `owner_avatar_url` 两列**（与菜谱同一理由：作者改了昵称/头像，记录本体不需要重发）；`collectPushPayload` 推 `owner_id = 我` 的记录（与使用记录同一口径），时间戳按 `toIsoTimestamp` 归一化。
- `src/services/migration.ts` 的 `claimLocalScope`：`cook_records` 加入「改 scope + 补 owner_id」的循环。
- 服务端：`model.SyncPayload` 加 `CookRecords`；`model.CookRecord` 带 `owner_nickname` / `owner_avatar_url`（仅响应有意义，与菜谱一致）；`maxServerSeqSQL` 的 UNION 加一条；`getRemoteChanges` 初始化空切片 + `queryCookRecords`（`LEFT JOIN users` 派生两列）；`mergeLocalChanges` 在库存批次之后、使用记录之前合并记录（先父后子）；`insertUsage` 写入 `cook_id`；**`queryUsages` 的 SELECT 与 Scan 也要带 `cook_id`**，否则拉下来的使用记录丢了归属，别的设备详情页一片空。
- 使用记录的 `cook_id` 不做存在性校验：记录被范围校验跳过时宁可保留这条扣减（丢了它会永久对不上库存），只是详情页看不到它。**顺序必须记录在前**，正常路径下记录总已存在。

---

## 6. 应用层

### 6.1 类型（`src/types/index.ts`）

```ts
export interface CookRecord {
  id: string;
  scope_id: string;
  owner_id: string | null;
  recipe_id: string;
  owner_nickname: string | null; // 服务端派生；本机新建为 NULL
  owner_avatar_url: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** 展示用的作者：自己做的回退到当前账号（本机新建的行两列为 NULL）。 */
export interface CookRecordAuthor {
  name: string | null;
  avatar_url: string | null;
}

export interface CookRecordLine {
  ingredient_name: string;
  unit_name: string | null;
  amount: number;
}

/** 一条制作记录 + 它扣掉的全部食材（同一食材同一单位跨批次合并） */
export interface CookRecordDetail {
  record: CookRecord;
  author: CookRecordAuthor;   // 展示用，store 里算好（自己做的回退到当前账号）
  recipe_name: string | null; // 菜谱被删时为 null，页面显示「已删除的菜谱」
  lines: CookRecordLine[];
}

/** 库存页一行扣减记录：某食材在某次制作里被扣掉多少（可能跨多个单位） */
export interface IngredientCook {
  record: CookRecord;
  recipe_name: string | null;
  parts: { unit_name: string | null; amount: number }[];
}
```

`InventoryUsage` 加 `cook_id: string | null`。

### 6.2 库存 store（`src/stores/inventory.ts`）

- `commitCook(recipeId, lines)`：
  1. 立即 `INSERT cook_records`（`id = crypto.randomUUID()`，`created_at = updated_at = now`），
  2. 扣减使用记录全部带 `cook_id`，
  3. `enqueueSync({ cook_records: [记录整行], inventory_usages: [使用记录整行] })`。
  返回的 `CookResult` 形状不变（页面只关心扣了什么）。
  不开事务的契约沿用：最坏是「有记录、没扣减」，记录成了空壳，可见且不伤账。
- 新增读取方法（全部带 `scope_id = activeScope`、`deleted_at IS NULL`）：
  - `fetchCookRecords(recipeId): Promise<CookRecordDetail[]>` —— 该菜谱的记录，`created_at` 倒序；行在一条 SQL 里 `JOIN inventory_batches → ingredients / units`，按 `cook_id + ingredient_id + unit_id` 聚合（同一食材跨批次合并）。
  - `fetchCookRecord(id): Promise<CookRecordDetail | null>` —— 单条，菜谱名 `LEFT JOIN recipes`。
  - 作者解析只在 store 一处：`owner_id === null || owner_id === auth.serverUserId` → 当前账号的昵称/头像；否则用记录里服务端派生的两列。列表、详情、库存三处都用这个结果，不在页面里各写一遍。
  - **JOIN 批次不过滤 `b.deleted_at`**：删批次只影响以后的可扣量，不追改历史。否则删掉一个批次，那次制作的明细行就消失，全删完变成「这次没有扣任何库存」—— 历史被静默改写。界面只显示食材名 + 数量单位，不显示批次。
  - `fetchIngredientCooks(ingredientId): Promise<IngredientCook[]>` —— 该食材被哪些制作扣过，`created_at` 倒序；同一记录可能跨多个单位，页面上用「、」连接。
- 查询都按 `batch.ingredient_id` 过滤食材（使用记录本身不存食材，库存 spec §4.15 的既有取舍）。

### 6.3 路由（`src/router/index.ts`，改）

```ts
{ path: "/recipe/:id/cook",        name: "recipe-cook-records", component: CookRecords,     meta: { hideTab: true } },
{ path: "/recipe/:id/cook/new",    name: "recipe-cook",         component: CookPage,        meta: { hideTab: true } },
{ path: "/recipe/:id/cook/:cookId", name: "recipe-cook-record", component: CookRecordDetail, meta: { hideTab: true } },
```

静态段 `new` 排在参数段 `:cookId` 之前（与 `/recipe/filter` 同一约定）。

### 6.4 制作记录列表 `src/views/CookRecords.vue`（新增）

- `AppHeader title="制作记录"` + `show-back`；右上角 `Plus`（`data-test="cook-record-add"`）→ `/recipe/:id/cook/new`。
- 每行 `data-test="cook-record"`：时间（`YYYY-MM-DD HH:mm`，本地时区）、作者（昵称 + 头像，`data-test="cook-record-author"`）、扣了几项食材（明细为空时「没有扣库存」）；点击 → `/recipe/:id/cook/{id}`。
- 空态（`data-test="cook-records-empty"`）：「还没有制作记录，点右上角加号记一次」。
- 数据：`onMounted` 调 `fetchCookRecords(recipeId)`。

### 6.5 制作详情 `src/views/CookRecordDetail.vue`（新增）

- `AppHeader title="制作记录"` + `show-back`。
- 顶部：制作时间；作者（`data-test="cook-record-author"`）；菜谱名（`data-test="cook-record-recipe"`）。
- 明细：每行 `食材名 + 数量 + 单位`（`data-test="cook-record-line"`）。
- 无明细时 `data-test="cook-record-empty"`：「这次没有扣任何库存」。
- 记录不存在（被别的设备清空）：「记录不存在」+ 返回。

### 6.6 制作表单 `src/views/CookPage.vue`（改）

- 「完成」保持 `router.back()`（返回即列表，`CookRecords` 挂载时重查，新记录自然出现）。表单本身的上游入口变成 `/recipe/:id/cook/new`，路由名与 `canConfirm` 都不动。
- 结果态空扣减的文案 `没有可扣的库存，这次没有记账` 改成 `没有可扣的库存，这次没有扣任何库存`：记录已经写了，原话变成了假话。只改这一句文案，对应断言随之更新（不改断言强度）。

### 6.7 库存页 `src/views/InventoryPage.vue`（改）

- 展开某食材时，`loadIngredientCooks(ingredientId)` 按需查一次并缓存在页面内存（`Map<string, IngredientCook[]>`）；收起再展开不重查，重进页面重查。
- 批次列表下方加「扣减记录」块（仅当有记录时渲染）：
  - 每行 `data-test="stock-usage"`：`菜谱名 · 时间 · 数量单位`；点击 → `/recipe/{record.recipe_id}/cook/{record.id}`。
  - 没有记录时整块不渲染（不占位、不加空态噪音）。
- 删除批次、录入批次等既有行为一字不改。

---

## 7. 测试

前端（vitest，新增用例，不改断言强度）：

| 文件 | 用例 |
| --- | --- |
| `src/stores/__tests__/team.test.ts` | `load` 冷启动路径：localStorage 有保存的团队 → 活动范围变成 `t:<id>`（问题 1 的回归测试） |
| `src/stores/__tests__/inventory.test.ts` | `commitCook` 写一条 `cook_records` 且每条 usage 带同一个 `cook_id`；一行都没扣也留记录；`fetchCookRecords` 只取当前菜谱 + 当前范围、按时间倒序、跨批次同单位合并；`fetchIngredientCooks` 只含该食材、菜谱名可空 |
| `src/stores/__tests__/team.test.ts`（续） | 团队列表没拉到（`load` 抛错）时 `restoreCurrentTeam` 不抹掉保存的团队、不落 `null` |
| `src/views/__tests__/CookPage.test.ts` | 空扣减文案随新记录语义更新；`canConfirm` 全填 0 仍禁用（保持现有断言） |
| `src/views/__tests__/CookRecords.test.ts`（新） | 列表渲染、空态、加号进 `/recipe/r1/cook/new`、点行进详情 |
| `src/views/__tests__/CookRecordDetail.test.ts`（新） | 明细渲染、空明细文案、记录不存在、作者显示（自己 vs 队友） |
| `src/views/__tests__/InventoryPage.test.ts` | 展开后显示扣减记录、点击进详情、无记录不渲染块 |
| `src/router/__tests__/routes.test.ts` | 三条路由存在、`hideTab`、`new` 不被 `:cookId` 抢走、`/recipe/r1/cook` 解析到 `recipe-cook-records` |
| `src/services/__tests__/sync*.test.ts` | 载荷含 `cook_records`；远端 LWW 合并；LWW 跳过时仍刷新作者两列；`collectPushPayload` 推我的记录 |
| `src/services/__tests__/migration.test.ts` | 认领时 `cook_records.scope_id` / `owner_id` 一起改写 |

后端（Go，testcontainers 可用）：

- `database/migrations_test.go`：`cook_records` 存在、`inventory_usages.cook_id` 存在。
- `service/sync_*_test.go`：记录推送落库 + 幂等；LWW 后到覆盖；范围不符跳过；使用记录带 `cook_id`；增量下发。

---

## 8. 兼容与发布

- 本地老库自动补列，不删任何数据；老使用记录不进制作记录。
- 服务端新增 002 迁移，向前兼容旧客户端（不认识的 `cook_records` 字段被忽略；不推 `cook_id` 的 usage 落 NULL）。
- 旧客户端同步时不会带 `cook_records`，服务端按空数组处理。

## 9. 留给实现者决定

- `fetchCookRecords` 的 SQL 拆几条（一条 JOIN + 内存分组，还是两次查询）—— 以可读性和测试可断言为准。
- 列表行的时间格式与摘要文案的具体措辞。
- 扣减记录块在展开区里的视觉层级。
