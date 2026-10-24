# 一起做饭 · 食材库存 设计

2026-10-24 · 状态：设计待审

---

## 1. 要解决什么

现在菜谱能记、能查、能做（指导模式），但**家里还剩多少东西，App 一无所知**。买菜回来只是躺进冰箱，做饭时才发现「五花肉只剩一小块」，或者冰箱里翻出一袋过期的干货。

真正的问题不是「记账」，是**做饭前那 10 秒的判断题**：这道菜我现在做得了吗？还有多少？

所以做两件事：**按批次登记买到的东西**，和**每做一次菜自动扣掉**。剩下多少不单独维护，永远由「批次数量 − 使用记录」算出来，不会漂。

成功的样子：在菜谱详情页点「制作」，表单已经按这道菜的食材和用量填好，改两个数字点确认，冰箱里的账就平了；回到库存页，一眼看到哪样快过期、哪样已经不足。

---

## 2. 目标 / 非目标 / 反目标

**目标**

- 库存页：按食材汇总剩余量，带临期 / 已过期标记，可展开看每批次。
- 录入批次：食材（结构化选择）+ 数量 + 单位 + 生产日期 + 保质期天数 + 过期日（自动算或手填）。
- 菜谱详情页顶栏加「制作」按钮 → 预填的消耗表单页 → 可改每行数量与单位 → 确认后按「最早过期优先」扣批次、写使用记录。
- 库存不足时明确告诉你扣不满，而不是静默扣成负数。

**非目标（本轮明确不做）**

- 库存同步到服务器：库存表不进同步载荷（`sync.ts` 的 payload 与 `enqueueSync` 一行不改）。`sync.ts` 全文只有一处必改：字典合并时的 `repointSql`（理由见 §4.15）。
- 手动记账（库存页直接减库存 / 新增一条消耗记录）。
- 「这道菜我有几个食材、还差什么」的缺料计算、按库存反向推荐菜谱。
- 制作历史列表页、撤销某次制作。
- 批次编辑（录错了删掉重录）。
- 库存页的搜索、分类筛选、低库存阈值自定义。
- 过期日提醒通知（只在页面上标色）。

**反目标（做出来了也算失败）**

- **改完之后有任何一个已有测试断言被放宽、删除或改弱。**
- 库存里存食材纯文本。必须 `ingredient_id` / `unit_id` 引用字典表（AGENTS.md 硬约束）。
- 库存余量存成表里的一列再逐步 UPDATE。必须由批次与使用记录派生，否则手改一次批次数量就和历史对不上。
- 在 `recipe_ingredients` 或菜谱编辑页上加任何库存字段。
- 为一个表单再引入一套组件库 / 抽象层，或改动 `RefSheet` / `IngredientSheet` / `AppHeader` 的对外行为。
- 单位对不上时静默跨单位扣减（「2 个」扣掉「500 g」）。

---

## 3. 这些是你定的（不要改）

- **在菜谱详情页点「制作」，弹出预填的消耗表单**，实际用量可以改，也可以直接确认。
- **扣批次全自动**：按过期日从早到晚扣，表单里不出现批次选择。
- 库存按批次录入，含生产日期、保质期、过期日（过期日可自动算或手填）。

## 4. 这些是我做的判断（可以推翻，但要知道）

1. **库存只存本地，不同步。** 它描述的是「这台手机所在的那个厨房」，跨设备同步会立刻变成两个厨房的账混在一起。真要同步得先有「厨房」这个概念，不是本轮的事。
2. **余量派生，不落列。** 每个批次的余量 = `amount − SUM(该批次的使用记录)`。因此「修改批次」这种操作不存在（改了会让历史记录对不上账面），只提供「删除批次」。
3. **库存页入口放「我的」里一行**，不动底部三个标签。库存是低频查看、高频写入（做饭时点制作）的东西，不值得占一个主标签。
4. **单位不同的批次永不混算。** 同一食材有「500 g」和「2 个」两批时，汇总显示成 `500 g、2 个`，扣减时只扣「与该行单位相同」的批次。跨单位换算需要密度/体积密度，那是另一个项目。
5. **制作表单里数量可改，单位也可改。** 单位可改是必须的：菜谱写「2 个」而库存记「500 g」时，不能改单位就等于永远扣不掉，而这正是最容易撞上的情况。
6. **数量填 0 = 这次不用这个食材**，不扣减、也不写记录。比多一个复选框少一次点击。
7. **扣不满就只扣到 0，并且明确报出来。** 不写「负数库存」，不阻止确认 —— 家里做饭账目本来就不精确，挡住用户比账不准更烦人。
8. **每次确认在结果页停留**，显示「扣了哪些、扣了多少、哪些不够」，底部「完成」才回详情页。理由：静默返回详情页时，用户分不清扣成功没有，容易重复点。
9. **临期阈值 7 天**，写成一个常量 `EXPIRING_SOON_DAYS`。已过期单独一种状态（红色），不合并进「临期」。
10. **过期日可空。** 不知道保质期的东西（散装干货、冻肉）也允许入库，只是永远不参与临期标记。录批次时**不强制**填日期。
11. **录入批次用底部弹层（sheet），不用独立页。** 复用 `IngredientSheet` 已验证的形态：`RefSheet` 选食材 → 本层填数量/单位/日期。少一个路由、少一套返回键处理，且选食材/选单位两处都能直接复用 `RefSheet`。
12. **一次制作的若干条使用记录不额外建「制作会话」表**，也不加 `cook_id`。本轮没有任何 UI 会把它们当成一组来看；将来要「撤销这次制作」时再 `ALTER TABLE ... ADD COLUMN cook_id`，成本一样。
13. **日期一律 `YYYY-MM-DD` 文本**，用 UTC 做加减（`Date.parse(d + "T00:00:00Z")`）。不存时间戳：保质期到「日」为止，时区换算只会制造差一天的 bug。
14. **库存写库不开事务**，沿用 `stores/recipe.ts` 已经记录的契约（`plugin-sql` 连接池不保证 `BEGIN` 与后续语句同连接）。每条使用记录彼此独立，崩溃点最坏是「扣了一半」——库存偏高，而不是凭空多出食材。
15. **库存表的外键列不写 `REFERENCES`（纯 `TEXT`）。** 原因不是偷懒：`sync.ts` §4 的字典合并会把**输掉合并的那一行物理 `DELETE`**（`DELETE FROM ingredients WHERE id = ?`，只把 `recipe_ingredients` 重指过去），`deleteCachedOtherRecipes` 也会 `DELETE FROM recipes`。两个运行时都默认开 `foreign_keys`，加了 `REFERENCES` 就会让一次普通的字典合并把同步永久卡死。
16. **同步的字典合并要把库存批次一起重指。** `repointSql` 里各加一条 `UPDATE inventory_batches SET ingredient_id = ? WHERE ingredient_id = ?`（`unit_id` 同理）。不加的话：远端合并掉本地这个食材后，批次行还指着已经物理删除的 id，JOIN 不出来 → **库存静默消失**（看不见、也删不掉）。这是本轮唯一需要动 `sync.ts` 的地方，两条 SQL。
17. **有库存的食材 / 单位不许删。** `refStore.remove` 现在只数 `recipe_ingredients` 的引用，要扩成「菜谱引用或有用量的库存批次」都算引用，否则删掉食材后批次还在、名字却查不到。
18. **同一道菜重复引用同一食材时按行顺次扣。** 菜谱允许同一个食材出现多行（`stores/recipe.ts` 的既有行为），制作页就会出现两行同 `ingredient_id`。`commitCook` 里维护一个本轮的 `已扣量: Map<batch_id, number>`，第 2 行规划时用「余量 − 本轮已扣」当候选量，避免同一批次被重复扣到负数。页面不合并行 —— 菜谱里本来就写着两行，合并会让人对不上账。
19. **有库存的单位不止一个时，预填选「这个单位有库存就先用它」，都没库存（或菜谱单位无库存）则选余量最大的那个，余量相同按单位名字典序。** 必须写死，否则预填结果不可预测、测试也没法断言。
20. **「今天」取本地日**（`new Date()` → 本地 `YYYY-MM-DD`），因为用户在哪个时区就以哪天为准；只有「日期 + 保质期天数」的算术用 UTC 零点，防止跨时区差一天。纯函数只收字符串，`today` 由页面传，便于测试。

---

## 5. 数据结构

### 5.1 两张新表（`src/db/index.ts` 的 `DDL`，本地 SQLite）

```sql
CREATE TABLE IF NOT EXISTS inventory_batches (
  id              TEXT PRIMARY KEY,
  ingredient_id   TEXT NOT NULL,      -- 逻辑外键，不写 REFERENCES（§4.15）
  amount          REAL NOT NULL CHECK (amount > 0),
  unit_id         TEXT,               -- 同上
  produced_at     TEXT,               -- YYYY-MM-DD，可空
  shelf_life_days INTEGER,            -- 可空；有它 + produced_at 才能自动算过期日
  expires_at      TEXT,               -- YYYY-MM-DD，可空；自动算完也存这里，查临期只看这一列
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

CREATE TABLE IF NOT EXISTS inventory_usages (
  id          TEXT PRIMARY KEY,
  recipe_id   TEXT NOT NULL,          -- 逻辑外键：缓存菜谱会被 sync 物理删除（§4.15）
  batch_id    TEXT NOT NULL,          -- 逻辑外键；批次只软删
  amount      REAL NOT NULL CHECK (amount > 0),
  used_at     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_ing ON inventory_batches(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_inventory_usages_batch ON inventory_usages(batch_id);
```

- 两张都是业务表，带 `id` / `updated_at` / `deleted_at`（AGENTS.md 规则）。它们不进同步载荷，但保留墓碑列是为了将来真要同步时不用改表。
- **三个业务外键列刻意不写 `REFERENCES`**（§4.15）：`sync.ts` 会物理删掉被合并的字典行与缓存菜谱行，真外键只会换来同步卡死，换不来完整性。完整性靠应用层守卫（§4.17）与「批次软删」（§4.2）。
- `expires_at` 冗余存一份而不在查询时算：临期查询变成纯列比较，且用户手填的过期日本来就没有 `produced_at + days` 的关系。
- 使用记录**不存 `ingredient_id` / `unit_id`**：批次上已经都有，存两份就能不一致。展示时 JOIN 出来。
- `batch_id` 不加 `ON DELETE CASCADE`：批次是软删（`deleted_at`），行永远在，历史记录不会悬空。
- `recipe_id` 可能指向一条**已不存在的**菜谱（社区菜谱取消收藏后被 sync 物理删除）。本轮没有历史页，这一列只在扣减时写入、无人读取，所以悬空无害；将来做历史页时用 `LEFT JOIN recipes` 显示「这道菜已不在库里」。

### 5.2 类型（`src/types/index.ts` 追加）

```ts
export interface InventoryBatch {
  id: string;
  ingredient_id: string;
  amount: number;
  unit_id: string | null;
  produced_at: string | null;
  shelf_life_days: number | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** 批次 + 派生出来的余量。余量永不落库。 */
export interface BatchStock {
  batch: InventoryBatch;
  ingredient_name: string;
  unit_name: string | null;
  remaining: number;
}

/** 库存页一行 = 一个食材，按单位拆成若干份额（不同单位不混算） */
export interface IngredientStock {
  ingredient_id: string;
  ingredient_name: string;
  parts: { unit_id: string | null; unit_name: string | null; remaining: number }[];
  /** 余量 > 0 的批次里最早的过期日，用于临期标记与排序；全为空则 null */
  soonest_expires_at: string | null;
  /** 所有份额余量都 ≤ 0 */
  usedUp: boolean;
}

/** 录入批次的提交形状 */
export interface BatchInput {
  ingredient_id: string;
  amount: number;
  unit_id: string | null;
  produced_at: string | null;
  shelf_life_days: number | null;
  expires_at: string | null;
}

/** 制作表单的一行（预填自菜谱食材，可改数量与单位） */
export interface CookLine {
  ingredient_id: string;
  ingredient_name: string;
  unit_id: string | null;
  /** 页面上选中的单位名，只用于结果态显示，不落库 */
  unit_name: string | null;
  amount: number;
}

export interface CookResult {
  /** 实际扣掉的量（可能小于表单填的） */
  deducted: { ingredient_name: string; unit_name: string | null; amount: number }[];
  /** 扣不满的行 */
  shortfall: { ingredient_name: string; unit_name: string | null; missing: number }[];
}
```

---

## 6. 逐块设计

### 6.1 纯函数 `src/utils/inventory.ts`（新增）

```ts
export const EXPIRING_SOON_DAYS = 7;

/** 本地日（YYYY-MM-DD）。页面传 `new Date()` 进来，测试传固定时刻。 */
export function localToday(now: Date): string;

/** 生产日期 + 保质期天数 → 过期日；任一为空返回 null。UTC 加法，不随本地时区差一天。 */
export function computeExpiresAt(producedAt: string | null, shelfLifeDays: number | null): string | null;

/** today 也传进来（测试可控）：过期日为 null → "none" */
export function expiryState(expiresAt: string | null, today: string): "none" | "soon" | "expired";

/** 单位下这一批次还能扣多少；用记录已扣过的要减掉 */
export function remainingOf(batch: { amount: number }, used: number): number;

/**
 * FIFO 扣减计划：按 expires_at 升序（null 排最后），同日期按 created_at 升序。
 * 只吃「已经筛过单位」的候选。want 超出库存时只扣现有的，shortfall 报差额。
 */
export function planDeduction(
  candidates: { batch_id: string; remaining: number; expires_at: string | null; created_at: string }[],
  want: number,
): { plan: { batch_id: string; amount: number }[]; shortfall: number };

/** 库存页排序：先「还有余量」后「已用完」；组内按最早过期日升序（null 最后），再按食材名。 */
export function sortStockRows(rows: IngredientStock[]): IngredientStock[];
```

`planDeduction` 的 `candidates` 由调用方传「该单位下、扣过本轮已扣量之后」的候选；函数本身只看余量，不查库、不知道批次之间的生意关系。

**扣减规则（逐条写死，实现照抄）**

| 步骤 | 规则 |
|---|---|
| 候选 | 该 `ingredient_id` 且 `unit_id` 与该行**完全相等**（`null` 只配 `null`）且「余量 − 本轮已扣」> 0 且未软删的批次 |
| 排序 | `expires_at` 有值的在前、升序；无过期日的排最后；都无则按 `created_at` 升序 |
| 分配 | 依次扣：每批扣 `min(余量, 剩余需求)`，直到需求为 0 |
| 不足 | 需求未清零 → `shortfall = 剩余需求`，`plan` 只含真实存在的量 |
| 写库 | `plan` 里每项写一条 `inventory_usages`。`plan` 为空则该行不写记录 |

### 6.2 store `src/stores/inventory.ts`（新增）

```ts
export const useInventoryStore = defineStore("inventory", () => {
  /** 全部未删批次 + 余量，一次查库；库存页展开与制作页都从这里读 */
  const batches: Ref<BatchStock[]>;

  /** 查库并重算余量。每次进库存页 / 制作页 / 提交后都调 */
  function fetchAll(): Promise<void>;

  /** 校验 + 落库 + 重新 fetchAll */
  function addBatch(input: BatchInput): Promise<void>;

  /** 软删批次（用记录不动） */
  function removeBatch(id: string): Promise<void>;

  /** 某食材各单位的可用余量：Map<ingredient_id, {unit_id, remaining}[]>，制作页预填用。同步读内存，调用前先 fetchAll */
  function remainingByIngredient(ingredientIds: string[]): Map<string, { unit_id: string | null; remaining: number }[]>;

  /** 按行扣减并写使用记录，返回实际扣减与不足 */
  function commitCook(recipeId: string, lines: CookLine[]): Promise<CookResult>;
});
```

`fetchAll` 的 SQL（一份数据两用：批次余量 + 食材汇总都在 JS 里聚合）：

```sql
SELECT b.id, b.ingredient_id, b.amount, b.unit_id, b.produced_at, b.shelf_life_days,
       b.expires_at, b.created_at, b.updated_at, b.deleted_at,
       i.name AS ingredient_name, u.name AS unit_name,
       COALESCE(x.used, 0) AS used
FROM inventory_batches b
JOIN ingredients i ON i.id = b.ingredient_id
LEFT JOIN units u ON u.id = b.unit_id
LEFT JOIN (
  SELECT batch_id, SUM(amount) AS used
  FROM inventory_usages
  WHERE deleted_at IS NULL
  GROUP BY batch_id
) x ON x.batch_id = b.id
WHERE b.deleted_at IS NULL
ORDER BY b.expires_at IS NULL ASC, b.expires_at ASC, b.created_at ASC, b.id ASC
```

- `remaining = amount - used`，在 store 里算成 `BatchStock`。
- 不筛 `i.deleted_at IS NULL`：食材被引用时删不掉（`refStore.remove` 的前置检查），能被 JOIN 出来的必然没软删（与 `recipeFilter` 的食材查询同一条理由）。
- 进货时**校验**（在任何写入之前，抛中文错误给页面显示）：数量 > 0；`expires_at` 若与 `produced_at` 同时存在，不得早于后者；`shelf_life_days` 若给出必须是 ≥ 1 的整数。
- `removeBatch`：`UPDATE inventory_batches SET deleted_at = ?, updated_at = ? WHERE id = ?`。不删 `inventory_usages`（历史不追改）。
- `commitCook` 开头先 `fetchAll()` 拿最新余量（避免用过期内存算账），逐行 `planDeduction`，然后把所有 `plan` 项按顺序 INSERT；**不开事务**（§4.14），每条记录自己完整。
- `commitCook` 内维护 `usedThisCook: Map<batch_id, number>`（§4.18）：每行规划前把候选余量减掉它，规划后把本行结果累加进去。同食材同单位出现多行时不会重复扣同一批。
- `remainingByIngredient` 也走同一份 `fetchAll` 结果，不额外写 SQL。
- store 不触达 `enqueueSync`。库存不同步是设计，不是遗漏。

### 6.3 库存页 `src/views/InventoryPage.vue`（新增，`/inventory`）

```
<div class="flex h-full flex-col">
  <AppHeader title="食材库存" show-back @back="router.back()">
    <template #action>  加号（data-test="inventory-add", aria-label="录入批次"）→ 打开 BatchSheet
  </AppHeader>
  <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
    <p v-if="loading">…</p>
    <p v-else-if="rows.length === 0">还没有库存，点右上角加号记一批</p>
    <ul v-else>
      每个食材一行（data-test="stock-row"）：
        左：食材名 + 临期/已过期徽标
        右：余量文本（多单位拼接 "500 g、2 个"；已用完显示灰字「已用完」）
        点击整行 → 展开该食材的批次列表（data-test="stock-batch"）
      展开的批次行：数量与剩余、生产日期、过期日、右侧删除按钮（ConfirmDialog 确认）
    </ul>
  </div>
</div>
```

- 展开状态用 `ref<Set<string>>`（食材 id 集合），本页内存态，不持久化。
- 余量文本：`parts.map(p => `${round(p.remaining)} ${p.unit_name ?? ""}`.trim()).join("、")`。数字用 `Number(r.toFixed(2))` 去掉浮点尾巴（`0.1 + 0.2` 这种）。
- 徽标：`expiryState` → `soon` 显示「快过期」(`text-warning` 若有，否则 `text-danger`)、`expired` 显示「已过期」(`text-danger`)。**不新增颜色变量**（§6.9）。
- 批次行排序与 `fetchAll` 的 `ORDER BY` 一致，页面不再排。
- 删除批次成功后 `void store.fetchAll()`。
- 空状态文案里的「右上角」必须与加号实际位置一致（加号在 `AppHeader` 的 `action` 槽）。

### 6.4 录入批次 `src/components/BatchSheet.vue`（新增）

照 `IngredientSheet.vue` 的三层结构写，**不改那个组件**：

- 第一步：`RefSheet`（`mode="single"`，`store=useIngredientStore()`，`empty-hint="还没有食材，输入名称即可新建"`）选食材 → 进入第二步。
- 第二步（本组件的面板，`z-20 / z-30`，与 `IngredientSheet` 同一层级关系）：
  - 数量：`type="number" inputmode="decimal"`，必填，≤ 0 报「数量要大于 0」。
  - 单位：一行按钮 → `RefSheet`（`useUnitStore()`），可留空（与菜谱食材一致，「适量」类东西不记单位）。
  - 生产日期：`type="date"`，可空。
  - 保质期天数：`type="number" inputmode="numeric"`，可空。
  - 过期日：`type="date"`，可空。**自动规则**：`produced_at` 与 `shelf_life_days` 都有效时，`computeExpiresAt` 的结果自动写入过期日；**一旦用户手改过期日，`expiryTouched = true`，之后不再自动覆盖**；用户手动清空过期日则 `expiryTouched = false`，恢复自动。
  - 底部「保存」`data-test="batch-save"`，提交 `emit("save", input)`，父组件等 `addBatch` 成功后关窗；失败把错误文案显示在面板内（不关窗，不丢输入）。
- 键盘：`useKeyboardInset()` + `paddingBottom: calc(inset + 2rem + env(safe-area-inset-bottom))`，与 `IngredientSheet` 逐字一致。
- `data-test`：`batch-amount` / `batch-unit` / `batch-produced` / `batch-shelf-life` / `batch-expires` / `batch-save` / `batch-close`。

### 6.5 制作消耗页 `src/views/CookPage.vue`（新增，`/recipe/:id/cook`）

```
<div class="flex h-full flex-col">
  <AppHeader title="制作" show-back @back="router.back()" />
  <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
    <p>按实际用量改，填 0 表示这次不用这样</p>
    <ul>
      每行（data-test="cook-row"）：
        食材名（data-test="cook-name"）
        可用余量（data-test="cook-available"）："库存 500 g" / "库存 0 g"
        数量输入（data-test="cook-amount"，number/decimal，"适量"的行预填空）
        单位按钮（data-test="cook-unit"）→ RefSheet 选单位
    </ul>
    <p v-if="anyShortfall" data-test="cook-shortfall-hint" class="text-sm text-danger">
      有几行库存不够，确认后只扣现有的
    </p>
  </div>
  <div class="shrink-0 px-4 py-3">
    <button data-test="cook-confirm">确认制作</button>
  </div>
</div>
```

- 数据来源：`recipeStore.getDetail(id)` 的 `ingredients`（含 `ingredient_name` / `unit_name` / `amount`）+ `inventoryStore.remainingByIngredient(...)`。
- **预填规则**：数量 = 菜谱用量（`amount` 为 `null`（适量）→ 预填空）；单位 = 菜谱单位，但若该单位下余量为 0 而**该食材在别的单位下有库存**，预填改成那个有库存的单位（多个候选取余量最大、同余量按单位名，§4.19） —— 这是「菜谱 2 个、库存 500 g」最常见的撞法，避免用户还要手点一下。
- 行内可用余量随所选单位实时变（`remainingByIngredient` 的结果保存在内存里，改单位不查库）。
- 确认前的校验：所有行数量都为空或 0 → 按钮 `disabled`；某行数量非数字 → 该行红字「填个数字」。负数视为 0。
- 确认后：`commitCook` → 原地切到结果态（同一路由，不跳转）：
  - 标题「已记录」
  - `deducted` 逐行：「五花肉 扣了 200 g」
  - `shortfall` 逐行：「鸡蛋 还差 2 个（库存已扣完）」
  - 底部按钮变「完成」`data-test="cook-done"` → `router.back()`
- 结果态下所有输入与确认按钮不再渲染，避免重复提交。
- 从结果态返回时列表页/详情页无需刷新（库存页 `onMounted` 会重查）。

### 6.6 菜谱详情页加按钮（`src/views/RecipeDetail.vue`，改）

`AppHeader` 的 `action` 槽里，**放在「指导模式」前面**：

```vue
<button
  type="button"
  data-test="cook"
  aria-label="制作"
  class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
  @click="router.push(`/recipe/${recipeId}/cook`)"
>
  <ChefHat :size="18" class="text-text-secondary" />
</button>
```

- 图标用 `lucide-vue-next` 的 `ChefHat`。
- **对别人的菜谱也显示**：做饭不需要编辑权限。这是本条唯一需要说明的取舍。
- 除这一个按钮与 `import` 之外，详情页一个字节不改。

### 6.7 「我的」页加入口（`src/views/MePage.vue`，改）

在用户卡片与「多设备同步」行之间插一行，形态照抄现有 `server-row`（整行按钮 + 右侧 `ChevronRight`）：

```vue
<button type="button" data-test="inventory-row" class="…与 server-row 同款…" @click="router.push('/inventory')">
  <span class="text-text">食材库存</span>
  <ChevronRight :size="16" class="text-text-secondary" />
</button>
```

### 6.8 字典守卫与同步重指（改两个现有文件，各一处）

- `src/stores/refStore.ts` 的 `countRecipes` 改名意图不变，查询扩成「菜谱引用数 + 库存批次引用数」（§4.17）：有任意一个 > 0 就抛「这个食材还有库存，先删掉批次再来」。仅新增一条 SQL 与一个判断，现有行为在库存为空时逐字不变。
- `src/services/sync.ts` 的 `repointSql`：`ingredients` 分支补 `UPDATE inventory_batches SET ingredient_id = ? WHERE ingredient_id = ?`，`units` 分支补 `UPDATE inventory_batches SET unit_id = ? WHERE unit_id = ?`（§4.16）。**除此之外 `sync.ts` 不动**：payload 类型、下载、上传、`deleteCachedOtherRecipes` 全部维持原样。

### 6.9 路由（`src/router/index.ts`，改）

```ts
{ path: "/inventory", name: "inventory", component: InventoryPage, meta: { hideTab: true } },
{ path: "/recipe/:id/cook", name: "recipe-cook", component: CookPage, meta: { hideTab: true } },
```

`/inventory` 放在静态段区域（`/me` 附近）；`/recipe/:id/cook` 放在 `/recipe/:id` **之前**（与 `guide` 同一条理由：静态尾段优先）。

### 6.10 设计变量

**不新增颜色、不新增字号。** 用现有 `bg-surface` / `text-text` / `text-text-secondary` / `text-primary` / `text-danger` / `border-gray-200` / `rounded-xl` / `rounded-lg` / `text-xs` `text-sm` `text-base`。「快过期」用 `text-danger`（项目里没有 warning 色，不去发明一个）。

---

## 7. 现有测试给的约束

现有断言**一处都不许改弱**，只允许：补 fixture 字段、加 `vi.mock`、加新用例。

| 文件 | 需要的改动 | 为什么不算改弱 |
|---|---|---|
| `db/__tests__/schema.test.ts` | 加 `inventory_batches` / `inventory_usages` 存在性与列断言 | 纯新增 |
| `db/__tests__/migrate.test.ts` | 不用改（`initTables` 内部调 DDL，老库不涉及新表） | — |
| `views/__tests__/RecipeDetail.test.ts` | 加一条「顶栏有 `[data-test="cook"]`，点了跳 `/recipe/:id/cook`」 | 纯新增 |
| `views/__tests__/MePage.test.ts` | 加一条「`[data-test="inventory-row"]` 跳 `/inventory`」 | 纯新增 |
| `router/__tests__/routes.test.ts` | 加两条路由存在且 `hideTab` | 纯新增 |
| `stores/__tests__/refStore.test.ts` | 加「有库存批次时不能删食材 / 不能删单位」 | 纯新增（库存为空时旧用例走的是同一分支） |
| `services/__tests__/syncMerge.test.ts` | 加「字典合并后批次指向合并后的食材 / 单位」 | 纯新增（原有合并用例不受影响） |

必须原样通过、一行不碰：

- `RecipeDetail.test.ts` 现有全部断言（编辑 / 删除 / 收藏 / 指导模式 / 作者卡片）。
- `MePage.test.ts` 现有全部断言（同步条三态、AI 隐私开关）。
- 共享组件测试：`RefSheet` / `IngredientSheet` / `AppHeader` / `ConfirmDialog` **一个字节都不改这些组件**。

新增测试：

| 文件 | 覆盖 |
|---|---|
| `utils/__tests__/inventory.test.ts` | `computeExpiresAt`（跨月、闰年、null）；`expiryState`（none/soon/expired 边界 7 天与当天）；`planDeduction`（单批、跨批、无过期日排最后、同日期按 created_at、库存不足只扣现有、want=0）；`sortStockRows`（已用完沉底、最早过期在前、null 最后） |
| `stores/__tests__/inventory.test.ts` | `addBatch` 落库与校验（数量 0 / 负数 / 过期日早于生产日期 / 保质期天数非正）；`fetchAll` 余量 = 数量 − 使用记录；`removeBatch` 软删后不出现在结果、使用记录仍在；`commitCook` 跨批次写记录、单位不同不混扣、扣不满返回 shortfall、软删批次不参与 |
| `views/__tests__/InventoryPage.test.ts` | 空状态文案；汇总多单位拼接；快过期/已过期徽标；展开批次；删批次确认后消失；加号打开 `BatchSheet` |
| `components/__tests__/BatchSheet.test.ts` | 数量校验；生产日期 + 保质期天数自动算过期日；手改过期日后不再被覆盖；清空过期日恢复自动；保存提交的形状 |
| `views/__tests__/CookPage.test.ts` | 预填数量与单位；「适量」行预填空；单位自动切到有库存的那个；有多个有库存单位时按 §4.19 的确定性规则选；改成 0 不扣且不写记录；全 0 时确认按钮 disabled；库存不足提示；确认后结果态显示扣减与差额；点「完成」回上一页 |

---

## 8. 验证

```bash
npm run test        # 全绿（含新增五个测试文件）
npm run build       # vue-tsc 类型检查 + 构建
npm run tauri -- android build --apk --debug   # 真机装一遍
```

真机上要盯的七件事：

1. 录入批次时软键盘弹起，底部「保存」仍然点得到；键盘收起不残留空白。
2. 生产日期 + 保质期天数填完，过期日自动出现；手动改过期日后不再被覆盖。
3. 菜谱写「2 个」、库存记「500 g」时，制作页打开就把单位切到 `g`、数量按菜谱填 —— 不出现「扣不掉」的死路。
4. 跨两个批次扣减：两个批次的余量都正确减少，且先扣快过期那批。
5. 库存不足时确认后显示「还差多少」，库存变成「已用完」而不是负数。
6. 「我的 → 食材库存」返回、详情页「制作」返回，都不留空白页或死循环。
7. 库存页与制作页在窄屏上不出现横向滚动。

---

## 9. 留给下一轮

- 「这道菜还差什么料」的缺料计算 / 按库存反向推荐。
- 制作历史（需要给 `inventory_usages` 加 `cook_id`）与「撤销这次制作」。
- 撤销后重做：批次编辑（现在只能删了重录）。
- 低库存阈值、买菜清单（余量低于阈值 → 生成采购项）。
- 库存同步 / 多厨房。
- 过期提醒通知。

---

## 10. 风险

- **账实不符无法修正**：扣错了只能删批次重录，使用记录会留在库里。本轮刻意不做撤销（§9），这是最大的一处不完整。
- **单位靠人填**：同一个东西这次记「g」下次记「斤」，两批就永远不会被一起扣。缓解是自动切单位（§6.5），根治要单位换算表，不在本轮。
- **`sync.ts` 现在必须知道库存表存在**（§4.16 的两条 repoint）。这是本地表与远端字典共享主键的必然代价：以后再往 `sync.ts` 里加物理 `DELETE` 的路径时，先检查有没有本地表引着那些 id。
- 无事务的逐条写入（§4.14）：崩溃点最多让库存偏高。
