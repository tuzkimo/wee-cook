# 一起做饭 · 菜谱筛选与搜索 设计

2026-10-14 · 状态：待实施

对应上一轮：`docs/superpowers/specs/2026-10-13-ui-shell-redesign-design.md`（UI 外壳，已实施）。它的 §9「留给下一轮」第一条就是本轮：**筛选页 / 搜索（列表右上角补漏斗图标）**。

参考项目：`D:\projects\my\wee-count` 的 `src/views/FilterPage.vue` 与 `src/views/TransactionList.vue` 里的筛选状态栏。视觉与交互照抄那一套，**但下面标了「不照抄」的地方是有意偏离**。

---

## 1. 要解决什么

菜谱少的时候列表翻一下就找到了，多了以后**靠扫是扫不到的**。真正的问题是「我记得的线索不完整」：

- 记得用了什么食材（「有五花肉的那道」），不记得菜名；
- 记得是哪个分类（「那个汤」），不记得叫什么；
- 记得标签（「上次那个快手的」）。

所以要做的是**用记忆碎片快速收敛范围**，不是精确检索。

现在菜谱页右上角只有一个加号，没有任何过滤入口。`recipeStore.fetchAll` 已经把每道菜的分类、标签查出来放在内存里，筛选所需的数据**几乎全都在手上**，缺的只有食材关联。

**成功的样子**：脑子里只有「五花肉 + 家常菜」两条线索，从列表页点两下就能把那道菜挑出来，不需要按菜名去猜。

---

## 2. 目标 / 非目标 / 反目标

**目标**
- 菜谱列表页右上角加筛选入口（漏斗图标），点击进筛选页。
- 筛选页支持三维度多选：**分类、标签、食材**。
- 菜谱列表页顶部常驻名称搜索框，模糊（子串）匹配。
- 筛选生效后，列表页出现一条「筛选信息条」，写明筛了什么，可一键清除，可点击回筛选页接着改。
- 筛选结果与搜索词叠加生效。

**非目标（本轮明确不做）**
- 筛选条件持久化（不落库、不写 URL、不加 query 参数）。App 重启即清空。
- 筛选结果排序方式的变化：仍然按 `updated_at DESC, id ASC`，与现在一致。
- 「按食材反向推荐」（我有什么食材→做什么菜）、缺料计算。
- 保存筛选方案 / 常用筛选。
- 筛选页里的「新建分类/标签/食材」——那是 RefSheet 的职责，筛选页只做只读选择。
- 详情页、编辑页的任何改动。

**反目标（做出来了也算失败）**
- **改完之后有任何一个已有测试断言被放宽、删除或改弱。** 允许新增断言、新增用例、给 fixture 补字段。
- 筛选条常驻占一行。**没筛选时它必须完全不出现**——列表页的价值就是那串菜谱，手机上一行固定高度就是少看一道菜。
- 为一个三维度多选引入组件库或自造一套抽象层。
- 复用 `RefSheet` 来选分类/标签/食材。它每行带「编辑 / 删除」、底部带「新建」，这些出现在筛选场景是错的；给它加开关会动到现有四个调用点。
- 筛选页里出现「筛选之后还剩几条」这类实时统计（要多一次全量过滤的耦合，用户在列表页看结果就够了）。

---

## 3. 这些是你定的（不要改）

- **右上角加漏斗按钮，点击进入筛选页**（独立整页，不是弹层）。
- 四个筛选维度：**名称模糊检索、分类多选、标签多选、食材多选**。
- **食材多选是「同时包含」**：选了五花肉 + 土豆，只要两样都用了的菜。
- **筛选页点「确定」回到菜谱页**，结果已经缩小。
- **名称搜索框常驻在菜谱列表页顶部**，不放进筛选页（避免为了搜个名字多两步点击）。
- **筛选信息条按需出现**：有筛选才出现，没筛选整条不渲染。
- 参考 WeeCount 的筛选页与信息条形态。

## 4. 这些是我做的判断（可以推翻，但要知道）

1. **标签多选也用「同时包含」**。理由：与食材保持一致；选「快手 + 下饭」时，用户要的是两个都贴了的菜，不是命中任一的一大堆。
2. **分类多选只能「或者」**。`recipes.category_id` 是单值外键，一道菜只有一个分类，选「家常菜 + 汤」只能表示「属于其中任一类」。这不是选择，是数据结构决定的。
3. **跨维度一律「并且」**：名称、分类、标签、食材四个条件同时满足才入选。
4. **筛选状态只活在内存里**（Pinia store）。返回列表、进详情再回来都保留；杀掉 App 就清空。不写 URL 的理由：这是离线单页 App，没有分享链接、没有刷新保留这两个需求，而 URL 化会带来「URL 与 store 两份状态谁说了算」的一整类 bug（WeeCount 那边为这个坑写了好几段防御注释）。
5. **筛选条上不显示搜索词**。搜索框就在同一屏、内容肉眼可见，重复显示是噪音。但**「清除筛选」会连搜索框一起清空**——「清除」的语义是「回到干净状态」，留一个字让列表仍然少一截会让人以为清除坏了。
6. **清除筛选是全清**（关键词 + 三个多选），不做「只清多选」的第二种语义。
7. **筛选页底部两个按钮：确定（主）＋ 重置（次）**。重置只清空当前草稿、留在本页。多加这个按钮是因为分类/标签/食材可能选中十几个 chip，逐个点掉太难受；它与列表页的「清除筛选」分工明确：一个改草稿，一个清已生效的。
8. **筛选页的三个候选列表都从已加载的菜谱里推导**，只列出**真的有菜谱在用**的分类 / 标签 / 食材。不调 `useLabelStore`、不调 `useIngredientStore`。两个好处：筛不出空结果的死选项；以及绕开 `labelStore.fetchAll(kind)` 那个「后一次调用覆盖前一次」的共享 ref 坑（分类和标签要同时拿出来，得用 `asRefStore` 开两个实例才行，没必要）。
9. **食材候选用「搜索框 + 复选行」列表，分类和标签用 chips**。食材可能有几十上百条，chips 铺不开；分类标签短、数量适中，chips 一眼扫得快（与 WeeCount 一致）。
10. **标签区带搜索框，分类区不带**。分类通常不到十个，搜索框是纯装饰。
11. **搜索框固定在列表滚动区之外**（不随列表滚走）。
12. **`AppHeader` 不改**。它只有一个 `action` 插槽，漏斗和加号两个按钮由列表页自己在插槽里并排。上一轮已经定下「顶栏动作一律用图标」，两个图标按钮并排符合那条。
13. **无结果与无数据分开写**：库里一条菜谱都没有时是「还没有菜谱，点右上角加号记一道」（沿用现有文案）；有菜谱但被筛掉了是「没有符合条件的菜谱」。
14. **信息条按「筛选是否活跃」渲染，不按「摘要文案是否为空」**。两者分开是必须的：如果按文案渲染，一旦选中的 id 在候选里已经不存在（比如最后一道带该标签的菜被删了），摘要会变空 → 整条不渲染 → 用户看到的是「列表 0 条，却没有东西可点、取消不掉」。所以渲染条件是 `isFilterActive(filter)`，而摘要里**查不到名字的 id 兜底显示 id 本身**（WeeCount 的 `acc?.name ?? q.account` 同款），保证活跃筛选永远有一条看得见、点得动的条。看到一个 uuid 说明这个条件是历史残留，点「清除」即可。
15. **筛选页底部按钮栏用 `useKeyboardInset()` 顶起来**。Android 上软键盘弹出后 `h-dvh` 不收缩，底部「确定 / 重置」会被键盘盖住点不到——`RefSheet`、`IngredientSheet` 都为这件事专门处理过，这里照做：`:style="inset ? { paddingBottom: inset + 'px' } : undefined"`。**不要**再叠 `env(safe-area-inset-bottom)`：隐藏 tab 栏时外壳的 `[data-test="content"]` 已经补过了，叠上去就是双倍。

---

## 5. 数据结构

### 5.1 `RecipeListItem` 增加食材（`src/types/index.ts`）

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

放这里的理由：列表行已经承担了「把筛选要用的数据一次带全」的职责（分类、标签就是这么做的），食材加进去是同一个模式的延续。这样**筛选逻辑变成对 `RecipeListItem[]` 的纯函数**，不需要再碰数据库，`FilterPage` 也不需要第二个 store。

### 5.2 `recipeStore.fetchAll` 多查一条（`src/stores/recipe.ts`）

```sql
SELECT ri.recipe_id, ri.ingredient_id, i.name AS ingredient_name
FROM recipe_ingredients ri
JOIN ingredients i ON i.id = ri.ingredient_id
WHERE ri.deleted_at IS NULL
ORDER BY ri.recipe_id ASC, ri.sort_order ASC, ri.id ASC
```

- 用内 JOIN 且不加 `i.deleted_at IS NULL`：食材被引用时删不掉（`labelStore.remove` 同款前置检查），能被 JOIN 出来的必然没软删。加了反而会把关联静默漏掉。
- 同一道菜里同一个食材可能出现多行（`recipeIngredients` 允许重复，见 `stores/__tests__/recipe.test.ts` 的「同一道菜里重复添加同一个食材可以保存」）。**聚合时按 `ingredient_id` 去重**，否则「同时包含」的匹配和摘要都会重复。
- 按 `sort_order` 排，摘要里的食材顺序就是菜谱里的顺序（更符合「我记的是主料」的直觉）。

---

## 6. 逐块设计

### 6.1 筛选状态 `src/stores/recipeFilter.ts`（新增）

```ts
export interface RecipeFilter {
  keyword: string;
  categoryIds: string[];
  tagIds: string[];
  ingredientIds: string[];
}

export interface RecipeFilterStore {
  filter: RecipeFilter;              // reactive 对象，不是 Ref：组件里直接 v-model 到 filter.keyword
  apply(next: RecipeFilter): void;  // 整体替换（筛选页确定时用）
  clear(): void;                    // 四项全清（列表页「清除筛选」用）
}
```

`defineStore("recipeFilter", ...)`，`filter` 初值为 `reactive(emptyFilter())`（**不用 `ref`**：`tsconfig.json` 的 `include` 覆盖测试文件，测试里 mock 出的同形状对象与真实类型一致才能过 `vue-tsc`）。**不做持久化、不写 URL。**

### 6.2 纯函数 `src/utils/recipeFilter.ts`（新增）

```ts
export interface RecipeFilter { ... }   // 共用类型，只在这个文件 export；需要它的地方（store、两个页面）都从这里 import

/** 空筛选常量；apply 与 clear 都用它 */
export function emptyFilter(): RecipeFilter;

/** 三个多选任一非空 → true。关键词不算（它有自己的输入框） */
export function isFilterActive(filter: RecipeFilter): boolean;

/** 四个条件全部满足才留下；keyword 做子串匹配、不分大小写 */
export function filterRecipes(items: RecipeListItem[], filter: RecipeFilter): RecipeListItem[];

/** 信息条文案；filter 不活跃时返回 ""（调用方据此决定是否渲染整条） */
export function filterSummary(filter: RecipeFilter, items: RecipeListItem[]): string;
```

**匹配规则（逐条写死，实现照抄）**

| 维度 | 规则 |
|---|---|
| `keyword` | `keyword.trim()` 后为空则不过滤；否则 `recipe.name.toLowerCase().includes(trimmed.toLowerCase())`，**字面子串**，不做拼音、不做分词 |
| `categoryIds` | 空数组不过滤；否则 `categoryIds.includes(item.category.id)`（或） |
| `tagIds` | 空数组不过滤；否则 `tagIds.every(id => item.tags.some(t => t.id === id))`（并且） |
| `ingredientIds` | 空数组不过滤；否则 `ingredientIds.every(id => item.ingredients.some(i => i.id === id))`（并且） |

**摘要文案**（`·` 连接，空维度整段跳过）：

- 分类：`📂 家常菜、汤`；超过 2 个 → `📂 家常菜、汤 等4个分类`
- 标签：`🏷️ 快手`；超过 2 个 → `🏷️ 快手、下饭 等3个标签`
- 食材：`🥕 五花肉、土豆`；超过 2 个 → `🥕 五花肉、土豆 等3个食材`
- 名字从 `items` 里查：分类查 `item.category`，标签查 `item.tags`，食材查 `item.ingredients`；**查不到名字的行兜底显示 id 本身**（理由见 §4.14）。
- **关键词不出现在摘要里**（§4.5）。

例：`📂 家常菜 · 🏷️ 快手、下饭 等3个标签 · 🥕 五花肉、土豆`

### 6.3 菜谱列表页 `src/views/RecipeList.vue`（改）

```
<div class="flex h-full flex-col">
  <AppHeader title="菜谱">
    <template #action>
      <button data-test="recipe-filter" aria-label="筛选">  漏斗 → /recipe/filter
      <button data-test="recipe-add" aria-label="新建菜谱"> 加号 → /recipe/new（原样保留）
    </template>
  </AppHeader>

  <div class="shrink-0 px-4 pt-3">                             ← 搜索区，不随列表滚
    <input v-model="filterStore.filter.keyword" data-test="recipe-search" placeholder="搜索菜名" />
  </div>

  <div v-if="summary" data-test="filter-bar" ...>             ← 只在 isFilterActive 时渲染
    <span data-test="filter-summary">{{ summary }}</span>
    <button data-test="filter-clear">清除</button>
  </div>

  <div class="flex-1 min-h-0 overflow-auto px-4 py-3">          ← 原滚动区，内容换成 visible
    <p v-if="store.recipes.length === 0">还没有菜谱，点右上角加号记一道</p>
    <p v-else-if="visible.length === 0">没有符合条件的菜谱</p>
    <ul v-else> ... 现有卡片，一字不改 ... </ul>
  </div>
</div>
```

- `visible = computed(() => filterRecipes(store.recipes, filterStore.filter))`
- `summary = computed(() => filterSummary(filterStore.filter, store.recipes))`
- 漏斗：`lucide-vue-next` 的 `Filter`，`size="20"`，与加号同一个按钮样式（`flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100`），图标色 `text-text`（与加号一致）。
- 信息条：`shrink-0 flex items-center gap-1 overflow-x-auto border-b border-gray-100 bg-surface px-4 py-2`，文字 `whitespace-nowrap text-xs text-text-secondary`，整条 `@click` 进筛选页，「清除」按钮 `@click.stop="filterStore.clear()"`（不加 `.stop` 会同时触发进筛选页）。
- 搜索框样式：与 `RefSheet` 的搜索框同款（`w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary`）。
- 卡片、缩略图、标签胶囊、`data-test` 钩子全部维持原样。

### 6.4 筛选页 `src/views/FilterPage.vue`（新增）

```
<div class="flex h-full flex-col">
  <AppHeader title="筛选" :show-back="true" @back="goBack" />   ← goBack = router.back()，与编辑页一致
  <div class="flex-1 min-h-0 overflow-auto px-4 py-3">
    分类区  chips
    标签区  搜索框 + chips
    食材区  搜索框 + 复选行
  </div>
  <div class="shrink-0 px-4 py-3">  确定（主） / 重置（次） </div>
</div>
```

- **草稿**：进入时从 `filterStore.filter` 复制一份（数组要 `[...]` 复制，不能共享引用），本页所有勾选只改草稿。
- **确定**：`filterStore.apply(draft)` → `router.push("/")`。用 `push` 不用 `back`：从筛选页返回列表页是唯一去向，`push` 在「直接打开筛选页」时也一定成立。返回列表页会触发 `RecipeList` 的 `onMounted` → `fetchAll`，多查一次无害。
- **重置**：把草稿清成 `emptyFilter()`，留在本页。
- **返回（取消）**：`router.back()`，草稿丢弃，已生效的筛选不变。
- **候选列表**（都从 `recipeStore.recipes` 推导，只列真的有菜谱在用的条目）：
  - 分类：去重（`category.id`），按名称排。
  - 标签：去重（`tag.id`），按名称排；**已选中的标签无论是否命中搜索词都置顶保留**（照抄 WeeCount 的做法——被搜索词筛掉就再也取消不掉了）。
  - 食材：去重（`ingredient.id`），**按出现的菜谱数降序、同数按名称排**（常用的排前面，与 `labelStore` 的 `usage_count DESC` 同一套直觉）。
  - 三个候选都为空时给一行灰字（如「还没有分类」）。
- **排序用字符串比较（`a.name < b.name ? -1 : 1`），不用 `localeCompare`，也不写 `localeCompare("zh")`**：与 `labelStore.sortLabels` 的既有写法一致，且不依赖 Node 与 Android WebView 的 ICU 数据一致。单测里断言顺序时用 ASCII 名称（`"A"` / `"B"` / `"C"`），中文名只断言集合成员，避免测试跟着 ICU 走。
- 已选但候选里已经没有的 id（菜谱被删导致的残留）**不在本页补 chip**：列表页那条信息条已经能看清、能清除（§4.14），多一条渲染分支不值得。
- **chips**：`rounded-full px-3 py-1.5 text-xs`，选中 `bg-primary text-white`，未选 `bg-gray-100 text-text-secondary`（与设计变量「蓝色只出现在选中的选项上」一致）。
- **食材复选行**：照 `RefSheet` 的列表行形态——`flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm hover:bg-gray-50`，左边 20px 方框（选中 `border-primary bg-primary text-white`，勾号 `✓`），右边名字 `min-w-0 flex-1 truncate`。**没有编辑/删除按钮**。
- `data-test`：`filter-category-chip` / `filter-tag-chip` / `filter-tag-search` / `filter-ingredient-search` / `filter-ingredient-row` / `filter-confirm` / `filter-reset`。
- **取消入口只有顶栏那个返回箭头**（`AppHeader` 的 `show-back`，钩子是 `data-test="back"`），不另加关闭按钮——`AppHeader` 的 `action` 槽这页不用。测试点返回就点 `[data-test="back"]`。
- `onMounted` 里 `void recipeStore.fetchAll()`：直接进筛选页（开发时刷新浏览器）也能拿到候选。

### 6.5 路由 `src/router/index.ts`（改）

```ts
{ path: "/recipe/filter", name: "recipe-filter", component: FilterPage, meta: { hideTab: true } },
```

**必须放在 `/recipe/:id` 之前**（`/recipe/new` 旁边）。vue-router 4 对静态段的路由打分高于参数段，理论上不会误配，但不依赖打分规则更稳。

### 6.6 设计变量

**不新增颜色、不新增字号。** 用现有的 `bg-bg` / `bg-surface` / `text-text` / `text-text-secondary` / `text-primary` / `border-gray-100` / `border-gray-200` / `rounded-xl`（卡片）/ `rounded-full`（chip）/ `text-xs` `text-sm` `text-lg`。摘要里的 emoji 是文案不是图标库。

---

## 7. 现有测试给的约束

现有测试**一处断言都不许改弱**，只允许三种改动：给 fixture 补新字段、加 `vi.mock`、加新用例。

| 文件 | 需要的改动 | 为什么不算改弱 |
|---|---|---|
| `views/__tests__/RecipeList.test.ts` | `item()` fixture 补 `ingredients: []`；新增 `vi.mock("@/stores/recipeFilter", ...)` | `RecipeListItem` 多了必填字段，不补编译不过；页面多了个 store 依赖，不 mock 会抛错。现有断言一条没动 |
| `stores/__tests__/recipe.test.ts` | `fetchAll` 用例里加 `ingredients` 断言 | 纯新增 |
| `router/__tests__/routes.test.ts` | 加 `/recipe/filter` 存在且 `hideTab` | 纯新增 |

必须原样通过、一行不能碰的断言：

- `RecipeList.test.ts`：卡片顺序、分类与**全部**标签、封面 / 首字回退、`line-clamp-2`、点卡片跳转、点加号跳 `/recipe/new`、空状态文案「还没有菜谱，点右上角加号记一道」、`fetchAll` **恰好调用 1 次**、根元素不含 `safe-area-inset-top`、空状态说的「右上角」与加号实际位置一致（`add.element.closest("header")` 非空——所以加号**必须留在 `AppHeader` 的 action 插槽里**，不能挪到别处）。
- 详情页、编辑页的全部测试（本轮完全不碰那两个页面）。
- 共享组件（`RefSheet` / `IngredientSheet` / `ImagePicker` / `ConfirmDialog` / `AppHeader`）的测试：**本轮一个字节都不改这几个组件**。

---

## 8. 验证

```bash
npm run test        # 全绿
npm run build       # vue-tsc 类型检查 + 构建
npm run tauri -- android build --apk --debug   # 真机装一遍，肉眼过
```

真机上要盯的六件事：

1. 列表页没筛选时**信息条完全不出现**；三个维度任一选中后出现，文案与筛出来的结果一致（不是「摘要说筛了、列表没筛」）。
2. 搜索框和筛选条**不随列表滚动**；列表滚到底时最后一行不被底部 tab 栏或手势条压住。
3. 筛选页三个候选列表：勾选、搜索、已选标签置顶、重置、返回丢弃、确定回列表——六条都走一遍。
4. **在筛选页的两个搜索框里打字，软键盘弹起后「确定 / 重置」仍然点得到**（§4.15）；键盘收起后按钮栏回原位，不留一块空白。
5. 选两样食材，结果里每道菜都真的两样都有（这是最容易做错成「或」的一条）。
6. 顶栏两个图标按钮（漏斗 + 加号）在窄屏上不与标题挤在一起。

---

## 9. 留给下一轮

- 筛选条件持久化 / 保存筛选方案（现在每次杀 App 都要重选）。
- 「我有什么食材 → 能做什么菜」的反向推荐（本轮只做了「菜谱有什么食材」）。
- 缺料标记（哪道菜差几样）。
- 筛选结果排序切换（按创建时间 / 名称）。
- 深色模式（上一轮就欠着）。
