# 一起做饭 · 多设备同步与团队共享 设计

2026-10-14 · 状态：待确认

---

## 1. 要解决什么

**真实场景**：家里两个人的手机各有一本菜谱。A 录了一道菜，B 打开 App 看不到；B 想照着做还得让 A 截图发过来。换新手机或重装 App，录过的菜谱全没了（现在只有手动导出的备份兜底）。

**所以这个 App 需要两件互相独立的事**：

1. **同步**——同一本菜谱跨设备对上，换手机不丢；
2. **团队（家庭）**——几个人共用一本菜谱，谁都能看、都能跟着做，但只有录的人能改能删。

**成功的样子**：A 在厨房录完一道菜，B 在自己手机上打开就看到，能跟着做；B 想改一下盐量，发现改不了（界面上根本没有编辑按钮，不是灰着）；两个人都断网也照常录、照常看，联网后自动对上，不需要点「同步」按钮。

**为什么是现在**：菜谱 CRUD 与筛选已完成（`2026-10-13-recipe-crud`、`2026-10-14-recipe-filter`），还没有任何后端。同步要求给业务表加 `owner_id` / `team_id` 并统一 `updated_at` / `deleted_at` 的语义，越晚做、存量数据的迁移面越大。

---

## 2. 目标 / 非目标 / 反目标

**目标**

- **不登录时的行为与现在完全一致**：不出登录墙、不发任何网络请求、功能不缺。
- **登录后私人菜谱跨设备同步**：`team_id` 为空的菜谱只属于自己，换手机能全部拿回来。
- **封面图与步骤图一起同步**：不只同步文字。
- **团队**：创建团队、6 位邀请码加入、看成员列表；团队菜谱全员可见。
- **只有创建者能改、能删**自己的菜谱（私人菜谱同理：只有自己能动）。
- **一个人可以属于多个团队**，界面能在「我的菜谱」和各个家庭之间切换。
- **离线优先不被破坏**：任何操作都不等网络；同步失败不阻塞使用、不丢改动、不改坏本地数据。

**非目标（本轮明确不做）**

- 团队改名 / 解散 / 退出 / 移除成员 / 转让所有权。
- 把菜谱从私人搬进团队、或从团队搬回私人（改 `team_id` 的界面）。
- 协作编辑（多人改同一条菜谱）、评论、一起做。
- 图片垃圾回收（删了菜谱，服务器上的图留着）。
- 食材别名归一（「五花肉」/「三层肉」），只保留**同名即同一条**的去重。
- AI 截图收录（另起一轮，复用本轮的 `/files` 通道）。
- 端到端加密：服务器以明文保存菜谱（自托管，服务端属可信域）。
- 冲突的细粒度合并：LWW 输掉的那次修改无声丢弃，不提示、不保留历史。
- 同步历史 / 撤销 / 回收站。

**反目标（做出来了也算失败）**

- 没登录的人被任何同步逻辑挡住，或本地功能被网络状态影响。
- 同步失败时静默丢掉本地改动，或把本地数据覆盖成空的。
- 「只有创建者能改」只靠 UI 拦住（服务端不校验），或只靠服务端拒绝（导致本机出现永远同步不上去的改动，两边永久分叉）。
- 为了同步把已完成的 CRUD / 筛选全部重写。
- 一次修改菜谱要等几百毫秒「保存中」，或列表滑动因为同步变卡。

---

## 3. 约束（既定）

来自 `AGENTS.md`：

- Vue 3 + TypeScript + Vite；Tauri 2；正式平台 Android。
- TS 严格模式，**禁止 `any`**；测试优先，不可删改已有测试。
- **每张业务表带 `id`、`updated_at`、`deleted_at`**（`deleted_at TEXT`，软删时间戳，NULL = 未删除）。**不用** wee-count 的 `is_deleted`；协议字段同样用 `deleted_at`，不引入第二套表示。
- 食材必须引用结构化数据：菜谱只存 `ingredient_id` + 用量 + `unit_id`。
- 开发者文档放 `docs/`，不往 README 塞。

来自 wee-count（**结构照抄，不重新发明**）：

- 后端：Go 1.25 + chi + pgx + PostgreSQL 16 + Redis 7 + JWT；Docker Compose 自托管（1C1G 起步）；数据库迁移随 API 启动自动执行。
- 同步协议：全局单调 `server_seq` + 客户端 `last_server_seq` 游标 + LWW（`updated_at` 新的赢）+ 软删墓碑 + 写事务全局 advisory lock 串行化 + `backfillReferenced` 补齐父行。
- 客户端：`api.ts`（baseUrl / 15s 超时 / 401→refresh 单飞）、`tokenStorage.ts`、`settingsFile.ts`、`stores/auth.ts`、`services/sync.ts`（待推送队列按 uid 隔离并持久化、游标按 uid 隔离、3s 防抖、指数退避重试）、`services/migration.ts`（首次全量上传）、`toIsoTimestamp` / `compareTimestamp`。

**新增依赖**：`@tauri-apps/plugin-store`（前端）+ `tauri-plugin-store = "2"`（Rust）+ capabilities 里的 `store:default`（存 refresh token 与服务器地址；wee-cook 目前没有任何设置持久化层）。

**不动的**：现有七张表的名字与列名、现有的唯一索引、现有的 CRUD 与筛选行为。

---

## 4. 总体形状

- **后端是可选组件**：不部署、不登录时，App 行为与今天完全一致（`hasBaseUrl() === false` 时 `enqueueSync` 直接返回）。
- **服务器不是真相源**：它只做「收增量 / 发增量 / 存图片」，唯一真相源始终是各设备的本地 SQLite。没有服务器时 App 完整可用。
- **没有实时推送**：客户端在启动、写操作后 3 秒防抖、手动下拉时各同步一次。不做 WebSocket / 长连接。
- **不做「双库」**：wee-count 按服务端用户分不同的 SQLite 文件（`{userId}.db`）。wee-cook 沿用**单库 + `owner_id` 过滤**，理由见 §9.1。

---

## 5. 权限模型

| 对象 | 谁看得见 | 谁能改 / 删 |
|---|---|---|
| 私人菜谱（`team_id IS NULL`） | 只有 `owner_id` | 只有 `owner_id` |
| 团队菜谱（`team_id = T`） | T 的全部成员 | 只有 `owner_id` |
| 字典（食材 / 单位 / 分类 / 标签） | 服务器上所有登录用户共享一份 | 任何登录用户（新增 / 改名 / 软删都允许，LWW 决定结果） |
| 私人图片文件 | 只有 `owner_id` | 只有 `owner_id`（只增不改） |
| 团队图片文件 | T 的全部成员 | 只有 `owner_id`（只增不改） |

三条落到实现上的硬规则：

1. **服务端是权限的唯一裁决者**：拉取按「我可见的范围」过滤（不是把全部数据发给客户端再让客户端过滤）；推送时 `owner_id` 一律取当前登录用户，客户端传来的值丢弃；`team_id` 必须是当前用户所在的团队，否则整条跳过。
2. **客户端不出现编辑入口**：别人的菜谱详情页没有编辑 / 删除按钮。这是**必须**的，不是锦上添花——如果本机出现了改别人菜谱的改动，服务端跳过它、而本地因为 `updated_at` 更新反而「赢」，这条改动会永远同步不上去、也不会被覆盖，两边永久分叉。服务端校验只是第二道锁（防自觉破坏），不能当唯一防线。
3. **字典的越权不在本轮范围内**：同一台服务器上的登录用户可以改别人建的食材名。自托管场景下服务器属于一个家庭（见 §11 的决定清单）。

---

## 6. 数据模型

### 6.1 本地 SQLite（改动）

```sql
-- 既有表加两列（存量行两列都是 NULL = 本地自建、尚未认领）
ALTER TABLE recipes ADD COLUMN owner_id TEXT;   -- NULL = 未认领（见 §9.2）
ALTER TABLE recipes ADD COLUMN team_id  TEXT;   -- NULL = 私人

-- 新增：哪些图片服务器上已经有了（避免每次同步重复上传）
CREATE TABLE IF NOT EXISTS uploaded_files (
  name        TEXT PRIMARY KEY,   -- 裸文件名，如 "3f2a....jpg"
  uploaded_at TEXT NOT NULL
);
```

其余不动：`recipe_steps` / `recipe_ingredients` / `recipe_labels` 的列与索引保持原样（子表不加 `owner_id` / `team_id`，归属由父菜谱决定；本地也不给它们加同步游标，理由见 §7.3）。`ingredients` / `units` / `labels` 保持现状（没有归属列，全局一份）。

**时间戳**：写库一律用同一套 ISO 8601 UTC 字符串；与服务器往返前经 `toIsoTimestamp()` 归一化，比较用 `compareTimestamp()`（两者照抄 wee-count，SQLite 的 `datetime('now')` 产出的 `"YYYY-MM-DD HH:MM:SS"` 会让 Go 的 `time.Time` 解析失败、整批 400）。

### 6.2 服务器 PostgreSQL

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SEQUENCE IF NOT EXISTS global_server_seq;

users (
  id UUID PK DEFAULT uuid_generate_v4(), username VARCHAR(50) UNIQUE NOT NULL,
  nickname VARCHAR(50) NOT NULL, password_hash VARCHAR(255) NOT NULL,
  avatar_url TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);
-- 照抄 wee-count：username 而非 email，头像只是一个 URL 字符串，本轮没有上传头像的界面

teams (
  id UUID PK, name VARCHAR(100) NOT NULL, created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);

team_members (
  team_id UUID REFERENCES teams(id), user_id UUID REFERENCES users(id),
  role VARCHAR(20) DEFAULT 'member', joined_at TIMESTAMPTZ,
  PRIMARY KEY (team_id, user_id)
);

recipes (
  id TEXT PK,                      -- 客户端生成的 UUID 字符串，不用 uuid 类型
  owner_id UUID NOT NULL REFERENCES users(id),
  team_id UUID REFERENCES teams(id),        -- NULL = 私人
  name TEXT NOT NULL, cover_path TEXT,      -- 裸文件名，不是路径
  category_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ,
  server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')
);

recipe_steps        (id TEXT PK, recipe_id TEXT REFERENCES recipes(id) ON DELETE CASCADE,
                     sort_order INT, text TEXT, image_path TEXT);
recipe_ingredients  (id TEXT PK, recipe_id TEXT REFERENCES recipes(id) ON DELETE CASCADE,
                     ingredient_id TEXT, amount DOUBLE PRECISION, unit_id TEXT, sort_order INT);
recipe_labels       (recipe_id TEXT REFERENCES recipes(id) ON DELETE CASCADE,
                     label_id TEXT, PRIMARY KEY (recipe_id, label_id));
-- 三张子表**没有 server_seq**：它们跟着父菜谱整条走（§7.3），不做行级增量
-- 三张子表也**没有 deleted_at**：服务端只保存「当前有效的子行快照」，软删的子行不参与同步。
--   本地仍按 AGENTS 的约定保留子行 deleted_at（软删行不下发）。这是对 AGENTS 那条约定的一例有意例外，
--   已确认（见 §11.13）。

ingredients (id TEXT PK, name TEXT NOT NULL, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
             deleted_at TIMESTAMPTZ, server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq'));
units       (同上);
labels      (id TEXT PK, name TEXT NOT NULL, kind TEXT NOT NULL, ...同上);

files (
  name TEXT PK,                    -- "<uuid>.jpg"，客户端生成，全局唯一
  owner_id UUID NOT NULL REFERENCES users(id),   -- 上传者，只用于排查与将来的 GC，不参与鉴权
  size BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
-- 注意：files **没有 team_id**。读权限不看这张表，看「有没有一条我可见的菜谱引用了它」，见 §8.1
```

索引：`recipes(team_id)`、`recipes(owner_id)`、`recipes(server_seq)`、`recipes(cover_path)`、`recipe_steps(image_path)`、字典表各自 `(name)`、`(server_seq)`、`team_members(user_id)`、`recipe_steps(recipe_id)`、`recipe_ingredients(recipe_id)`。

> 服务器上的字典表**没有同名唯一约束**：去重不靠约束，靠 §7.4 的「同名合并到旧 id」——撞约束会让整批写入回滚，而合并是能自愈的。`name` 上建普通索引即可。

---

## 7. 同步协议

### 7.1 请求 / 响应

```
POST /api/v1/sync          （Authorization: Bearer <access token>）

{
  "last_server_seq": 128,
  "local_changes": {
    "ingredients": [ { "id", "name", "created_at", "updated_at", "deleted_at" } ],
    "units":       [ ... ],
    "labels":      [ { "id", "name", "kind", ... } ],
    "recipes": [
      { "id", "name", "cover_path", "category_id", "created_at", "updated_at", "deleted_at",
        "team_id",
        "steps":       [ { "id", "sort_order", "text", "image_path" } ],
        "ingredients": [ { "id", "ingredient_id", "amount", "unit_id", "sort_order" } ],
        "label_ids":   [ "<label id>" ] }
    ]
  }
}
```

响应：

```
{
  "server_seq": 431,
  "remote_changes": {
    "ingredients": [...], "units": [...], "labels": [...],
    "recipes": [ { 同上传形状，外加 "owner_id" } ],   -- 子表整条带下来
    "files":   [ { "name": "3f2a....jpg", "size": 184320 } ]   -- 本次返回的菜谱引用到的图片
  }
}
```

- 请求体上限 32MB（照抄），但**不含图片字节**：图片走 §8 的独立通道。
- `owner_id` 只在响应里有意义；请求里带的值一律丢弃（服务端赋值）。
- `files` 只列本次 `remote_changes.recipes` 引用到的图片名，客户端对本地不存在的逐个下载。

### 7.2 服务端写事务的顺序（照抄 wee-count 的两次事故修正）

一个写事务里，按顺序：

1. `SELECT pg_advisory_xact_lock(897753)` —— 全局串行化所有同步写事务，保证 `server_seq` 的赋值顺序 = 提交顺序（`nextval` 按调用序发号，并发交错提交会出现「低 seq 晚提交」被已推进的游标永久跳过）。
2. 合并字典（`ingredients` / `units` / `labels`），记录 `旧 id → 有效 id` 的 remap。
3. **把 `recipes` 里所有引用（`category_id`、`label_ids`、`ingredient_id`、`unit_id`）按 remap 重写**，然后才合并菜谱。
   （wee-count 在这步栽过：同批次的事务引用了被合并掉的分类 id，撞外键 23503 导致整次同步回滚。）
4. 合并 `recipes`（LWW）+ 子表 delete-all-then-insert。
5. 提交。

所有单条 merge 用 `FOR UPDATE` 锁已存在行，条件写 `!incoming.After(remote)` 则跳过，绝不用 `23505` 回退兜底（PostgreSQL 事务内语句报错即 aborted 态，后续 UPDATE 必 25P02，回退在真库跑不通）。

### 7.3 菜谱为什么整条同步，而不是行级 LWW

`steps` / `ingredients` / `label_ids` 作为菜谱的子数组一起上传下发，服务端在同一个事务里 `DELETE` 全部子行再 `INSERT` 新行（`syncTransactionTags` 的同一手法）。

理由：**只有创建者能改菜谱**，所以同一个 id 的写入方最多是「同一个人在不同设备上」——LWW 的粒度对到菜谱这一层就是正确的粒度：名字、步骤、食材、标签永远一起变，不会出现「A 手机上的名字配 B 手机上的步骤」这种半新半旧的混合物。附带好处是子行不需要 `server_seq`、不需要各自的 LWW、不需要跨表 remap。

代价：改一次菜谱会重传它的全部子行（家庭 App 的数据量下可忽略）。**已知限制**：一旦将来允许协作编辑同一条菜谱，必须回到行级 LWW —— 代码里留 `shortcut:` 注释标明这一点。

### 7.4 字典的同名合并（照抄 wee-count 的 tag / category 分支）

- **合并键**：`ingredients` / `units` 用 `(name)`；`labels` 用 `(name, kind)` —— 与本地唯一索引 `idx_labels_name_kind` 一致。分类和标签**不能**并成一行：`kind` 不同就是两种东西，而 `recipes.category_id` 与 `recipe_labels.label_id` 都指向这张表，跨 kind 合并会让一条菜谱的分类变成标签。
- 推送 `id = X` 行时，若 X 不存在**但同键的行已存在**（id = Y，**含软删行**）→ 把内容合并到 Y、丢弃 X、返回 Y。
- 必须包含软删行：本地清库重绑会重新生成 UUID，而软删行仍占着「同名」这个坑；漏判会写出两条同名数据，两个客户端从此各看各的。
- **remap 不新增协议字段**：客户端在 `applyRemoteChanges` 里做同一件事的镜像——收到 id = Y 的字典行时，若本地已有同键的 X → 把引用改指 Y（`recipe_ingredients.ingredient_id` / `unit_id`、`recipes.category_id`、`recipe_labels.label_id`，以及**同一批 `remote_changes.recipes` 子数组里的引用**）→ 删掉 X → 插入 Y。服务端返回的增量里天然带着 Y（Y 的 `server_seq` 被推进了），不需要 `id_remap` 字段。
- 软删的字典行**不阻止**已引用它的菜谱正常显示（详情页 JOIN 不筛 `deleted_at`），只是不再出现在「选择」列表里。同名再建一次等于复活。

### 7.5 拉取与游标

- 在单个 `REPEATABLE READ` 只读事务里读三类增量 + 取快照内的全局 `MAX(server_seq)`，先读后推进游标。
- 可见范围过滤（服务端 SQL 里就带上，不是发完再筛）：

```
recipes:  (owner_id = $me AND team_id IS NULL)
       OR (team_id IN (SELECT team_id FROM team_members WHERE user_id = $me))
字典三张表: 无过滤，全量增量（团队无关的共享字典）
```

- `backfillReferenced`：增量返回的菜谱可能引用 `server_seq` 早于游标、本次没下发的字典行（比如食材是三天前建的、菜谱是今天改的）。按 id 反查补齐父行，否则客户端外键缺失会卡死。**wee-cook 的子表随菜谱整条走，所以只需要补字典这一层。**

### 7.6 墓碑与删除

- 删除 = 客户端写 `deleted_at`（软删）。列表查询一律 `WHERE deleted_at IS NULL`。远端墓碑到了就跟着写 `deleted_at`，本地行保留（关联的子行一起软删）。
- 别人的菜谱被它的作者删掉：墓碑会下发到我了（我原本能看到它），我本地跟着消失。这是必须的——否则它会在我本地永远复活。

---

## 8. 图片通道

### 8.1 接口

```
POST /api/v1/files?name=<裸文件名>   body = 裸二进制
  → 200 { "name": "3f2a....jpg", "size": 184320 }
  文件名由客户端给（它本地已按这个名字落盘、菜谱里引的也是这个名字），服务端只校验形状
  （`<uuid>.jpg`），带路径分隔符的值一律拒绝
  幂等：同名已存在 → 直接 200，不覆盖、不重复占用磁盘
  限制：单文件 ≤ 5MB，且必须是 JPEG（看前三个字节）

GET /api/v1/files/{name}
  → 200 二进制 / 404 文件不存在（DB 有行但磁盘没文件时同样 404）
```

**读权限由「引用」反查，而不是文件自己的归属**：

```sql
-- 可见 ⇔ 存在一条我可见的菜谱引用了这个文件（含软删菜谱：菜谱删了图也不至于取不回）
SELECT EXISTS(
  SELECT 1 FROM recipes r
  WHERE (r.cover_path = $1
         OR EXISTS (SELECT 1 FROM recipe_steps s WHERE s.recipe_id = r.id AND s.image_path = $1))
    AND (  (r.owner_id = $me AND r.team_id IS NULL)
        OR r.team_id IN (SELECT team_id FROM team_members WHERE user_id = $me))
)
```

这样选，是为了让**可见性永远跟着使用它的菜谱走**：不需要在 `files` 上维护一份独立归属，也就不会出现「先上传到私人、后被团队菜谱引用 → 队友 403、封面永远空白」这类不一致（上传的那一刻服务端还不知道这条菜谱属于谁）。代价是每次下载多一次反查，靠 `recipes(cover_path)` 与 `recipe_steps(image_path)` 两个索引兜住；副作用是孤儿图片谁都读不了——本轮不做垃圾回收，孤儿图只是占磁盘。

存储用 Docker 卷 `/data/files/<name>`（不是对象存储）。客户端已经把图压到最长边 1280px / JPEG 质量 0.72，实测远小于 5MB。

**为什么按文件名而不是内容哈希做键**（此处推翻了早期讨论里的内容哈希方案）：文件名本身就是 `<uuid>.jpg`，全局唯一，内容哈希需要客户端把整个文件读一遍算 sha256，换来的只是「同一张图重复上传时省磁盘」——家庭场景下几乎不发生。这是有意的取舍，写进代码注释。

### 8.2 客户端上传

同步开始时，先看 `local_changes.recipes` 引用到的全部图片名（`cover_path` + `steps[].image_path`），对 `uploaded_files` 表里没有的逐个上传。**任何一张上不去（网络失败、超限、服务端拒绝），这批菜谱就整批不推**，等下次再传；字典照推。上传不需要带归属（服务端也不需要）。

理由：宁可晚一个周期，也不要让服务器上出现「菜谱已到、图还没有」的持久状态——用户会在家人手机上看到一个永远空着的封面。

上传成功后写 `uploaded_files`；失败不写，下次自然重试。查 `uploaded_files` 而不是问服务器，是为了省一次往返（代价：本机清库重装后会把图重传一遍，视为可接受的浪费）。

### 8.3 客户端下载

收到 `remote_changes.files` 后，对本地 `$APPDATA/images/<name>` 不存在的文件排队串行下载（不强求在本次同步内完成，失败下一轮再来）。下载失败**不影响**菜谱本身的落地：菜谱先落库，图后补，UI 上就是暂时没封面。

`imageSrc()` 与 `imageStore.ts` 的落盘约定**不变**（库里存裸文件名，磁盘在 `$APPDATA/images/`，路径随安装变化所以绝不存绝对路径）。

---

## 9. 客户端行为

### 9.1 单库 + 过滤（而不是按用户分库）

本机同一时刻只有一个「当前账号」，但库里可能同时住着几个人的数据（同一台手机换人登录、或团队同步下来的菜谱）。显示规则：

| 当前状态 | 显示的菜谱 | 能改 / 能删的菜谱 |
|---|---|---|
| 未登录 | **本地全部**（不过滤） | `owner_id` 为 NULL 或等于…本机都算自己的 |
| 已登录 | `owner_id = 我` 且私人，或 `team_id ∈ 我的团队` | `owner_id = 我` |

未登录时**能改**的范围比能看的范围窄：`owner_id` 指向别人的菜谱同样只读。否则登出期间改了家人的团队菜谱 → 本地 `updated_at` 更新 → 登录后推上去被服务端跳过 → 本地这条改动永远赢着，两边永久分叉（正是 §2 的反目标）。

未登录时**不过滤**是刻意的：认领（§9.2）之后，本地那些菜谱的 `owner_id` 已经被填成某个账号了，如果未登录就过滤掉，用户会以为数据丢了。登出后能看到本设备上住过的全部数据（含家人的团队菜谱），代价可以接受——别人的私人菜谱永远不会被同步下来（服务端按 owner 拦），本机本来就能看到本机磁盘上的东西。

「当前菜谱本」（我的菜谱 / 某个家庭）是需要持久化的 UI 状态：登录后默认选「我的菜谱」，加入团队后可在顶部切换；选中的家庭在团队被删/退出后回落「我的菜谱」。持久化位置见 §9.6。

### 9.2 存量数据认领

- 未登录时创建的菜谱，`owner_id` / `team_id` 都是 NULL。
- **首次成功登录后的第一次同步**：本地先 `UPDATE recipes SET owner_id = <服务端返回的我的 user id> WHERE owner_id IS NULL`，再走首次全量上传（`firstFullSync`，照抄 wee-count：游标为空即全量推）。
- 判据是「还有没有 `owner_id IS NULL` 的菜谱」本身，天然幂等，不需要额外的标记位。第二次登录的另一个人不会把前一个人的数据认领走（已经没有 NULL 行了）。

### 9.3 推送集合：只推自己的，登录时补扫一次

**推送的 `recipes` 一律先按 `owner_id = 我` 过滤**（无主行已在 §9.2 认领）。不清这一条会有两个事故：同设备换人登录后把对方的私人菜谱推成自己的；或者本地住着家人的团队菜谱，被当成自己的推上去。字典三张表全推（无归属，幂等）。

**「队列里有什么就推什么」不够**，还有三条路会漏掉改动：登出期间录的菜（`enqueueSync` 直接返回、不入队）、`pending_sync:*` 这条 localStorage 记录被清掉、上次同步推完一半就崩了。所以：**每当会话从「不在线」变成「在线」（登录成功、或冷启动恢复会话成功）时，做一次「全扫推送」**——把本地 `owner_id = 我` 的全部菜谱与全部字典行作为 `local_changes` 推一次，而不是只推队列。LWW 幂等，重复推没有副作用；家庭规模的数据量（几百条）一次推完是毫秒级。日常写操作仍走 §9.5 的 3 秒防抖队列（推得少、更快）。

### 9.4 加入团队后必须全量重拉

游标是**跨团队共享的一个数字**。B 在 A 已经录了 50 道菜之后才用邀请码加入团队 T，那 50 行的 `server_seq` 早已小于 B 的游标，按「`server_seq > 游标`」永远拉不下来，团队菜谱对 B 是空的。

规矩：**创建团队 / 加入团队成功后，把当前 uid 的 `last_server_seq` 清 0**，下一次同步就是一次全量拉取（只拉我可见的范围），LWW 幂等，重复应用没有副作用。不做按团队分游标（`team_cursors`），那是为省一次全量拉取而引入一套并行的游标体系，家庭规模下不值。

### 9.5 触发时机

照抄 wee-count：启动后恢复会话成功即同步一次；任何写操作（新增/编辑/删除菜谱、改字典）后 `enqueueSync`，3 秒防抖；失败按 5s → 10s → 20s → 60s 上限指数退避；`performSync` 带互斥 + `syncQueued` 补跑；待推送队列与游标**都按 uid 隔离**并持久化。

登录/登出的边界：未登录时 `enqueueSync` 直接返回（不发请求）；登出只停定时器（`resetSyncTimers`），**保留**各 uid 的积压队列，下次同一账号登录继续推。

### 9.6 新增与改动的文件

| 文件 | 说明 |
|---|---|
| `src/services/api.ts` | 照抄（baseUrl 响应式视图、15s 超时、401→refresh 单飞、`hasBaseUrl()`） |
| `src/services/tokenStorage.ts` | 照抄（按服务端 user id 分开存 refresh token） |
| `src/services/settingsFile.ts` | 照抄（服务器地址等设置项的通用读写层，三态：tauri / web / error） |
| `src/stores/auth.ts` | 简化版：注册 / 登录 / 恢复会话 / 登出 / `isOnline` / `serverUserId`（去掉 wee-count 的本地多用户档案与密码锁） |
| `src/stores/team.ts` | 新增：我的团队列表、创建团队、邀请码、加入、成员列表 |
| `src/services/sync.ts` | 协议 + 队列 + 游标 + 定时器 + `applyRemoteChanges`（去掉 ledgers / accounts / transactions / member_aliases / AI 相关分支） |
| `src/services/syncFiles.ts` | 新增：上传队列（依赖 `uploaded_files`）、下载队列（写 `$APPDATA/images/`） |
| `src/services/migration.ts` | 新增：认领 + `firstFullSync` |
| `src/db/index.ts` | §6.1 的 ALTER + 新表；`migrateTables` 从空实现变成真迁移 |
| `src/stores/recipe.ts` | 查询按 §9.1 过滤；写入时补 `owner_id` / `team_id`；每次写入后 `enqueueSync`；新增「当前菜谱本」条件 |
| `src/stores/ingredient.ts` / `label.ts` | 写入后 `enqueueSync`（字典行参与同步） |
| `src/stores/book.ts`（或并入 `prefs`） | 新增：「当前菜谱本」的持久化状态 |
| 视图 | `LoginPage.vue`（登录/注册，含服务器地址填写）、`TeamPage.vue`（列表 + 创建）、`TeamJoinPage.vue`（邀请码）、`TeamMembersPage.vue`（成员 + 邀请码展示）；`MePage.vue` 加同步入口与状态；`RecipeDetail.vue` 按 `owner_id` 隐藏编辑/删除；`RecipeList.vue` 顶部加菜谱本切换 |
| `src-tauri/Cargo.toml` / `lib.rs` / `capabilities/default.json` | 加 `tauri-plugin-store` + `store:default` 权限 |
| `backend/**`、`compose.yml`、`Dockerfile` | 新增，见 §10 |

---

## 10. 后端

### 10.1 目录

```
backend/
  cmd/server/main.go          启动：读配置 → 连库 → 跑迁移 → 起路由
  cmd/server/router.go        路由 + 中间件（含两条限流）
  internal/config/            DATABASE_URL / REDIS_URL / JWT_SECRET / CORS_ALLOWED_ORIGINS /
                             TRUST_PROXY / FILES_DIR / MAX_FILE_BYTES
  internal/database/          postgres.go（pgx pool + iofs 迁移）/ redis.go / migrations/*.sql
  internal/middleware/auth.go JWT 校验，写 userID 进 context
  internal/model/             user.go / team.go / recipe.go / dict.go / sync.go / file.go
  internal/service/           auth.go / team.go / sync.go / files.go / authz.go
  internal/handler/           auth.go / team.go / sync.go / files.go / helpers.go
```

### 10.2 接口清单

```
GET    /api/v1/healthz                                                公开：存活探测与客户端「测试连接」
POST   /api/v1/auth/register     { username, password, nickname }     （按 IP 限流 10/min）
POST   /api/v1/auth/login        { username, password }               （按 IP 限流 10/min）
POST   /api/v1/auth/refresh      { refresh_token }                    （不限流）
GET    /api/v1/me                                                     受保护
PUT    /api/v1/auth/profile      { nickname, avatar_url }             受保护
POST   /api/v1/sync                                                    受保护
GET    /api/v1/teams                                                  受保护：我加入的团队 + 成员数
POST   /api/v1/teams             { name }                             受保护：建团队，建者为 owner
POST   /api/v1/teams/{id}/invite                                      受保护：仅 owner，返回 6 位码（Redis 24h）
POST   /api/v1/teams/join        { code }                             受保护 + 限流 10/min
GET    /api/v1/teams/{id}/members                                     受保护：仅成员
POST   /api/v1/files?team_id=                                         受保护
GET    /api/v1/files/{name}                                           受保护
```

`GET /teams` 是相对 wee-count 多出来的：wee-count 的团队/账本列表通过同步下发（它把 team 也当成一个 ledger 行）。wee-cook 没有账本抽象，团队只走 REST。

中间件的两条限流、`RealIP` 的信任模型（`TRUST_PROXY`）、CORS 白名单（`http://tauri.localhost`）**照抄 wee-count**，包括为什么 `TRUST_PROXY=false` 时按 socket peer 而不是 `X-Forwarded-For` 限流。

### 10.3 部署

`compose.yml` = `api`（Go，公开镜像 `ghcr.io/tuzkimo/wee-cook-api`）+ `postgres:16-alpine`（绑 127.0.0.1）+ `redis:7-alpine`（绑 127.0.0.1）+ `files` 命名卷。迁移随 API 启动执行。文档写 `docs/SELF-HOSTING.md`；README 只加一句「想多设备同步 / 家庭共用，见自托管指南」并链过去。

---

## 11. 我替你做的决定（请过一眼）

1. **字典全局共享**，不分团队：同一台服务器上，任何人建的食材 / 单位 / 分类 / 标签名对所有登录用户可见。自托管假设是「一台服务器 = 一个家庭」，而全局字典让别名归一的收益最大化。**升级路径**：给三张字典表加 `team_id`（可空）并按 §7.5 的规则过滤，客户端切菜谱本时切字典。
2. **菜谱不带 `ledgers` / 账本抽象层**：`team_id` 可空 + `owner_id` 就够表达私人 / 团队。wee-count 的账本是能改名、能分享、能建多个的一等公民，wee-cook 没有这个需求。
3. **子表整条替换**而不是行级 LWW（§7.3）。
4. **图片按文件名做键**，不做内容哈希（§8.1，推翻了早期讨论）。
5. **未登录态显示不过滤，但只有无主菜谱可改**（§9.1）。
6. **服务器上不存子表的时间戳 / 游标**：子表跟着父行走。
7. **图片回收、团队管理（改名/解散/退出/移除）、菜谱换本、别名归一、AI 收录都不在本轮**。
8. **图片的读权限由「引用它的菜谱」反查决定**（§8.1），`files` 上不维护独立归属。最初写的「`files.team_id` + 团队鉴权」被推翻：它解不了「私人图被团队菜谱复用 → 队友 403、封面永远空白」这个死角。
9. **推送集合 = `owner_id = 我`；登录 / 恢复会话时做一次全扫推送**（§9.3）。
10. **加入团队后把同步游标清 0、全量重拉一次**（§9.4），而不是引入按团队分游标。
11. **LWW 输掉的那次修改无声丢弃**，UI 不提示、不保留历史（冲突只可能发生在「同一个人的两台设备」上）。
12. **服务端不做业务校验之外的清洗**：引用不存在的图片名、不存在的分类 id 都照原样存下来（客户端的外键是软约束；服务端校验只会让同步因为一条脏数据整批失败）。
13. **（已确认）服务器上的三张子表 `recipe_steps` / `recipe_ingredients` / `recipe_labels` 不带 `deleted_at` 列**。理由是它们随父菜谱整条替换（§7.3），服务端只保存「当前有效的子行快照」，软删的子行根本不下发；给它们加一个永远是 NULL 的列，是为了满足形式而加的形式。本地 SQLite 侧照旧保留子行 `deleted_at`（软删行不上传；应用远端菜谱时本地子行整组 `DELETE` 再插入，不复活、不留孤儿）。这条例外已同步写进根目录 `AGENTS.md` 的技术约束。

---

## 12. 验证

- **后端**：`go test ./...`。service 层用 `dbQuerier` 注入 fake（照抄 wee-count 的形状），同步另有一组真库集成测试（`sync_integration_test.go` 的形状：起临时 Postgres，跑迁移，断言 LWW / 游标 / advisory lock / remap / 越权跳过）。路由层 e2e 断言中间件顺序与限流。
- **前端**：`npm run test`（vitest）。新增用例至少覆盖：`applyRemoteChanges` 的 LWW 与同名合并重映射（含 `labels` 按 `(name, kind)` 而不是只按 name）、游标与队列按 uid 隔离、图片上传前置（图没传成功则菜谱整批不推）、`owner_id` 过滤（未登录 / 已登录两态）与「未登录也不能改别人的菜谱」、首次认领的幂等性与「登录后补扫能推出登出期间录的菜」、加入团队后游标清零、推送集合不含 `owner_id ≠ 我` 的行、`compareTimestamp` 的跨格式比较。
- **手动端到端**：本机 `docker compose up` + 两个 Tauri 实例（两个不同 `$APPDATA`，或一台真机 + 桌面端）：建团队 → 邀请码加入 → A 录菜谱带封面 → B 看到并能下载封面 → B 无编辑入口 → B 断网录私人菜谱 → 恢复网络后 A 看不到它。Android 真机跑一遍（CORS 与明文 HTTP 在真机上的表现与桌面 dev 不同）。
- **专门验一次「后加入的人能看到存量数据」**（§9.4 的坑）：A 先录 5 道团队菜谱 → B 再输邀请码加入 → B 必须看得到这 5 道（回归网：游标没清就会全空，而且不报错）。
- **验证顺序**：每个 Phase 结束跑一次全量（`npm run test` + `npm run build` + `cargo check` + `go test ./...`），不是只在最后跑一次。

---

## 13. 留给 builder 的

- 表结构 DDL 的具体写法、索引取舍、迁移文件切分（001/002/...）。
- 错误码与文案（登录失败、邀请码无效、文件超限与图片无关的其他错误）。
- 各视图的布局与交互细节（照现有 `MePage` / `RecipeEdit` 的写法与 Tailwind 风格）。
- 同步状态在 UI 上的呈现方式（「同步中 / 已同步 / 同步失败 · 重试」，不打扰用户的前提下）。
- 同步调度的具体参数（防抖时长、退避上限）——沿用 wee-count 的值即可，需要调再说。
- 后端 Dockerfile / CI / 镜像发布的细节（可照 `docs/后端CI-CD自动部署指南.md` 同构）。
