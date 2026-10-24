# 食材库存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按批次登记买到的食材，做菜时点「制作」按最早过期优先自动扣库存，并在库存页看到余量与临期。

**Architecture:** 两张本地表（`inventory_batches` 批次 / `inventory_usages` 使用记录），余量永远由「批次数量 − 使用记录合计」派生，不落列。扣减逻辑是 `src/utils/inventory.ts` 里的纯函数（FIFO 计划），store 只负责查库与写记录。三个界面：库存页、批次录入弹层、制作消耗页，全部复用现有 `AppHeader` / `RefSheet` / `ConfirmDialog` 形态。

**Tech Stack:** Vue 3 setup + TS 严格模式、Pinia setup store、`@tauri-apps/plugin-sql`（SQLite）、vitest + happy-dom + `node:sqlite` 真库测试、Tailwind（复用现有设计变量）。

**Spec:** `docs/superpowers/specs/2026-10-24-inventory-design.md`（下称「规格」）

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**（AGENTS.md）。
- 食材与单位只能引用 `ingredients.id` / `units.id`，**库存表里不许出现食材名文本**（AGENTS.md）。
- 库存**只存本地**：不进 `SyncPayload`，不调 `enqueueSync`。`sync.ts` 除规格 §4.16 那两条 `repointSql` 外一行不改。
- 新表带 `id` / `updated_at` / `deleted_at`；余量**不落列**，一律派生。
- **不许放宽、删除或改弱任何已有测试断言**（规格 §2 反目标）。只允许：给 fixture 补字段、加 `vi.mock`、加新用例。
- 不新增颜色与字号，只用现有 `text-text` / `text-text-secondary` / `text-primary` / `text-danger` / `bg-surface` / `border-gray-200` / `rounded-xl` / `rounded-lg` / `text-xs` `text-sm` `text-base`。项目里没有 warning 色：「快过期」用 `text-danger`。
- 排版参照现有组件：图标按钮 `flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100`；输入框 `w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary`；主按钮 `w-full rounded-xl bg-primary py-3 text-base font-semibold text-white`。
- 底部弹层必须用 `useKeyboardInset()`，写法与 `IngredientSheet.vue` 逐字一致。
- 提交信息用中文，格式 `feat(库存): …` / `fix(库存): …` / `test(库存): …`。
- 每次提交前该任务的测试必须绿；全部任务完成后跑 `npm run test` 与 `npm run build`。

## Review Focus

规格里没写、但真实使用一定会撞上的输入，按最可能出事排序。每一条的测试安排在下表右侧的任务里。

| 输入 / 条件 | 合理预期 | 归属 |
|---|---|---|
| 菜谱写「2 个」、库存记「500 g」 | 制作页打开就把单位切到有库存的那个，不当场扣不掉 | Task 7 |
| 同一道菜里同一个食材出现两行 | 两行各扣各的，同一批次不被扣两次 | Task 3 + Task 7 |
| 字典合并（同步）后批次指向的食材被物理删除 | 批次跟着重指，库存不静默消失 | Task 4 |
| 用户手改过期日后又改了保质期天数 | 手填的日期不被自动覆盖 | Task 5 |
| 表单填的量超过库存 | 余量停在 0，不用负数记账，并明确报「还差多少」 | Task 3 + Task 7 |

---

## File Structure

**新增**

| 文件 | 职责 |
|---|---|
| `src/utils/inventory.ts` | 纯函数：日期换算、临期判定、汇总、排序、FIFO 扣减计划。不碰数据库 |
| `src/stores/inventory.ts` | 一处 SQL 取全量批次余量 + 录入/删除批次 + 写使用记录 |
| `src/components/BatchSheet.vue` | 录入批次的底部弹层（三步：选食材 → 填数量单位 → 填日期） |
| `src/views/InventoryPage.vue` | 库存汇总与批次展开、删除 |
| `src/views/CookPage.vue` | 制作消耗表单 + 结果态 |

**修改**

| 文件 | 改动 |
|---|---|
| `src/db/index.ts` | `DDL` 追加两张表与两个索引 |
| `src/types/index.ts` | 追加 `InventoryBatch` / `BatchStock` / `IngredientStock` / `BatchInput` / `CookLine` / `CookResult` |
| `src/stores/refStore.ts` | 删除守卫把「库存批次引用」也算进去 |
| `src/services/sync.ts` | 两处 `repointSql` 各加一条 `UPDATE inventory_batches` |
| `src/views/RecipeDetail.vue` | 顶栏加「制作」按钮 |
| `src/views/MePage.vue` | 加一行「食材库存」入口 |
| `src/router/index.ts` | 加 `/inventory`、`/recipe/:id/cook` |

**测试**：`src/utils/__tests__/inventory.test.ts`、`src/stores/__tests__/inventory.test.ts`、`src/components/__tests__/BatchSheet.test.ts`、`src/views/__tests__/InventoryPage.test.ts`、`src/views/__tests__/CookPage.test.ts`（新增）；`src/db/__tests__/schema.test.ts`、`src/stores/__tests__/refStore.test.ts`、`src/services/__tests__/syncMerge.test.ts`、`src/views/__tests__/MePage.test.ts`、`src/views/__tests__/RecipeDetail.test.ts`、`src/router/__tests__/routes.test.ts`（追加用例）。

---

### Task 1: 纯函数 `src/utils/inventory.ts`

**Files:**
- Create: `src/utils/inventory.ts`
- Test: `src/utils/__tests__/inventory.test.ts`

**Interfaces:**
- Consumes: `@/types` 的 `IngredientStock`（Task 2 定义；本任务先在测试里直接构造对象字面量，若类型未就绪就在 Task 2 之后编译——**本任务与 Task 2 可互换顺序**，建议按 1→2 执行并在 Task 2 后回跑本任务测试）。
- Produces:
  - `EXPIRING_SOON_DAYS = 7`
  - `localToday(now: Date): string`
  - `computeExpiresAt(producedAt: string | null, shelfLifeDays: number | null): string | null`
  - `expiryState(expiresAt: string | null, today: string): "none" | "soon" | "expired"`
  - `planDeduction(candidates: DeductionCandidate[], want: number): { plan: { batch_id: string; amount: number }[]; shortfall: number }`，其中 `DeductionCandidate = { batch_id: string; remaining: number; expires_at: string | null; created_at: string }`
  - `groupStockRows(batches: BatchStock[]): IngredientStock[]`
  - `sortStockRows(rows: IngredientStock[]): IngredientStock[]`

- [ ] **Step 1: 写失败测试**

`src/utils/__tests__/inventory.test.ts` 断言（全部为规格 §6.1 的规则）：

```ts
import { describe, expect, it } from "vitest";
import {
  computeExpiresAt, expiryState, groupStockRows, localToday, planDeduction, sortStockRows,
} from "@/utils/inventory";

// localToday：用本地构造器造时间，任何时区都应回同一个本地日
expect(localToday(new Date(2026, 9, 24, 23, 30))).toBe("2026-10-24");
expect(localToday(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");

computeExpiresAt("2026-10-01", 7);      // "2026-10-08"
computeExpiresAt("2026-12-28", 7);      // "2027-01-04" 跨年
computeExpiresAt("2028-02-27", 2);      // "2028-02-29" 闰年
computeExpiresAt(null, 7);              // null
computeExpiresAt("2026-10-01", null);   // null

// today 固定 "2026-10-24"
expiryState("2026-10-31", T);  // "soon"    —— 第 7 天仍算临期
expiryState("2026-11-01", T);  // "none"    —— 第 8 天不算
expiryState("2026-10-24", T);  // "soon"    —— 当天到期，还没过
expiryState("2026-10-23", T);  // "expired"
expiryState(null, T);          // "none"

// planDeduction
// 1) 单批足够：candidates [{A,100,expires "2026-11-01",created "1"}], want 40
//    → plan [{A,40}], shortfall 0
// 2) 跨批且先扣快过期：B 过期 10-01、A 过期 10-05，各 100，want 150 → [{B,100},{A,50}]
// 3) 无过期日排最后：A null / B "2026-10-01"，各 100，want 50 → [{B,50}]
// 4) 同过期日按 created_at 升序
// 5) 库存不足：单批 60，want 100 → plan [{A,60}], shortfall 40
// 6) want 0 → plan [], shortfall 0
// 7) 余量 0 的候选被跳过（不会产生 amount 0 的项）

// groupStockRows：同食材同单位相加；同食材不同单位拆成两个 part（按批次出现顺序）；
// 所有 part 余量 <= 0 → usedUp true；
// soonest_expires_at 只看 remaining > 0 的批次（已用完的过期批次不该让食材显示「已过期」）

// sortStockRows：usedUp 沉底；其余按 soonest_expires_at 升序，null 排最后；再按 ingredient_name
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/__tests__/inventory.test.ts`
Expected: FAIL（`Failed to resolve import "@/utils/inventory"`）

- [ ] **Step 3: 实现**

签名按 Interfaces 写死。算法要点：

- `computeExpiresAt`：`Date.parse(producedAt + "T00:00:00Z") + days * 86400000`，再 `new Date(ms).toISOString().slice(0, 10)`。不用本地时区做日期加减（规格 §4.20）。
- `expiryState`：字符串比较即可（`YYYY-MM-DD` 字典序 = 时间序）。`expiresAt < today` → expired；`expiresAt <= addDays(today, EXPIRING_SOON_DAYS)` → soon；否则 none。`addDays` 同样走 UTC 算术。
- `planDeduction`：过滤 `remaining > 0` → 排序（`expires_at === null` 排后，其次 `expires_at`，再 `created_at`）→ 依次 `take = Math.min(c.remaining, left)`，`take > 0` 才推进 `plan`。
- `groupStockRows`：按 `ingredient_id` 分桶，按首次出现顺序产出；`parts` 按 `unit_id` 合并累加 `remaining`；`usedUp = parts.every(p => p.remaining <= 0)`；`soonest_expires_at` 取 `remaining > 0` 且 `expires_at !== null` 的最小值。
- `sortStockRows`：返回新数组，不原地排序。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/utils/__tests__/inventory.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/inventory.ts src/utils/__tests__/inventory.test.ts
git commit -m "feat(库存): 批次余量、临期判定与 FIFO 扣减纯函数"
```

---

### Task 2: 两张表与类型

**Files:**
- Modify: `src/db/index.ts`（`DDL` 数组末尾、`idx_ai_messages_session` 之后）
- Modify: `src/types/index.ts`（文件末尾）
- Test: `src/db/__tests__/schema.test.ts`（追加用例）

**Interfaces:**
- Produces: 表 `inventory_batches(id, ingredient_id, amount, unit_id, produced_at, shelf_life_days, expires_at, created_at, updated_at, deleted_at)`、表 `inventory_usages(id, recipe_id, batch_id, amount, used_at, updated_at, deleted_at)`、索引 `idx_inventory_batches_ing` / `idx_inventory_usages_batch`；类型 `InventoryBatch` / `BatchStock` / `IngredientStock` / `BatchInput` / `CookLine` / `CookResult`（字段逐字照规格 §5.2，`CookLine` 额外带 `unit_name: string | null`，供结果态显示单位）。

- [ ] **Step 1: 写失败测试**

`src/db/__tests__/schema.test.ts` 追加：

```ts
it("inventory 两张表建出来了", async () => {
  const { db } = await freshTestDb();
  const rows = await db.select<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const names = rows.map((r) => r.name);
  expect(names).toContain("inventory_batches");
  expect(names).toContain("inventory_usages");
});

it("inventory 两张表都有 id/updated_at/deleted_at", async () => {
  // 对两张表分别 PRAGMA table_info，断言三个列都在
});

it("inventory_batches.amount 拒绝 0 与负数", async () => {
  // INSERT amount 0 → rejects.toThrow()
});

it("inventory 的外键列不写 REFERENCES：物理删掉食材行后批次行仍在", async () => {
  // 插食材 i1 → 插批次引用 i1 → DELETE FROM ingredients WHERE id='i1' → 批次行 select 出来 length 1
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/db/__tests__/schema.test.ts`
Expected: FAIL（表不存在）

- [ ] **Step 3: 加 DDL 与类型**

`src/db/index.ts`：把规格 §5.1 的两段 `CREATE TABLE` 与两个 `CREATE INDEX` 逐字加进 `DDL` 数组，**不要** `REFERENCES`（规格 §4.15），`amount` 保留 `CHECK (amount > 0)`。

`src/types/index.ts`：按规格 §5.2 追加六个接口，`CookLine` 加 `unit_name: string | null`。

`IngredientStock.soonest_expires_at` 的注释改成「只看余量 > 0 的批次里最早的过期日」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/db/__tests__/schema.test.ts src/db/__tests__/migrate.test.ts`
Expected: PASS（老库迁移用例不应受影响）

- [ ] **Step 5: 提交**

```bash
git add src/db/index.ts src/types/index.ts src/db/__tests__/schema.test.ts
git commit -m "feat(库存): 新增库存批次与使用记录两张本地表"
```

---

### Task 3: store `src/stores/inventory.ts`

**Files:**
- Create: `src/stores/inventory.ts`
- Test: `src/stores/__tests__/inventory.test.ts`

**Interfaces:**
- Consumes: `@/db` 的 `getDb`、Task 1 的 `planDeduction`、Task 2 的类型。
- Produces:
  - `useInventoryStore()`（`defineStore("inventory", …)`），返回 `{ batches: Ref<BatchStock[]>, fetchAll(): Promise<void>, addBatch(input: BatchInput): Promise<void>, removeBatch(id: string): Promise<void>, remainingByIngredient(ingredientIds: string[]): Map<string, { unit_id: string | null; remaining: number }[]>, commitCook(recipeId: string, lines: CookLine[]): Promise<CookResult> }`
  - 注意：`remainingByIngredient` 是**同步**函数（规格 §6.2 写的 async，实现改成直接读 `batches`，省一次查库；调用前需已 `await fetchAll()`）。

- [ ] **Step 1: 写失败测试**

`src/stores/__tests__/inventory.test.ts` 用 `src/stores/__tests__/recipe.test.ts` 同一套骨架（`beforeEach` 里 `setActivePinia(createPinia())` + `freshTestDb()` + `setDb(db)`，用 `useIngredientStore().add("鸡蛋")` 造食材）。用例：

```ts
it("addBatch 落库并出现在 fetchAll 结果里，余量等于数量", …)
it("addBatch 数量为 0 或负数被拒绝：'数量要大于 0'", …)
it("addBatch 过期日早于生产日期被拒绝：'过期日不能早于生产日期'", …)
it("addBatch 保质期天数给 0 或小数被拒绝：'保质期天数要是正整数'", …)
it("fetchAll 的余量 = 批次数量 − 未删除使用记录合计", …)
it("fetchAll 不返回软删批次", …)
it("removeBatch 软删批次，使用记录仍在库里", …)
it("remainingByIngredient 按单位聚合，余量为 0 的单位不出现在结果里", …)
it("commitCook 按最早过期优先跨批次写记录", async () => {
  // 两个批次各 100 g（过期 10-01 / 10-05），一行 want 150
  // → inventory_usages 两行：100 归早过期批次、50 归另一批
  // → 之后 fetchAll 余量分别是 0 与 50
});
it("commitCook 只扣同单位的批次：库存记 g、行是「个」→ shortfall = want，不写记录", …)
it("commitCook 库存不足时只扣现有量，shortfall = 差额，余量不为负", …)
it("commitCook 同食材同单位出现两行时第二行用剩下的量，不重复扣同一批", async () => {
  // 单批 100 g；两行各 want 60 → 第一行扣 60，第二行只扣 40，shortfall 20，余量 0
});
it("commitCook 数量为 0 的行不写记录", …)
it("commitCook 不参与同步：enqueueSync 不被调用", …)  // vi.mock("@/services/sync")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/inventory.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

- `fetchAll`：SQL 逐字照规格 §6.2（一份查询带 `LEFT JOIN (SELECT batch_id, SUM(amount) …)`），映射成 `BatchStock`：`remaining = row.amount - row.used`。
- `addBatch`：先校验（数量 > 0；`shelf_life_days` 若给出须为 `Number.isInteger` 且 ≥ 1；两者都有时 `expires_at >= produced_at`），再 `INSERT`（`id = crypto.randomUUID()`，`created_at = updated_at = new Date().toISOString()`），最后 `await fetchAll()`。
- `removeBatch`：`UPDATE inventory_batches SET deleted_at = ?, updated_at = ? WHERE id = ?` 后 `await fetchAll()`。不碰 `inventory_usages`。
- `remainingByIngredient`：从 `batches.value` 过滤出 `ingredientIds` 命中的、`remaining > 0` 的项，按 `ingredient_id` → `unit_id` 累加。返回的 Map 里没有的食材就是「没库存」。
- `commitCook`：实现顺序逐条照规格 §6.2，关键点：
  1. 先 `await fetchAll()`；
  2. 维护 `usedThisCook: Map<string, number>`（batch_id → 本轮已扣），候选余量 = `remaining - usedThisCook`；
  3. 每行 `planDeduction` 后逐条 `INSERT INTO inventory_usages (id, recipe_id, batch_id, amount, used_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL)`，并把本行结果累进 `usedThisCook`；
  4. `deducted` 每行只产出一条（`amount` 为该行实际扣减合计），`shortfall` 只在该行扣不满时产出；
  5. 全部写完后 `await fetchAll()` 再 `return result`；
  6. 加注释说明为何不开事务（规格 §4.14，照抄 `stores/recipe.ts` 的 `shortcut:` 写法）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/inventory.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/stores/inventory.ts src/stores/__tests__/inventory.test.ts
git commit -m "feat(库存): 库存 store 负责批次录入与 FIFO 扣减记账"
```

---

### Task 4: 保护批次引用（删除守卫 + 同步重指）

**Files:**
- Modify: `src/stores/refStore.ts`（`countRecipes` 与 `remove` 的守卫）
- Modify: `src/services/sync.ts:158-176` 与 `:204-222`（两处 `repointSql`）
- Test: `src/stores/__tests__/refStore.test.ts`、`src/services/__tests__/syncMerge.test.ts`（各追加用例）

**Interfaces:**
- Consumes: Task 2 的表。
- Produces: 无新导出。行为：有未删库存批次的食材 / 单位不可删除；字典合并后批次的 `ingredient_id` / `unit_id` 指向合并后的行。

- [ ] **Step 1: 写失败测试**

`src/stores/__tests__/refStore.test.ts` 追加两条（形态照现有 `remove 被引用的食材被拒绝且不改库`）：

```ts
it("有库存批次的食材不能删：'「鸡蛋」还有库存，先删掉批次再删食材'", async () => {
  // 造食材 + 一条 inventory_batches（ingredient_id 指向它，走 raw SQL 插入即可）
  await expect(store.remove(egg.id)).rejects.toThrow("还有库存");
});

it("有库存批次的单位不能删", …)
```

`src/services/__tests__/syncMerge.test.ts` 追加（照 `同名字典行合并：本地已有同名 X，收到 Y` 那条的骨架）：

```ts
it("字典合并后库存批次跟着重指到合并后的食材 id", async () => {
  // 本地 ingredients id="old" name="鸡蛋"，一条 inventory_batches.ingredient_id="old"
  // remote.ingredients 含 id="new" name="鸡蛋" → applyRemoteChanges
  // 断言 batches 里那条的 ingredient_id === "new"
});
it("字典合并后库存批次跟着重指到合并后的单位 id", …)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/refStore.test.ts src/services/__tests__/syncMerge.test.ts`
Expected: 新用例 FAIL（现在会删成功 / 批次 id 仍是旧值），旧用例仍 PASS

- [ ] **Step 3: 实现**

- `refStore.ts`：把 `countRecipes` 的结果与一条新查询（`SELECT COUNT(*) AS count FROM inventory_batches WHERE ${refColumn} = ? AND deleted_at IS NULL`）合并成「引用数」，`remove` 里引用数 > 0 就抛 `` `${label}「${name}」还有库存，先删掉批次再删${label}` ``（现有菜谱引用文案**一字不改**，只在库存引用时用新文案）。查名字要用现有 `remove` 里已取到的那一行，不额外查。
- `sync.ts`：`ingredients` 分支的 `repointSql` 数组追加 `"UPDATE inventory_batches SET ingredient_id = ? WHERE ingredient_id = ?"`；`units` 分支追加 `"UPDATE inventory_batches SET unit_id = ? WHERE unit_id = ?"`。其它一律不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/refStore.test.ts src/services/__tests__/sync.test.ts src/services/__tests__/syncMerge.test.ts src/services/__tests__/syncReconcile.test.ts src/services/__tests__/syncDownload.test.ts`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add src/stores/refStore.ts src/services/sync.ts src/stores/__tests__/refStore.test.ts src/services/__tests__/syncMerge.test.ts
git commit -m "fix(库存): 有库存的食材单位不许删，字典合并时批次跟着重指"
```

---

### Task 5: 录入批次弹层 `src/components/BatchSheet.vue`

**Files:**
- Create: `src/components/BatchSheet.vue`
- Test: `src/components/__tests__/BatchSheet.test.ts`

**Interfaces:**
- Consumes: `useIngredientStore` / `useUnitStore`（`@/stores/ingredient`）、`useInventoryStore().addBatch`、`computeExpiresAt`（Task 1）、`RefSheet`、`useKeyboardInset`。
- Produces: `<BatchSheet v-model:visible />`… 实际按现有约定用 `:visible` + `@close`；props `{ visible: boolean }`，emits `{ close: []; saved: [] }`。

- [ ] **Step 1: 写失败测试**

`src/components/__tests__/BatchSheet.test.ts`（store 用 `vi.mock("@/stores/inventory")`，食材/单位用真 store 或 mock，照 `IngredientSheet.test.ts` 的骨架）：

```ts
it("未选食材时先显示 RefSheet 的食材列表；选中后进入表单", …)
it("数量留空或 0 时点保存报 '数量要大于 0'，不调用 addBatch", …)
it("生产日期 + 保质期天数填完，过期日自动算出（2026-10-01 + 7 → 2026-10-08）", …)
it("手动改过期日后，再改保质期天数不会覆盖手填值", …)
it("清空过期日后恢复自动计算", …)
it("保质期天数为 0 时报 '保质期天数要是正整数'", …)
it("过期日早于生产日期时报 '过期日不能早于生产日期'", …)
it("保存成功后 emit saved 与 close，addBatch 收到的形状含 ingredient_id/amount/unit_id/produced_at/shelf_life_days/expires_at", …)
it("addBatch 抛错时错误显示在面板内且不关窗", …)
it("每次打开都从选食材重新开始，不残留上一轮输入", …)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/BatchSheet.test.ts`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现**

整体照 `src/components/IngredientSheet.vue`：同一个 `Teleport` + 遮罩 `z-20` / 面板 `z-30`（必须低于 `RefSheet` 的 `z-40 / z-50`）、同样的 `Transition`、同样的 `panelPadBottom`、同样「关窗由父组件决定、自己从不关」。

- 三步：`step = "pick" | "form" | "unit"`。`pick` 用 `RefSheet` 选食材；`unit` 用 `RefSheet` 选单位（`selected-ids` 传当前单位）；`form` 是本组件面板。
- 表单字段与 `data-test`：`batch-amount` / `batch-unit` / `batch-produced` / `batch-shelf-life` / `batch-expires` / `batch-save` / `batch-close`。
- 自动过期日：`watch([producedAt, shelfLifeDays], …)`，`expiryTouched` 为真时跳过（规格 §6.4）。
- 保存：先本地校验（数量、保质期天数、日期先后），再 `await inventoryStore.addBatch({...})`；成功 `emit("saved"); emit("close")`，失败把 `error instanceof Error ? error.message : "保存失败，请重试"` 显示在面板内。
- `watch(() => props.visible, …)` 每次打开重置全部状态。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/BatchSheet.test.ts src/components/__tests__/IngredientSheet.test.ts src/components/__tests__/RefSheet.test.ts`
Expected: PASS（后两个是回归，一个字节没改它们）

- [ ] **Step 5: 提交**

```bash
git add src/components/BatchSheet.vue src/components/__tests__/BatchSheet.test.ts
git commit -m "feat(库存): 批次录入弹层，过期日按保质期自动算"
```

---

### Task 6: 库存页 +「我的」入口 + 路由

**Files:**
- Create: `src/views/InventoryPage.vue`
- Modify: `src/views/MePage.vue`（用户卡片与同步行之间插一行）
- Modify: `src/router/index.ts`
- Test: `src/views/__tests__/InventoryPage.test.ts`、`src/views/__tests__/MePage.test.ts`、`src/router/__tests__/routes.test.ts`（后两个追加用例）

**Interfaces:**
- Consumes: `useInventoryStore().{batches, fetchAll, removeBatch}`、`groupStockRows` / `sortStockRows` / `expiryState` / `localToday`、`BatchSheet`、`ConfirmDialog`。
- Produces: 路由 `/inventory`（`name: "inventory"`, `meta: { hideTab: true }`）。

- [ ] **Step 1: 写失败测试**

`InventoryPage.test.ts`（mock `@/stores/inventory` 返回固定 `batches`，mock `vue-router`）：

```ts
it("没有批次时显示 '还没有库存，点右上角加号记一批'", …)
it("同一食材多单位余量拼成 '500 g、2 个'", …)
it("余量 <= 0 的食材显示灰字 '已用完'", …)
it("7 天内到期的食材显示 '快过期'，昨天的显示 '已过期'", …)
it("点食材行展开该食材的批次，再点收起", …)
it("展开的批次行显示数量、生产日期、过期日", …)
it("删批次要过 ConfirmDialog，确认后调 removeBatch", …)
it("点右上角加号打开 BatchSheet", …)
it("onMounted 调用 fetchAll 恰好 1 次", …)
```

追加：

```ts
// MePage.test.ts
it("点 '食材库存' 进入 /inventory", …)   // [data-test="inventory-row"]

// routes.test.ts
it("/inventory 与 /recipe/:id/cook 存在且 hideTab", …)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/InventoryPage.test.ts src/views/__tests__/MePage.test.ts src/router/__tests__/routes.test.ts`
Expected: 新用例 FAIL，旧用例 PASS

- [ ] **Step 3: 实现**

- `InventoryPage.vue`：结构照规格 §6.3。`rows = computed(() => sortStockRows(groupStockRows(store.batches)))`；`today = localToday(new Date())` 每行算一次 `expiryState`；展开集合是 `ref(new Set<string>())`，切换时新建 Set 保证响应式；删除走 `ConfirmDialog` → `store.removeBatch(id)`；`BatchSheet` 的 `@saved` 里 `void store.fetchAll()`。
- `MePage.vue`：插一行按钮（`data-test="inventory-row"`，样式与 `server-row` 同款）→ `router.push("/inventory")`；`ChevronRight` 已 import，不用加。
- `router/index.ts`：加两条路由，`/recipe/:id/cook` 放在 `/recipe/:id` 之前、`/recipe/:id/guide` 旁边。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/InventoryPage.test.ts src/views/__tests__/MePage.test.ts src/router/__tests__/routes.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/views/InventoryPage.vue src/views/MePage.vue src/router/index.ts \
  src/views/__tests__/InventoryPage.test.ts src/views/__tests__/MePage.test.ts src/router/__tests__/routes.test.ts
git commit -m "feat(库存): 库存页展示余量与临期，「我的」加入口"
```

---

### Task 7: 制作消耗页 + 详情页「制作」按钮

**Files:**
- Create: `src/views/CookPage.vue`
- Modify: `src/views/RecipeDetail.vue`（顶栏 `action` 槽，指导模式按钮之前；`lucide-vue-next` 的 import 里加 `ChefHat`）
- Modify: `src/router/index.ts`（若 Task 6 已加则跳过）
- Test: `src/views/__tests__/CookPage.test.ts`、`src/views/__tests__/RecipeDetail.test.ts`（追加用例）

**Interfaces:**
- Consumes: `useRecipeStore().getDetail(id)`（`RecipeDetail.ingredients: RecipeIngredientRow[]`，含 `ingredient_name` / `unit_name` / `amount`）、`useInventoryStore().{batches, fetchAll, remainingByIngredient, commitCook}`、`CookLine` / `CookResult`、`RefSheet`（选单位）。
- Produces: 路由 `/recipe/:id/cook`（`name: "recipe-cook"`, `meta: { hideTab: true }`）。

- [ ] **Step 1: 写失败测试**

`CookPage.test.ts`（mock `vue-router`、`@/stores/recipe`、`@/stores/inventory`，形状照 `RecipeDetail.test.ts`）：

```ts
it("每行预填菜谱用量与单位，'适量'（amount 为 null）的行数量留空", …)
it("菜谱单位没有库存、另一单位有库存时，预填切到有库存的那个单位", …)
it("有多个单位有库存时选余量最大的（同余量按单位名）", …)
it("行内显示可用余量 '库存 500 g'，换成别的单位后跟着变", …)
it("数量填 0 的行不进入 commitCook 的 lines", …)
it("所有行都是空或 0 时确认按钮 disabled", …)
it("库存不够时显示提示，确认后结果态逐行显示 '还差 N'", …)
it("确认成功后原地进入结果态：显示扣减明细，输入与确认按钮不再渲染", …)
it("结果态点 '完成' 调 router.back()", …)
it("点行内单位按钮打开 RefSheet，选中后该行单位与余量更新", …)

// RecipeDetail.test.ts
it("顶栏有 '制作' 按钮，点了跳 /recipe/:id/cook", …)     // [data-test="cook"]
it("别人的菜谱也显示 '制作' 按钮", …)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/CookPage.test.ts src/views/__tests__/RecipeDetail.test.ts`
Expected: 新用例 FAIL，旧用例 PASS

- [ ] **Step 3: 实现**

- `CookPage.vue`：结构照规格 §6.5。`onMounted` → `await store.fetchAll()` + `await recipeStore.getDetail(id)`，按预填规则（规格 §4.19）生成 `rows`：每行 `{ ingredient_id, ingredient_name, unit_id, unit_name, amountText }`，并缓存 `remainingByIngredient` 结果。
- 确认：把有正数数量、且能解析成数字的行映射成 `CookLine` → `await store.commitCook(recipeId, lines)` → `result = …`，模板切结果态。
- 单位选择：一个 `RefSheet`（`useUnitStore()`，`mode="single"`），用 `unitRowIndex` 记住在改哪一行。
- `RecipeDetail.vue`：只在 `action` 槽加那个按钮（规格 §6.6），不带 `canEdit` 条件。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/CookPage.test.ts src/views/__tests__/RecipeDetail.test.ts src/views/__tests__/RecipeGuide.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/views/CookPage.vue src/views/RecipeDetail.vue src/views/__tests__/CookPage.test.ts src/views/__tests__/RecipeDetail.test.ts
git commit -m "feat(库存): 制作页预填用量并扣减库存"
```

---

### Task 8: 全量验证与真机验收

**Files:**
- 无代码改动（发现 bug 就回到对应任务修，不在这里「顺手改」）

- [ ] **Step 1: 跑全量测试**

Run: `npm run test`
Expected: 全绿，且测试文件数比改动前多 5 个

- [ ] **Step 2: 类型检查与构建**

Run: `npm run build`
Expected: `vue-tsc --noEmit` 无错误（确认没有 `any` 混进来），构建成功

- [ ] **Step 3: 真机走查（`npm run tauri android dev`）**

逐条过规格 §8 的七件事，特别确认：

1. 弹层里软键盘弹起时「保存」点得到，收起后不留空白。
2. 生产日期 + 保质期天数 → 过期日自动出现；手改后不再被覆盖。
3. 菜谱「2 个」、库存「500 g」时，制作页打开就切到 `g`。
4. 跨两批扣减先扣快过期那批，两批余量都正确减少。
5. 库存不足后库存显示「已用完」，没有负数。
6. 三个页面互相返回不留空白页。
7. 窄屏无横向滚动。

- [ ] **Step 4: 提交验收记录（如有文档修正）**

```bash
git add docs/superpowers/specs/2026-10-24-inventory-design.md
git commit -m "docs(库存): 真机验收后补充调整"
```

---

## 留给下一轮（不在本计划内）

缺料计算、制作历史与撤销、批次编辑、低库存阈值与买菜清单、库存同步、过期通知（规格 §9）。
