# 菜谱筛选与搜索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 菜谱列表页加名称模糊搜索 + 右上角筛选入口，筛选页支持分类/标签/食材三维度多选（食材与标签「同时包含」，分类「命中任一」），筛选结果回到列表页并用一条按需出现的信息条写明筛了什么。

**Architecture:** 筛选所需的数据全部塞进 `RecipeListItem`（在现有 `fetchAll` 上多查一条食材关联），过滤与摘要做成对 `RecipeListItem[]` 的纯函数（`src/utils/recipeFilter.ts`），筛选状态放一个内存里的 Pinia store（`src/stores/recipeFilter.ts`），两个页面只负责画和改状态。不碰数据库 schema、不碰任何共享组件。

**Tech Stack:** Vue 3 + TypeScript（严格模式）+ Pinia + vue-router 4 + Vitest（happy-dom）+ Tailwind 4 主题变量 + lucide-vue-next + node:sqlite 跑真 SQL 的 store 测试。

**Spec:** `docs/superpowers/specs/2026-10-14-recipe-filter-design.md`

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**。
- 不重构无关代码，不修改未被本计划点名的文件。**`RefSheet.vue` / `IngredientSheet.vue` / `ImagePicker.vue` / `ConfirmDialog.vue` / `AppHeader.vue` 一个字节都不许改。**
- 测试优先：每个任务先写失败测试。**已有测试的断言不许放宽、删除或改弱**；只允许三种改动——给 fixture 补新字段、加 `vi.mock`、加新用例。
- 所有现有 `data-test` 钩子必须保留（列表页 `recipe-add` / `recipe-card` / `recipe-cover` / `recipe-cover-fallback` / `recipe-name` / `recipe-category` / `recipe-tag`）。
- 设计变量不新增：只用 `bg-bg` / `bg-surface` / `text-text` / `text-text-secondary` / `text-primary` / `text-danger` / `border-gray-100` / `border-gray-200` / `rounded-xl` / `rounded-full` / `text-xs` `text-sm` `text-lg`。**不要用 15/16/17px，不要引入组件库。**
- 顶栏动作一律图标，不用文字。
- 注释只写「为什么」，一行说清；中文。
- 提交信息用中文，沿用现有 `feat:` / `test:` / `docs:` 前缀风格。每个任务单独提交。
- 验证命令：`npm run test`（vitest run）、`npm run build`（vue-tsc --noEmit + vite build）。

## Review Focus

最可能咬到用户、而规格里没明说的五处，各自都有归属任务里的测试钉住：

1. **同一道菜里同一个食材出现两行**（编辑页允许重复添加）：列表行的食材必须去重，否则摘要会写两遍、勾选框也会算错。→ Task 1。
2. **筛选活跃但候选里已经没有那个 id**（最后一道带该标签的菜被删了）：不允许出现「列表 0 条 + 没有任何东西可点」。信息条必须仍然渲染且可清除。→ Task 3。
3. **「库里一条菜谱都没有」与「有菜谱但被筛掉了」是两种文案**，不能合并成一句。→ Task 3。
4. **分类多选被误写成 AND**：一道菜只有一个分类，选两个分类时必须是「命中任一」，写成 AND 会永远筛出 0 条。→ Task 2。
5. **关键词的边界**：中文子串、前后空格、大小写。→ Task 2。

真机上只能靠人眼的一条（软键盘遮挡底部按钮）写在 spec §8，Task 5 里交给设备上的人。

---

### Task 1: 列表行带出食材

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/stores/recipe.ts`（只改 `fetchAll`）
- Modify: `src/stores/__tests__/recipe.test.ts`（只加用例）
- Modify: `src/views/__tests__/RecipeList.test.ts`（只改 `item()` fixture）

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `src/types/index.ts`: `export interface IngredientRef { id: string; name: string }`；`RecipeListItem` 变为 `{ recipe: Recipe; category: Label; tags: Label[]; ingredients: IngredientRef[] }`
  - `useRecipeStore().fetchAll()` 之后，每个 `RecipeListItem.ingredients` 是该菜谱的食材（去重、按 `recipe_ingredients.sort_order` 排）

- [ ] **Step 1: 写失败测试**

在 `src/stores/__tests__/recipe.test.ts` 的 `describe("recipeStore", ...)` 里追加（不要改动现有用例；`newCategory` / `newIngredient` / `input` 都是文件里现成的辅助函数）：

```ts
it("fetchAll 带出食材：按 sort_order、同一食材只留一次", async () => {
  const pork = await newIngredient("五花肉");
  const potato = await newIngredient("土豆");
  const store = useRecipeStore();
  await store.create(
    input({
      category_id: await newCategory(),
      // 传入顺序：土豆 → 五花肉 → 五花肉（同一食材重复添加，编辑页允许）
      ingredients: [
        { ingredient_id: potato, amount: 2, unit_id: null },
        { ingredient_id: pork, amount: 500, unit_id: null },
        { ingredient_id: pork, amount: 100, unit_id: null },
      ],
    }),
  );

  await store.fetchAll();

  expect(store.recipes[0].ingredients).toEqual([
    { id: potato, name: "土豆" },
    { id: pork, name: "五花肉" },
  ]);
});
```

再追加一条「空食材的菜谱拿到空数组」，防止 `undefined`：

```ts
it("fetchAll 里没有食材的菜谱拿到空数组而不是 undefined", async () => {
  const store = useRecipeStore();
  await store.create(input({ category_id: await newCategory() }));

  await store.fetchAll();

  expect(store.recipes[0].ingredients).toEqual([]);
});
```

同时给 `src/views/__tests__/RecipeList.test.ts` 的 `item()` 补上新字段（不补编译不过，`npm run build` 会红）。`opts` 增加 `ingredients?: string[]`，返回对象增加：

```ts
    ingredients: (opts.ingredients ?? []).map((name, index) => ({
      id: `${id}-i${index}`,
      name,
    })),
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/recipe.test.ts`
Expected: 两条新用例 FAIL（`store.recipes[0].ingredients` 是 `undefined`）；`RecipeList.test.ts` 因缺少 `ingredients` 属性在类型层面报错（vitest 不做类型检查，所以先靠上面两条 store 用例变红）。

- [ ] **Step 3: 改类型**

`src/types/index.ts`：加 `IngredientRef` 并给 `RecipeListItem` 加字段（注释照写）。

```ts
/** 列表行里用到的食材：只要 id 与名字，够筛选和显示摘要 */
export interface IngredientRef {
  id: string;
  name: string;
}

/** 列表页一行：菜谱 + 它的分类、标签、食材 */
export interface RecipeListItem {
  recipe: Recipe;
  category: Label;
  tags: Label[];
  ingredients: IngredientRef[];
}
```

- [ ] **Step 4: 改 `fetchAll`**

`src/stores/recipe.ts` 的 `fetchAll` 里，在现有 `links` 查询之后加一条查询与一次聚合，并把 `ingredients` 放进返回的每一行：

```ts
const ingredientRows = await db.select<
  { recipe_id: string; ingredient_id: string; ingredient_name: string }[]
>(
  `SELECT ri.recipe_id, ri.ingredient_id, i.name AS ingredient_name
   FROM recipe_ingredients ri
   JOIN ingredients i ON i.id = ri.ingredient_id
   WHERE ri.deleted_at IS NULL
   ORDER BY ri.recipe_id ASC, ri.sort_order ASC, ri.id ASC`,
);

const ingredientsByRecipe = new Map<string, IngredientRef[]>();
for (const row of ingredientRows) {
  const list = ingredientsByRecipe.get(row.recipe_id) ?? [];
  // 同一道菜里同一个食材可能有多行（编辑页允许重复添加），列表里只留第一次出现的
  if (!list.some((item) => item.id === row.ingredient_id)) {
    list.push({ id: row.ingredient_id, name: row.ingredient_name });
  }
  ingredientsByRecipe.set(row.recipe_id, list);
}
```

`recipes.value = rows.map(...)` 里加 `ingredients: ingredientsByRecipe.get(recipe.id) ?? []`，`import type` 里加上 `IngredientRef`。

**为什么内 JOIN 而不加 `i.deleted_at IS NULL`**：食材被菜谱引用时删不掉（`labelStore.remove` 同款前置检查），能被 JOIN 出来的必然没软删；加上反而会把关联静默漏掉。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test -- src/stores/__tests__/recipe.test.ts`
Expected: 全绿（含两条新用例）。

Run: `npm run test`
Expected: 全绿。

Run: `npm run build`
Expected: 无类型错误。

- [ ] **Step 6: 提交**

```bash
git add src/types/index.ts src/stores/recipe.ts src/stores/__tests__/recipe.test.ts src/views/__tests__/RecipeList.test.ts
git commit -m "feat: 列表查询带出每道菜的食材（去重、按 sort_order）"
```

---

### Task 2: 筛选逻辑与筛选状态

**Files:**
- Create: `src/utils/recipeFilter.ts`
- Create: `src/utils/__tests__/recipeFilter.test.ts`
- Create: `src/stores/recipeFilter.ts`
- Create: `src/stores/__tests__/recipeFilter.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RecipeListItem`（含 `ingredients`）
- Produces:
  - `src/utils/recipeFilter.ts`:
    - `export interface RecipeFilter { keyword: string; categoryIds: string[]; tagIds: string[]; ingredientIds: string[] }`
    - `export function emptyFilter(): RecipeFilter`
    - `export function cloneFilter(filter: RecipeFilter): RecipeFilter`
    - `export function isFilterActive(filter: RecipeFilter): boolean`
    - `export function filterRecipes(items: RecipeListItem[], filter: RecipeFilter): RecipeListItem[]`
    - `export function filterSummary(filter: RecipeFilter, items: RecipeListItem[]): string`
  - `src/stores/recipeFilter.ts`: `export const useRecipeFilterStore = defineStore("recipeFilter", ...)`，返回 `{ filter: RecipeFilter; apply(next: RecipeFilter): void; clear(): void }`。
    `filter` 是 **`reactive<RecipeFilter>(emptyFilter())`，不是 `ref`**——这样 `npm run build`（vue-tsc 会连测试文件一起查，`tsconfig.json` 的 `include` 是 `src/**/*.ts`）里，测试 mock 出来的同形状对象与真实类型完全一致，组件里 `v-model="filterStore.filter.keyword"` 也不用写 `.value`。`apply` 存的是 `cloneFilter(next)`，`clear()` 存 `emptyFilter()`（两者都走 `Object.assign(filter, ...)`，整体替换数组引用）

- [ ] **Step 1: 写失败测试（纯函数）**

`src/utils/__tests__/recipeFilter.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Label, LabelKind, Recipe, RecipeListItem } from "@/types";
import {
  cloneFilter,
  emptyFilter,
  filterRecipes,
  filterSummary,
  isFilterActive,
} from "@/utils/recipeFilter";

const NOW = "2026-10-14T00:00:00.000Z";

function label(id: string, name: string, kind: LabelKind): Label {
  return { id, name, kind, created_at: NOW, updated_at: NOW, deleted_at: null };
}

/** 一行菜谱；分类/标签/食材的 id 由名字派生，测试里好读 */
function row(
  name: string,
  opts: { category?: string; tags?: string[]; ingredients?: string[] } = {},
): RecipeListItem {
  const category = opts.category ?? "家常菜";
  const recipe: Recipe = {
    id: `r-${name}`,
    name,
    cover_path: null,
    category_id: `cat-${category}`,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  };
  return {
    recipe,
    category: label(recipe.category_id, category, "category"),
    tags: (opts.tags ?? []).map((tag) => label(`tag-${tag}`, tag, "tag")),
    ingredients: (opts.ingredients ?? []).map((ingredient) => ({
      id: `ing-${ingredient}`,
      name: ingredient,
    })),
  };
}

/** 全部条件都只填需要的字段 */
function filter(overrides: Partial<ReturnType<typeof emptyFilter>> = {}) {
  return { ...emptyFilter(), ...overrides };
}

describe("emptyFilter / cloneFilter", () => {
  it("emptyFilter 四项为空且是独立对象", () => {
    const a = emptyFilter();
    const b = emptyFilter();
    expect(a).toEqual({ keyword: "", categoryIds: [], tagIds: [], ingredientIds: [] });
    expect(a.categoryIds).not.toBe(b.categoryIds);
  });

  it("cloneFilter 复制数组，改副本不影响原对象", () => {
    const source = filter({ categoryIds: ["cat-家常菜"], tagIds: ["tag-快手"] });

    const copy = cloneFilter(source);
    copy.categoryIds.push("cat-汤");
    copy.tagIds.length = 0;

    expect(source.categoryIds).toEqual(["cat-家常菜"]);
    expect(source.tagIds).toEqual(["tag-快手"]);
  });
});

describe("isFilterActive", () => {
  it("只有关键词不算活跃（关键词有自己的输入框）", () => {
    expect(isFilterActive(filter({ keyword: "红烧" }))).toBe(false);
  });

  it("三个多选任一非空就算活跃", () => {
    expect(isFilterActive(filter({ categoryIds: ["cat-家常菜"] }))).toBe(true);
    expect(isFilterActive(filter({ tagIds: ["tag-快手"] }))).toBe(true);
    expect(isFilterActive(filter({ ingredientIds: ["ing-五花肉"] }))).toBe(true);
  });
});

describe("filterRecipes", () => {
  it("空筛选原样返回，顺序不变", () => {
    const items = [row("红烧肉"), row("番茄炒蛋")];
    expect(filterRecipes(items, emptyFilter())).toEqual(items);
  });

  it("关键词按中文子串匹配", () => {
    const items = [row("红烧肉"), row("番茄炒蛋")];

    expect(filterRecipes(items, filter({ keyword: "红烧" })).map((i) => i.recipe.name)).toEqual([
      "红烧肉",
    ]);
    expect(filterRecipes(items, filter({ keyword: "鱼" }))).toEqual([]);
  });

  it("关键词去掉前后空格，且不分大小写", () => {
    const items = [row("ABC 汤")];

    expect(filterRecipes(items, filter({ keyword: "  abc  " }))).toHaveLength(1);
  });

  it("分类多选是「或」——一道菜只有一个分类", () => {
    const items = [row("红烧肉", { category: "荤菜" }), row("冬瓜汤", { category: "汤" }), row("炒青菜", { category: "素菜" })];

    const names = filterRecipes(items, filter({ categoryIds: ["cat-荤菜", "cat-汤"] })).map(
      (i) => i.recipe.name,
    );

    expect(names).toEqual(["红烧肉", "冬瓜汤"]);
  });

  it("标签多选是「且」——两个标签都贴了的才算", () => {
    const items = [
      row("红烧肉", { tags: ["家常", "下饭"] }),
      row("番茄炒蛋", { tags: ["家常"] }),
      row("炒青菜", { tags: ["下饭"] }),
    ];

    const names = filterRecipes(items, filter({ tagIds: ["tag-家常", "tag-下饭"] })).map(
      (i) => i.recipe.name,
    );

    expect(names).toEqual(["红烧肉"]);
  });

  it("食材多选是「且」——两样都用了的才算", () => {
    const items = [
      row("土豆炖肉", { ingredients: ["五花肉", "土豆"] }),
      row("回锅肉", { ingredients: ["五花肉"] }),
      row("炒土豆丝", { ingredients: ["土豆"] }),
    ];

    const names = filterRecipes(items, filter({ ingredientIds: ["ing-五花肉", "ing-土豆"] })).map(
      (i) => i.recipe.name,
    );

    expect(names).toEqual(["土豆炖肉"]);
  });

  it("跨维度是「且」", () => {
    const items = [
      row("土豆炖肉", { category: "荤菜", ingredients: ["五花肉", "土豆"] }),
      row("土豆丝", { category: "素菜", ingredients: ["土豆"] }),
    ];

    const names = filterRecipes(
      items,
      filter({ categoryIds: ["cat-荤菜"], ingredientIds: ["ing-土豆"] }),
    ).map((i) => i.recipe.name);

    expect(names).toEqual(["土豆炖肉"]);
  });

  it("选中的条件在数据里根本不存在时结果是空", () => {
    expect(filterRecipes([row("红烧肉")], filter({ tagIds: ["tag-已删除"] }))).toEqual([]);
  });
});

describe("filterSummary", () => {
  const items = [
    row("土豆炖肉", { category: "家常菜", tags: ["快手", "下饭", "汤"], ingredients: ["五花肉", "土豆"] }),
  ];

  it("不活跃时返回空串（调用方据此不渲染整条）", () => {
    expect(filterSummary(emptyFilter(), items)).toBe("");
    expect(filterSummary(filter({ keyword: "土豆" }), items)).toBe("");
  });

  it("按 分类 → 标签 → 食材 拼，中间用 · 连，超过两个折叠", () => {
    const summary = filterSummary(
      filter({
        categoryIds: ["cat-家常菜"],
        tagIds: ["tag-快手", "tag-下饭", "tag-汤"],
        ingredientIds: ["ing-五花肉", "ing-土豆"],
      }),
      items,
    );

    expect(summary).toBe("📂 家常菜 · 🏷️ 快手、下饭 等3个标签 · 🥕 五花肉、土豆");
  });

  it("只选了一个维度时只写那一段", () => {
    expect(filterSummary(filter({ categoryIds: ["cat-家常菜"] }), items)).toBe("📂 家常菜");
    expect(filterSummary(filter({ ingredientIds: ["ing-五花肉"] }), items)).toBe("🥕 五花肉");
  });

  it("查不到名字的 id 兜底显示 id 本身（菜谱被删后的残留）", () => {
    expect(filterSummary(filter({ tagIds: ["tag-已删除"] }), items)).toBe("🏷️ tag-已删除");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/utils/__tests__/recipeFilter.test.ts`
Expected: FAIL —— `Failed to resolve import "@/utils/recipeFilter"`。

- [ ] **Step 3: 实现 `src/utils/recipeFilter.ts`**

签名见 Interfaces。实现要点（除下面写死的规则外，写法自定）：

- `filterRecipes`：对每个 item 依次判四个条件，全过才留；`keyword` 先 `trim()`，空则跳过，否则比较 `item.recipe.name.toLowerCase().includes(kw.toLowerCase())`（**字面子串**，不做拼音、不做分词）。
- `filterSummary`：
  - `isFilterActive(filter)` 为 false → 返回 `""`。
  - 三个维度各生成一段，段之间 `" · "` 连接，空维度整段跳过：
    - 分类 `📂 `、标签 `🏷️ `、食材 `🥕 `
    - 段内名字用 `、` 连接；**超过 2 个**时只显示前 2 个，后面接一个空格 + `等N个分类` / `等N个标签` / `等N个食材`（N 是选中的总数，含显示出来的两个）。
    - 名字查不到时兜底显示 id（保证活跃筛选的摘要永远非空）。
  - 名字来源：先把 `items` 里的分类、标签、食材分别建成一份 `Map<id, name>`，再按 `filter` 里 id 的顺序取（**顺序跟用户勾选顺序走，不要重排**）。
- 「超过 2 个」的阈值写成文件内常量 `const MAX_VISIBLE = 2;`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/utils/__tests__/recipeFilter.test.ts`
Expected: 全绿。

- [ ] **Step 5: 写失败测试（store）**

`src/stores/__tests__/recipeFilter.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { emptyFilter } from "@/utils/recipeFilter";
import { useRecipeFilterStore } from "@/stores/recipeFilter";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("recipeFilterStore", () => {
  it("初值是空筛选", () => {
    expect(useRecipeFilterStore().filter).toEqual(emptyFilter());
  });

  it("apply 存的是副本，之后改原对象不影响 store", () => {
    const store = useRecipeFilterStore();
    const next = { ...emptyFilter(), categoryIds: ["cat-家常菜"] };

    store.apply(next);
    next.categoryIds.push("cat-汤");

    expect(store.filter.categoryIds).toEqual(["cat-家常菜"]);
  });

  it("clear 四项全清，包括关键词", () => {
    const store = useRecipeFilterStore();
    store.apply({
      keyword: "红烧",
      categoryIds: ["cat-家常菜"],
      tagIds: ["tag-快手"],
      ingredientIds: ["ing-五花肉"],
    });

    store.clear();

    expect(store.filter).toEqual(emptyFilter());
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/recipeFilter.test.ts`
Expected: FAIL —— 找不到 `@/stores/recipeFilter`。

- [ ] **Step 7: 实现 `src/stores/recipeFilter.ts`**

照 Interfaces 写：`defineStore("recipeFilter", ...)`，`const filter = reactive<RecipeFilter>(emptyFilter())`，`apply(next)` 写 `Object.assign(filter, cloneFilter(next))`，`clear()` 写 `Object.assign(filter, emptyFilter())`，返回值形状与其它 store 一致（显式声明返回接口，参照 `stores/recipe.ts` 的写法）。**不要用 `ref`**：测试里 mock 的 store 就是同形状的 reactive 对象，用 `ref` 会让测试文件在 `vue-tsc` 下类型对不上。

- [ ] **Step 8: 跑测试确认通过**

Run: `npm run test`
Expected: 全绿。

Run: `npm run build`
Expected: 无类型错误。

- [ ] **Step 9: 提交**

```bash
git add src/utils/recipeFilter.ts src/utils/__tests__/recipeFilter.test.ts src/stores/recipeFilter.ts src/stores/__tests__/recipeFilter.test.ts
git commit -m "feat: 菜谱筛选逻辑与筛选状态（纯函数 + 内存 store）"
```

---

### Task 3: 列表页 —— 搜索框、漏斗、信息条

**Files:**
- Modify: `src/views/RecipeList.vue`
- Modify: `src/views/__tests__/RecipeList.test.ts`（加 `vi.mock` 与用例，**现有断言一行不动**）

**Interfaces:**
- Consumes: Task 1 的 `RecipeListItem.ingredients`；Task 2 的 `filterRecipes` / `filterSummary` / `isFilterActive` / `useRecipeFilterStore`
- Produces: 列表页顶栏多出 `data-test="recipe-filter"`；搜索框 `data-test="recipe-search"`；信息条 `data-test="filter-bar"` / `data-test="filter-summary"` / `data-test="filter-clear"`

- [ ] **Step 1: 写失败测试**

`src/views/__tests__/RecipeList.test.ts` 顶部加 mock。**注意两个细节**：`vi.mock` 的工厂体在模块导入时执行，所以在工厂里 `await import` Vue（不要在 `vi.hoisted` 里调 `reactive`）；**spy 放 `vi.hoisted`**，否则 `expect(filterStore().clear)` 这种写法在 `vue-tsc` 下会因为真实类型是 `() => void` 而报错。

现有 `mocks` 的 `vi.hoisted` 对象里补两个 spy（原有四个字段不动）：

```ts
  apply: vi.fn(),
  clear: vi.fn(),
```

然后加：

```ts
vi.mock("@/stores/recipeFilter", async () => {
  const { reactive } = await import("vue");
  const filter = reactive({
    keyword: "",
    categoryIds: [] as string[],
    tagIds: [] as string[],
    ingredientIds: [] as string[],
  });
  return {
    useRecipeFilterStore: () => ({ filter, apply: mocks.apply, clear: mocks.clear }),
  };
});
```

再加一个 import 与一个重置辅助（现有 `beforeEach` 里补一行 `resetFilter();`，别动 `vi.clearAllMocks()`）：

```ts
import { useRecipeFilterStore } from "@/stores/recipeFilter";

/** 每个用例从空筛选开始；filter 是 mock 工厂里的单例 reactive 对象，必须手动重置 */
function resetFilter(): void {
  const { filter } = useRecipeFilterStore();
  filter.keyword = "";
  filter.categoryIds = [];
  filter.tagIds = [];
  filter.ingredientIds = [];
}
```

新用例（`describe("RecipeList", ...)` 内追加）。**注意用 `await flushPromises()` 推动重绘**（该文件已 import 它），不要用 `wrapper.vm.$nextTick()`：

```ts
  it("搜索框按菜名子串过滤，且过滤后不动 store 里的原数组", async () => {
    const wrapper = mountList([item("r1", "红烧肉"), item("r2", "番茄炒蛋")]);

    await wrapper.get('[data-test="recipe-search"]').setValue("红烧");

    expect(names(wrapper)).toEqual(["红烧肉"]);
    expect(mocks.recipes.map((i) => i.recipe.name)).toEqual(["红烧肉", "番茄炒蛋"]);
  });

  it("没有筛选时不渲染信息条", () => {
    const wrapper = mountList([item("r1", "红烧肉")]);
    expect(wrapper.find('[data-test="filter-bar"]').exists()).toBe(false);
  });

  it("筛选活跃时信息条写明筛了什么，点它进筛选页", async () => {
    const wrapper = mountList([
      item("r1", "红烧肉", { category: "荤菜", tags: ["家常", "下饭"], ingredients: ["五花肉"] }),
      item("r2", "炒青菜", { category: "素菜" }),
    ]);
    useRecipeFilterStore().filter.categoryIds = ["cat-r1"];
    await flushPromises();

    expect(wrapper.get('[data-test="filter-summary"]').text()).toBe("📂 荤菜");
    expect(names(wrapper)).toEqual(["红烧肉"]);

    await wrapper.get('[data-test="filter-bar"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/recipe/filter");
  });

  it("点清除只清筛选，不进筛选页", async () => {
    const wrapper = mountList([item("r1", "红烧肉", { category: "荤菜" })]);
    useRecipeFilterStore().filter.categoryIds = ["cat-r1"];
    await flushPromises();

    await wrapper.get('[data-test="filter-clear"]').trigger("click");

    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("有菜谱但被筛掉时是「没有符合条件的菜谱」，不是「还没有菜谱」", async () => {
    const wrapper = mountList([item("r1", "红烧肉", { category: "荤菜" })]);
    useRecipeFilterStore().filter.tagIds = ["tag-不存在"];
    await flushPromises();

    expect(wrapper.text()).toContain("没有符合条件的菜谱");
    expect(wrapper.text()).not.toContain("还没有菜谱");
    // 筛选活跃但一条都没命中时，信息条必须还在，否则用户没有任何取消入口
    expect(wrapper.find('[data-test="filter-bar"]').exists()).toBe(true);
  });

  it("点漏斗跳 /recipe/filter", async () => {
    const wrapper = mountList([item("r1", "红烧肉")]);

    await wrapper.get('[data-test="recipe-filter"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/recipe/filter");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/views/__tests__/RecipeList.test.ts`
Expected: 新用例 FAIL（找不到 `recipe-search` / `recipe-filter` / `filter-bar`）；含 `ingredients` 的 fixture 用例报 `undefined`（Task 1 若已完成则不会）。

- [ ] **Step 3: 改 `src/views/RecipeList.vue`**

结构（class 是要照抄的决定，其它写法自定）：

```
<div class="flex h-full flex-col">
  <AppHeader title="菜谱">
    <template #action>
      <button data-test="recipe-filter" aria-label="筛选"  → /recipe/filter
              class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100">
        <Filter :size="20" class="text-text" />
      </button>
      <button data-test="recipe-add" aria-label="新建菜谱"  → /recipe/new   ← 原样保留，位置不动
              class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100">
        <Plus :size="20" class="text-text" />
      </button>
    </template>
  </AppHeader>

  <div class="shrink-0 px-4 pt-3">
    <input v-model="filterStore.filter.keyword" data-test="recipe-search" type="text"
           placeholder="搜索菜名" aria-label="搜索菜名"
           class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary" />
  </div>

  <div v-if="active" data-test="filter-bar"
       class="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-gray-100 bg-surface px-4 py-2"
       @click="router.push('/recipe/filter')">
    <span data-test="filter-summary" class="flex-1 whitespace-nowrap text-xs text-text-secondary">{{ summary }}</span>
    <button data-test="filter-clear" aria-label="清除筛选" class="shrink-0 text-xs text-primary"
            @click.stop="filterStore.clear()">清除</button>
  </div>

  <div class="flex-1 min-h-0 overflow-auto px-4 py-3">   ← 原滚动区
    <p v-if="store.recipes.length === 0" ...>还没有菜谱，点右上角加号记一道</p>
    <p v-else-if="visible.length === 0" class="py-12 text-center text-text-secondary">没有符合条件的菜谱</p>
    <ul v-else ...>  ← 现有卡片整段照抄，一个字都不改
  </div>
</div>
```

script 里加三个 computed 与 store：

```ts
const filterStore = useRecipeFilterStore();
const visible = computed(() => filterRecipes(store.recipes, filterStore.filter));
const summary = computed(() => filterSummary(filterStore.filter, store.recipes));
const active = computed(() => isFilterActive(filterStore.filter));
```

要点：
- 列表用 `visible`，空状态两个分支的顺序**必须先判 `store.recipes.length === 0`**。
- 漏斗在加号**左边**，加号保持最右（现有测试断言空状态文案说的「右上角」与加号位置一致）。
- 信息条整条 `@click` 进筛选页，「清除」必须 `.stop`，否则会顺带跳页。
- 滚动列表里的钩子（`recipe-card` / `recipe-cover` / `recipe-name` / `recipe-category` / `recipe-tag` / `recipe-cover-fallback` / `line-clamp-2`）全部保留。
- import：`Filter` 来自 `lucide-vue-next`（与已有 `Plus` 同一行）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: 全绿 —— 含 Task 1/2/3 的新用例与 `RecipeList.test.ts` 里原有的十条。

- [ ] **Step 5: 提交**

```bash
git add src/views/RecipeList.vue src/views/__tests__/RecipeList.test.ts
git commit -m "feat: 菜谱列表加名称搜索、筛选入口与筛选信息条"
```

---

### Task 4: 筛选页与路由

**Files:**
- Create: `src/views/FilterPage.vue`
- Create: `src/views/__tests__/FilterPage.test.ts`
- Modify: `src/router/index.ts`
- Modify: `src/router/__tests__/routes.test.ts`（加用例）

**Interfaces:**
- Consumes: Task 1 的 `RecipeListItem.ingredients`；Task 2 的 `useRecipeFilterStore` / `emptyFilter` / `cloneFilter`；`useRecipeStore().recipes` 与 `fetchAll()`；`useKeyboardInset()`（`Ref<number>`，不支持的环境返回 0）
- Produces: 路由 `/recipe/filter`（name `recipe-filter`，`meta.hideTab: true`）；页面钩子 `filter-category-chip` / `filter-tag-chip` / `filter-tag-search` / `filter-ingredient-search` / `filter-ingredient-row` / `filter-ingredient-name` / `filter-confirm` / `filter-reset`

- [ ] **Step 1: 写失败测试（路由）**

`src/router/__tests__/routes.test.ts` 追加：

```ts
  it("有 /recipe/filter，而且不会被 /recipe/:id 抢走", () => {
    const route = router.getRoutes().find((r) => r.path === "/recipe/filter");

    expect(route).toBeDefined();
    expect(route?.meta.hideTab).toBe(true);
    expect(router.resolve("/recipe/filter").name).toBe("recipe-filter");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/router/__tests__/routes.test.ts`
Expected: FAIL —— `route` 是 `undefined`。

- [ ] **Step 3: 加路由**

`src/router/index.ts`：import `FilterPage`，并把 `/recipe/filter` **插在 `/recipe/:id` 之前**（`/recipe/new` 那一行下面）：

```ts
{ path: "/recipe/filter", name: "recipe-filter", component: FilterPage, meta: { hideTab: true } },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/router/__tests__/routes.test.ts`
Expected: 全绿（此时 `/recipe/filter` 还会白屏，页面还没写——下一步补）。

- [ ] **Step 5: 写失败测试（页面）**

`src/views/__tests__/FilterPage.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { Label, LabelKind, Recipe, RecipeListItem } from "@/types";
import FilterPage from "@/views/FilterPage.vue";
import { useRecipeFilterStore } from "@/stores/recipeFilter";

const NOW = "2026-10-14T00:00:00.000Z";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  apply: vi.fn(),
  clear: vi.fn(),
  fetchAll: vi.fn(async () => {}),
  recipes: [] as RecipeListItem[],
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push, back: mocks.back }) }));
vi.mock("@/stores/recipe", () => ({
  useRecipeStore: () => ({ recipes: mocks.recipes, fetchAll: mocks.fetchAll }),
}));
vi.mock("@/stores/recipeFilter", async () => {
  const { reactive } = await import("vue");
  const filter = reactive({
    keyword: "",
    categoryIds: [] as string[],
    tagIds: [] as string[],
    ingredientIds: [] as string[],
  });
  return { useRecipeFilterStore: () => ({ filter, apply: mocks.apply, clear: mocks.clear }) };
});

function label(id: string, name: string, kind: LabelKind): Label {
  return { id, name, kind, created_at: NOW, updated_at: NOW, deleted_at: null };
}

function item(
  id: string,
  opts: { category?: string; tags?: string[]; ingredients?: string[] } = {},
): RecipeListItem {
  const category = opts.category ?? "家常菜";
  const recipe: Recipe = {
    id,
    name: `菜谱${id}`,
    cover_path: null,
    category_id: `cat-${category}`,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  };
  return {
    recipe,
    category: label(recipe.category_id, category, "category"),
    tags: (opts.tags ?? []).map((tag) => label(`tag-${tag}`, tag, "tag")),
    ingredients: (opts.ingredients ?? []).map((ingredient) => ({
      id: `ing-${ingredient}`,
      name: ingredient,
    })),
  };
}

const wrappers: VueWrapper[] = [];

function mountPage(items: RecipeListItem[]): VueWrapper {
  mocks.recipes.splice(0, mocks.recipes.length, ...items);
  const wrapper = mount(FilterPage);
  wrappers.push(wrapper);
  return wrapper;
}

function chipNames(wrapper: VueWrapper, hook: string): string[] {
  return wrapper.findAll(`[data-test="${hook}"]`).map((node) => node.text());
}

/** 食材行的文字里带勾号，所以断言名字要看行内那个单独的 span */
function ingredientNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-test="filter-ingredient-name"]').map((node) => node.text());
}

beforeEach(() => {
  vi.clearAllMocks();
  const { filter } = useRecipeFilterStore();
  filter.keyword = "";
  filter.categoryIds = [];
  filter.tagIds = [];
  filter.ingredientIds = [];
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

describe("FilterPage", () => {
  it("分类、标签、食材候选只列真的有菜谱在用的条目，各去重一次", () => {
    const wrapper = mountPage([
      item("r1", { category: "荤菜", tags: ["家常"], ingredients: ["五花肉", "土豆"] }),
      item("r2", { category: "荤菜", tags: ["家常", "下饭"], ingredients: ["五花肉"] }),
    ]);

    expect(chipNames(wrapper, "filter-category-chip")).toEqual(["荤菜"]);
    expect(chipNames(wrapper, "filter-tag-chip")).toEqual(["下饭", "家常"]);
    expect(ingredientNames(wrapper)).toEqual(["五花肉", "土豆"]);
  });

  it("食材按出现过的菜谱数降序，同数按名称升序", () => {
    const wrapper = mountPage([
      item("r1", { ingredients: ["土豆", "五花肉", "A 料"] }),
      item("r2", { ingredients: ["五花肉", "A 料"] }),
    ]);

    expect(ingredientNames(wrapper)).toEqual(["A 料", "五花肉", "土豆"]);
  });

  it("进入时草稿复制已生效的筛选，勾选显示为选中", async () => {
    useRecipeFilterStore().filter.categoryIds = ["cat-荤菜"];
    const wrapper = mountPage([item("r1", { category: "荤菜" })]);

    expect(wrapper.get('[data-test="filter-category-chip"]').classes()).toContain("bg-primary");
  });

  it("勾选分类后点确定：写回筛选状态并回列表页", async () => {
    const wrapper = mountPage([item("r1", { category: "荤菜" })]);

    await wrapper.get('[data-test="filter-category-chip"]').trigger("click");
    await wrapper.get('[data-test="filter-confirm"]').trigger("click");

    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.apply.mock.calls[0][0].categoryIds).toEqual(["cat-荤菜"]);
    expect(mocks.push).toHaveBeenCalledWith("/");
  });

  it("食材多选能同时勾上两个不同的食材", async () => {
    const wrapper = mountPage([item("r1", { ingredients: ["五花肉", "土豆"] })]);

    const rows = wrapper.findAll('[data-test="filter-ingredient-row"]');
    await rows[0].trigger("click");
    await rows[1].trigger("click");
    await wrapper.get('[data-test="filter-confirm"]').trigger("click");

    expect(mocks.apply.mock.calls[0][0].ingredientIds).toEqual(["ing-五花肉", "ing-土豆"]);
  });

  it("返回不改已生效的筛选（草稿丢弃）", async () => {
    const wrapper = mountPage([item("r1", { category: "荤菜" })]);

    await wrapper.get('[data-test="filter-category-chip"]').trigger("click");
    await wrapper.get('[data-test="back"]').trigger("click");

    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it("重置清空本页勾选，但不写回、不跳页", async () => {
    const wrapper = mountPage([item("r1", { category: "荤菜" })]);

    const chip = wrapper.get('[data-test="filter-category-chip"]');
    await chip.trigger("click");
    expect(chip.classes()).toContain("bg-primary");

    await wrapper.get('[data-test="filter-reset"]').trigger("click");

    expect(wrapper.get('[data-test="filter-category-chip"]').classes()).not.toContain("bg-primary");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("标签搜索：命中项留下，已选中的标签即使不命中搜索词也保留（否则取消不掉）", async () => {
    const wrapper = mountPage([item("r1", { tags: ["快手", "下饭"] })]);
    const tags = () => chipNames(wrapper, "filter-tag-chip");

    await wrapper.get('[data-test="filter-tag-chip"]').trigger("click"); // 选中「下饭」（名称排序在前）
    expect(tags()).toEqual(["下饭", "快手"]);

    await wrapper.get('[data-test="filter-tag-search"]').setValue("根本没有这个词");

    // 未选中的被搜索词筛掉，已选中的留下来
    expect(tags()).toEqual(["下饭"]);
  });

  it("食材搜索：只留命中的行", async () => {
    const wrapper = mountPage([item("r1", { ingredients: ["五花肉", "土豆"] })]);

    await wrapper.get('[data-test="filter-ingredient-search"]').setValue("土豆");

    expect(ingredientNames(wrapper)).toEqual(["土豆"]);
  });

  it("挂载时拉一次菜谱（直接打开筛选页也有候选）", async () => {
    mountPage([item("r1")]);
    await flushPromises();

    expect(mocks.fetchAll).toHaveBeenCalledTimes(1);
  });
});
```

注意：`afterEach` 需要从 `@vue/test-utils` 里 import（与 `flushPromises` / `mount` 同一行）。

- [ ] **Step 6: 跑测试确认失败**

Run: `npm run test -- src/views/__tests__/FilterPage.test.ts`
Expected: FAIL —— 找不到 `@/views/FilterPage.vue`。

- [ ] **Step 7: 实现 `src/views/FilterPage.vue`**

骨架与要点（class 照抄，写法自定）：

```
<div class="flex h-full flex-col">
  <AppHeader title="筛选" :show-back="true" @back="goBack" />

  <div class="flex-1 min-h-0 overflow-auto px-4 py-3">
    <!-- 分类：chips，无搜索框（分类少） -->
    <p class="mb-1 text-xs text-text-secondary">分类</p>
    <div class="flex flex-wrap gap-2">
      <button v-for="c in categories" :key="c.id" data-test="filter-category-chip"
              class="rounded-full px-3 py-1.5 text-xs transition-colors"
              :class="draft.categoryIds.includes(c.id) ? 'bg-primary text-white' : 'bg-gray-100 text-text-secondary'"
              @click="toggle(draft.categoryIds, c.id)">{{ c.name }}</button>
    </div>

    <!-- 标签：搜索框 + chips（已选置顶） -->
    <input v-model="tagSearch" data-test="filter-tag-search" ... />

    <!-- 食材：搜索框 + 复选行（照 RefSheet 的行样式，但没有编辑/删除） -->
    <input v-model="ingredientSearch" data-test="filter-ingredient-search" ... />
    <div v-for="ing in ingredients" :key="ing.id" data-test="filter-ingredient-row"
         class="flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm transition-colors hover:bg-gray-50"
         @click="toggle(draft.ingredientIds, ing.id)">
      <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs"
            :class="draft.ingredientIds.includes(ing.id) ? 'border-primary bg-primary text-white' : 'border-gray-300'">
        <span v-if="draft.ingredientIds.includes(ing.id)">✓</span>
      </span>
      <span data-test="filter-ingredient-name" class="min-w-0 flex-1 truncate text-text">{{ ing.name }}</span>
    </div>
  </div>

  <div class="shrink-0 px-4 py-3" :style="keyboardInset > 0 ? { paddingBottom: `${keyboardInset + 12}px` } : undefined">
    <button data-test="filter-confirm" ...bg-primary... @click="confirm">确定</button>
    <button data-test="filter-reset" ...border border-gray-200... @click="reset">重置</button>
  </div>
</div>
```

script 要点：

- `const draft = reactive(cloneFilter(filterStore.filter));`（**必须复制数组**，否则本页勾选会直接改到已生效的筛选）。
- 三个候选 computed，全部从 `store.recipes` 推导，只列真的有菜谱在用的条目：
  - 分类：`Map<id, Label>` 去重后 `[{ id, name }]`，按 `name` 字符串比较（`a.name < b.name ? -1 : 1`）排——**不用 `localeCompare`**。
  - 标签：同上；再按「本页 draft 已选的置顶 + 搜索词过滤未选的」重组（搜索词用 `trim()` 后的小写子串匹配）。
  - 食材：`Map<id, { id, name, count }>`，`count` 是该食材出现在多少道菜谱里；排序 `count` 降序 → 名称升序 → id 升序（三段都比较，保证顺序确定）。搜索词过滤同上。
- 分类/标签的 chip 里**只放名字，不要 ☑/☐ 前缀**（选中态靠底色表达），这样断言 chip 文本时不会把勾号带进去。
- `toggle(list: string[], id: string): void`：在列表里就地增删（不要重新赋值数组，缩短逻辑分支）。
- `confirm()`：`filterStore.apply(draft)` 然后 `router.push("/")`（用 `push` 不用 `back`：直接打开筛选页时 `back` 会出界）。
- `goBack()`：`router.back()`（与 `RecipeEdit.vue` 一致）。
- `reset()`：`Object.assign(draft, emptyFilter())`，留在本页。
- `onMounted`：`void recipeStore.fetchAll()`。
- 底部按钮栏的键盘内边距用 `useKeyboardInset()`，**不要再叠 `env(safe-area-inset-bottom)`**——隐藏 tab 栏时外壳已经补过了（`App.vue` 的 `[data-test="content"]`）。
- 三个候选都为空时各给一行灰字（如「还没有分类」），字号 `text-xs text-text-secondary`。
- 取消入口只有顶栏返回箭头，`action` 槽这页不用。

- [ ] **Step 8: 跑测试确认通过**

Run: `npm run test`
Expected: 全绿。

Run: `npm run build`
Expected: 无类型错误（`FilterPage.vue` 里的 `RecipeFilter` 类型从 `@/utils/recipeFilter` import，不要写 `any`）。

- [ ] **Step 9: 提交**

```bash
git add src/views/FilterPage.vue src/views/__tests__/FilterPage.test.ts src/router/index.ts src/router/__tests__/routes.test.ts
git commit -m "feat: 筛选页（分类/标签/食材多选）与 /recipe/filter 路由"
```

---

### Task 5: 收尾验证

**Files:**
- 不改代码（这一轮只跑验证；发现问题回到对应任务修）

**Interfaces:**
- Consumes: Task 1–4 的全部产物
- Produces: 一份给设备上的人看的验收清单

- [ ] **Step 1: 全量测试**

Run: `npm run test`
Expected: 全绿。**特别确认 `RecipeList.test.ts` 的十条原有断言一条没改**：

Run: `git diff 4326eeb -- src/views/__tests__/RecipeList.test.ts`
Expected: diff 里只有 `ingredients` fixture 字段、`vi.mock` 块、import、`resetFilter` 与新用例；**没有任何一行旧断言被删改**。

- [ ] **Step 2: 类型检查与构建**

Run: `npm run build`
Expected: 通过。

- [ ] **Step 3: 确认没碰不该碰的文件**

Run: `git log --oneline | head -8` 找到本轮开始前那个提交（`chore: 版本升到 0.3.0`，即 `4326eeb`），然后

Run: `git diff --stat 4326eeb`
Expected: 只有 `src/types/index.ts`、`src/stores/recipe.ts`、`src/stores/recipeFilter.ts`、`src/utils/recipeFilter.ts`、`src/views/RecipeList.vue`、`src/views/FilterPage.vue`、`src/router/index.ts`、四个测试文件、以及两份 docs。**不能出现 `RefSheet.vue` / `IngredientSheet.vue` / `ImagePicker.vue` / `ConfirmDialog.vue` / `AppHeader.vue`。**

- [ ] **Step 4: 交给设备上的人**

告诉用户跑：

```bash
npm run tauri -- android dev     # 装机
```

**下面是要在真机上人眼过的，自动化测试覆盖不到**（来自 spec §8）：

1. 没筛选时信息条完全不出现；任一维度选中后出现，文案与结果一致。
2. 搜索框和筛选条不随列表滚动；滚到底最后一行不被 tab 栏或手势条压住。
3. 筛选页：勾选、搜索、已选标签置顶、重置、返回丢弃、确定回列表，六条都走一遍。
4. **在筛选页两个搜索框里打字，软键盘弹起后「确定 / 重置」仍然点得到**；键盘收起后按钮栏回原位、不留空白。
5. 选两样食材，结果里每道菜都真的两样都有。
6. 顶栏漏斗 + 加号两个图标在窄屏上不与标题挤在一起。

- [ ] **Step 5: 真机问题回来后的提交**

真机上调出来的样式/间距问题单独提交（`fix: ...`），不要混进前四个任务的提交里。
