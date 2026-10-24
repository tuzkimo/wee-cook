# 一起做饭 · 团队与共享库存 设计

2026-10-24 · 状态：设计待审

**取代** `2026-10-15-community-design.md`（社区：公开菜谱 / 收藏 / 关注）与 `2026-10-24-inventory-design.md` §4.1（库存只存本地）。同步协议、图片通道、存量认领、全扫推送、触发时机继续有效，本文件只写变化。

---

## 1. 要解决什么

上一版把「共享」建模成**社区**：一条菜谱公开到一台服务器的所有人，靠收藏关系把别人的菜落回本机。

走完全流程才发现这个模型回答不了 App 最核心的问题：**「我们家冰箱里还剩什么？」** 社区是一群互不相识的人在看菜谱，而库存天然是**一个家庭内部的账**——买菜的是家里人，做饭的也是家里人，「我家还剩多少五花肉」既不该公开给同服务器所有人，也不能只存在一台手机上（换手机、两口子各看各的都对不上）。

所以共享单位改回**团队（= 家庭）**：菜谱与库存都归一个团队，团队成员共享一本菜谱和一个冰箱；一个人可以属于多个团队（自己家、爸妈家），界面上随时切换。

还有一条被这次改动逼出来的前提：**一台服务器可能不止一个家庭**（自己家 + 爸妈家），所以**食材 / 单位 / 分类 / 标签字典也必须按家庭分开**，不能用「同名即同一条」的全局字典——自家录的「生抽」不该出现在爸妈家的食材选择里，两个家庭各有一个「生抽」也不能被合并成一条。

**成功的样子**：A 在自家录一道菜、记一批五花肉，B 在自己手机上立刻看到，做这道菜点「制作」扣的是家里那个冰箱的账，扣完两人看到的余量都少了；B 切到「爸妈家」，看到的是另一个家庭的菜谱、库存**和食材表**，两边互不串。同一台手机换人登录，也看不到上一个人的任何东西。

---

## 2. 目标 / 非目标 / 反目标

**目标**

- **不登录时的行为与今天完全一致**：不出登录墙、不发任何网络请求、功能不缺（菜谱 + 库存 + 字典都在本机）。
- **团队**：创建、6 位邀请码加入、成员列表、改名、移除成员、退出、转让 owner、解散。
- **一个人可以属于多个团队**，界面上能在「我的菜谱」与各团队之间切换；切换是一个全局状态，菜谱页与库存页共用。
- **范围隔离彻底**：菜谱、库存、字典全部按范围（个人 / 某个团队）分开；换账号、换范围都看不到别人的数据。
- **菜谱归团队**：团队菜谱全员可见，只有创建者能改能删。
- **库存归团队**：批次录入、扣减、删除团队内全员可做；库存页升为底栏独立标签页。
- **库存跟着同步**：`inventory_batches` / `inventory_usages` 进同步载荷。
- **离线优先不被破坏**：任何操作都不等网络；同步失败不阻塞使用、不丢改动。

**非目标（本轮明确不做）**

- 社区：公开菜谱、收藏、关注、用户页（本版**删除**已有实现）。
- 菜谱换本（把一条私人菜谱搬进团队，或反过来）。
- 协作编辑同一条菜谱（仍然只有创建者能改）。
- 库存的并发对账（两人同时做饭会重复扣同一批次，见 §8.7）。
- 成员别名（wee-count 的 `member_aliases`）、按成员筛选、制作历史、缺料计算、低库存提醒。
- 评论、点赞、通知、动态流、图片垃圾回收。
- 端到端加密：服务器明文保存（自托管，服务端属可信域）。
- 按账号分库（见 §4 的路线比较）。

**反目标（做出来了也算失败）**

- 没登录的人被任何同步逻辑挡住，或本地功能被网络状态影响。
- **串范围**：在「爸妈家」录的库存出现在「自家」的列表里；自家字典里出现爸妈家的食材；同一台手机换账号后看到上一个人的东西。
- 团队菜谱能改到别人创建的那条上（UI 与 service 任一层失守）。
- 为了这版把已完成的 CRUD / 筛选 / 同步协议重写。
- 同步失败时静默丢掉本地改动，或把本地数据覆盖成空的。
- 库存余量存成表里的一列再逐步 UPDATE（必须由批次 − 使用记录派生）。

---

## 3. 约束（既定）

- 来自 `AGENTS.md`：Vue 3 + TS 严格模式（**禁止 `any`**）、Tauri 2、测试优先、食材必须引用结构化数据、业务表带 `id` / `updated_at` / `deleted_at`（例外见 §13）、README 只写用户内容。
- 后端技术栈与同步协议照旧（Go + chi + pgx + PostgreSQL 16 + Redis 7 + JWT；全局 `server_seq` + 游标 + LWW + 软删墓碑 + advisory lock + 子表整条替换 + 字典同名合并 + 父行补齐）。
- **单库**，用范围列隔离，不按账号 / 团队分库文件（§4）。
- **不新增依赖**。

---

## 4. 归属建模与选定

| 路线 | 做法 | 代价 |
|---|---|---|
| **A（选定）单库 + `scope_id`** | 一个 SQLite 文件，五张业务表各带 `scope_id`（`p:<uid>` 个人 / `t:<teamId>` 团队 / `p:local` 未登录）。所有查询按当前范围过滤 | 每个查询都要带范围条件；认领是「改写范围列」 |
| B 单库 + `team_id` / `owner_id` 组合 | 不引入范围键，用两列表达归属 | 字典要按「家庭内共有 / 个人私有」两种归属，查询与唯一索引都要处理 NULL；SQLite 的 UNIQUE 里 NULL 互不相等，**挡不住个人范围的重名**，得改用表达式索引并让每处 SQL 记住这条 |
| C 每个范围一个库文件 | 切团队 = 换库 | 游客数据要跨库复制迁移（字典同名还得复用同步的 remap）、多句柄、每范围一套游标与队列；玩家规模下换不到任何东西 |
| D 每账号一个库（wee-count 客户端） | 换账号 = 换库 | 只在账号隔离上有优势；而账号隔离用范围过滤同样能做到，还省掉跨库认领。wee-count 这么做是因为它没有「未登录也能用」的模式 |

**选 A**：范围键是一个字符串，一套过滤条件走到底；字典唯一索引直接 `UNIQUE(scope_id, name)`，没有 NULL 语义陷阱；登录认领是一条 `UPDATE`。

**为什么不按账号分库**：「单库切账号」的隔离靠的是**范围列**，不是文件：登录态只认 `p:<我>` 与 `t:<我所在的团队>`，登出态只认 `p:local`。物理上数据都在这一个文件里，但界面上、同步载荷里、服务端可见范围里，没有任何一条路径能跨过范围取到别人的行。

---

## 5. 总体形状

- **后端仍是可选组件**：不配地址、不登录时行为与今天一致。
- **本地 SQLite 仍是唯一真相源**；服务器只做「收增量 / 发增量 / 存图片」。
- **团队列表只走 REST，不进同步载荷**（团队不是内容，是「我的身份」）。
- **当前范围是一个全局 UI 状态**，菜谱页与库存页共用，按账号持久化。
- **一次同步**拉回「我的个人范围 ∪ 我加入的全部团队范围」。
- **没有实时推送**：启动、写操作后 3 秒防抖、手动同步。

---

## 6. 权限模型

| 对象 | 谁看得见 | 谁能改 / 删 |
|---|---|---|
| 个人菜谱（`p:<uid>`） | 只有我（含我的其他设备） | 只有我 |
| 团队菜谱（`t:T`） | T 的全部成员 | 创建者（`owner_id`） |
| 个人库存 / 使用记录（`p:<uid>`） | 只有我 | 只有我 |
| 团队库存批次（`t:T`） | T 的全部成员 | **T 的全部成员**（增 / 软删 / 扣减） |
| 个人字典（`p:<uid>`） | 只有我 | 只有我 |
| 团队字典（`t:T`） | T 的全部成员 | T 的全部成员（LWW 决定结果；同名合并只在本范围内发生） |
| 图片 | 引用它的菜谱在我可见范围内 | 上传者（只增不改） |
| 团队成员关系 | T 的全部成员 | owner（移除 / 转让 / 解散）；本人（退出） |

三条硬规则：

1. **服务端是权限的唯一裁决者**：拉取按「我可见的范围」过滤；推送时范围必须是 `p:<我>` 或 `t:<我所在的团队>`（`owner_id` 一律取当前登录用户）。
2. **客户端不出现越权入口**：别人的菜谱没有编辑 / 删除按钮（`canEdit` 只看创建者）。
3. **库存是团队共有财产**：能改别人的批次是**设计**，服务端对团队批次的写权限只校验「是不是这个团队的成员」。

---

## 7. 数据模型

### 7.1 本地 SQLite（`src/db/index.ts`）

未正式使用、无发布过的存量库 → **直接改写 DDL**，本地开发库删掉重来。

```sql
-- 五张业务表加范围列（NOT NULL）。取值：
--   'p:<服务端 user id>' 个人范围      't:<团队 id>' 团队范围      'p:local' 未登录时的本机范围
ALTER TABLE recipes            ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'p:local';
ALTER TABLE ingredients        ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'p:local';
ALTER TABLE units              ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'p:local';
ALTER TABLE labels             ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'p:local';
ALTER TABLE inventory_batches  ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'p:local';
ALTER TABLE inventory_usages   ADD COLUMN scope_id TEXT NOT NULL DEFAULT 'p:local';

-- 字典的唯一键带上范围：两个家庭各有一个「生抽」互不影响
CREATE UNIQUE INDEX idx_ingredients_scope_name   ON ingredients(scope_id, name)        WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_units_scope_name         ON units(scope_id, name)              WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_labels_scope_name_kind   ON labels(scope_id, name, kind)       WHERE deleted_at IS NULL;

CREATE INDEX idx_recipes_scope           ON recipes(scope_id);
CREATE INDEX idx_inventory_batches_scope ON inventory_batches(scope_id);
CREATE INDEX idx_inventory_usages_scope  ON inventory_usages(scope_id);
```

- 子表（`recipe_steps` / `recipe_ingredients` / `recipe_labels`）不加范围列：归属由父行决定。
- `inventory_usages` 另加 `owner_id`（谁扣的）；`inventory_batches` 另加 `owner_id`（谁录的，不展示，只用于推送「我的批次」）。
  - 现有 `inventory_batches` / `inventory_usages` 本身没有 `owner_id`，这条是**新增列**。
- `recipes.owner_id` 保留：编辑权只看创建者；`owner_nickname` / `owner_avatar_url` 保留（团队里显示「谁加的菜」）。
- 字典表**不加** `owner_id`：个人字典的归属就是这个范围本身。
- 范围列由应用层写入，不靠默认值（默认值只是给 DDL 的 NOT NULL 兜底）。

```sql
-- 团队列表缓存（服务端 GET /teams 的全量快照，团队不进同步载荷）。
-- 不是业务实体，是「我的身份」的缓存：登录整表替换、登出清空，不带 updated_at / deleted_at（§13 例外）
CREATE TABLE IF NOT EXISTS teams (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL,       -- 'owner' | 'member'
  member_count INTEGER NOT NULL DEFAULT 0
);
```

移除：`favorite_recipes`、`local_accounts`、`recipes.is_public`。

### 7.2 服务器 PostgreSQL（改写 `001_init.up.sql`）

在现有表上按范围加列；服务端用 `team_id` + `owner_id` 表达范围（`scope_id` 是客户端的形状，服务端识别后落这两列）。

```sql
-- 恢复团队两张表
teams (
  id UUID PK DEFAULT uuid_generate_v4(), name VARCHAR(100) NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ
);
team_members (
  team_id UUID REFERENCES teams(id), user_id UUID REFERENCES users(id),
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);

-- 字典三张表加范围：team_id NULL = 个人字典（owner_id 就是那个人）
ALTER TABLE ingredients ADD COLUMN team_id UUID REFERENCES teams(id);
ALTER TABLE ingredients ADD COLUMN owner_id UUID REFERENCES users(id);
-- units / labels 同理

-- recipes：is_public → team_id（owner_id 本来就有）
--   team_id NULL = 个人菜谱；否则团队成员共享

-- 库存两张表（业务表，全列）
inventory_batches (
  id TEXT PK,
  owner_id UUID NOT NULL REFERENCES users(id),   -- 录入者
  team_id  UUID REFERENCES teams(id),            -- NULL = 个人库存
  ingredient_id TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
  unit_id TEXT, produced_at TEXT,                -- YYYY-MM-DD
  shelf_life_days INT, expires_at TEXT,          -- YYYY-MM-DD
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ,
  server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);
inventory_usages (
  id TEXT PK,
  owner_id UUID NOT NULL REFERENCES users(id),   -- 扣减者，取 JWT
  team_id  UUID REFERENCES teams(id),            -- 与批次同值，服务端校验不一致就跳过
  recipe_id TEXT NOT NULL, batch_id TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
  used_at TIMESTAMPTZ NOT NULL,                  -- 记录的发生时间，不另设 created_at
  updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ,
  server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);
```

- **字典同名合并在服务端只在同一范围内发生**：个人范围是 `team_id IS NULL AND owner_id = $me`，团队范围是 `team_id = T`。合并不跨范围（否则两个家庭又会被并成一条）。
- `produced_at` / `expires_at` 用 `TEXT`（库存设计 §4.13：保质期到「日」为止）。
- 库存表**不建**指向字典 / 菜谱的外键（字典合并会物理删行，真外键只会让同步卡死）。
- 删除：`favorites`、`follows`、`idx_favorites_recipe`、`recipes.is_public`。
- 索引：`idx_team_members_user`、`idx_recipes_team`、`idx_recipes_server_seq`、字典各自 `(server_seq)` / `(team_id, name)`、库存的 `(server_seq)` / `(team_id)` / `(batch_id)`。

---

## 8. 同步协议（改动点）

协议形状、`server_seq` / 游标 / LWW / advisory lock / 子表整条替换 / 父行补齐，**全部沿用**。变化如下。

### 8.1 载荷

每行都带 `scope_id`（客户端原样给出，服务端翻译成 `team_id` / `owner_id` 并校验）：

```jsonc
"recipes":          [ ..., "scope_id" ]
"inventory_batches":[ { "id", "scope_id", "owner_id", "ingredient_id", "amount", "unit_id",
                        "produced_at", "shelf_life_days", "expires_at",
                        "created_at", "updated_at", "deleted_at" } ]
"inventory_usages": [ { "id", "scope_id", "owner_id", "recipe_id", "batch_id", "amount",
                        "used_at", "updated_at", "deleted_at" } ]
```

- `ingredients` / `units` / `labels` 只加 `scope_id`（字典行没有 `owner_id`：个人字典的归属就是范围本身）。
- `inventory_usages` 没有 `created_at`：`used_at` 就是发生时间。
- 响应里 `owner_id` 才有意义；请求里的一律丢弃（服务端按 JWT 与范围赋值）。
- `recipes[]` 不再有 `is_public`。

游标的 `MAX(server_seq)` 从四张表扩到六张表（菜谱 + 三字典 + 两张库存）。

### 8.2 范围校验（服务端唯一入口）

```go
// 'p:<uid>' → team_id = NULL, owner_id = uid（uid 必须等于当前登录用户）
// 't:<uuid>' → team_id = uuid（必须是当前用户的可见团队：成员 ∧ 团队未解散）
// 其他形状 / 越权 → 整条跳过（不回滚整批）
```

### 8.3 写入规则

顺序仍是：advisory lock → 合并字典并记 remap → 按 remap 重写引用（菜谱 + **库存批次**的 `ingredient_id` / `unit_id`）→ 合并菜谱 → 合并库存。

- **字典**：LWW on `updated_at`；同名合并只在**同一范围**内进行（`team_id IS NULL AND owner_id = $me` 或 `team_id = T`）。
- **菜谱**：新增行 `owner_id` 取当前用户、范围按 §8.2 校验；已存在行的写权限仍只看 `owner_id = 我`。**范围在更新时不改**（不做菜谱换本）。
- **库存批次**：LWW on `updated_at`。
  - 写权限：范围内的成员 / 本人（个人范围只有本人）。
  - 新增行：`owner_id` 取当前用户（录入者）。
  - 更新行（含软删墓碑）：保留原 `owner_id`，范围不允许变（与已存在的行不一致就跳过）。
- **使用记录**：**只增不清**。`INSERT ... ON CONFLICT (id) DO NOTHING`，绝不 UPDATE / DELETE。
  - 校验：`batch_id` 必须在服务器上存在（**含已软删的批次**），那条批次的可见范围 = 这条记录的范围。任一不满足就跳过该条。
  - 软删批次必须放行：成员离线期间批次被删，他记的记录若被丢弃，余量会永久对不上且不会自愈。
  - 只推**自己产生的**记录（`owner_id = 我`）：队友的扣减各自推，`ON CONFLICT` 只按 id 去重，不会被算到推送者头上。

### 8.4 可见范围（服务端 SQL）

```sql
-- 可见团队 = 成员关系 ∧ 团队未解散（解散只软删 teams 行，成员行不删）
visible_teams: SELECT tm.team_id FROM team_members tm
               JOIN teams t ON t.id = tm.team_id AND t.deleted_at IS NULL
               WHERE tm.user_id = $me

recipes:   (team_id IS NULL AND owner_id = $me)              -- 我的个人菜谱
        OR team_id IN (visible_teams)                        -- 我团队的（含我自己建的）
batches:   同 recipes 的条件
usages:    同 recipes 的条件（usages 自带 team_id）
dicts:     (team_id IS NULL AND owner_id = $me) OR team_id IN (visible_teams)
```

### 8.5 推送集合

「全扫推送」沿用，范围变成「我的个人范围 ∪ 我加入的团队」：

- `recipes`：`owner_id = 我` 的全部（含墓碑）——个人菜谱 + 我建的团队菜谱。
- `inventory_batches`：个人范围全部 + 我团队范围全部（含墓碑）。
- `inventory_usages`：`owner_id = 我` 的全部。
- 字典三张表：上述范围内的全部（含软删行）。
- 图片：沿用现有上传前置（图没传成功则这批菜谱不推）。

已退出团队留下的本地行不再被推送（不在我的范围里），服务端也不再下发它们。

**登录时序**：登录 / 恢复会话成功后必须先 `GET /teams` 把团队缓存刷成本账号的，再认领、再触发全扫同步。登出时清空 `teams` 表与内存态。

### 8.6 客户端落地

- 批次的合并与菜谱同一套 LWW 骨架；`applyRemoteChanges` 里字典合并的 `repointSql` 已重指库存批次，保持。
- **字典的去重查询要带范围**：`findDupSql` 从 `WHERE name = ?` 改成 `WHERE scope_id = ? AND name = ?`（labels 再加 `kind`）。不带范围就会把两个家庭同名食材合并成一条。
- remap 重指按 id 进行（每个范围的 id 都是新 UUID，不跨范围重复）。
- 使用记录用 `INSERT OR IGNORE`（id 是客户端 UUID，`scope_id` / `owner_id` 随行写入）；**不参与 LWW、不软删**。
- 远端来的批次行的 `ingredient_id` / `unit_id` 也要过 remap。
- 图片通道不变。

### 8.7 并发扣减的处理（有意不解决）

两个人几乎同时点「确认制作」，各自按本地余量规划，同一批次会被扣两次，余量变成负数。

- **不引入服务端预留 / 锁 / 冲突提示**：家用场景下这是极小概率事件。
- 表现：余量按 0 兜底显示（`已用完`），不显示负数；账实偏差由用户自己删批次 / 再录一批修正。
- 写进代码注释（`shortcut:`）。将来真要解决，方向是给批次加不可变的使用日志 + 服务端聚合。

---

## 9. 团队接口（REST）

```
GET    /api/v1/teams                              → 我加入的团队 + 成员数 + 我的角色
POST   /api/v1/teams            { name }          → 建团队，建者为 owner
POST   /api/v1/teams/join       { code }          → 6 位邀请码入组（按 IP 限流 10/min）
PUT    /api/v1/teams/{id}       { name }          → 改名（owner）
POST   /api/v1/teams/{id}/invite                  → 生成 6 位码（owner，Redis 24h）
GET    /api/v1/teams/{id}/members                 → 成员列表（成员）
DELETE /api/v1/teams/{id}/members/{userId}        → 移除成员（owner；不能移除自己）
DELETE /api/v1/teams/{id}/members/me              → 退出（member；owner 不能直接退）
PUT    /api/v1/teams/{id}/owner { user_id }       → 转让 owner（owner；目标必须是本团队成员）
DELETE /api/v1/teams/{id}                         → 解散（owner，软删 teams 行）
```

- 邀请码存 Redis：`invite:<6位>` → `teamID:creatorID`，TTL 24h；入组成功后才删码。
- 角色只有 `owner` / `member`，一个团队**恰好一个 owner**。
- 改名按 wee-count「改昵称」的形态：一行文本输入 + 保存，不单独开页面、不二次确认。
- 解散：`UPDATE teams SET deleted_at = NOW()`，**`team_members` 行不删**（留「当时谁在这个家」的记录；可见范围 SQL 已按 `deleted_at IS NULL` 过滤）。团队的菜谱、库存、字典**不删**（成员查不到即可）。客户端 `GET /teams` 不再返回它，本地数据自然从界面上消失（不删本地数据：删数据是另一件需要单独决定的事）。
- 越权一律 403 / 404。

**删除的接口**：`/community/*`、`/favorites/*`、`/follows/*`、`/users/{id}`。

---

## 10. 客户端行为

### 10.1 范围（当前团队）

一个全局状态 `currentTeamId: string | null`（`null` = 我的菜谱），派生出一个范围键：

| 状态 | 范围键 | 显示 |
|---|---|---|
| 有当前团队 | `t:<teamId>` | 该团队的菜谱 / 库存 / 字典 |
| 已登录、无当前团队 | `p:<uid>` | 我的个人菜谱 / 库存 / 字典 |
| 未登录 | `p:local` | 本机未认领的数据 |

- 持久化在 `localStorage["current_team:<uid>"]`，按账号隔离；冷启动恢复上次选中的范围，那个团队已不在缓存里就回落「我的菜谱」。
- **创建 / 加入团队后自动切到那个团队**；退出 / 被移除 / 解散时若正在看它 → 回落「我的菜谱」。
- 切范围时刷新所有受范围影响的 store（菜谱、库存、字典），不重新拉网络。

### 10.2 页面

**底栏**（`App.vue`）：菜谱 / **库存** / AI（条件）/ 我的。

- `/inventory` 变成一级路由（去掉 `hideTab`），页头左侧是范围切换器，右上角加号录批次。

**菜谱页**（`RecipeList.vue`）：删掉四个 tab（全部 / 我的 / 收藏 / 关注）与社区段落；页头加范围切换器 + 保留筛选按钮；空态文案随范围变。

**「我的」页**（`MePage.vue`）：删掉「食材库存」行（已升为底栏标签）；加「我的团队」行（未登录 / 未配服务器时不显示）。

**团队列表页**（`TeamListPage.vue`，`/me/teams`）：我加入的团队（名字、角色、成员数）+ 切到这里；底部「创建团队」「邀请码加入」。

**团队成员页**（`TeamMembersPage.vue`，`/me/teams/:id`）：

- 成员列表：头像 + 昵称 + 角色标签。
- owner 可见：改名（行内输入）、生成邀请码、移除成员、转让 owner、解散（二次确认）。
- member 可见：退出团队（二次确认）。
- 自己那一行不显示「移除」。

**菜谱详情 / 编辑**：删收藏按钮、公开开关、用户页跳转；作者卡片保留；`canEdit` 只看创建者；「制作」按钮不变。

**库存页 / 制作页**：渲染逻辑不变，只把查询范围从「全部本地」改成「当前范围」。

### 10.3 未登录态

- 范围键固定 `p:local`，只能看到未认领的数据。
- **登录成功后的认领**（`src/services/migration.ts`）：把 `scope_id = 'p:local'` 的全部行改写为 `scope_id = 'p:<uid>'`，菜谱 / 批次 / 使用记录的 `owner_id` 补成当前 uid。
  - 字典改写要处理同名合并：目标范围里已有同名的行 → 把引用改指过去、删掉本机这条（复用同步的 remap 逻辑，见 §8.6），否则直接改范围列。
  - 登出后 `p:local` 为空，未登录界面显示空态「登录后查看你的菜谱」——**不删任何数据**，登录回来就全在。
- AI 会话按 `user_id` 过滤（现有行为，未登录产生的会话永不显示），不随团队切换。

---

## 11. 逐块改动

### 11.1 `src/stores/team.ts`（新增）

```ts
export const useTeamStore = defineStore("team", () => {
  const teams: Ref<{ id: string; name: string; role: "owner" | "member"; member_count: number }[]>;
  const currentTeamId: Ref<string | null>;
  const scopeId: Ref<string>;                 // 't:<id>' | 'p:<uid>' | 'p:local'
  function load(): Promise<void>;             // GET /teams → 整表替换本地 teams 缓存
  function switchTo(id: string | null): void; // 持久化 + 刷新菜谱 / 库存 / 字典 store
  function create(name: string): Promise<void>;
  function join(code: string): Promise<void>;
  function rename(id: string, name: string): Promise<void>;
  function members(id: string): Promise<TeamMember[]>;
  function invite(id: string): Promise<string>;
  function removeMember(id: string, userId: string): Promise<void>;
  function leave(id: string): Promise<void>;
  function transfer(id: string, userId: string): Promise<void>;
  function dissolve(id: string): Promise<void>;
});
```

- `create` / `join` 成功后：`load()` → `switchTo(newId)` → `requestSyncNow()`（新团队的范围是空的，拉取走的是同一套增量，`server_seq` 早已推过的行不会再下发——**所以入团 / 建团后要把该范围的本地数据当作「从零开始」**：当前实现只有一个游标，这里靠把游标清 0 实现，见 §11.4）。
- `leave` / `removeMember`(self) / `dissolve`：若当前范围是该团队 → `switchTo(null)`；`load()`。
- 所有写操作成功后都 `load()`。
- 登录 / 恢复会话成功后先 `load()`，再认领，再同步；登出清空 `teams` 表与 `currentTeamId`。

### 11.2 `src/stores/recipe.ts`（改）

- `visibleRecipeFilter()` → `scope_id = ?`（范围值来自 team store）。
- `canEdit`：`owner_id === 我`（未登录时 `owner_id === null`）。
- `create` 写入 `scope_id = 当前范围`、`owner_id = 我`。
- 删掉 `fetchFavorites` / `favorites` / `getDetail` 里社区缓存的可见分支。

### 11.3 `src/stores/inventory.ts`（改）

- `fetchAll` / `addBatch` / `remainingByIngredient` / `commitCook` 全部按当前范围过滤（批次的 SQL 加 `scope_id = ?`）。
- `addBatch` 写 `scope_id = 当前范围`、`owner_id = 我`。
- `commitCook` 写入的使用记录带 `scope_id` = 批次的范围、`owner_id = 我`。
- 写库后 `enqueueSync`：新增 / 软删批次 → 入队该批次；`commitCook` → 入队本次写入的使用记录。

### 11.4 `src/services/sync.ts`（改）

- `SyncPayload` 加 `inventory_batches` / `inventory_usages`；`PENDING_KEYS` 扩成六类。
- `collectPushPayload`：按 §8.5 收集（含两个新数组；字典按范围）。
- `applyRemoteChanges`：加两个分支（批次 LWW + 使用记录 `INSERT OR IGNORE`）；字典 `findDupSql` 加 `scope_id`。
- 删除：`reconcileFavorites`、`registerLocalAccount`、`bumpFavoriteOps` / `favoriteOpsEpoch`、`cacheCommunityChanges`、`deleteCachedOtherRecipes`、`favorite_recipe_ids` 字段。
- 游标推进、退避、按 uid 隔离不变。
- `clearSyncCursorFor(uid)`：清 `last_server_seq:<uid>`（建团 / 入团后调用）。
- **前提**：`SyncPayload` 的每一行都带 `scope_id`，服务端按 §8.2 校验；客户端不做范围合并。

### 11.5 存量数据认领（`src/services/migration.ts`，改）

`claimOrphanRecipes` 扩成 `claimLocalScope`：

- `recipes` / `inventory_batches` / `inventory_usages`：`UPDATE ... SET scope_id = 'p:<uid>', owner_id = <uid> WHERE scope_id = 'p:local'`。
- 字典：逐个找「目标范围已有同名行」，有则按 remap 改指引用并删本机这行，无则改范围列（§8.6 同一套）。
- 判据是「`p:local` 里还有没有行」，幂等。

游客（未登录）录的菜谱与库存都是 `p:local`；不扩认领的话，库存永远停在游客范围，登录后既看不到也同步不上去。

### 11.6 视图与组件

| 文件 | 动作 |
|---|---|
| `views/TeamListPage.vue` / `views/TeamMembersPage.vue` / `components/TeamSwitcher.vue` | 新增 |
| `views/InventoryPage.vue` | 页头换 `TeamSwitcher` + 加号；数据来自带范围过滤的 store |
| `views/RecipeList.vue` | 删 tab 行 / 社区段落 / 收藏逻辑；加 `TeamSwitcher` |
| `views/RecipeDetail.vue` | 删收藏按钮、公开开关、用户页跳转 |
| `views/RecipeEdit.vue` | 删公开开关 |
| `views/MePage.vue` | 删库存行；加「我的团队」行 |
| `components/RecipeCard.vue` | 删收藏星标 / 关注入口；保留作者名 |
| `components/CommunityFeed.vue` / `views/UserPage.vue` / `stores/community.ts` / `services/community.ts` | **删除** |
| `src/stores/refStore.ts`（字典查询） | 按当前范围过滤（含「有引用不许删」的检查：只数同范围的引用） |
| `router/index.ts` | 删 `/user/:id`；`/inventory` 去掉 `hideTab`；加 `/me/teams`、`/me/teams/:id` |
| `App.vue` | 底栏加库存项 |

### 11.7 后端

- **删除**：`internal/model/community.go`、`internal/service/community.go`、`internal/handler/community.go` 及各自测试；社区 / 收藏 / 关注 / 用户页路由；迁移里的 `favorites` / `follows` / `recipes.is_public`。
- **新增**：`internal/model/team.go`、`internal/service/team.go`、`internal/handler/team.go` 及测试；库存合并逻辑（`internal/service/inventory.go` 或并入 `sync.go`，按 builder 判断）。
- **改动**：
  - `service/sync.go`：两个新数组、范围解析（§8.2）、字典合并带范围、`mergeRecipe` 的 `team_id`、`maxServerSeqSQL` 扩到六表、`backfillReferenced` 补批次引用的字典行。
  - `service/files.go` 的 `CanRead`：引用它的菜谱在我可见范围内（个人 ∪ 我的团队）。
  - `handler/sync.go`：去掉 `favorite_recipe_ids`。
  - `cmd/server/router.go` / `main.go`：`/teams*` 路由与装配。
- **不变**：`internal/config`、`internal/database`、`internal/middleware`、`handler/auth.go`、AI 模块、部署文件（`SELF-HOSTING.md` 里社区那段改写）。

---

## 12. 我做的判断（可以推翻，但要知道）

1. **单库 + `scope_id`**（§4 的 A），不按账号 / 团队分库文件。
2. **字典按范围分开**，服务端的同名合并也只在同范围内发生——这是本版新增的硬要求（多家庭共用一台服务器）。
3. **库存团队内全员可写**，包括删别人录的批次：共用冰箱里记错的人常常不在场。
4. **菜谱仍然只有创建者能改**：整条替换的合并策略以「只有作者能改」为前提，放开要先改协议。
5. **库存不改余量建模**：余量仍派生（批次 − 使用记录），服务端不存「余量」列。
6. **并发扣减不解决**（§8.7），显示按 0 兜底。
7. **团队列表只走 REST、不进同步载荷**，本地 `teams` 表是缓存。
8. **一个团队恰好一个 owner**；owner 退出前必须转让或解散（服务端拒绝 + 客户端引导），不做「自动转让给最早加入的成员」。
9. **解散不删菜谱 / 库存 / 字典**，只软删团队行；本地团队数据也留着（界面上看不到）。
10. **建团 / 入团后清游标全量重拉**：只有一个全局游标，新入的团队里那些 `server_seq` 早于游标的行否则永远拉不下来（旧团队设计踩过的坑）。
11. **未登录单独一个范围 `p:local`**，登录后整批认领；登出后未登录界面为空态——不删数据。
12. **不做成员别名**（wee-count 有，但那是每个人的私有视图）。
13. **库存页不显示录入者**：多人共用的账，谁录的不重要，省一次成员查询与一列昵称缓存。
14. **存量开发库直接删掉重来**：尚未实机验证，没有需要迁移的发布数据。

---

## 13. 需要你点头的例外（`AGENTS.md` 的「每张业务表带 id / updated_at / deleted_at」）

**服务端的 `team_members` 不带 `id` / `updated_at` / `deleted_at`。** 它是关系表（`PRIMARY KEY (team_id, user_id)`）：退组 / 移除就是删行，角色变更是一次 UPDATE，没有 LWW 与墓碑的用武之地。与已经确认过的 `favorites` / `follows` 是同一条推理。

**本地的 `teams` 表同样不带 `updated_at` / `deleted_at`。** 它不是业务实体，是「我加入的团队」这份服务端状态的缓存：登录整表替换、登出清空。

**本地的 `inventory_usages` 只加 `scope_id` / `owner_id`，不加 `created_at`。** `used_at` 就是它的发生时间。

（本地的五张范围表 + 服务端的两张库存表都是正经业务表，`id` / `updated_at` / `deleted_at` 齐全。）

---

## 14. 现有测试的处置

**需要人工确认（与 `AGENTS.md`「不可删改已有测试」冲突）**：社区相关功能的实现与测试整块删除，因为功能本身被本版删除。逐项：

| 文件 | 处置 |
|---|---|
| `components/__tests__/CommunityFeed.test.ts`、`views/__tests__/UserPage.test.ts` | 删除（功能删除） |
| `stores/__tests__/community.test.ts`、`services/__tests__/community.test.ts` | 删除（功能删除） |
| `services/__tests__/syncReconcile.test.ts` | 删除（收藏对账功能删除） |
| `stores/__tests__/recipeVisibility.test.ts` | 改写：可见范围换成范围键，删收藏 / 公开缓存断言 |
| `views/__tests__/RecipeList.test.ts` | 改写：删四个 tab / 收藏 / 社区段落用例，加范围切换用例 |
| `views/__tests__/RecipeDetail.test.ts`、`RecipeEdit.test.ts` | 删收藏 / 公开开关用例；保留编辑、删除、指导模式、制作按钮 |
| `components/__tests__/RecipeCard.test.ts` | 删收藏星标 / 关注断言 |
| `db/__tests__/schema.test.ts`、`migrate.test.ts` | 删 `favorite_recipes` / `local_accounts` / `is_public` 断言，加 `scope_id` 与新的唯一索引断言 |
| `services/__tests__/syncMerge.test.ts` | 删 `is_public` 断言，加范围隔离与「字典同名不跨范围合并」断言 |
| `stores/__tests__/refStore.test.ts` | 加「字典按范围过滤 / 只数同范围引用」用例 |
| `router/__tests__/routes.test.ts` | 删 `/user/:id`，加团队两条路由；`/inventory` 不再 `hideTab` |
| `views/__tests__/MePage.test.ts` | 删库存行断言，加团队行断言 |
| 后端 `community_test.go` / `handler/community_test.go`、`files_test.go` 的公开图用例、`sync*_test.go` 的收藏 / 公开用例 | 删除或改写成本版范围 |

其余（库存相关的全部测试、`CookPage`、`BatchSheet`、`RefSheet` 等）**不做任何放宽**；库存 store 的用例改成「按范围查询」时，原有断言保留，只补范围维度。

**新增测试**：

- 后端：团队 service 全套 + 越权；库存合并（LWW、软删墓碑、非成员写入被跳过、使用记录幂等且允许指向已软删批次、范围不可变）；范围隔离（个人字典不出现在团队、两个团队同名食材不合并、已解散团队的团队行不再下发）；游标含新表；`backfillReferenced` 补批次引用的字典。
- 前端：范围切换（列表 / 库存 / 字典 / 创建归属）；`canEdit` 按创建者；库存 store 范围过滤；同步载荷与 `applyRemoteChanges`（批次 LWW、使用记录 OR IGNORE、字典去重带范围、remap 重指批次）；认领把 `p:local` 全部改写并处理字典同名合并；建团 / 入团清游标；登录先刷团队缓存再同步、登出清空缓存；团队页 owner/member 按钮可见性。

---

## 15. 验证

```bash
npm run test
npm run build
cargo check
cd backend && go test ./...
```

**手动端到端**（A / B 两个账号打同一台 `docker compose up` 的服务，A 建两个团队分别代表自己家与爸妈家）：

1. A 建「自己家」→ 邀请码 → B 加入 → B 的切换器里出现它。
2. A 在「自己家」录一道菜、录一批五花肉 → B 切到「自己家」都看得到；B 切回「我的菜谱」看不到。
3. B 做这道菜确认制作 → A 下次同步后余量变少。
4. A 在「爸妈家」录一个食材「生抽」→ 切到「自己家」，食材选择里没有它；「自己家」也录一个「生抽」，两条互不影响（不合并）。
5. B 试图改 A 创建的菜谱：没有编辑按钮；直接进编辑路由也被拦。
6. A 改名 → B 的切换器名字跟着变；A 移除 B → B 的该团队消失并回落到「我的菜谱」。
7. 后加入的人能看到存量数据（§12.10 的回归网）：A 先录 5 道 → B 入团 → 5 道都在。
8. 游客录一道菜 + 一批库存 → 登录 → 两者都还在并开始同步；登出 → 界面空态；再登录 → 都在。
9. 同一台手机 A 登出、B 登录：B 看不到 A 的任何菜谱 / 库存 / 食材。
10. Android 真机跑一遍底栏四个标签与切换器。

---

## 16. 留给 builder 的

- 团队页的布局细节、邀请码复制交互、解散 / 退出确认文案。
- 范围切换器的形态（下拉 sheet 还是行内分段控件）。
- 服务端团队接口的错误码与文案（重名、码失效、不能移除自己、owner 不能直接退）。
- 库存合并逻辑放 `sync.go` 还是独立文件。
- 迁移文件切分（本版仍是单文件原地改写）。
- `docs/开发者-同步与社区.md` 改名与改写（社区段落 → 团队段落）。
- 团队接口的集成测试是否起真 Postgres（沿用 `sync_integration_test.go` 的形状）。
