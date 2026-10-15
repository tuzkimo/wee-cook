# 一起做饭 · 社区共享 设计

2026-10-15 · 状态：待确认
**取代** `2026-10-14-sync-team-design.md`：团队 / 成员 / 邀请码 / 菜谱本那部分作废并从代码里删掉；同步协议、图片通道、存量认领、全扫推送、触发时机那几节继续有效，本文件只写变化。

---

## 1. 要解决什么

上一版把「共享」建模成**团队**：创建团队、6 位邀请码、成员列表、多个菜谱本之间切换。代码写完了，但回头看不值这个价钱——真实需求只有两条：

1. **跨设备同步**——换手机不丢，家里两个人的手机各自录的菜能对上；
2. **让同一台服务器上的人看到我愿意公开的菜**。

团队多出来的概念（团队、成员、角色、邀请码、菜谱本、加入后必须清游标全量重拉）没有需求支撑，而且为了让人「能选一个菜谱本」还引入了一整套归属过滤 UI。

本版把它换成一句话：**一个服务器 = 一个社区。** 填服务器地址 + 注册账号就是加入它。

---

## 2. 目标 / 非目标 / 反目标

**目标**

- **不登录时的行为与现在完全一致**：不出登录墙、不发任何网络请求、功能不缺。
- **登录后我的菜谱跨设备同步，默认私有**：`is_public = 0` 时只有自己看得见，与今天相同。
- **一条菜谱可以标记公开**。公开后，同一台服务器上所有登录用户都能看到它。
- **别人的公开菜谱在线浏览**：列表、详情、图片，不占本机长期存储。
- **可以收藏一条公开菜谱**。收藏的菜谱落到本机，离线也能看。
- **可以关注一个用户**。关注只影响社区列表的筛选（只看我关注的人）。
- **只有作者能改、能删**自己的菜谱（已实现，保留）。
- **离线优先不被破坏**：任何操作都不等网络；我的菜谱页与网络状态无关。

**非目标（本版明确不做）**

- 团队、邀请码、成员列表、菜谱本切换（本版**删除**已有的实现）。
- 评论、点赞、通知、粉丝数、关注者 / 关注列表页、动态流。
- 社区搜索（只有「全部公开」与「只看我关注的」两个视图 + 翻页）。
- 公开菜谱的协作编辑。
- 图片垃圾回收（浏览缓存与孤儿图都留在磁盘上）。
- 端到端加密：服务器以明文保存菜谱（自托管，服务端属可信域）。
- 冲突的细粒度合并：LWW 输掉的那次修改无声丢弃，不提示、不保留历史。
- 同步历史 / 撤销 / 回收站。
- 多服务器切换（换服务器 = 换账号）。

**反目标（做出来了也算失败）**

- 没登录的人被任何同步逻辑挡住，或本地功能被网络状态影响。
- **社区接口挂了导致菜谱页空着或转圈**——我的菜谱必须与网络无关地显示（见 §9.1）。
- 浏览过的公开菜谱混进「我的菜谱」，或分不清哪条是谁的。
- **切换账号后，本机上另一个账号的菜谱被清掉**（见 §7.2 的对账规则）。
- 同步失败时静默丢掉本地改动，或把本地数据覆盖成空的。
- 「只有作者能改删」只靠 UI 拦住（服务端不校验），或只靠服务端拒绝（导致本机出现永远同步不上去的改动）。
- 为了这版改动把已完成的 CRUD / 筛选 / 同步协议重写。

---

## 3. 约束

- 来自 `AGENTS.md` 的全部约束不变：Vue 3 + TS 严格模式（**禁止 `any`**）、Tauri 2、测试优先、食材必须引用结构化数据、每张业务表带 `id` / `updated_at` / `deleted_at`（例外见 §12）、README 只写用户内容。
- 后端技术栈与同步协议照旧（Go + chi + pgx + PostgreSQL 16 + Redis 7 + JWT；全局 `server_seq` + 游标 + LWW + 软删墓碑 + advisory lock）。
- **本版不新增任何依赖**（客户端与后端都不加库）。
- 布尔值端到端用 `0` / `1` 整数：SQLite `INTEGER`、PostgreSQL `SMALLINT`、Go `int16`、JSON number、TS `number`。理由是客户端与协议零转换、TS 里不需要 `boolean ↔ number` 的胶水（`is_public` 只在 SQL 与 JSON 之间流动，从不出现在需要 `true/false` 的 JS 分支里）。

---

## 4. 总体形状

- **后端仍是可选组件**：不配地址、不登录时，App 行为与今天完全一致。
- **我的菜谱仍以本地 SQLite 为真相源**；服务器只做「收增量 / 发增量 / 存图片」。
- **别人的公开菜谱以服务器为准**：那是别人的东西，本机存一份缓存而已，随时可以被丢掉重取。
- **没有实时推送**：启动、写操作后 3 秒防抖、开同步一次，沿用现有触发时机。
- **单库 + 过滤**（不按账号分库），沿用。
- **不做搜索/推荐/热门**：社区列表就是「公开菜谱按 `updated_at` 倒序」。

---

## 5. 权限模型

| 对象 | 谁看得见 | 谁能改 / 删 |
|---|---|---|
| 我的私有菜谱（`is_public = 0`） | 只有我（含我的其他设备） | 只有我 |
| 我的公开菜谱（`is_public = 1`） | 我 + 同服务器所有登录用户 | 只有我 |
| 别人公开的菜谱 | 所有登录用户（在线看；收藏后落本机离线看） | 只有作者 |
| 我收藏的菜谱 | 只有我（本机一份只读副本） | 只有作者 |
| 字典（食材 / 单位 / 分类 / 标签） | 服务器上所有登录用户共享一份 | 任何登录用户（LWW 决定结果） |
| 图片 | 引用它的菜谱我可见（我的 / 我收藏的 / 公开的） | 只有上传者（只增不改） |

落到实现上的硬规则：

1. **服务端是权限的唯一裁决者**：`owner_id` 一律取当前登录用户，客户端传来的值丢弃；社区接口只返回 `is_public = 1 AND deleted_at IS NULL` 的菜谱；图片下载除了「我可见的菜谱引用它」之外，加一条「公开菜谱引用它」。
2. **客户端不出现编辑入口**：别人的菜谱详情页没有编辑 / 删除按钮（现有的 `canEdit` 已经这么做，不用改）。这是**必须**的：本地若出现改别人菜谱的改动，服务端会跳过它、本地 `updated_at` 反而更新、这条改动永远同步不上去，两边永久分叉。
3. **字典的越权不在范围内**：同一台服务器上的登录用户可以改别人建的食材名（自托管场景，服务器属可信域）。

---

## 6. 数据模型

### 6.1 本地 SQLite（`src/db/index.ts`）

```sql
-- 迁移直接改写，不叠新文件：本版尚未实机验证，没有需要兼容的存量库（见 §11.10）
ALTER TABLE recipes ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;  -- 0 = 私有
ALTER TABLE recipes ADD COLUMN owner_nickname TEXT;                   -- 作者昵称的本地副本，供离线显示（§11.11）
-- 废弃：team_id 列不再创建（上一版的迁移里它只存在于未发布的代码）

-- 我当前有效的收藏（服务端每次同步全量下发，整表替换）
CREATE TABLE IF NOT EXISTS favorite_recipes (
  recipe_id TEXT PRIMARY KEY
);

-- 本机登录过的账号。**清理社区缓存时靠它保护「本机上另一个账号自己的菜谱」**（§7.2）
CREATE TABLE IF NOT EXISTS local_accounts (
  user_id TEXT PRIMARY KEY
);
```

`uploaded_files`、字典表、子表的列与索引全部不动。

### 6.2 服务器 PostgreSQL（改写 `001_init.up.sql`）

```sql
-- 删除：teams、team_members 两张表与 idx_team_members_user

ALTER TABLE recipes ... -- 建表时直接写 is_public：
--   team_id UUID REFERENCES teams(id)  →  is_public SMALLINT NOT NULL DEFAULT 0

-- 新增两表。收藏是「我订了一条别人的菜谱」，关注是「我订了一个人」，
-- 都是只由本人改写的订阅关系，不是业务实体（见 §12）
favorites (
  user_id   UUID NOT NULL REFERENCES users(id),
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, recipe_id)
);
follows (
  follower_id UUID NOT NULL REFERENCES users(id),
  followee_id UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id)
);
```

索引：`recipes(server_seq)` 等照旧（去掉 `idx_recipes_team`）；新增 `favorites(recipe_id)`（图片读权限与「作者取消公开」的排查都要按菜谱反查）、`follows(follower_id)`（主键已够用，不额外建）。

菜谱子表、字典表、`files` 表全部不动。

---

## 7. 同步协议（改动点）

协议形状、`server_seq` / 游标 / LWW / advisory lock / 子表整条替换 / 字典同名合并 / 父行补齐，**全部沿用上一版**。只有三处变化：

### 7.1 载荷字段

- `recipes[]` 里 `team_id` → `is_public`（0/1）。普通字段，随便哪次写入都可以变。
- `recipes[]` 新增 `owner_nickname`（服务端 JOIN `users` 取 `nickname`），客户端落到本地那一列。
- 响应新增 `favorite_recipe_ids: string[]`：**我当前有效的收藏**（`favorites` JOIN `recipes`，只含作者仍公开、未删除的）。
- 推送方向不受影响：仍然只推 `owner_id = 我` 的全部菜谱（含墓碑）+ 全部字典行。

### 7.2 客户端对账（本版唯一的同步逻辑新增）

同步成功后按顺序做三件事：

1. **整表替换收藏集合**：`DELETE FROM favorite_recipes` → 按 `favorite_recipe_ids` 逐条插入。
2. **清掉别人的菜谱副本**：

   ```sql
   DELETE FROM recipes
   WHERE owner_id IS NOT NULL
     AND owner_id <> $me
     AND owner_id NOT IN (SELECT user_id FROM local_accounts)
     AND id NOT IN (SELECT recipe_id FROM favorite_recipes)
   ```

   （连同它的子行一起删。）
3. 游标照旧推进。

这一条规则同时解决四件事：**取消收藏**、**作者取消公开**、**作者删除**、**换账号后上个账号浏览过的社区缓存**。收藏关系本身在服务端不受影响——作者重新公开，`favorite_recipe_ids` 里又会包含它，菜谱自动回到她本机。

**为什么必须加 `local_accounts` 这一层**：本机可能住着不止一个账号的数据（同一台手机换人登录）。只看 `owner_id <> 我` 就清理，A 登录同步一次会把 B 留在本机的菜谱全删掉，而 B 的游标早已推过那些行的 `server_seq`，重新登录也拉不回来——静默丢数据。`local_accounts`（登录成功 / 冷启动恢复会话成功时写入）把「本机用过的那几个账号」白名单化：凡是我本机账号自己的数据一律不碰，删的只能是「本机谁都不要、只因为浏览或收藏才存在」的别人的副本。

**未登录时也不**显示**这批缓存**（§9.1，只过滤，不删），否则登出后别人的公开菜会混进「我的菜谱」。

**收藏对账要有一次「操作版本」保护**：收藏 / 取消收藏成功时递增一个本地计数；同步响应回来时若计数已经变了，跳过本轮的收藏对账与清理，只落远端菜谱变更，并补跑一次同步（`performSync` 现成的 `syncQueued` 机制）。否则一次「响应快照早于收藏 POST」的在途同步会把刚收藏的 id 和刚落本的菜谱一起抹掉——下一轮同步会补回来，但用户会看到收藏闪一下消失。

### 7.3 可见范围（服务端 SQL）

```sql
-- 原来的「我的私人 ∪ 我的团队」换成「我的 ∪ 我收藏的」，且后者**必须同时筛 is_public 与 deleted_at**
recipes: owner_id = $me
      OR id IN (SELECT f.recipe_id FROM favorites f
                JOIN recipes r ON r.id = f.recipe_id
                WHERE f.user_id = $me AND r.is_public = 1 AND r.deleted_at IS NULL)
```

收藏行在作者取消公开后仍然保留（§11.4），所以**收藏分支不能只查 `favorites`**——不筛 `is_public` 就会在作者取消公开后继续把正文和后续编辑下发给收藏者，那是隐私泄漏。这一条要有专门的测试（§13）。

被作者取消公开的菜谱自然落在这个范围之外，客户端靠 §7.2 的清理与它告别——**不需要「你不再可见」的墓碑机制**。这是本版能这么小的关键：拉取过滤只能告诉你「有什么」，而全量的 `favorite_recipe_ids` 负责告诉你「没什么了」。

同理，`favorite_recipe_ids` 也必须 JOIN `recipes` 筛 `is_public = 1 AND deleted_at IS NULL`，否则它会说「你还收藏着一条已经私有的菜」。

### 7.4 删掉的规矩与补上的规矩

「加入团队后把游标清 0 再全量重拉」整条删除（没有团队了）。

**新增一条**：收藏一条菜谱后，那条菜谱的 `server_seq` 可能早于我本机（以及我其他设备）的游标，靠增量永远拉不下来。解法不是在客户端补拉，而是**服务端在写 `favorites` 的同一个事务里把该菜谱的 `server_seq` 推进到最新**，客户端收藏 / 取消收藏成功后再 `enqueueSync()` 触发一次同步——正文与图片就沿着现有的拉取与下载通道自己下来，第二台设备也自动拿到。

- 这是对 `server_seq` 语义的一次扩张：它不再只表示「内容变了」，也表示「这条菜谱对某些客户端的可见性 / 订阅状态变了」。代码里要写一行注释。
- 代价是别的可见用户可能多收到一次内容没变的菜谱（LWW 幂等，无副作用）。
- 取消收藏不需要推进 `server_seq`（菜谱离开我的可见范围，正文不会再下发），本地靠 §7.2 的清理消失；但同样要 `enqueueSync()` 一次让清理尽快发生。

---

## 8. 社区接口（新增）

```
GET    /api/v1/community/recipes?limit=&offset=&author_id=&followed_only=
         → { items: [ { id, name, cover_path, author_id, author_nickname, updated_at, favorited } ], has_more }
           只返回别人（owner_id <> 我）的公开菜谱：我自己的公开菜谱出现在「我的」段落里，
           再进一次社区列表就是同一个东西看两遍
GET    /api/v1/community/recipes/{id}
         → 与 /sync 里的 recipe payload 同形状（含 owner_id、steps、ingredients、label_ids）
           + 它引用的字典行（复用 sync 的 backfillReferenced），供客户端直接落库
GET    /api/v1/users/{id}                  → { id, nickname, avatar_url, followed, public_count }
POST   /api/v1/favorites/{recipe_id}       → 收藏（幂等；菜谱不存在、不公开、已删 → 404）
                                            同一个事务里推进该菜谱的 server_seq（§7.4）
DELETE /api/v1/favorites/{recipe_id}       → 取消收藏（幂等）
POST   /api/v1/follows/{user_id}           → 关注（幂等；不能关注自己 → 400）
DELETE /api/v1/follows/{user_id}
```

删除的接口：`GET/POST /teams`、`POST /teams/{id}/invite`、`GET /teams/{id}/members`、`POST /teams/join`。

**收藏与关注只走 REST，不进同步队列**：两者都只可能发生在「我正在看点东西」的时候，而浏览本来就是在线动作，直接调一次 API 即可；离线时按钮不可用（灰着），不做离线暂存。这样同步协议里不出现「收藏操作队列」这种新东西，`favorite_recipe_ids` 是只读下发。

**图片读权限**（`service/files.go`）扩展一条：引用它的菜谱我可见，或者那条菜谱是公开的、未删除的。

---

## 9. 客户端行为

### 9.1 菜谱页

顶部一行筛选，四个：**全部**（默认）· 我的 · 收藏 · 关注。

- **我的**：本地查询（`owner_id = 我`）。未登录时是「本机自己的」：`owner_id IS NULL OR owner_id IN local_accounts`——不再无条件不过滤，否则登出后别人的公开菜缓存会混进菜谱页（§7.2）。
- **收藏**：本地查询，`id IN (SELECT recipe_id FROM favorite_recipes)`。
- **全部**：**两个段落，不合并排序**——上段「我的菜谱」（本地，随时可用），下段「社区」（API 分页，滚到底加载更多），各自带小标题、各自有自己的加载 / 失败状态。
- **关注**：只显示社区段落，加 `followed_only=1`。

两段而不是一个合并列表，是为了让**社区接口挂掉时菜谱页照样能用**（反目标第 2 条）：社区段落显示「加载失败 · 重试」，我的菜谱不受影响。同理，分页也不用跟本地数据混排。

### 9.2 公开开关

- 菜谱编辑页：一个「公开到社区」开关，默认关，随保存一起提交。
- 我的菜谱详情页：一个快捷开关（这是本版最常被点的动作之一）。
- **取消公开不弹二次确认**：它虽然会让别人的本机副本消失，但收藏关系不清（§7.2），重新公开后自动回到对方手上，是可撤销的动作，不值得一次打断。

### 9.3 收藏与关注

- 别人的公开菜谱详情页（`canEdit` 已经是 false，没有编辑 / 删除按钮）：一个「收藏」按钮；作者昵称可点，进用户页（ta 的公开菜谱 + 关注 / 取消关注按钮）。
- 社区列表里每条也可直接点收藏。
- 收藏成功后**触发一次同步**（`enqueueSync()`）；正文与图片沿现有拉取 / 下载通道自己下来（§7.4），不需要客户端补拉。
- 离线时这两个按钮不可用。

### 9.4 其他

- 存量数据认领、会话恢复后的全扫推送、3 秒防抖、指数退避、按 uid 隔离的队列与游标：全部沿用上一版，不改。
- 未登录：一切与今天相同（不发请求、不过滤、可改无主菜谱）。

---

## 10. 后端

**删除**：`internal/model/team.go`、`internal/service/team.go`、`internal/handler/team.go` 及各自测试；`service/authz.go` 里的 `canReadTeam` / `myTeamIDs`（换成收藏相关的可见范围查询）；router 里的 `/teams*` 与 join 限流组；迁移里的 teams / team_members。

**新增**：`internal/model/community.go`、`internal/service/community.go`、`internal/handler/community.go`（列表 / 详情 / 收藏 / 关注 / 用户页，一个文件放得下）；迁移里的 `favorites`、`follows`、`recipes.is_public`。

**改动**：`service/sync.go` 的 `recipesVisibleScope` 与 payload 字段；`service/files.go` 的读权限；`handler/sync.go` 组装 `favorite_recipe_ids`；`cmd/server/router.go` 路由表。

`internal/config`、`database`、`middleware`、`handler/auth.go`、部署文件（Dockerfile / compose.yml / SELF-HOSTING.md）不动——自托管文档里提到团队的那一段要删。

---

## 11. 我替你做的决定（请过一眼）

1. **浏览过的公开菜谱落本地、并在下次同步时清理**，而不是做一个独立的「在线详情」视图。理由：详情页、图片显示、字典解析三条路都能直接复用现有代码（图片接口要带 `Authorization`，`<img>` 发不了这个头，所以远端图本来就得先落到 `$APPDATA/images/`）。代价是**浏览过的菜谱与图片会在本机留缓存到下次同步**，图片不回收（与本版「不做图片 GC」一致）。
2. **对账清理靠 `local_accounts` 白名单兜底**，而不是「按 `owner_id ≠ 我` 一刀切」，也不用额外的 `browsed` 标记行（§7.2 的多账号陷阱）。
3. **收藏 / 关注只走 REST、离线不可用**，不进同步队列（§8）。
4. **取消收藏或作者取消公开后，收藏关系保留在服务端**：作者重新公开，菜谱自动回到收藏者本机。
5. **社区列表不做搜索**，只按 `updated_at` 倒序 + 翻页 + 「只看我关注的」。
6. **不做粉丝数 / 通知 / 关注者列表**：关注是单向订阅，不产生任何回执。
7. **「我的」与「社区」在菜谱页分两段**，不合并排序（§9.1）。
8. **JSON 与数据库两端用 0/1 表示公开**（§3）。
9. **`is_public` 不进编辑页以外的界面文案**；「社区」「公开」两个词在 UI 上统一（写文案时照此）。
10. **迁移文件直接改写，不叠新的迁移**。本版尚未实机验证，后端若已在本地跑过一次 `docker compose up`，需要删掉本地开发库重来（开发数据可弃）。
11. **收藏时服务端推进该菜谱的 `server_seq`**，客户端不写补拉逻辑（§7.4）。
12. **本地 `recipes.owner_nickname` 列**存作者昵称（不做本地 `users` 缓存表）：收藏的菜谱离线时也显示得出作者名（用户页本身要在线）。昵称改了会陈旧到下一次拉取。
13. **社区列表不带社交信息以外的装饰**：已收藏的条目标一个星，不显示收藏数 / 粉丝数（决定 6）。

---

## 12. 需要你点头的例外（`AGENTS.md` 的「每张业务表带 id / updated_at / deleted_at」）

**服务端 `favorites` / `follows` 与本地 `favorite_recipes` 不带 `id`、`updated_at`、`deleted_at`。**

它们不是业务实体，而是「一方的订阅关系」：只由本人改写，服务端每次同步**全量下发**、客户端**整表替换**，取消订阅就是删掉一行。软删与 LWW 在这里都用不上——加两列永远是 NULL 的时间戳，是为了满足形式而加的形式。这与已经确认过的「服务端三张子表不带 `deleted_at`」是同一条推理。

本地 `local_accounts` 是同一条推理的另一例：它是本机的设备状态，不是业务表。

（`recipes.is_public` 是一列，不是新表，不受这条影响。）

---

## 13. 验证

**后端**：`go test ./...`

- 删掉团队相关的全部测试；新增收藏 / 关注 / 社区列表 / 用户页的 service 与 handler 测试。
- 必须有越权的用例：私有菜谱不出现在社区列表；别人未公开的菜谱调详情返回 404；不能关注自己；未登录调社区接口 401。
- 真库集成测试补三条：**取消公开后，收藏者的 `favorite_recipe_ids` 里不再有它**；**同一次同步里这条菜谱的正文与子行也不在下发的 `remote_changes` 里**（隐私泄漏的回归网）；**重新公开后又回来**。
- 收藏要把菜谱的 `server_seq` 推到最新：收藏后一个游标已经推过该菜谱旧 `server_seq` 的客户端，下一次同步必须能拉到它。
- 图片读权限：公开菜谱引用的图，非作者也能下载；私有且我未收藏的菜谱引用的图返回 403（或 404，与现有实现保持一致）。

**前端**：`npm run test`（vitest）

- 覆盖：`is_public` 与 `owner_nickname` 在载荷里的往返；对账清理（不在 `local_accounts` 里、又未被收藏的别人的行被删；**`local_accounts` 里另一个账号自己的菜谱行不被删**——多账号回归网）；`favorite_recipes` 整表替换；收藏操作版本保护（在途同步的旧快照不覆盖刚收藏的 id）；列表可见范围（我的 / 收藏 / 未登录三态，未登录不显示别人的缓存行）；`canEdit` 对社区缓存行返回 false。
- 删掉团队 store / 菜谱本切换的测试。

**手动端到端**（两个账号 A / B 打同一台 `docker compose up` 的服务）：

1. A 录一道菜，默认私有 → B 的社区里看不到它；
2. A 把它公开 → B 的社区里出现，能点进详情、能看图；
3. B 收藏它 → 断网后 B 仍能看到它；
4. B 取消收藏 → 下次同步后本地消失；
5. A 取消公开 → B 同步后本地消失；A 再公开 → B 那边又回来（收藏关系还在）；
6. B 收藏一条菜谱后，在 B 的第二台设备（或清库重装）上必须能看到它；
7. C 账号在 B 之后登录同一台手机：C 同步后，B 留在本机的菜谱**一条都没少**。

**Android 真机跑一遍**（CORS 与明文 HTTP 在真机上的表现与桌面 dev 不同）。

每个 Phase 结束跑一次全量：`npm run test` + `npm run build` + `cargo check` + `go test ./...`。

---

## 14. 留给 builder 的

- 社区列表 / 用户页的布局与分页大小（下拉一页多少条）、空状态文案。
- 收藏 / 关注按钮的交互与失败提示；「公开」开关在详情页的位置。
- 社区段落的加载 / 失败 / 重试呈现方式。
- 错误码与文案（收藏失败、关注自己、菜谱已不可见）。
- 重写 `001_init.up.sql` 时表与索引的写法、以及 `favorites(recipe_id)` 索引的取舍。
- `docs/开发者-同步与团队.md` 与 `docs/SELF-HOSTING.md` 里团队段落的删改措辞（文件名里的「团队」二字也要改）。
- 收藏 / 取消收藏成功后递增的那个本地计数的存放位置（内存即可，不需要跨启动）。

---

## 15. 被取代的文档

- `2026-10-14-sync-team-design.md`：§5 权限模型、§6 数据模型的 teams / team_members / `team_id`、§9.1 菜谱本、§9.4 加入团队清游标、§10.2 的 `/teams*` 接口——作废；其余各节继续有效。
- `2026-10-14-sync-client.md` / `2026-10-14-sync-backend.md`：Task 3（团队）与客户端「菜谱本切换、归属过滤」部分作废，其余照旧。两份计划保持原样作为执行记录，只加一行取代说明。
