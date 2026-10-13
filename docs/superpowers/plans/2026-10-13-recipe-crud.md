# 菜谱增删改查 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给「一起做饭」做出一本能录、能改、能删、能翻的菜谱本：六张业务表 + 五个底部 sheet + 列表/编辑/详情三个页面，全程跑通。

**Architecture:** 数据层（`src/db`）只负责建表和持有连接；三个 store（`refStore` 工厂 / `label` / `recipe`）承载全部 SQL 与业务规则；组件层只有一个通用底部 sheet（`RefSheet`）加一个食材专用 sheet，其余四个实体共用。图片经 canvas 压到 1280px 后落 App 数据目录，库里只存文件名。store 与图片服务都通过 `Db`/`ImageDeps` 接口取依赖，测试直接接到真 `node:sqlite`，不 mock 数据库。

**Tech Stack:** Vue 3 + TypeScript（strict，禁 `any`）+ Vite + Pinia + Tailwind 4；Tauri 2（`@tauri-apps/plugin-sql` / `plugin-dialog` / `plugin-fs`）；vitest + happy-dom + `node:sqlite`。

**Spec:** `docs/superpowers/specs/2026-10-13-recipe-crud-design.md` —— 实现前通读，本计划只写「怎么做」，不重复「为什么」。

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**（测试里也不许）。
- 每张业务表带 `id` / `updated_at` / `deleted_at`；软删除一律 `deleted_at = <ISO 字符串>`，未删除是 `NULL`。
- 时间戳一律 `new Date().toISOString()`。**禁止 SQLite 的 `datetime('now')`**（不是 RFC3339）。
- 食材必须引用结构化数据：菜谱表里不许出现任何食材纯文本。
- 图片路径只存文件名（如 `<uuid>.jpg`），不存绝对路径。
- 不可删改已有测试。新增功能必须先写测试。
- 测试用真 `node:sqlite`（`DatabaseSync`）跑真 DDL 和真 SQL，**不 mock 数据库、不断言 SQL 字符串**。`node:sqlite` 需要 Node ≥ 22.13。
- 开发文档进 `docs/`，README 只写普通用户看的内容。
- commit 信息用中文，符合中文开发习惯。
- 每个任务结束都要能过 `npm run test`、`vue-tsc --noEmit`、`cargo check`（后两条只在 Task 1、Task 7、Task 8 改了 Rust/配置后才需要跑）。

## 跨任务的既定接口

后面任务只看到自己那一份，所以把共用的形状写死在这里。**名字、参数、返回类型一律照抄本节，不要改名。**

```ts
// src/types/index.ts
export type LabelKind = "category" | "tag";
export interface Recipe { id: string; name: string; cover_path: string | null; category_id: string; created_at: string; updated_at: string; deleted_at: string | null }
export interface RecipeStep { id: string; recipe_id: string; sort_order: number; text: string; image_path: string | null; updated_at: string; deleted_at: string | null }
export interface RecipeIngredient { id: string; recipe_id: string; ingredient_id: string; amount: number | null; unit_id: string | null; sort_order: number; updated_at: string; deleted_at: string | null }
export interface Label { id: string; name: string; kind: LabelKind; created_at: string; updated_at: string; deleted_at: string | null }
export interface Ingredient { id: string; name: string; created_at: string; updated_at: string; deleted_at: string | null }
export interface Unit { id: string; name: string; created_at: string; updated_at: string; deleted_at: string | null }

/** 带本地派生的使用次数。只用于列表排序，不落库。 */
export type WithUsage<T> = T & { usage_count: number };
export type LabelWithUsage = WithUsage<Label>;
export type IngredientWithUsage = WithUsage<Ingredient>;
export type UnitWithUsage = WithUsage<Unit>;

/** 列表页一行：菜谱 + 它的分类与标签 */
export interface RecipeListItem { recipe: Recipe; category: Label; tags: Label[] }

/** 详情页：食材行已 JOIN 出名字，省得页面再查一遍 */
export interface RecipeIngredientRow extends RecipeIngredient { ingredient_name: string; unit_name: string | null }
export interface RecipeDetail { recipe: Recipe; category: Label; tags: Label[]; steps: RecipeStep[]; ingredients: RecipeIngredientRow[] }

/** 编辑页提交的形状：全量，不含 id */
export interface RecipeInput {
  name: string;
  cover_path: string | null;
  category_id: string;
  tag_ids: string[];
  steps: { text: string; image_path: string | null }[];
  ingredients: { ingredient_id: string; amount: number | null; unit_id: string | null }[];
}
```

```ts
// src/db/index.ts
export interface Db {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  select<T>(sql: string, params?: unknown[]): Promise<T>;
}
export function setDb(db: Db | null): void;
export function getDb(): Db;                            // 未打开时 throw new Error("数据库未打开")
export async function initTables(db: Db): Promise<void>; // 真 DDL 的唯一来源，测试直接调它
export async function initDb(): Promise<void>;           // 加载 plugin-sql → initTables → setDb
```

```ts
// src/stores/refStore.ts
export interface RefRow { id: string; name: string; created_at: string; updated_at: string; deleted_at: string | null }
export interface RefStore {
  items: Ref<WithUsage<RefRow>>[];                      // 实际是 Ref，(RefRow & { usage_count: number })[]
  fetchAll(): Promise<void>;
  add(name: string): Promise<WithUsage<RefRow>>;
  update(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}
export function createRefStore(opts: { table: "ingredients" | "units"; label: string }): RefStore;
```

```ts
// src/stores/label.ts
export interface LabelStore {
  labels: Ref<LabelWithUsage[]>;
  fetchAll(kind: LabelKind): Promise<void>;
  add(kind: LabelKind, name: string): Promise<LabelWithUsage>;
  update(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** 给 RefSheet 用：把某一 kind 包成统一形状 */
  asRefStore(kind: LabelKind): RefStore;
}
export const useLabelStore: () => LabelStore;   // defineStore("label", ...)
```

```ts
// src/stores/recipe.ts
export interface RecipeStore {
  recipes: Ref<RecipeListItem[]>;
  fetchAll(): Promise<void>;                                   // ORDER BY updated_at DESC
  getDetail(id: string): Promise<RecipeDetail>;
  create(input: RecipeInput): Promise<string>;                 // 返回新菜谱 id
  update(id: string, input: RecipeInput): Promise<void>;
  remove(id: string): Promise<void>;                           // 只软删父行
}
export const useRecipeStore: () => RecipeStore;  // defineStore("recipe", ...)
```

```ts
// src/services/imageStore.ts
export interface ImageDeps {
  pickFromGallery: () => Promise<Uint8Array | null>;           // null = 用户取消
  decodeToJpeg: (bytes: Uint8Array) => Promise<{ dataUrl: string; width: number; height: number }>;
  writeImage: (name: string, bytes: Uint8Array) => Promise<void>;
}
export type SaveImageResult = { ok: true; name: string } | { ok: false; message: string };
export async function pickAndSaveImage(deps?: ImageDeps): Promise<SaveImageResult | null>;  // null = 取消
export async function saveImageBytes(bytes: Uint8Array, deps?: ImageDeps): Promise<SaveImageResult>;
export function setImageBaseDir(dir: string): void;
export function imageSrc(name: string): string;                // convertFileSrc(`${baseDir}/images/${name}`)
```

```ts
// src/components/RefSheet.vue
defineProps<{
  visible: boolean;
  title: string;              // "管理分类"
  store: RefStore;            // ingredient/unit/label 三路共用
  mode: "single" | "multiple";
  selectedIds: string[];
  emptyHint: string;          // "还没有分类，点下面新建一个"
}>();
defineEmits<{ close: []; select: [string[]] }>();   // 关闭不带选择结果；select 是"确定，用这组 id"
```

```ts
// src/components/IngredientSheet.vue
defineProps<{ visible: boolean }>();
defineEmits<{ close: []; add: [payload: { ingredient_id: string; amount: number | null; unit_id: string | null }] }>();
```

```ts
// src/components/ImagePicker.vue
defineProps<{ modelValue: string | null; label?: string }>();   // label 默认 "封面图"
defineEmits<{ "update:modelValue": [value: string | null] }>();
```

```ts
// src/components/ConfirmDialog.vue —— 从 wee-count 原样复制
defineProps<{ visible: boolean; title: string; description?: string; confirmText?: string; cancelText?: string; danger?: boolean; hideCancel?: boolean }>();
defineEmits<{ confirm: []; cancel: [] }>();
```

## Review Focus

这几类输入/情形规格里没写、也没有哪个任务的测试天然覆盖，但真用户第一天就会碰到。**每一条都在下面标了归属任务，那些测试要写进对应任务里：**

1. **同一道菜里重复添加同一个食材**（腌一次、炒一次）——用户会这么干，规格里明说了要支持。若 `recipe_ingredients` 上的唯一索引写错，保存直接报错。归属 Task 4。
2. **数量填成非数字 / 0 / 负数**——输入框是 `<input type="number">` 也挡不住 `0` 和 `-1`。归属 Task 9（配合 Task 4 的 store 层边界）。
3. **名称前后带空格，或只有空格**——「 鸡蛋 」和「鸡蛋」必须是同一条，纯空格必须被拒绝。归属 Task 2、Task 3。
4. **空菜谱**：只填了菜名和分类，没有任何步骤、没有食材——必须存得下、列表页和详情页都不炸。归属 Task 4、Task 10。
5. **超长名称**（比如 40 个字的菜名）在列表卡片和 sheet 行里不撑破布局。归属 Task 8。

---

### Task 1: 数据层——依赖、建表、连接

**Files:**
- Create: `src/types/index.ts`、`src/db/index.ts`、`src/db/__tests__/sqliteTestDb.ts`、`src/db/__tests__/schema.test.ts`
- Modify: `package.json`、`src-tauri/Cargo.toml`、`src-tauri/capabilities/default.json`、`src-tauri/src/lib.rs`、`src/main.ts`

**Interfaces:**
- Produces: `Db`、`setDb`、`getDb`、`initTables`、`initDb`（见「跨任务的既定接口」）；测试助手 `sqliteTestDb.ts` 导出 `makeTestDb(): { db: Db; raw: DatabaseSync }` 与 `freshTestDb(): Promise<{ db: Db; raw: DatabaseSync }>`（后者已跑过 `initTables`）。

- [ ] **Step 1: 装依赖、开权限**

```bash
npm i @tauri-apps/plugin-sql @tauri-apps/plugin-dialog @tauri-apps/plugin-fs pinia
```

`src-tauri/Cargo.toml` 的 `[dependencies]` 加：

```toml
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
```

`src-tauri/src/lib.rs` 的 builder 链上加 `.plugin(tauri_plugin_sql::Builder::default().build())`、`.plugin(tauri_plugin_dialog::init())`、`.plugin(tauri_plugin_fs::init())`。

`src-tauri/capabilities/default.json` 的 `permissions` 数组加：`"sql:default"`、`"sql:allow-load"`、`"sql:allow-execute"`、`"sql:allow-select"`、`"dialog:default"`、`"fs:default"`、`{ "identifier": "fs:allow-write-file", "allow": [{ "path": "$APPDATA/**" }] }`、`{ "identifier": "fs:allow-mkdir", "allow": [{ "path": "$APPDATA/**" }] }`。

- [ ] **Step 2: 写失败的表结构测试**

`src/db/__tests__/sqliteTestDb.ts`：把 `node:sqlite` 的 `DatabaseSync` 包成 `Db`。形状照 `@tauri-apps/plugin-sql` 的 `Database`（`execute` / `select`，参数用 `?` 或 `$1` 都行——`node:sqlite` 支持 `?`，本项目 SQL 统一用 `?` 占位）。

`src/db/__tests__/schema.test.ts`：**不抄 DDL、不 mock**，直接 import 生产的 `initTables`，接到真库上，然后：

```ts
it("七张表都建出来了", ...)              // SELECT name FROM sqlite_master WHERE type='table' 含 recipes/recipe_steps/recipe_ingredients/labels/recipe_labels/ingredients/units
it("recipes.category_id 是 NOT NULL", ...)   // PRAGMA table_info(recipes) 里 category_id 的 notnull === 1
it("六张业务表都有 id/updated_at/deleted_at", ...)  // 逐表核对列名；recipe_labels 除外
it("部分唯一索引挡住未删除行的重名，但允许软删后重建同名", ...)
   // 插「鸡蛋」→ 再插「鸡蛋」应抛错
   // 把第一条 deleted_at 置为 ISO 串 → 再插「鸡蛋」应成功
it("labels 的 (name, kind) 各自独立：同名的分类与标签可以共存", ...)
it("initTables 跑两次不报错（幂等）", ...)      // 用 freshTestDb 的 raw 再调一次 initTables
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run test -- src/db/__tests__/schema.test.ts`
Expected: FAIL，`initTables` 未定义 / 找不到 `src/db/index.ts`

- [ ] **Step 4: 实现 `src/types/index.ts` 与 `src/db/index.ts`**

`initTables` 里七条 `CREATE TABLE IF NOT EXISTS` + 五条 `CREATE INDEX IF NOT EXISTS`，**逐字照抄规格 §4 的 DDL**。`initDb` 用 `Database.load("sqlite:weecook.db")`，把连接 `setDb` 进去，再 `initTables`。留一个空的 `migrateTables(db)` 并在 `initTables` 末尾调用，注释说明「首次建表，暂无迁移」。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test -- src/db/__tests__/schema.test.ts`
Expected: PASS

- [ ] **Step 6: 接进启动流程**

`src/main.ts`：`await initDb()` 之后再 `mount`；同时装 Pinia。为了不让设备端启动时白屏，先 `mount` 再 `initDb()` 也接受——选一种，在 `src/db/index.ts` 顶部注释写清为什么。

验证：`npm run test`、`npx vue-tsc --noEmit`、`cargo check` 三条都过。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: 建立菜谱数据库层，七张表与索引就位"
```

---

### Task 2: `refStore` 工厂 + 食材/单位

**Files:**
- Create: `src/stores/refStore.ts`、`src/stores/ingredient.ts`、`src/stores/__tests__/refStore.test.ts`

**Interfaces:**
- Consumes: `getDb`（Task 1）、`freshTestDb`（Task 1）、`IngredientWithUsage` / `UnitWithUsage`（Task 1）。
- Produces: `createRefStore`、`RefStore`、`useIngredientStore`、`useUnitStore`。两个 store 都是 `RefStore` 形状，`items` 里是带 `usage_count` 的行。

- [ ] **Step 1: 写失败的测试**

`src/stores/__tests__/refStore.test.ts`，每个用例都 `setActivePinia(createPinia())` + 拿到 `freshTestDb()` 的 `db` 后 `setDb(db)`：

```ts
it("fetchAll 按使用次数倒序，未删除菜谱才计数", ...)
   // 造 2 道菜：菜 A 用「鸡蛋」「盐」，菜 B 用「鸡蛋」「糖」
   // 期望 usage_count：鸡蛋 2、盐 1、糖 1；把菜 B 软删后 鸡蛋 1、盐 1、糖 0
it("同一道菜里重复用同一食材只算一次", ...)          // 菜 A 里插两条 ingredient_id=鸡蛋 → 鸡蛋 usage_count 1
it("add 存 trim 后的名字", ...)                    // add("  鸡蛋 ") 后库里是 "鸡蛋"
it("add 纯空格或空串被拒绝", ...)                   // await expect(...).rejects.toThrow("请输入食材名称")
it("add 重名被拒绝", ...)                          // 第二次 add("鸡蛋") → rejects.toThrow("同名食材已存在")
it("update 改名、保留 usage_count、拒绝与别人重名", ...)
it("remove 被引用的食材被拒绝且不改库", ...)          // 「鸡蛋」被 2 道菜引用 → rejects.toThrow("有 2 道菜谱在用「鸡蛋」，不能删除")
it("remove 未被引用的食材成功软删除", ...)           // deleted_at 非 NULL，且从 items 里消失
it("单位与食材互不干扰", ...)                       // 单位列表里没有 "鸡蛋"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/refStore.test.ts`
Expected: FAIL，找不到 `src/stores/refStore.ts`

- [ ] **Step 3: 实现**

`createRefStore({ table, label })` 返回 `{ items, fetchAll, add, update, remove }`。要点：

- `fetchAll` 用「聚合子查询 + LEFT JOIN」的形状（规格 §5），**不要写成 `JOIN` 后 `GROUP BY`**；计数用 `COUNT(DISTINCT ri.recipe_id)`；`ORDER BY usage_count DESC, name ASC, id ASC`（第三项是给测试的确定性）。
- 表名从 `opts.table` 拼进 SQL（常量，不是用户输入），`?` 只用于参数。
- 错误文案模板用 `opts.label`：`请输入${label}名称`、`同名${label}已存在`、`有 ${n} 道菜谱在用「${name}」，不能删除`。
- `remove` 先数引用再软删，两步。

`src/stores/ingredient.ts`：

```ts
export const useIngredientStore = defineStore("ingredient", () =>
  createRefStore({ table: "ingredients", label: "食材" }));
export const useUnitStore = defineStore("unit", () =>
  createRefStore({ table: "units", label: "单位" }));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/stores/__tests__/refStore.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/stores src/types
git commit -m "feat: 食材与单位 store，按使用次数排序并保护被引用的条目"
```

---

### Task 3: 分类与标签 store（一张表两个 kind）

**Files:**
- Create: `src/stores/label.ts`、`src/stores/__tests__/label.test.ts`

**Interfaces:**
- Consumes: `getDb`、`freshTestDb`、`LabelKind`、`LabelWithUsage`、`RefStore`（Task 2）。
- Produces: `useLabelStore`、`asRefStore(kind)`。`asRefStore` 让 `RefSheet` 不用为分类/标签写第二种适配。

- [ ] **Step 1: 写失败的测试**

```ts
it("fetchAll(kind) 只返回该 kind 的行", ...)          // 建「炒菜」(category)、「吐司」(tag) → fetchAll("tag") 只有吐司
it("使用次数把两条路径都算进来：被选为分类的菜谱数 + 被打成标签的菜谱数", ...)
   // 菜 A 分类=炒菜、标签=吐司；菜 B 分类=炒菜、标签=吐司
   // 期望 炒菜 usage_count 2、吐司 usage_count 2
it("软删的菜谱不计入使用次数", ...)
it("分类与标签可以重名，互不冲突", ...)                // add("面包", "category") 后再 add("面包", "tag") 成功
it("同一 kind 内重名（忽略大小写）被拒绝", ...)         // add("Bread") 后 add("bread") → rejects.toThrow("同名分类已存在")
it("add trim、纯空格拒绝", ...)
it("remove 被引用的分类被拒绝且不改库", ...)            // 「炒菜」被 1 道菜当分类 → rejects.toThrow("有 1 道菜谱在用「炒菜」，不能删除")
it("remove 被引用的标签被拒绝", ...)
it("remove 未被引用成功软删", ...)
it("asRefStore(kind) 返回的形状能被 RefSheet 用（items/fetchAll/add/update/remove 五个都在）", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/label.test.ts`
Expected: FAIL，找不到 `src/stores/label.ts`

- [ ] **Step 3: 实现**

`fetchAll(kind)` 的计数子查询用两条路径 `UNION ALL` 再按 id 聚合：

```sql
SELECT x.id AS id, COUNT(DISTINCT x.recipe_id) AS cnt FROM (
  SELECT r.category_id AS id, r.id AS recipe_id FROM recipes r
    WHERE r.deleted_at IS NULL AND r.category_id IS NOT NULL
  UNION ALL
  SELECT rl.label_id AS id, rl.recipe_id AS recipe_id FROM recipe_labels rl
    JOIN recipes r2 ON r2.id = rl.recipe_id AND r2.deleted_at IS NULL
) x
GROUP BY x.id
```

外层 `LEFT JOIN` 回 `labels`，`WHERE l.kind = ? AND l.deleted_at IS NULL`，`ORDER BY usage_count DESC, l.name ASC, l.id ASC`。

`asRefStore(kind)` 返回的对象里，`items` 是一个包住 `fetchAll(kind)` 结果的 `computed`，`add(name)` 内部调 `add(kind, name)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/stores/__tests__/label.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/stores
git commit -m "feat: 分类与标签 store，共用一张表按 kind 区分"
```

---

### Task 4: 菜谱 store

**Files:**
- Create: `src/stores/recipe.ts`、`src/stores/__tests__/recipe.test.ts`

**Interfaces:**
- Consumes: `getDb`、`freshTestDb`、`RecipeInput`、`RecipeListItem`、`RecipeDetail`（Task 1）；`useIngredientStore`、`useLabelStore` 的建数据能力（Task 2、3，测试里用来铺数据）。
- Produces: `useRecipeStore` 的 `fetchAll` / `getDetail` / `create` / `update` / `remove`。

- [ ] **Step 1: 写失败的测试**

```ts
it("create 返回新 id，详情能按 sort_order 回读步骤和食材", ...)
   // 3 条步骤、2 条食材（顺序打乱传入）→ getDetail 里顺序是传入顺序
it("create 把标签写进 recipe_labels", ...)
it("create 未选分类时报错且库里没有新行", ...)         // rejects.toThrow("请选择分类")
it("create 菜名 trim；纯空格菜名被拒绝", ...)          // rejects.toThrow("请输入菜名")
it("同一道菜里重复添加同一个食材可以保存，且使用次数只算 1 次", ...)  // Review Focus 1
it("create 允许空菜谱：没有步骤、没有食材", ...)        // Review Focus 4
it("update 改菜名、改食材用量、删一条步骤、加一条标签后回读一致", ...)
it("update 后旧的步骤和食材行被软删而不是物理删除", ...) // getDetail 不含旧行；直接查库能看到旧行 deleted_at 非 NULL
it("update 只改步骤时 recipes.updated_at 变大", ...)
it("update 只改食材用量时 recipes.updated_at 变大", ...)
it("update 只加删标签时 recipes.updated_at 变大", ...)
it("update 只换封面时 recipes.updated_at 变大", ...)
it("fetchAll 按 updated_at DESC 且带出分类与标签", ...)
it("remove 只软删父行，子行原封不动", ...)              // 直接查 recipe_steps 断言 deleted_at 仍为 NULL
it("remove 后该菜谱引用的食材使用次数减 1", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/recipe.test.ts`
Expected: FAIL，找不到 `src/stores/recipe.ts`

- [ ] **Step 3: 实现**

要点（**这几条是本任务的全部难点，逐条落实**）：

- 所有写入都带 `updated_at` / `created_at` = `new Date().toISOString()`。
- **先插后删，不许先删后插**。改子表时：先把新的步骤/食材行插进去，再 `UPDATE ... SET deleted_at = ?` 软删旧行。中途失败留下的是重复行（看得见、能修），而不是丢数据。在函数上方加一行注释：

  ```ts
  // shortcut: 无事务（plugin-sql 连接池不保证 BEGIN 与后续语句同连接，见规格 §4）
  //          故用「先插后删」，崩溃点最坏留下重复行而非丢数据。真需要原子性时改走 Rust 侧命令。
  ```

- **先插后删的「旧行」范围**：`update` 一开始就 `getDetail(id)` 拿到旧的步骤 id 与食材行 id，用它们做软删目标；新插入的行 id 不在其中。
- `recipe_labels` 没有软删除：先 `INSERT OR IGNORE` 选中的，再 `DELETE ... WHERE recipe_id = ? AND label_id NOT IN (<选中的>)`。选中的集合为空时用 `DELETE ... WHERE recipe_id = ?`。
- **父行 bump**：`create`/`update` 的最后一步都是 `UPDATE recipes SET name = ?, cover_path = ?, category_id = ?, updated_at = ? WHERE id = ?`——即使只改了步骤也要走这一步（规格 §10.7）。`update` 的测试会钉住这一点。
- 校验顺序：菜名 trim 后为空 → `请输入菜名`；`category_id` 为空串 → `请选择分类`。
- `getDetail` 的食材行 JOIN 出 `ingredient_name`（`LEFT JOIN ingredients`）和 `unit_name`（`LEFT JOIN units`），`ORDER BY ri.sort_order ASC, ri.id ASC`；步骤 `ORDER BY sort_order ASC, id ASC`。
- `amount` 存 `null` 表示「适量」，不要存 0。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/stores/__tests__/recipe.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/stores
git commit -m "feat: 菜谱 store，支持增删改查与子表全量更新"
```

---

### Task 5: 通用底部 sheet（外加两个照抄件）

**Files:**
- Create: `src/components/ConfirmDialog.vue`、`src/composables/useKeyboardInset.ts`（均从 `D:\projects\my\wee-count` 原样复制）、`src/components/RefSheet.vue`、`src/components/__tests__/RefSheet.test.ts`

**Interfaces:**
- Consumes: `RefStore`（Task 2、3）。
- Produces: `RefSheet`（props/emits 见「跨任务的既定接口」）。Task 6、9 会用它。

- [ ] **Step 1: 抄两个现成件**

从 `D:\projects\my\wee-count` 复制 `src/components/ConfirmDialog.vue` 和 `src/composables/useKeyboardInset.ts` 到本仓同名路径，**不改逻辑**。复制后把 wee-count 特有的 CSS 变量（`bg-surface`、`text-text`、`text-text-secondary`、`bg-primary` 等）按本仓 `src/assets/main.css` 里已有的 Tailwind 主题对齐；本仓若没有这些颜色变量，就换成等价的标准 Tailwind 类（`bg-white`、`text-slate-900`、`text-slate-500`、`bg-blue-600`），不要往 CSS 里新增主题变量。

- [ ] **Step 2: 写失败的测试**

```ts
it("列表按 store.items 的顺序渲染，新建的条目排在该位置", ...)   // items 里 usage_count 5、0 → 顺序不变
it("筛选框按名称包含过滤，清空后恢复全部", ...)                 // 输入「鸡」→ 只剩「鸡蛋」
it("single 模式点第二行时替换选中，只有一个勾", ...)
it("multiple 模式点两行有两个勾，再点一次取消勾选", ...)
it("确定按钮 emit('select', [...]) 并把选中 id 传出去", ...)
it("列表为空时显示 emptyHint", ...)
it("点「新建」进表单模式，输入名称保存后回到列表且选中它", ...)
it("保存时名称纯空格 → 显示错误、不调 store.add", ...)
it("store.add 抛「同名食材已存在」→ 错误显示在表单里且留在表单模式", ...)
it("点「删除」弹 ConfirmDialog，确认后才调 store.remove", ...)
it("store.remove 抛错 → 弹提示对话框，条目还在列表里", ...)
it("关闭再打开时选中态与筛选框被重置", ...)
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run test -- src/components/__tests__/RefSheet.test.ts`
Expected: FAIL，找不到 `src/components/RefSheet.vue`

- [ ] **Step 4: 实现 `RefSheet.vue`**

结构照 `wee-count/src/components/CategorySheet.vue`：`Teleport to="body"` + 遮罩 + 面板；面板内两种模式（列表 / 表单）用同一个 `v-if` 切换，**不开第二层弹窗**；底部内边距用 `useKeyboardInset()` 算出的键盘高度。

去掉 wee-count 那套 emoji 图标分组（本项目不需要图标）。新增一个筛选输入框（`ref` + 本地 `computed` 过滤，**不过滤使用次数排序**），放在列表顶部——食材变多时靠它找。单选模式在列表模式下点路径直接返回（点行 = 选中 + `emit('select', [id])` + 关窗），多选模式点行只切换勾选，靠底部「确定」按钮返回。行内的「编辑」「删除」按钮必须 `@click.stop`，否则点它们会顺手把这条选中并关窗。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test -- src/components/__tests__/RefSheet.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/components src/composables
git commit -m "feat: 通用底部选择面板，食材、单位、分类、标签共用"
```

---

### Task 6: 食材选择 sheet（多一步数量与单位）

**Files:**
- Create: `src/components/IngredientSheet.vue`、`src/components/__tests__/IngredientSheet.test.ts`

**Interfaces:**
- Consumes: `RefSheet`（Task 5）、`useIngredientStore`、`useUnitStore`（Task 2）。
- Produces: `IngredientSheet`（props/emits 见「跨任务的既定接口」）。

- [ ] **Step 1: 写失败的测试**

```ts
it("第一步列出食材（按使用次数倒序）并带筛选框", ...)
it("选中食材后进第二步，显示食材名、数量输入框、单位选择行", ...)
it("第二步选单位打开单位 sheet，选中后回填单位名", ...)
it("数量留空 + 单位留空 → emit payload { amount: null, unit_id: null }", ...)
it("数量填 0 或负数 → 显示错误且不 emit", ...)          // Review Focus 2
it("数量填非数字（输入框被粘进 'abc'）→ 视为空", ...)
it("数量填 2、单位选「个」→ payload { amount: 2, unit_id: <个的id> }", ...)
it("在这一层新建食材后自动选中它并进入第二步", ...)
it("关闭时重置到第一步", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/components/__tests__/IngredientSheet.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

两步都在同一个面板里：第一步直接复用 `RefSheet` 的列表+筛选+新建能力（把 `useIngredientStore` 包成 `RefStore` 传进去，或把它的列表部分抽成 `RefSheet` 的插槽——**选件数少的那种**），选中后切到第二步；第二步只有一个数量 `<input inputmode="decimal">`、一个「单位」行（点开第二个 `RefSheet`，`mode="single"`）、一个「确定」。

数量的处理：`Number.isFinite(n) && n > 0` 才写成数字，否则 `null`；填了 0 或负数就报错（不是静默当空——用户填 0 是有意为之，要告诉他）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/components/__tests__/IngredientSheet.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components
git commit -m "feat: 食材选择面板，带数量与单位两步录入"
```

---

### Task 7: 图片——压缩、落盘、显示

**Files:**
- Create: `src/services/imageStore.ts`、`src/services/__tests__/imageStore.test.ts`、`src/components/ImagePicker.vue`、`src/components/__tests__/ImagePicker.test.ts`
- Modify: `src-tauri/tauri.conf.json`、`src/main.ts`

**Interfaces:**
- Consumes: 无（不依赖任何 store）。
- Produces: `pickAndSaveImage`、`saveImageBytes`、`setImageBaseDir`、`imageSrc`、`ImageDeps`（见「跨任务的既定接口」）；`ImagePicker` 组件（Task 9 用）。

- [ ] **Step 1: 写失败的测试**

`src/services/__tests__/imageStore.test.ts`，注入假 `ImageDeps`：

```ts
it("pickFromGallery 返回 null 时整条链路返回 null，不写盘", ...)
it("最长边是长边时缩到 1280，短边按比例", ...)          // 传入 4000x3000 的假解码器断言 scaleToFit 的输出
it("竖图以高度为准", ...)                              // 1080x4000
it("小图不放大", ...)                                  // 800x600 → 800x600
it("JPEG 质量参数是 0.72", ...)
it("落盘文件名以 images/ 开头、数据库侧返回的是裸文件名", ...)
it("decodeToJpeg 抛错 → { ok: false, message: '这张图读不出来，换一张试试' } 且没有写盘", ...)
it("writeImage 抛错 → 返回 ok:false，不冒泡异常", ...)
it("imageSrc(name) 返回 convertFileSrc 出来的地址", ...)
```

`src/components/__tests__/ImagePicker.test.ts`：

```ts
it("modelValue 为 null 时显示占位，有值时显示图", ...)
it("点占位打开「拍照 / 从相册选 / 移除」三个选项", ...)
it("选相册成功 → emit update:modelValue 带上文件名", ...)
it("用户取消 → 不发 emit", ...)
it("失败 → 显示 message，不发 emit", ...)
it("已有图时点「移除」→ emit update:modelValue 传 null", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/__tests__/imageStore.test.ts src/components/__tests__/ImagePicker.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `imageStore.ts`**

- `scaleToFit` 与 `sniffImageMime` 从 `D:\projects\my\wee-count\src\services\ai\imageScale.ts` 复制。`JPEG_QUALITY` 用 **0.72**。
- **不要**复制 wee-count 那个「压缩后超 1 MiB 就拒绝」的闸门，也**不要**复制 `ACCEPTED_MIME` 白名单——本项目图只落本地盘，解不开就报 `这张图读不出来，换一张试试`（规格 §10.4）。把这条差异写进文件顶部的注释，免得后人以为是漏抄。
- 生产依赖 `realDeps`：`pickFromGallery` 用 `plugin-dialog` 的 `open({ multiple: false, directory: false, filters: [{ name: "图片", extensions: ["jpg","jpeg","png","webp","heic","heif"] }] })` + `plugin-fs` 的 `readFile`；`decodeToJpeg` 用 `createImageBitmap` + canvas；`writeImage` 用 `plugin-fs` 的 `writeFile(join(baseDir, "images", name), bytes)`，写前 `mkdir` 一次。
- 文件名用 `crypto.randomUUID() + ".jpg"`。

- [ ] **Step 4: 实现 `ImagePicker.vue`**

一个按钮/预览框：有值显示图（`imageSrc(modelValue)`），无值显示「+ 封面图」占位。点击展开一行内联选项（拍照 / 从相册选 / 移除）——**不要再套一层底部 sheet**。拍照走 `<input type="file" accept="image/*" capture="environment">`，`change` 后把 `File` 读成字节交给 `saveImageBytes`。

`@click` 触发隐藏的 `input.click()`，样式与 wee-count `ProfilePage.vue` 里的头像上传一致。

- [ ] **Step 5: 配 asset protocol 与 CSP**

`src-tauri/tauri.conf.json`：`app.security` 加 `"assetProtocol": { "enable": true, "scope": ["$APPDATA/**"] }`；`csp` 的 `img-src` 追加 `asset: http://asset.localhost`。

`src/main.ts` 在 `initDb()` 附近调用 `setImageBaseDir(await appDataDir())`（`appDataDir` 来自 `@tauri-apps/api/path`）。

- [ ] **Step 6: 跑测试确认通过**

Run: `npm run test -- src/services/__tests__/imageStore.test.ts src/components/__tests__/ImagePicker.test.ts`
Expected: PASS

- [ ] **Step 7: 真机验证拍照路径（规格 §12 风险 1）**

`npm run tauri android dev`，在设备上打开任意用到 `ImagePicker` 的地方（本任务做完时可以先临时挂到首页试一次，Task 9 之后从编辑页试）。确认：点「拍照」能唤起相机；拍完的图能显示。

- 能唤起 → 在 `ImagePicker.vue` 顶部注释记一句「拍照走 webview 的 capture，零依赖」，继续。
- 唤不起 → 改走社区相机插件，**接口不变**（`pickFromGallery` / `saveImageBytes` 签名不动），把插件调用关在 `imageStore.ts` 的 `realDeps` 里，并把这条记进 `docs/` 的开发者笔记。
- 同时确认相册选择与「图能不能显示出来」（asset protocol + CSP），这是风险 2。

- [ ] **Step 8: 提交**

```bash
git add src/services src/components src/main.ts src-tauri/tauri.conf.json
git commit -m "feat: 图片压缩与本地存储，支持相册选择与拍照"
```

---

### Task 8: 列表页 + 路由

**Files:**
- Create: `src/views/RecipeList.vue`、`src/views/__tests__/RecipeList.test.ts`
- Modify: `src/router/index.ts`
- Delete: `src/views/HomeView.vue`、`src/views/__tests__/HomeView.test.ts`

**Interfaces:**
- Consumes: `useRecipeStore`（Task 4）、`imageSrc`（Task 7）。
- Produces: 路由 `/`（列表）、`/recipe/new`、`/recipe/:id/edit`、`/recipe/:id`。

- [ ] **Step 1: 写失败的测试**

```ts
it("按 store.recipes 的顺序渲染卡片，显示菜名", ...)
it("显示分类名与全部标签", ...)
it("有封面时用 imageSrc 出来的地址，无封面时显示菜名首字", ...)
it("空列表显示「还没有菜谱，点下面的加号记一道」和加号", ...)     // Review Focus 4 的显示侧
it("超长菜名有截断类，不撑破卡片", ...)                          // Review Focus 5
it("点卡片跳到 /recipe/:id", ...)
it("点加号跳到 /recipe/new", ...)
it("onMounted 时调 store.fetchAll", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/views/__tests__/RecipeList.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现列表页**

卡片网格（手机两列 `grid-cols-2`，宽屏 `sm:grid-cols-3`），卡片内容：封面（`aspect-[4/3] object-cover`，无封面则首字大号居中）、菜名（`line-clamp-2` 做截断兜底）、分类名、标签 chip。右下角固定「+」按钮。**本轮不加任何筛选控件**（规格 §6.3）。

- [ ] **Step 4: 改路由、删占位页**

`src/router/index.ts` 改成四条路由。删除 `src/views/HomeView.vue` 与 `src/views/__tests__/HomeView.test.ts`（规格 §6.3 已确认）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，且不再有引用 HomeView 的测试失败

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: 菜谱列表页顶替首页占位，接入三条菜谱路由"
```

---

### Task 9: 录入/编辑页

**Files:**
- Create: `src/views/RecipeEdit.vue`、`src/views/__tests__/RecipeEdit.test.ts`

**Interfaces:**
- Consumes: `useRecipeStore`、`useLabelStore`（Task 3、4）、`RefSheet`（Task 5）、`IngredientSheet`（Task 6）、`ImagePicker`（Task 7）、`useIngredientStore` / `useUnitStore`（Task 2）。
- Produces: 路由 `/recipe/new` 与 `/recipe/:id/edit` 的页面。

- [ ] **Step 1: 写失败的测试**

```ts
it("新建模式：菜名空时保存按钮不可点", ...)
it("新建模式：菜名填了但没选分类 → 保存报「请选择分类」，store.create 未被调用", ...)   // 规格 §10.3
it("填了菜名和分类即可保存一个空菜谱（无步骤无食材）", ...)                              // Review Focus 4
it("点分类行打开 RefSheet 单选，选中后行上显示分类名", ...)
it("点标签行打开 RefSheet 多选，选中显示为 chip，点 chip 的 × 取消", ...)
it("点「添加食材」打开 IngredientSheet，确认后追加一行「食材名 数量 单位」", ...)
it("食材行可删，删完回到空态不报错", ...)
it("步骤可加、可删、可上下移，序号跟着重排", ...)
it("步骤文本纯空白的行在保存时被丢弃", ...)                // Review Focus：空行不该存进库
it("数量在 store 层被挡：构造 amount 为负数时保存报错而不是写库", ...)   // Review Focus 2
it("编辑模式：onMounted 拉详情，各字段被填上", ...)
it("编辑模式：删掉最后一条步骤后保存，回读详情里没有步骤", ...)
it("有未保存改动时点返回 → 弹 ConfirmDialog，取消则不跳转", ...)
it("保存成功后跳到详情页 /recipe/:id", ...)
it("store.create 抛错 → 错误显示在页面上，不跳转", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/views/__tests__/RecipeEdit.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

顺序按规格 §6.2：菜名 → 封面图 → 分类 → 标签 → 食材 → 步骤 → 保存/取消。测试用 `mockRouter`（`vi.mock("vue-router")`）断言跳转，不要起真路由。

本地状态用一个 `RecipeInput` 形状的 `ref`（步骤和食材各自带一个只用于渲染的本地 `key`，提交前剥掉）。步骤的上下移用按钮（`↑` `↓`），不做拖拽——手机上拖拽在 `Teleport` 出来的 sheet 里会和滚动打架。

保存前清洗一次输入：菜名 `trim`；步骤文本 `trim` 后为空的丢弃；食材的 `amount` 必须是正有限数否则 `null`（0 和负数在这一步就报错，参照 Task 6 的处理）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/views/__tests__/RecipeEdit.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/views
git commit -m "feat: 菜谱录入与编辑页，食材步骤分类标签一次录完"
```

---

### Task 10: 详情页

**Files:**
- Create: `src/views/RecipeDetail.vue`、`src/views/__tests__/RecipeDetail.test.ts`

**Interfaces:**
- Consumes: `useRecipeStore.getDetail`、`useRecipeStore.remove`（Task 4）、`imageSrc`（Task 7）。
- Produces: 路由 `/recipe/:id` 的页面。

- [ ] **Step 1: 写失败的测试**

```ts
it("显示菜名、分类、标签", ...)
it("食材行显示「数量 单位 食材名」三段：2 个 鸡蛋 / 200 克 五花肉 / 适量 盐", ...)
   // amount 与 unit 都为空 → 显示「适量」；只有数字没单位 → 只显示数字
it("步骤按 sort_order 渲染，带序号", ...)
it("步骤有插图时渲染图", ...)
it("空菜谱（无食材无步骤）不报错，两个区块各显示一句空态文案", ...)      // Review Focus 4
it("点「编辑」跳到 /recipe/:id/edit", ...)
it("点「删除」弹 ConfirmDialog，确认后调 store.remove 并跳回列表", ...)
it("id 不存在时显示「菜谱不存在」并能返回列表", ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/views/__tests__/RecipeDetail.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

食材清单在前，字号偏大（`text-lg`），步骤在后、每条一个序号圆点。**不做计时器、不做防熄屏、不做逐步高亮**（规格 §6.4，那是跟做模式）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: 全绿

- [ ] **Step 5: 全量验证**

```bash
npm run test
npm run build          # vue-tsc --noEmit + vite build
cargo check
```

再跑一次 `npm run tauri android dev`，用手走完：新建分类 → 新建单位 → 新建食材 → 录一道菜（带封面、带步骤图、重复加一次同一食材）→ 回列表 → 打开详情 → 改一次 → 删掉。

- [ ] **Step 6: 提交**

```bash
git add src/views
git commit -m "feat: 菜谱详情页，食材清单与步骤大字号展示"
```

---

## 自检记录

- **规格覆盖**：§4 数据模型 → Task 1；§5 使用次数 → Task 2、3；§6.1 sheet → Task 5、6；§6.2 编辑页 → Task 9；§6.3 列表页 → Task 8；§6.4 详情页 → Task 10；§7 图片 → Task 7；§8 文件清单与依赖 → Task 1、5、7；§9 测试计划七条 → 第 1 条 Task 2/3、第 2 条 Task 2/3、第 3 条 Task 2/3、第 4 条 Task 4、第 5 条 Task 4、第 6 条 Task 5、第 7 条 Task 7、第 8 条 Task 4、第 9 条 Task 4/9；§10.3 分类必填 → Task 4、9；§10.7 bump → Task 4；§10.8 只软删父行 → Task 4；§10.9 不预置种子 → 全篇没有 seed 任务；§12 风险 1、2 → Task 7 Step 7。
- **类型一致性**：全篇的 `RefStore` / `WithUsage` / `RecipeInput` / `imageSrc` 只在「跨任务的既定接口」里定义一次，各任务只引用不重定义。
- **Review Focus**：5 条各自落在 Task 4（1、4）、Task 2/3（3）、Task 8（5）、Task 9（2）的测试里。
