# 一起做饭 · 菜谱增删改查 设计

2026-10-13 · 状态：待确认

---

## 1. 要解决什么

**真实场景**：在某个 App 收藏过、或截图存过、或记在备忘录里的一道菜，真要做的时候，人在厨房、一只手拿着手机、另一只手沾着油，翻很久找不到，甚至根本想不起来存在哪。

**所以这个 App 不是收藏夹，是一本自己按固定格式录进去的菜谱本。** 录的时候费点手，换来的是想做时几秒筛出来、打开就能跟着做。

**成功的样子**：录过一道菜之后，下次做它时，从打开 App 到看见食材清单，不超过三次点击，不需要打字。

**为什么是现在**：项目骨架已跑通（Vue3 + Tauri 2 + Android 可安装），还没有任何数据层。菜谱 CRUD 是后面所有功能（筛选、跟做、AI 收录、多设备同步）的地基，先把它做对。

---

## 2. 目标 / 非目标 / 反目标

**目标**
- 手动录入一道菜：菜名、可选封面图、食材（结构化）、步骤、分类、标签。
- 食材 / 单位 / 分类 / 标签都是可自由增删的独立数据，录入时从底部 sheet 里选。
- 菜谱能改、能删（软删除）。
- 列表页能一眼看到所有菜谱，点开是详情页。

**非目标（本轮明确不做）**
- 搜索、多条件筛选（这是最终目的，但建立在 CRUD 之上，下一轮）
- 跟做模式：计时器、防熄屏、大字逐步
- AI 截图收录、多设备同步、备份导出
- 食材别名归一（"五花肉"/"三层肉"）、份量倍数换算、营养信息
- 分类树（多级分类）

**反目标（就算做出来了也算失败）**
- 录入一道菜要打字超过必要限度 —— 食材、单位、分类、标签必须全是"选"，不是"填"。
- 手机上列表页滑动卡顿或图片半天不显示。
- 为了 CRUD 引入一套只有 CRUD 用得上的抽象层。
- 已录入的历史数据在后续版本里读不出来（表结构必须先按未来同步的需要打底）。

---

## 3. 约束（既定，不改）

来自项目 `AGENTS.md`：

- Vue 3 + TypeScript + Vite；Tauri 2；正式平台是 Android。
- TypeScript 严格模式，**禁止 `any`**。
- **食材必须引用结构化数据**：菜谱只存 `ingredient_id` + 用量 + `unit_id`，菜谱表里不许出现食材纯文本。
- **每张业务表带 `id`、`updated_at`、`deleted_at`**（软删除时间戳，NULL 表示未删除），为后期 LWW 增量同步留位。
- 测试优先：非 bugfix 功能需附带单元测试，不可删改已有测试。
- 开发者文档放 `docs/`，不往 README 塞。

注：姊妹项目 WeeCount 用的是 `is_deleted INTEGER`，**本项目按自己的约定用 `deleted_at TEXT`**，不要照抄它的列名。

**可参考的既有实现**：`D:\projects\my\wee-count`。它的 `CategorySheet.vue` / `TagSheet.vue`（底部 sheet 的列表+表单+删除确认写法）、`stores/category.ts` / `stores/tag.ts`（使用次数排序的 SQL 形状）、`db/userDb.ts`（建表与迁移）、`services/ai/imageScale.ts`（图片压缩到 1280px）都已经在 Android 真机上跑通过。**照抄结构和写法，不要重新发明。**

---

## 4. 数据模型

六张业务表 + 一张关联表。

```sql
recipes (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  cover_path   TEXT,                    -- 相对 App 数据目录，NULL = 无封面
  category_id  TEXT NOT NULL REFERENCES labels(id),   -- 必填，见 §10.3
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT                       -- NULL = 未删除
)

recipe_steps (
  id          TEXT PRIMARY KEY,
  recipe_id   TEXT NOT NULL REFERENCES recipes(id),
  sort_order  INTEGER NOT NULL,
  text        TEXT NOT NULL,
  image_path  TEXT,                       -- 可空
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
)

recipe_ingredients (
  id             TEXT PRIMARY KEY,
  recipe_id      TEXT NOT NULL REFERENCES recipes(id),
  ingredient_id  TEXT NOT NULL REFERENCES ingredients(id),
  amount         REAL,                    -- 可空："适量" 就是 NULL
  unit_id        TEXT REFERENCES units(id), -- 可空："适量" 没有单位
  sort_order     INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
)

labels (                                  -- 分类与标签共用，见 §10.1
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- 'category' | 'tag'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
)

recipe_labels (                           -- 纯关联表，不参与同步，无软删除
  recipe_id  TEXT NOT NULL REFERENCES recipes(id),
  label_id   TEXT NOT NULL REFERENCES labels(id),
  PRIMARY KEY (recipe_id, label_id)
)

ingredients (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
)

units (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,              -- 克 / 毫升 / 个 / 勺 / 少许
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
)
```

**唯一性与索引**（重名判定只针对未删除行，用部分索引）：

```sql
CREATE UNIQUE INDEX idx_labels_name_kind  ON labels(name, kind) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_ingredients_name  ON ingredients(name)  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_units_name        ON units(name)        WHERE deleted_at IS NULL;
CREATE INDEX idx_recipe_steps_recipe      ON recipe_steps(recipe_id);
CREATE INDEX idx_recipe_ingredients_ing   ON recipe_ingredients(ingredient_id);
CREATE INDEX idx_recipe_ingredients_unit  ON recipe_ingredients(unit_id);
CREATE INDEX idx_recipe_labels_label      ON recipe_labels(label_id);
```

**时间戳格式**：一律用 JS 的 `new Date().toISOString()` 写入（UTC、RFC3339）。不要用 SQLite 的 `datetime('now')` —— 它产出的格式不是 RFC3339，WeeCount 在接后端时被这个坑过一次。

**数据库文件**：单个 `sqlite:weecook.db`。本项目没有多账号，不照抄 WeeCount 的 `per-user.db` 方案。

**外键**：SQLite 默认 `PRAGMA foreign_keys` 是 OFF，本项目不开（WeeCount 也没开，开了会全局改变行为）。完整性靠应用层显式保证：写 `recipe_ingredients` 前食材必须已存在。

**改子表必须 bump 父菜谱的 `updated_at`**（见 §10.7）。改步骤、改食材用量、加删标签、换封面，每一条写入路径都要顺带 `UPDATE recipes SET updated_at = ?`。

---

## 5. 「使用次数」的定义与排序

四个 sheet（食材、单位、分类、标签）都按使用次数倒序，这是「快」的核心——常做的菜用的东西自动浮到上面。

**使用次数 = 引用它的、未删除的菜谱数。** 不是引用行数：同一道菜里"盐"出现两次（腌制一次、炒制一次），鸡蛋在蛋炒饭和蛋花汤里各用一次，前者算 1，后者算 2。

SQL 形状照抄 WeeCount `stores/tag.ts` 里的写法——先把关联表聚合成「实体 → 菜谱数」的子查询，再 `LEFT JOIN` 回主表。不要图省事直接 `JOIN` 后 `GROUP BY`，那会退化成嵌套循环（WeeCount 实测 20 万行时差 50 倍）。

```sql
SELECT i.id, i.name, i.updated_at, COALESCE(u.cnt, 0) AS usage_count
FROM ingredients i
LEFT JOIN (
  SELECT ri.ingredient_id AS id, COUNT(DISTINCT ri.recipe_id) AS cnt
  FROM recipe_ingredients ri
  JOIN recipes r ON r.id = ri.recipe_id AND r.deleted_at IS NULL
  WHERE ri.deleted_at IS NULL
  GROUP BY ri.ingredient_id
) u ON u.id = i.id
WHERE i.deleted_at IS NULL
ORDER BY usage_count DESC, i.name ASC
```

`units` 和 `labels` 同构（`labels` 加 `kind` 过滤）。`usage_count` 是本地派生值，只用于列表排序，不落库、不外发。

---

## 6. 界面

### 6.1 底部 sheet（五个实例，一套实现）

食材、单位、分类（单选）、标签（多选）—— 这四个是**同一个组件**，靠参数区分：标题、数据源、是否多选。WeeCount 把同一套逻辑写了两遍（`CategorySheet.vue` 534 行 + `TagSheet.vue` 307 行），本项目不重复这个错误。

组件 `RefSheet.vue`，props：`visible`、`title`、`store`（提供 list/add/update/remove/fetch）、`mode`（`'single' | 'multiple'`）、`selectedIds`。结构照抄 `CategorySheet.vue`：

- 列表模式：按使用次数倒序的列表，每行「名称 + 编辑 + 删除」，底部「新建」按钮。
- 表单模式：名称输入 + 保存/取消。同一 sheet 内切换，不开新弹窗。
- 删除前 `ConfirmDialog` 二次确认；删除失败（被引用）弹提示。
- 软键盘弹出时底部留出空间（照抄 `composables/useKeyboardInset.ts`）。
- 用次数为 0 的新条目排在列表**末尾**（`usage_count DESC, name ASC` 自然满足）。

第五个是 `IngredientSheet.vue`——它比上面四个多一步：选中食材后要选单位、填数量。这一层不要塞进 `RefSheet`。

### 6.2 录入/编辑页（`RecipeEdit.vue`）

从列表页「新增」进入，编辑已有菜谱时同一页面复用，带 `recipeId` 参数。

1. 菜名（文本框，必填）
2. 封面图（点击 → 弹出「拍照 / 从相册选 / 移除」）
3. 分类（点一行 → 打开 `RefSheet` 单选；**必填**，未选时保存按钮不可点或报「请选择分类」）
4. 标签（点一行 → 打开 `RefSheet` 多选，已选显示为可删除的 chip）
5. 食材（列表，每行「食材名 + 数量 + 单位」，可拖不动，按加进来的顺序；点「+ 添加食材」→ `IngredientSheet`；每行可删）
6. 步骤（一条一条加，每条一个文本框 + 可选插图；每条可删、可上下移）
7. 保存 / 取消

未保存就退出时要提示（`ConfirmDialog`）。

### 6.3 列表页（`RecipeList.vue`，顶替现在的首页）

**已确认删除** `src/views/HomeView.vue` 和 `src/views/__tests__/HomeView.test.ts`（那个「菜谱功能开发中」占位页），路由 `/` 指向 `RecipeList`。删掉的那条占位测试不补——它的断言只覆盖占位文案。

卡片网格，每张卡：封面图（无封面则显示菜名首字）、菜名、分类、标签。右下角悬浮「+」进编辑页。点卡片进详情页，编辑与删除都在详情页。

**本轮不做筛选条件，但列表已经按使用次数无关的稳定顺序（`updated_at DESC`）排。** 筛选下一轮加在同一个页面上方。

### 6.4 详情页（`RecipeDetail.vue`）

大的食材料清单（`1 个 鸡蛋` / `200 克 五花肉` / `适量 盐`），下面是有序步骤（大字号）。右上角「编辑」。**没有计时、没有防熄屏、没有逐步高亮** —— 那是跟做模式，下一轮。

---

## 7. 图片

**两条入口都要**（已确认）：拍照、从相册选。

- **相册**：`@tauri-apps/plugin-dialog` 的 `open()` 选文件 + `@tauri-apps/plugin-fs` 的 `readFile()` 读字节。WeeCount 已用这条路在 Android 真机上跑通（`services/ai/imageInput.ts`），照抄。
- **拍照**：先在 Tauri 的 Android webview 里试 `<input type="file" accept="image/*" capture="environment">`——零依赖，一行 HTML。**这条路是否被 wry 的 Android 实现映射到相机 Intent，未经验证**（见 §12）。不通再引入社区相机插件。

**统一压缩**：选定后经 canvas 缩到最长边 1280px、导出 JPEG 再落盘。**抄 `imageScale.ts` 的哪一部分要分清**：

- 抄：`scaleToFit()`（等比缩放到最长边）、`sniffImageMime()`（**按字节头判类型，不看扩展名**）、`JPEG_QUALITY = 0.72`。
- **不抄**：WeeCount 那个「压缩后仍超 1 MiB 就整个拒绝」的闸门。那是为上传云端 AI 接口设的限制，本项目图只落本地盘，没有理由拒绝用户刚拍的照片。
- **不抄**：`ACCEPTED_MIME` 白名单。新 Android 手机默认用高效存储拍 HEIC，照抄白名单会让用户刚拍的封面被拒。做法是**交给解码器判决**：`createImageBitmap` 解不开（或 canvas 拿不到 2d context）就提示「这张图读不出来，换一张试试」，不写盘、不清空表单其余部分。

理由：相机原图动辄 8MB，列表页网格会卡；且这是唯一一次做这件事的时机。**不做缩略图**（同源图 + `<img loading="lazy">` 够用）。

**落盘**：写到 `$APPDATA/images/<uuid>.jpg`，数据库只存 `<uuid>.jpg` 这个相对名（不存绝对路径 —— Android 的应用目录路径会随安装变化）。

**显示**：`convertFileSrc()` + Tauri 的 asset protocol。需要在 `tauri.conf.json` 里开 `app.security.assetProtocol`，并把 `asset:` 和 `http://asset.localhost` 加进 CSP 的 `img-src`（现有 CSP 只有 `'self' data: blob: http: https:`）。

**删菜谱不删图**（本轮不做清理任务）。删图是另一件事，做了会误删共享路径。

---

## 8. 分层与文件清单

```
src/
  types/index.ts               Recipe / RecipeStep / RecipeIngredient / Label / Ingredient / Unit
  db/index.ts                  Database.load('sqlite:weecook.db') + 建表 + 迁移
  stores/recipe.ts             菜谱 CRUD + 详情读取（含步骤、食材、标签的读写）
  stores/label.ts              分类/标签共用，带 kind 过滤
  stores/ingredient.ts         食材与单位（两者都是「名称 + 使用次数」，同一个 store 的两个实例）
  components/RefSheet.vue      通用底部 sheet（列表 + 表单 + 删除确认）
  components/IngredientSheet.vue  选食材 + 选单位 + 填数量
  components/ImagePicker.vue   拍照/相册/移除 三选一
  components/ConfirmDialog.vue 从 WeeCount 照抄
  composables/useKeyboardInset.ts  从 WeeCount 照抄
  services/imageStore.ts       压缩 → 写盘 → 返回相对名；唯一接触 canvas 与 fs 的地方
  views/RecipeList.vue         新首页
  views/RecipeEdit.vue
  views/RecipeDetail.vue
```

`src/router/index.ts` 改成四条路由：`/` → RecipeList，`/recipe/new` → RecipeEdit，`/recipe/:id/edit` → RecipeEdit，`/recipe/:id` → RecipeDetail。`App.vue` 不变。删除 `src/views/HomeView.vue` 与 `src/views/__tests__/HomeView.test.ts`（见 §6.3）。

**新增依赖**：`@tauri-apps/plugin-sql`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-fs`、`pinia`；对应 `src-tauri/Cargo.toml` 加 `tauri-plugin-sql`（features `sqlite`）、`tauri-plugin-dialog`、`tauri-plugin-fs`；`capabilities/default.json` 加 `sql:default`、`sql:allow-load`、`sql:allow-execute`、`sql:allow-select`、`dialog:default`、`fs:default` 和 `$APPDATA` 范围内的读写权限。

**`main.ts`**：`createApp(App).use(router).use(createPinia()).mount("#app")`，并在 mount 前 `await initDb()`。

---

## 9. 测试计划

按项目约定用 vitest + happy-dom（`npm run test`）。测试要能在没有 Tauri 运行时的环境里跑，所以 **db 与插件调用必须可注入**——WeeCount `services/ai/imageInput.ts` 顶部的注入缝写法是本项目的标准做法，照它做。

必须覆盖（先写测试）：

1. **使用次数排序**：同食材在一道菜里出现两次 → 计数为 1；被两道菜引用 → 计数为 2；被删除的菜谱不计入。四个 store 各一条。
2. **重名**：同名食材/单位/分类/标签各一条（分类与标签同名互不冲突，因为分属不同 `kind`）。
3. **引用中的食材不能删**：删被 2 道菜引用的食材 → 抛错且列表不变；删未被引用的 → 软删除，`deleted_at` 非空。
4. **软删除**：删菜谱后从列表消失，但它引用的食材使用次数减 1。
5. **保存菜谱**：新建 → 步骤按 `sort_order` 回读；编辑 → 改食材用量、删一条步骤、加一条标签，回读一致。
6. **`RefSheet`**：单选模式只能选一个；多选模式可多选；表单模式进入/返回时状态被重置。
7. **`imageStore`**：用注入的假 canvas + 假 fs，断言压缩后的最大边是 1280、质量参数是 0.72、写盘路径以 `images/` 开头、库里存的是相对名；解码失败时返回提示且**没有**发生写盘。
8. **父行 `updated_at` 联动**：只改步骤 / 只改食材用量 / 只加删标签 / 只换封面，四种情况下 `recipes.updated_at` 都必须变大（见 §10.7）。
9. **分类必填**：不选分类保存 → 报错且库里没有新行；分类 sheet 存的是 `kind='category'` 的行。

---

## 10. 我做的判断（可以推翻）

### 10.1 分类与标签合并成一张表
两者机制上的差别只有「至多一个」和「必填性」；名称、软删除、使用次数排序、sheet 的增删改查完全一样。分成两张表的代价是两份 store、两份 sheet 参数、两次迁移，收益只有一点语义清晰。真要让分类长成树，加 `parent_id` 也是几行的事。

### 10.2 引入 Pinia
不是必须的（模块级 `ref` 也能共享状态），选它的实际理由是**测试隔离和热重载**：WeeCount 已有一套跑通的 store 测试写法可以直接照抄，省下的调试时间多于一个 3KB 依赖的成本。如果你不想加依赖，换成 `composables/useXxx.ts` + 模块级 `ref` 也是可行的，改动量不大。

### 10.3 分类必填，标签非必填
已确认。`recipes.category_id` 是 `NOT NULL`，保存时未选分类就报「请选择分类」，不给保存。

这给首次录入加了一道门槛：空库里还没有任何分类，用户必须先在分类 sheet 里建一个才能存下第一道菜。这是预期行为，**不靠预置种子数据绕过去**（见 §10.9）——分类是用户自己的世界观，不该由 App 定。sheet 的空态文案要明确领路（「还没有分类，点下面新建一个」）。

由于 §10.5 规定被引用的分类不能删，`NOT NULL` 和「不能删」合起来意味着分类永远不会悬空。

### 10.4 图片压缩到 1280px，但不设大小闸门
见 §7。压缩参数照抄 WeeCount，准入判据不抄 —— 本地存储没有拒绝的理由。如果你觉得原图直接存也行、卡了再说，那 `services/imageStore.ts` 可以砍掉一半。

### 10.5 被引用的食材/单位/分类/标签不能删，只能改
照抄 WeeCount 的做法：删之前先数引用，> 0 就抛「有 N 道菜谱在用」。替代方案是"删除时静默把菜谱里的引用清掉"，那会无声损坏菜谱数据。**数据完整性优先。**

### 10.6 数量允许为空
`amount REAL` 和 `unit_id` 都可空，用来表达"适量""少许"。否则用户只能瞎填一个数字。显示规则：两者皆空时渲染成「适量」，只填数字不填单位就只显示数字。

### 10.7 改子表要 bump 父菜谱的 `updated_at`
审阅设计的人问了这个问题，答案是**必须 bump**，理由是它同时踩到两件事：列表页按 `updated_at DESC` 排序（改了步骤却纹丝不动，用户以为没保存成功）；未来的 LWW 增量同步拿 `updated_at` 判新旧（不 bump 就会被后端当陈旧数据静默丢弃）。WeeCount 为同一个原因专门补过一段"只改标签也要 bump"的代码（`stores/transaction.ts:350-357`）。

代价是 `stores/recipe.ts` 里每条子表写入路径都要多带一次父行更新，别漏。

### 10.8 删菜谱只软删父行，不动子行
子行（步骤、食材行）跟着父行一起被过滤，不需要单独标记。真正的清理留给以后的数据维护任务。

### 10.9 空库不预置种子数据
不预置"炒菜/面包/蛋糕"，也不预置"克/毫升/个"。第一次录入时 sheet 里是空的（这正是用户描述的"如果空的允许点击添加"的场景）。少一份要维护、要被测试的 seed 逻辑。

### 10.10 测试用真 SQLite 而不是断言 SQL 字符串
WeeCount 有一套在 `node:sqlite` 上跑真实 DDL 的测试适配器。用它的理由很直接：断言 SQL 字符串只在 SQL 写错标点时才红，真建表能抓到类型、约束、部分索引写错这类问题，而那才是这里真正会错的地方。

---

## 11. 留给实现者的空间

以下按你的判断定，不必回问：

- 具体的 Tailwind 类名、间距、字号、暗色模式配色。
- `ConfirmDialog` / `useKeyboardInset` 从 WeeCount 抄过来时的裁剪程度（WeeCount 版本可能带本项目用不到的 props）。
- 步骤的「上下移」用手势还是按钮（WeeCount 里没有可照抄的现成实现）。
- 删除菜谱的确认文案。
- 迁移函数 `migrateTables()` 的写法——本轮是首次建表，它应该是空壳，但要留位置。

---

## 12. 开放风险（实现时必须先验证）

1. **Android 上 `<input type="file" capture>` 是否能唤起相机** —— 未验证。这是"拍照"功能唯一的不确定点。做法：先花 30 分钟把它做出来在真机上试；不通就改用社区相机插件，接口收敛在 `ImagePicker.vue` 内部，不影响其他部分。
2. **asset protocol 在 Android 上的表现** —— `convertFileSrc()` 在 Android 上返回 `http://asset.localhost/...`，需要 CSP 放行且 scope 配好。桌面端和 Android 的路径可能不同，必须在真机上跑一次。
3. **`plugin-sql` 在 Android 上的首次建表** —— WeeCount 已验证可行，但那是"打开时建表"的模式；本项目要在 `main.ts` mount 之前 `await`，注意别让首屏白屏太久。
4. **相机权限** —— 如果走插件路线，Android 需要在 `AndroidManifest.xml` 里加 `CAMERA` 权限。这属于"修改系统配置"之外的常规开发改动，但要知道它在哪一环。

---

## 13. 已知的、故意留给下一轮的债务

- 你举的标签例子 `450g` 不是标签，是模具规格。按现在的模型它只能当标签存，半年后标签表里会堆满 `450g`/`600g`/`8寸`。**本轮不解决**，因为正确的解法要么是"规格"字段、要么是食材的变体，得先有真实数据才知道该长什么样。等录了 20 道菜回来重新看这个问题。
