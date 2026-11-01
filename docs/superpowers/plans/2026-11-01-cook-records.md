# 制作记录（真实体）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 冷启动恢复上次选中的团队；把「一次制作」做成真实体（本地 + 服务端 + 同步），并加制作流水列表 / 详情页与库存扣减记录入口。

**Architecture:** 新增 `cook_records` 表（LWW + 软删，带服务端派生的作者两列），`inventory_usages` 加 `cook_id` 归属到记录。写入时先建记录再写使用记录（沿用「不开事务」的既有契约）。读取在库存 store 里用 JOIN 派生明细；UI 只消费 store 的聚合结果。

**Tech Stack:** Vue 3 + TypeScript + Pinia + vue-router + SQLite（plugin-sql）；Go + pgx + Postgres + golang-migrate；vitest；Go test（testcontainers）。

**Spec:** `docs/superpowers/specs/2026-11-01-cook-records-design.md`

## Global Constraints

- TypeScript 严格模式，禁止 `any`。
- 测试优先：每个任务先写失败测试，再实现；禁止为让测试变绿而放宽 / 删除已有断言。既有断言与新规格冲突时（本计划只涉及路由名、载荷键集、结果态文案三处）按新规格改写。
- 不重构无关代码，不修改未被本计划列出的文件。
- 每张业务表带 `id`、`updated_at`、`deleted_at`（`cook_records` 已满足）。
- 同步契约：软删 = 写 `deleted_at`；LWW 按 `updated_at`；使用记录只增不清；服务端 `owner_id` 由服务端赋值。
- 迁移必须幂等，重复执行不报错；不删除任何存量数据。
- commit message 用中文，符合中文开发习惯。

## Review Focus

1. **断网 / `/teams` 超时时的冷启动**：用户上次选的团队必须还在，活动范围不能落到空的 `p:local`。测试放在 Task 1。
2. **删过批次之后的制作历史**：老制作的明细仍然完整显示（历史不追改），不能变成「这次没有扣任何库存」。测试放在 Task 3。
3. **老库升级（已有使用记录 `cook_id IS NULL`）**：升级不报错、余量不变、旧记录不进历史。测试放在 Task 2。
4. **队友做的记录 + 菜谱已被删**：作者昵称/头像来自服务端派生的两列；菜谱名回退「已删除的菜谱」。测试放在 Task 5、Task 7。
5. **旧 localStorage 待推送队列（没有 `cook_records` 键）**：解析后缺键要归一化成空数组，不能抛 `undefined.length`。测试放在 Task 7。

---

## 执行约定

- 新会话开工前先读本计划与 `docs/superpowers/specs/2026-11-01-cook-records-design.md`，按 `superpowers:executing-plans` 的方式逐任务执行（用户已选「本会话逐任务实现」，全部分支完成后派一个独立 reviewer 通审）。
- 每个任务先跑该任务的测试确认红，再写实现；任务结束前跑该任务列出的验证命令。
- 不要跨任务顺手改无关文件；发现计划与实际代码不符时，先修计划再实现，并在最终汇报里说明。

---

### Task 1: 冷启动恢复上次选中的团队

**Files:**
- Modify: `src/stores/team.ts`
- Test: `src/stores/__tests__/team.test.ts`

**Interfaces:**
- Produces: `useTeamStore().load()` 在成功拉到团队列表后恢复保存的团队；`restoreCurrentTeam()` 在列表没拉到时不再抹掉 `localStorage["current_team:<uid>"]`。

- [ ] **Step 1: 写失败测试**

在 `describe("登录后的活动范围")` 里加两条：

```ts
it("load 拉到列表后就恢复保存的团队（冷启动不再落在我的菜谱）", async () => {
  localStorage.setItem("current_team:u1", "t1");
  const store = useTeamStore();

  await store.load();

  expect(store.currentTeamId).toBe("t1");
  expect(activeScope.value).toBe("t:t1");
  expect(mocks.fetchRecipeAll).toHaveBeenCalled();
});

it("团队列表没拉到时，恢复不抹掉保存的团队、范围只回落到个人", async () => {
  localStorage.setItem("current_team:u1", "t1");
  mocks.fetchTeams.mockRejectedValue(new Error("network"));
  const store = useTeamStore();

  await expect(store.load()).rejects.toThrow("network");
  await store.restoreCurrentTeam();

  expect(localStorage.getItem("current_team:u1")).toBe("t1");
  expect(store.currentTeamId).toBeNull();
  expect(activeScope.value).toBe("p:u1");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/team.test.ts`
Expected: 第一条 `currentTeamId` 为 `null`；第二条 `localStorage` 被清成 `null`。

- [ ] **Step 3: 实现**

`src/stores/team.ts` 里加模块内状态与读取函数：

```ts
const teamsLoadedFor = ref<string | null>(null);

function savedTeamId(uid: string): string | null {
  return localStorage.getItem(PERSIST_PREFIX + uid);
}
```

`load()` 成功 `cacheTeams(rows)` 后：`teamsLoadedFor.value = uid`，然后按顺序：

1. `currentTeamId.value` 非空且不在 `rows` 里 → `switchTo(null)`；
2. `currentTeamId.value === null` 且 `savedTeamId(uid)` 在 `rows` 里 → `switchTo(saved)`；
3. 否则沿用现有「`activeScope === LOCAL_SCOPE` → 个人范围 + `refreshScopedStores`」分支。

`resetFor()` 里清 `teamsLoadedFor.value = null`。

`restoreCurrentTeam()`：`teamsLoadedFor.value !== uid` 时只做「`activeScope === LOCAL_SCOPE` → `setActiveScope(personalScope(uid))` + `refreshScopedStores()`」，然后 `return`（不 `switchTo`）；否则维持现有逻辑，把读 key 换成 `savedTeamId(uid)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/team.test.ts`
Expected: 全部 PASS（含原有 5 条范围用例）。

- [ ] **Step 5: Commit**

```bash
git add src/stores/team.ts src/stores/__tests__/team.test.ts
git commit -m "fix(团队): 冷启动恢复上次选中的团队，列表拉取失败时不再抹掉选择"
```

---

### Task 2: 本地库结构、迁移与类型

**Files:**
- Modify: `src/db/index.ts`
- Modify: `src/types/index.ts`
- Test: `src/db/__tests__/schema.test.ts`, `src/db/__tests__/migrate.test.ts`

**Interfaces:**
- Produces: 表 `cook_records(id, scope_id, owner_id, recipe_id, owner_nickname, owner_avatar_url, created_at, updated_at, deleted_at)`；`inventory_usages.cook_id TEXT`；TS 类型 `CookRecord` / `CookRecordAuthor` / `CookRecordLine` / `CookRecordDetail` / `IngredientCook`；`InventoryUsage.cook_id: string | null`。

- [ ] **Step 1: 写失败测试**

`src/db/__tests__/schema.test.ts`：把 `cook_records` 加进 `BUSINESS_TABLES` 与 `SCOPED_TABLES`，并在 `inventory_usages` 的列断言里加 `cook_id`（沿用该文件已有的 PRAGMA 断言写法）；把「范围列：五张表 + 库存两张」这条用例的标题改成「范围列：业务表与库存表都带 scope_id」。另加：

```ts
it("cook_records 有 id / updated_at / deleted_at 与派生作者两列", async () => {
  const { db } = await freshTestDb();
  const names = (await db.select<{ name: string }[]>("PRAGMA table_info(cook_records)")).map((c) => c.name);
  expect(names).toEqual(expect.arrayContaining([
    "id", "scope_id", "owner_id", "recipe_id", "owner_nickname", "owner_avatar_url",
    "created_at", "updated_at", "deleted_at",
  ]));
});
```

`src/db/__tests__/migrate.test.ts` 加：

```ts
it("旧库升级后 inventory_usages 补上 cook_id，老使用记录留 NULL", async () => {
  const { db } = await makeTestDb();
  await db.execute(
    `CREATE TABLE inventory_usages (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, owner_id TEXT,
       recipe_id TEXT NOT NULL, batch_id TEXT NOT NULL, amount REAL NOT NULL, used_at TEXT NOT NULL,
       updated_at TEXT NOT NULL, deleted_at TEXT)`,
  );
  await db.execute(
    `INSERT INTO inventory_usages (id, scope_id, owner_id, recipe_id, batch_id, amount, used_at, updated_at)
     VALUES ('us1','p:local',NULL,'r1','b1',10,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
  );
  await initTables(db);
  expect(await db.select("SELECT cook_id FROM inventory_usages WHERE id = 'us1'")).toEqual([{ cook_id: null }]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/db/__tests__/schema.test.ts src/db/__tests__/migrate.test.ts`
Expected: FAIL（`cook_records` 不存在 / `cook_id` 列不存在）。

- [ ] **Step 3: 实现**

`src/db/index.ts`：

- `DDL` 里新增 `cook_records`（`CREATE TABLE IF NOT EXISTS`，列如 Interfaces 所列，`recipe_id` 不写 REFERENCES）。
- `inventory_usages` 的 `CREATE TABLE` 加 `cook_id TEXT`。
- `DDL_INDEXES` 加 `idx_cook_records_scope`、`idx_cook_records_recipe(recipe_id, created_at)`、`idx_inventory_usages_cook(cook_id)`。
- `migrateTables()` 里给 `inventory_usages` 补：`await addColumnIfMissing(db, "inventory_usages", "cook_id", "TEXT")`（放在现有 scope/owner 补列之后）。

`src/types/index.ts`：按 spec §6.1 加五个接口，并给 `InventoryUsage` 加 `cook_id: string | null`。

- [ ] **Step 4: 跑测试确认通过，并检查无 `any`**

Run: `npx vitest run src/db && npx vue-tsc --noEmit`
Expected: PASS；类型检查无错误（此刻会出现未使用类型的报错吗？不会——类型导出不报未使用）。

- [ ] **Step 5: Commit**

```bash
git add src/db/index.ts src/types/index.ts src/db/__tests__/schema.test.ts src/db/__tests__/migrate.test.ts
git commit -m "feat(制作记录): 本地加 cook_records 表与 inventory_usages.cook_id"
```

---

### Task 3: 库存 store 写记录 + 三条读取查询

**Files:**
- Modify: `src/stores/inventory.ts`, `src/types/index.ts`（如需补 `CookRecordAuthor` 使用处）
- Test: `src/stores/__tests__/inventory.test.ts`

**Interfaces:**
- Consumes: Task 2 的类型与列。
- Produces:
  - `commitCook(recipeId: string, lines: CookLine[]): Promise<CookResult>`（签名不变，副作用新增：写一条 `cook_records`，usage 带 `cook_id`）
  - `fetchCookRecords(recipeId: string): Promise<CookRecordDetail[]>`
  - `fetchCookRecord(id: string): Promise<CookRecordDetail | null>`
  - `fetchIngredientCooks(ingredientId: string): Promise<IngredientCook[]>`

- [ ] **Step 1: 写失败测试**

在 `describe("commitCook")` 里加：

```ts
it("每次确认写一条 cook_records，所有使用记录带同一个 cook_id", async () => {
  const egg = await newIngredient();
  const store = useInventoryStore();
  await store.addBatch(batch({ ingredient_id: egg, amount: 300 }));

  await store.commitCook("r1", [
    { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, unit_name: null, amount: 100 },
  ]);

  const records = await db.select<{ id: string; recipe_id: string; created_at: string }[]>(
    "SELECT id, recipe_id, created_at FROM cook_records",
  );
  expect(records).toHaveLength(1);
  expect(records[0].recipe_id).toBe("r1");
  const usages = await db.select<{ cook_id: string | null }[]>("SELECT cook_id FROM inventory_usages");
  expect(usages).toEqual([{ cook_id: records[0].id }]);
  expect(enqueueSync).toHaveBeenCalledWith(
    expect.objectContaining({ cook_records: [expect.objectContaining({ id: records[0].id })] }),
  );
});

it("一行都没扣成也留下一条空记录", async () => {
  const egg = await newIngredient();
  const store = useInventoryStore();

  await store.commitCook("r1", [
    { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, unit_name: null, amount: 2 },
  ]);

  expect(await db.select("SELECT COUNT(*) AS n FROM cook_records")).toEqual([{ n: 1 }]);
  expect(await countUsages()).toBe(0);
});
```

新建 `describe("fetchCookRecords / fetchCookRecord")`：

```ts
it("按记录聚合，跨批次同单位合并，只取该菜谱与当前范围，按时间倒序", async () => {
  const egg = await newIngredient();
  const wheat = await newIngredient("面粉");
  const store = useInventoryStore();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO recipes (id, scope_id, name, category_id, created_at, updated_at)
     VALUES ('r1','p:local','红烧肉','',?,?), ('r2','p:local','馒头','',?,?)`,
    [now, now, now, now],
  );
  await store.addBatch(batch({ ingredient_id: egg, amount: 100 }));
  await store.addBatch(batch({ ingredient_id: egg, amount: 100 }));

  // 时间戳要可控：两次 commitCook 在同一毫秒内会让倒序断言不稳定
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
    await store.commitCook("r1", [
      { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, unit_name: null, amount: 150 },
    ]);
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    await store.commitCook("r1", [
      { ingredient_id: wheat, ingredient_name: "面粉", unit_id: null, unit_name: null, amount: 10 },
    ]);
    vi.setSystemTime(new Date("2026-11-01T11:00:00Z"));
    await store.commitCook("r2", [
      { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, unit_name: null, amount: 5 },
    ]);
  } finally {
    vi.useRealTimers();
  }

  const records = await store.fetchCookRecords("r1");

  expect(records).toHaveLength(2);
  expect(records[0].recipe_name).toBe("红烧肉");
  expect(records[0].lines).toEqual([{ ingredient_name: "面粉", unit_name: null, amount: 10 }]);
  expect(records[1].lines).toEqual([{ ingredient_name: "鸡蛋", unit_name: null, amount: 150 }]);
  expect(await store.fetchCookRecord(records[1].record.id)).toMatchObject({ recipe_name: "红烧肉" });
});

it("删掉批次后历史仍完整（不追改）", async () => {
  const egg = await newIngredient();
  const store = useInventoryStore();
  await store.addBatch(batch({ ingredient_id: egg, amount: 100 }));
  await store.commitCook("r1", [
    { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, unit_name: null, amount: 40 },
  ]);
  const before = await store.fetchCookRecords("r1");
  for (const item of store.batches) await store.removeBatch(item.batch.id);

  expect(await store.fetchCookRecords("r1")).toEqual(before);
});
```

新建 `describe("fetchIngredientCooks")`：造两次制作（一次扣鸡蛋、一次扣面粉），断言只返回鸡蛋那条、`recipe_name` 正确、`parts` 跨批次合计。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/inventory.test.ts`
Expected: FAIL（`fetchCookRecords is not a function`；`cook_records` 无行）。

- [ ] **Step 3: 实现**

`src/stores/inventory.ts`：

- `commitCook` 开头写记录（`id = crypto.randomUUID()`，`created_at = updated_at = now`，两列作者为 NULL），usage `INSERT` 增加 `cook_id` 列与参数。
- 把 `enqueueUsages` 换成 `enqueueCook(recordId, usageIds)`：一次 `enqueueSync({ cook_records: [记录整行], inventory_usages: 使用记录整行 })`；`usageIds` 为空时只推记录。
- 三条查询用 spec §6.2 的 SQL：`cook_records` 过滤 `scope_id = activeScope AND deleted_at IS NULL`；明细 JOIN `inventory_batches → ingredients / units`，**不过滤 `b.deleted_at`**，`GROUP BY u.cook_id, b.ingredient_id, b.unit_id`；`fetchIngredientCooks` 额外 `WHERE b.ingredient_id = ?` 并在 TS 里按 `cr.id` 聚合 `parts`。
- 作者只在 store 一处解析：

```ts
function authorOf(record: CookRecord): CookRecordAuthor {
  const auth = useAuthStore();
  const mine = record.owner_id === null || record.owner_id === auth.serverUserId;
  return mine
    ? { name: auth.nickname, avatar_url: auth.avatarUrl }
    : { name: record.owner_nickname, avatar_url: record.owner_avatar_url };
}
```

- 返回值里带上 `author`（`CookRecordDetail.author`）；导出新方法。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/inventory.test.ts`
Expected: PASS（含原有 addBatch / removeBatch / commitCook 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/stores/inventory.ts src/stores/__tests__/inventory.test.ts src/types/index.ts
git commit -m "feat(制作记录): 确认制作写记录与 cook_id，库存 store 提供记录查询"
```

---

### Task 4: 路由与制作记录列表页

**Files:**
- Modify: `src/router/index.ts`
- Create: `src/views/CookRecords.vue`, `src/utils/time.ts`
- Test: `src/router/__tests__/routes.test.ts`, `src/views/__tests__/CookRecords.test.ts`, `src/utils/__tests__/time.test.ts`

**Interfaces:**
- Consumes: `useInventoryStore().fetchCookRecords(recipeId)`；`CookRecordDetail[]`（`record.id`、`record.created_at`、`author.name`、`author.avatar_url`、`lines`）。
- Produces: 路由名 `recipe-cook-records`（`/recipe/:id/cook`）、`recipe-cook`（`/recipe/:id/cook/new`，现有 `CookPage`）、`recipe-cook-record`（`/recipe/:id/cook/:cookId`）。

- [ ] **Step 1: 写失败测试**

`routes.test.ts` 把原来的 `/recipe/:id/cook` 用例改成：

```ts
it("制作三条路由存在且隐藏 tab 栏，new 不被 :cookId 抢走", () => {
  const paths = ["/recipe/:id/cook", "/recipe/:id/cook/new", "/recipe/:id/cook/:cookId"];
  for (const path of paths) {
    expect(router.getRoutes().find((r) => r.path === path)?.meta.hideTab, path).toBe(true);
  }
  expect(router.resolve("/recipe/r1/cook").name).toBe("recipe-cook-records");
  expect(router.resolve("/recipe/r1/cook/new").name).toBe("recipe-cook");
  expect(router.resolve("/recipe/r1/cook/cr1").name).toBe("recipe-cook-record");
});
```

`src/views/__tests__/CookRecords.test.ts`（新建，照 `InventoryPage.test.ts` 的 mock 方式：`vi.mock("vue-router")` + `vi.mock("@/stores/inventory")`）：

- 空列表 → `[data-test="cook-records-empty"]` 文案含「还没有制作记录」。
- 两条记录 → `[data-test="cook-record"]` 有 2 个，第一行文本含作者昵称与**用本地时区从同一 ISO 算出来的** `YYYY-MM-DD HH:mm`（测试里独立拼，不调实现函数），以及「扣了 N 项食材」。
- 某条记录 `lines: []` → 该行显示「没有扣库存」。
- 点加号 → `push("/recipe/r1/cook/new")`。
- 点第 1 行 → `push("/recipe/r1/cook/cr1")`。

`src/utils/__tests__/time.test.ts`（新建）：`formatLocalDateTime` 对整点、补零（`2026-11-01T01:05:00Z` 按本地时区算出预期值）与非法输入（返回空串即可，页面不渲染）三种情况。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/router/__tests__/routes.test.ts src/views/__tests__/CookRecords.test.ts src/utils/__tests__/time.test.ts`
Expected: FAIL（路由名不符 / 组件与函数不存在）。

- [ ] **Step 3: 实现**

- `src/router/index.ts` 按 Interfaces 加三条路由（`new` 在 `:cookId` 之前），`/recipe/:id/cook` 组件改为 `CookRecords`。
- `src/views/CookRecords.vue`：`AppHeader title="制作记录" show-back @back="router.back()"`，`action` 槽放 `Plus`（`data-test="cook-record-add"`，`aria-label="新增制作记录"`）→ `/recipe/:id/cook/new`；`onMounted` 调 `fetchCookRecords(recipeId)`；行内显示时间 + 作者（`UserAvatar`：`:url="author.avatar_url" :name="author.name ?? ''"`，尺寸类 `h-6 w-6 rounded-full`，旁边昵称文本 `data-test="cook-record-author"`；`author.name` 为空时整块不渲染）+ `扣了 N 项食材`（`lines.length === 0` 时为「没有扣库存」）；空态与点击跳转如测试。
- 时间格式化用本地时区 `YYYY-MM-DD HH:mm`（新建 `src/utils/time.ts` 的 `formatLocalDateTime(iso: string): string`，手写补零，不引依赖；解析失败返回空串。Task 5、Task 6 复用它）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/router/__tests__/routes.test.ts src/views/__tests__/CookRecords.test.ts src/utils/__tests__/time.test.ts src/views/__tests__/RecipeDetail.test.ts`
Expected: PASS（`RecipeDetail` 的「制作」按钮仍指向 `/recipe/r1/cook`）。

- [ ] **Step 5: Commit**

```bash
git add src/router/index.ts src/router/__tests__/routes.test.ts src/views/CookRecords.vue src/views/__tests__/CookRecords.test.ts src/utils/time.ts src/utils/__tests__/time.test.ts
git commit -m "feat(制作记录): 制作入口先进流水列表，新增按钮进表单"
```

---

### Task 5: 制作详情页与结果态文案

**Files:**
- Create: `src/views/CookRecordDetail.vue`
- Modify: `src/views/CookPage.vue`（仅一句文案）
- Test: `src/views/__tests__/CookRecordDetail.test.ts`, `src/views/__tests__/CookPage.test.ts`

**Interfaces:**
- Consumes: `fetchCookRecord(id)` → `CookRecordDetail | null`；`formatLocalDateTime`（Task 4）。
- Produces: 路由 `recipe-cook-record` 的页面组件。

- [ ] **Step 1: 写失败测试**

`CookRecordDetail.test.ts`（mock `vue-router` 的 `useRoute().params = { id: "r1", cookId: "cr1" }` 与 inventory store）：

- 有明细 → 文本含菜谱名「红烧肉」、作者昵称、**用本地时区从同一 ISO 独立拼出的** `YYYY-MM-DD HH:mm`、每行「鸡蛋 150」。
- `lines: []` → `[data-test="cook-record-empty"]` 含「这次没有扣任何库存」。
- `fetchCookRecord` 返回 `null` → 文案含「记录不存在」。
- 队友记录（`owner_id: "u2"`, `owner_nickname: "老王"`）→ 作者显示「老王」。

`CookPage.test.ts` 新增一条独立用例（不要改已有的「确认后原地进结果态」，它返回的扣减非空）：

```ts
it("扣减为空时结果态说「没有扣任何库存」，不说「没有记账」", async () => {
  availability.set("i1", [{ unit_id: "ge", remaining: 5 }]);
  mocks.commitCook.mockResolvedValue({ deducted: [], shortfall: [] });
  const wrapper = await open();
  await rowOf(wrapper, "五花肉").get('[data-test="cook-amount"]').setValue("2");

  await wrapper.get('[data-test="cook-confirm"]').trigger("click");
  await flushPromises();

  expect(wrapper.text()).toContain("这次没有扣任何库存");
  expect(wrapper.text()).not.toContain("没有记账");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/CookRecordDetail.test.ts src/views/__tests__/CookPage.test.ts`
Expected: FAIL（组件不存在 / 文案不匹配）。

- [ ] **Step 3: 实现**

- `CookRecordDetail.vue`：`AppHeader title="制作记录" show-back`；`onMounted` 取 `cookId` 调 `fetchCookRecord`；渲染作者、时间、菜谱名（`data-test="cook-record-recipe"`，为空时「已删除的菜谱」）、明细行（`data-test="cook-record-line"`，数量用 `Number(amount.toFixed(2))` 去浮点尾巴，与 `InventoryPage.trimNumber` 同口径）、空明细与不存在两种状态。
- `CookPage.vue` 只改结果态那句为 `没有可扣的库存，这次没有扣任何库存`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/CookRecordDetail.test.ts src/views/__tests__/CookPage.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/views/CookRecordDetail.vue src/views/CookPage.vue src/views/__tests__/CookRecordDetail.test.ts src/views/__tests__/CookPage.test.ts
git commit -m "feat(制作记录): 制作详情页，空扣减文案与新语义对齐"
```

---

### Task 6: 库存页展示扣减记录并跳到制作详情

**Files:**
- Modify: `src/views/InventoryPage.vue`
- Test: `src/views/__tests__/InventoryPage.test.ts`

**Interfaces:**
- Consumes: `fetchIngredientCooks(ingredientId): Promise<IngredientCook[]>`（`record.id`、`record.recipe_id`、`record.created_at`、`recipe_name`、`parts`）。

- [ ] **Step 1: 写失败测试**

在现有 InventoryPage 测试里加（复用该文件已有的 `seedBatch` / `rowOf` / `open`；`seedBatch` 的 usage 不带 `cook_id`，所以测试里补写记录再回填）：

```ts
it("展开食材后显示扣减记录，点击进制作详情", async () => {
  await seedBatch({ ingredientId: "i1", ingredientName: "五花肉", amount: 500, unitId: "g", unitName: "g", used: 200 });
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO recipes (id, scope_id, name, category_id, created_at, updated_at)
     VALUES ('r1','p:local','红烧肉','',?,?)`,
    [now, now],
  );
  await db.execute(
    `INSERT INTO cook_records (id, scope_id, owner_id, recipe_id, created_at, updated_at, deleted_at)
     VALUES ('cr1','p:local',NULL,'r1',?,?,NULL)`,
    [now, now],
  );
  await db.execute("UPDATE inventory_usages SET cook_id = 'cr1'");

  const wrapper = await open();
  await rowOf(wrapper, "五花肉").trigger("click");
  await flushPromises();

  const usage = wrapper.get('[data-test="stock-usage"]');
  expect(usage.text()).toContain("红烧肉");
  await usage.trigger("click");
  expect(mocks.push).toHaveBeenCalledWith("/recipe/r1/cook/cr1");
});

it("没有扣减记录时不渲染扣减块", async () => {
  await seedBatch({ ingredientId: "i1", ingredientName: "五花肉", amount: 500 });

  const wrapper = await open();
  await rowOf(wrapper, "五花肉").trigger("click");
  await flushPromises();

  expect(wrapper.find('[data-test="stock-usage"]').exists()).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/InventoryPage.test.ts`
Expected: FAIL（`stock-usage` 不存在）。

- [ ] **Step 3: 实现**

`InventoryPage.vue`：

- `const cooks = ref(new Map<string, IngredientCook[]>())`；`toggle()` 展开时若 `!cooks.value.has(id)` 调 `fetchIngredientCooks(id)` 并写入（失败静默保留空数组，不阻塞库存页）。
- 批次列表之后渲染扣减块：`v-if="(cooks.get(row.ingredient_id) ?? []).length > 0"`，标题「扣减记录」，每行 `data-test="stock-usage"`：`菜谱名（为空 → 已删除的菜谱） · 时间（formatLocalDateTime） · parts 用「、」拼接的数量单位`；点击 `router.push(\`/recipe/${item.record.recipe_id}/cook/${item.record.id}\`)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/InventoryPage.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/views/InventoryPage.vue src/views/__tests__/InventoryPage.test.ts
git commit -m "feat(库存): 展开食材显示扣减记录，可跳到那次制作详情"
```

---

### Task 7: 本地同步载荷、LWW 合并、推送与认领

**Files:**
- Modify: `src/services/sync.ts`, `src/services/migration.ts`
- Test: `src/services/__tests__/sync.test.ts`, `src/services/__tests__/syncMerge.test.ts`, `src/services/__tests__/migration.test.ts`

**Interfaces:**
- Consumes: `cook_records` 表（Task 2）。
- Produces: `SyncPayload.cook_records: CookRecord[]`；`collectPushPayload()` 推我的记录；远端合并按 LWW 并刷新作者两列；`claimLocalScope` 改写 `cook_records.scope_id` / `owner_id`。

- [ ] **Step 1: 写失败测试**

`sync.test.ts`：

- 「上行载荷的键集被钉死」用例的期望数组加 `"cook_records"`（按字母序排在**第一个**，在 `"files"` 前）。
- `collectPushPayload` 用例补一条 `cook_records`（`scope_id='p:u1', owner_id='u1'` 与 `owner_id='u2'` 各一条，断言只推我的）。

`syncMerge.test.ts`（在该文件里加一个 `record(over: Partial<CookRecord>)` 构造器，照现有 `batch()` / `usage()` 的写法）：

```ts
it("cook_records 走 LWW：后到的 updated_at 覆盖，旧的不动", async () => { /* 两次 applyRemoteChanges，断言 recipe_id / deleted_at */ });
it("cook_records 的 LWW 跳过分支仍刷新作者两列", async () => {
  await applyRemoteChanges(remote({ cook_records: [record({ id: "cr1", owner_nickname: "老王", updated_at: T1 })] }), db);
  await applyRemoteChanges(remote({ cook_records: [record({ id: "cr1", owner_nickname: "王叔", updated_at: T0 })] }), db);
  expect(await db.select("SELECT owner_nickname FROM cook_records WHERE id = 'cr1'")).toEqual([{ owner_nickname: "王叔" }]);
});
```

`migration.test.ts`：认领用例里插一条 `scope_id='p:local'` 的 `cook_records`，认领后断言 `scope_id='p:u1'`、`owner_id='u1'`。

`sync.test.ts` 再补一条旧队列归一化（Review Focus 5）：

```ts
it("旧待推送队列缺 cook_records 键时归一化成空数组", () => {
  localStorage.setItem(
    "pending_sync:u1",
    JSON.stringify({ ingredients: [], units: [], labels: [], recipes: [], inventory_batches: [], inventory_usages: [], files: [] }),
  );

  enqueueSync({ inventory_usages: [usage()] });
  resetSyncTimers();

  const parsed = JSON.parse(localStorage.getItem("pending_sync:u1") as string);
  expect(parsed.cook_records).toEqual([]);
  expect(parsed.inventory_usages).toHaveLength(1);
});
```
（`usage()` 用该文件已有写法造一条最小使用记录，或直接写内联字面量。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/__tests__/sync.test.ts src/services/__tests__/syncMerge.test.ts src/services/__tests__/migration.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `sync.ts`：`SyncPayload` 加 `cook_records: CookRecord[]`；`emptyPayload()` 加空数组；`PENDING_KEYS` 加 `"cook_records"`；`pendingFor()` 解析 localStorage 后 `p = { ...emptyPayload(), ...(JSON.parse(raw) as Partial<SyncPayload>) }`（缺键归一化）；`applyRemoteChanges` 在批次之后、使用记录之前加 LWW 分支（插入/更新带作者两列；跳过分支只 `UPDATE` 作者两列）；usage INSERT 增加 `cook_id`；`collectPushPayload` 加 `SELECT * FROM cook_records WHERE owner_id = ?` 并归一化时间戳。
- `migration.ts`：`claimLocalScope` 的 `for (const table of ["inventory_batches", "inventory_usages"])` 加 `"cook_records"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/services/__tests__/sync.test.ts src/services/__tests__/syncMerge.test.ts src/services/__tests__/migration.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/services/sync.ts src/services/migration.ts src/services/__tests__/sync.test.ts src/services/__tests__/syncMerge.test.ts src/services/__tests__/migration.test.ts
git commit -m "feat(同步): 制作记录进载荷与 LWW 合并，认领时随范围改写"
```

---

### Task 8: 服务端迁移、模型与同步合并

**Files:**
- Create: `backend/internal/database/migrations/002_cook_records.up.sql`, `002_cook_records.down.sql`, `backend/internal/model/cook.go`
- Modify: `backend/internal/model/inventory.go`, `backend/internal/model/sync.go`, `backend/internal/service/inventory.go`, `backend/internal/service/sync.go`
- Test: `backend/internal/database/migrations_test.go`, `backend/internal/service/sync_integration_test.go`, `backend/internal/service/sync_pull_test.go`

**Interfaces:**
- Consumes: 客户端载荷 `cook_records[]`、`inventory_usages[].cook_id`。
- Produces: 表 `cook_records`；`model.CookRecord`；`model.InventoryUsage.CookID *string`；`SyncPayload.CookRecords`；响应里的 `owner_nickname` / `owner_avatar_url` 由 `LEFT JOIN users` 派生。

- [ ] **Step 1: 写失败测试**

`migrations_test.go`：把 `"cook_records"` 加进 `TestMigrationsCreateAllTables` 的表清单，然后在库存两张表的断言旁加（该函数没有 `ctx` 变量，照周边写法用 `context.Background()`）：

```go
for _, column := range []string{"id", "owner_id", "team_id", "recipe_id", "created_at", "updated_at", "deleted_at", "server_seq"} {
	if !columnExists(context.Background(), t, pool, "cook_records", column) {
		t.Errorf("cook_records 应有 %s 列", column)
	}
}
if !columnExists(context.Background(), t, pool, "inventory_usages", "cook_id") {
	t.Error("inventory_usages 应有 cook_id 列")
}
```

`sync_integration_test.go`（照文件中已有的使用记录用例，`mustPush` + 查库）：

- 推一条 `CookRecord` + 一条带 `CookID` 的 usage → 两张表各落一行，usage 的 `cook_id` 正确。
- 同一条记录再推一次（更早的 `updated_at`）→ 不覆盖（LWW）。
- 范围不符（团队记录推到个人范围）→ 记录被跳过，usage 仍落库（扣减不丢）。
- 拉取：另一账号加入团队后全量拉取，响应里 `cook_records` 带 `owner_nickname`（注册时设的昵称），且下发的 usage 带 `cook_id`（与推送时同一个值）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/database/... ./internal/service/...`
Expected: FAIL（迁移未建表 / 载荷无字段）。首次跑会起 testcontainers，较慢。

- [ ] **Step 3: 实现**

- 迁移 `002_cook_records.up.sql` 按 spec §4.2；`down.sql` 删索引 → 删列 → 删表。
- `model/inventory.go`：`InventoryUsage` 加 `CookID *string \`json:"cook_id"\``；新增 `model/cook.go` 的 `CookRecord`（字段与 spec 一致，含派生的 `OwnerNickname` / `OwnerAvatarURL`）。
- `model/sync.go`：`CookRecords []CookRecord \`json:"cook_records"\``。
- `service/inventory.go`：`mergeCookRecord`（照 `mergeBatch`：`SELECT … FOR UPDATE` → 不存在则 `INSERT`（`owner_id` 取当前用户、`team_id` 取 `sc.TeamID`）→ 范围不符跳过 → `!UpdatedAt.After` 跳过 → `UPDATE` 带 `server_seq = nextval`）；`insertUsage` 的 INSERT 加 `cook_id`。
- `service/sync.go`：`maxServerSeqSQL` 加一条 UNION（注释「六条增量通道」改成七条）；`getRemoteChanges` 初始化 `CookRecords: []model.CookRecord{}` 并调 `queryCookRecords`；`mergeLocalChanges` 在批次循环之后、usage 循环之前加 `for _, cr := range req.CookRecords { resolveScope → mergeCookRecord }`；新增 `queryCookRecords`（`LEFT JOIN users`，`WHERE r.server_seq > $1 AND visibleRecipesSQL ORDER BY r.id`，扫出 `team_id` 拼 `ScopeID`）；**`queryUsages` 的 SELECT 与 Scan 也必须加 `cook_id`**，否则拉下来的使用记录丢了归属，别的设备详情页一片空。
- `sync_pull_test.go` 的 `TestCursorIsSnapshotMax` 表清单加 `cook_records`（少一条通道游标就会漏推进）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/database/... ./internal/service/... && gofmt -l internal`
Expected: PASS；`gofmt -l` 无输出。

- [ ] **Step 5: Commit**

```bash
git add backend/internal/database/migrations/002_cook_records.up.sql backend/internal/database/migrations/002_cook_records.down.sql backend/internal/model backend/internal/service backend/internal/database/migrations_test.go
git commit -m "feat(同步): 服务端加 cook_records 表与合并、下发，使用记录带 cook_id"
```

---

### Task 9: 文档与整体验收

**Files:**
- Modify: `docs/开发者-同步与团队.md`
- Modify: `docs/superpowers/specs/2026-11-01-cook-records-design.md`（状态改为「已实施」）

- [ ] **Step 1: 更新文档**

`docs/开发者-同步与团队.md` §2 表结构改动补一行 `cook_records`（范围列 + 作者两列由服务端 JOIN users 派生）与 `inventory_usages.cook_id`；§3 同步载荷示例加 `cook_records` 与 `cook_id`。

- [ ] **Step 2: 全量验证**

Run: `npm run test && npm run build`
Expected: 全部 PASS，构建成功。

Run: `cd backend && go test ./...`
Expected: PASS（Docker 可用）。

- [ ] **Step 3: 实机冒烟（人工）**

1. 选中团队 → 杀掉进程 → 重开：直接落在团队菜谱。
2. 菜谱详情点制作 → 制作记录列表 → 右上角新增 → 填数量确认 → 完成 → 列表出现这条。
3. 库存页展开该食材 → 看到扣减记录 → 点击进详情，内容与列表入口一致；删掉批次后历史仍在。
4. 两台设备 / 两个账号同团队：A 制作后 B 同步能看到记录与作者昵称。

- [ ] **Step 4: Commit**

```bash
git add docs/开发者-同步与团队.md docs/superpowers/specs/2026-11-01-cook-records-design.md
git commit -m "docs: 补制作记录的同步表结构与载荷说明"
```
