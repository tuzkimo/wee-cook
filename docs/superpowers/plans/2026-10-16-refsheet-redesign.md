# RefSheet 改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `RefSheet`（选食材 / 单位 / 分类 / 标签共用的底部面板）改成 tag sheet 的形态：默认就是搜索选择态，搜索无同名时行内直接创建，增删改收进右上角「管理」。

**Architecture:** 只改一个组件的形态与内部状态机，props / emits 签名保持不变，四个调用点（`RecipeEdit.vue` 的分类与标签、`IngredientSheet.vue` 的食材与单位）不重接。删掉「整页表单模式」，新建走搜索框行内创建，改名走管理模式里的内联输入框。删除的引用保护留在 store（`createRefStore.remove`），UI 只是提前把「有 N 道菜谱在用」说出来并禁用按钮。

**Tech Stack:** Vue 3 + TypeScript（strict，禁 `any`）+ Tailwind 4；vitest + happy-dom + `@vue/test-utils`。

**Spec:** `docs/superpowers/specs/2026-10-16-profile-avatar-refsheet-design.md` §8 / §9 —— 实现前通读。本计划只写「怎么做」。头像与资料那条线在另一份计划 `2026-10-16-profile-avatar.md` 里，两份没有共享文件，可任选先做。

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**。
- `RefSheet` 的 **props 与 emits 签名一个都不变**：`visible` / `title` / `store` / `mode` / `selectedIds` / `emptyHint`；`close` / `select`。四个调用点不需要改结构，只改 `empty-hint` 文案。
- **单选模式不自己关窗**（现有约定 R3）：`emit("select")` 之后由父组件翻 `visible`。这条不能改，`IngredientSheet` 靠它切第二步。
- 删除保持**软删 + 引用保护**：`usage_count > 0` 的条目禁用删除按钮；`createRefStore.remove` 的抛错行为一个字不改。
- 不重构无关代码（`useKeyboardInset`、`sheet-fade` / `sheet-slide-up` 过渡、`z-40` / `z-50` 的层叠关系照旧）。**软键盘 inset 与 z-index 不动**。
- 时间戳、图片、同步等约束本轮不涉及。
- commit 信息用中文，符合中文开发习惯。
- 每个任务结束都要能过 `npm run test` 与 `npm run build`。

## 人工确认过的测试例外

spec §9.1 已列出并获人工确认：`RefSheet.test.ts` 与 `IngredientSheet.test.ts` 里走「表单模式 / 逐行编辑删除」的断言与新契约**直接冲突**，按新契约改成等价断言。**这不是放宽或删弱断言**：`createRefStore` 的删除保护断言（`remove` 抛「有 N 道菜谱在用」）一个字不动，只是断言的对象从组件挪到了 store。逐条对照见 Task 1 / Task 2。

## Review Focus

spec 没有明说、但真实输入一定会撞上、撞上就没法解释的五件事。每条都在下文指定的任务里有对应断言：

1. **列表为空 + 搜索词非空**：只能出现「+ 创建「xxx」」，**不能同时显示 emptyHint**——「还没有食材」和「创建它」并列是自相矛盾的两句话。→ Task 1。
2. **搜索词与已有条目只差大小写**（`tomato` vs `Tomato`）：不能出现创建行（`store.add` 的 SQL 精确匹配会抛「同名食材已存在」，用户点了只会吃一个错）。→ Task 1。
3. **勾选 → 切进管理 → 切回选择**：已勾选的条目必须还在勾选态（管理模式只换渲染，不能顺手清 `selected`）。→ Task 1。
4. **`usage_count === 0` 但 `store.remove` 抛错**（读到用量与真正删除之间有窗口，别的菜谱刚引用了它）：要弹提示、条目还在列表里，不能静默失败。→ Task 1。
5. **单选模式创建失败**（`store.add` 抛，比如并发同名的另一台设备刚建过）：**不能 emit `select`**，错误要显示出来——否则父组件（`IngredientSheet`）拿着空 id 进第二步。→ Task 1。

---

## 跨任务的既定接口

```ts
// props / emits —— 照抄现有签名，一个新字段都不加
defineProps<{
  visible: boolean;
  title: string;
  store: RefStore;
  mode: "single" | "multiple";
  selectedIds: string[];
  emptyHint: string;
}>();
defineEmits<{ close: []; select: [string[]] }>();

// 组件内部状态（替换原来的 showForm / editingId / formName / formError）
// ⚠️ 内部的面板模式必须叫 panelMode，绝不能叫 mode：`props.mode` 已经是「single | multiple」，
//    两个同名变量会让单选/多选的判断读错对象。
const panelMode = ref<"select" | "manage">("select");
const editingId = ref<string | null>(null);         // 非 null = 正在内联改名
const formName = ref("");                           // 改名输入框的值
const formError = ref("");                          // 改名失败文案

// data-test 钩子（新增）
ref-manage         // 「管理」/「完成」按钮
ref-create         // 「+ 创建「xxx」」行
ref-usage          // 管理模式行尾的「N 道菜谱在用」
// 保留：ref-filter / ref-row / ref-name / ref-check / ref-edit / ref-delete / ref-confirm
// 删除：ref-new / ref-form-name / ref-form-save / ref-form-error
```

---

### Task 1: RefSheet 形态与状态机改造

**Files:**
- Modify: `src/components/RefSheet.vue`
- Modify: `src/components/__tests__/RefSheet.test.ts`

**Interfaces:**
- Consumes: `RefStore`（已有：`items` / `fetchAll` / `add(name)` / `update(id, name)` / `remove(id)`）、`ConfirmDialog`（已有）、`useKeyboardInset`（已有）。
- Produces: 见上「跨任务的既定接口」的钩子与内部状态；`RefSheet` 的两个面板模式 `select` / `manage`。

- [ ] **Step 1: 改写与新写测试（先红）**

在 `src/components/__tests__/RefSheet.test.ts` 里，**改写**下面这些用例（契约变化的直接冲突，逐条对应 spec §9.1）：

| 现有用例 | 改成 |
|---|---|
| 「点『新建』进表单模式，输入名称保存后回到列表且选中它」(L255) | 「搜索无同名时出现创建行，点它即建即选中」：`el('[data-test="ref-filter"]').setValue("新料")` → 出现 `ref-create` → 点它 → `expect(store.add).toHaveBeenCalledWith("新料")`、`expect(checkedNames()).toEqual(["新料"])`、`expect(has('[data-test="ref-create"]')).toBe(false)`（选完收起） |
| 「点『编辑』进表单，改名保存后回到列表且不额外发 select」(L275) | 走 `ref-manage` → `ref-edit` → 改 `ref-form-name` → 保存 → 名字变了且**留在管理模式**（`has('[data-test="ref-usage"]')` 仍为 true），`expect(wrapper.emitted("select"))` 为 undefined |
| 「保存时名称纯空格 → 显示错误、不调 store.add」(L295) | 「搜索词是纯空格时不出现创建行」：`ref-filter` 设为 `"   "` → `expect(has('[data-test="ref-create"]')).toBe(false)`、`expect(store.add).not.toHaveBeenCalled()` |
| 「store.add 抛「同名食材已存在」→ 错误显示在表单里」(L310) | 「已有同名条目时不出现创建行」：`ref-filter` 设为列表里已有的名字 → `expect(has('[data-test="ref-create"]')).toBe(false)` |
| 「点『删除』弹 ConfirmDialog，确认后才调 store.remove」(L325) | 前面加一步 `ref-manage`，其余断言不变 |
| 「store.remove 抛错 → 弹提示对话框，条目还在列表里」(L346) | 前面加 `ref-manage`，并**造一个 usage_count 为 0 的行**（现用例的行若带用量，垃圾桶已禁用，点不动） |
| 「single 模式点第二行时替换选中，只有一个勾」(L207) | 「single 模式点行即发 select，行内不画勾选框」：`expect(checkedNames()).toEqual([])`、`expect(wrapper.emitted("select")).toEqual([[["i2"]]])` |
| 「列表为空时显示 emptyHint」(L247) | 只改 `emptyHint` 文案字符串（见 Task 2），断言不变 |

**新写**这七条：

```ts
it("搜索词非空且不撞名时出现创建行，列表为空也不显示 emptyHint", ...)
  // store 的 items 为空 + ref-filter 设为 "新料"
  // expect(has('[data-test="ref-create"]')).toBe(true)
  // expect(bodyText()).not.toContain("还没有食材")

it("搜索词与已有条目只差大小写 → 不出现创建行", ...)
  // items = [row("i1", "Tomato", 0)] + ref-filter 设为 "tomato"
  // expect(has('[data-test="ref-create"]')).toBe(false)

it("搜索词命中前缀不影响创建", ...)
  // items = [row("i1", "五花肉", 0)] + ref-filter 设为 "五"
  // expect(has('[data-test="ref-create"]')).toBe(true)

it("多选模式创建后勾上并留在面板，确定时一起带出去", ...)
  // openSheet({ mode: "multiple" }) → 搜索 "新料" → 点 ref-create
  // expect(checkedNames()).toEqual(["新料"])、expect(has('[data-test="ref-confirm"]')).toBe(true)
  // 点 ref-confirm → expect(wrapper.emitted("select")).toEqual([[["new-1"]]])

it("单选模式创建失败 → 不发 select，错误显示出来", ...)
  // store.add 改成 mockRejectedValue(new Error("同名食材已存在"))
  // 点 ref-create → expect(wrapper.emitted("select")).toBeUndefined()
  // expect(el('[data-test="ref-form-error"]').text()).toContain("同名食材已存在")

it("切进管理模式再切回，已勾选的条目还在", ...)
  // openSheet({ mode: "multiple" }) → 点第一行 → 点 ref-manage → 点 ref-manage（完成）
  // expect(checkedNames()).toEqual(["i1"])

it("管理模式的行点不动，不改变勾选", ...)
  // 点 ref-manage → 点 ref-row → expect(checkedNames()).toEqual([])
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/RefSheet.test.ts`
Expected: FAIL — 找不到 `[data-test="ref-create"]` / `ref-manage`。

- [ ] **Step 3: 实现**

`src/components/RefSheet.vue`，按 spec §8：

**删掉**：`showForm`、底部「新建」按钮、每行的「编辑」「删除」文字按钮、整页表单模式的 `<template v-else>` 分支，以及 `ref-new` / `ref-form-save` 相关的处理函数（`openNew` / 表单模式的 `handleSubmit`）。

**状态**：`panelMode`（`"select" | "manage"`）、`editingId`、`formName`、`formError`；`watch(visible)` 打开时重置为 `select`、清空 `keyword` / `editingId` / `formError` / `deleteError`（现有逻辑保留）。

**头部**：标题用 `editingId ? "重命名" : props.title`；右上是「管理 / 完成」文字按钮（`data-test="ref-manage"`，`editingId` 非 null 时不渲染）+ ✕ 关闭。`toggleMode()`：切模式时 `keyword.value = ""`、`formError.value = ""`、`deleteError.value = ""`（**不清 `selected`**，Review Focus 第 3 条）。

**创建行**：

```ts
// 只在「搜索词非空」且「没有完全同名（忽略大小写）」时出现。前缀命中不影响创建。
const showCreate = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return kw.length > 0 && !toValue(props.store.items).some((item) => item.name.toLowerCase() === kw);
});
```

`createAndSelect()`：`name = keyword.value.trim()`；`await props.store.add(name)` → 选中它（multiple 追加到 `selected`；single 只 emit 并等父组件关窗）→ `keyword.value = ""`；**catch 里把错误显示到 `form-error` 且不 emit `select`**（Review Focus 第 5 条）。single 创建成功后立即 `emit("select", [created.id])`。

**列表**：`panelMode === "select"` 时整行可点（single 只渲染名字、**不渲染勾选框**；multiple 渲染勾选框 + 底部「确定」）；`panelMode === "manage"` 时行不可点选，行尾是 `<span data-test="ref-usage">{{ item.usage_count }} 道菜谱在用</span>` + 铅笔（`Pencil`，`data-test="ref-edit"`，`lucide-vue-next`）+ 垃圾桶（`Trash2`，`data-test="ref-delete"`，`usage_count > 0` 时 `disabled` 并加 `text-gray-300`）。

**空态**：`filtered.length === 0 && !showCreate` 时才显示 `emptyText`（Review Focus 第 1 条）。

**内联改名**：`editingId` 非 null 时，列表与创建行都让位给一个输入框（`data-test="ref-form-name"`）+ 取消 / 保存；保存调 `store.update(editingId, formName)`，失败写 `formError`（`data-test="ref-form-error"`），成功后 `editingId = null` 并**回到管理模式**。

**删除**：`askDelete(item)` → 现有 `ConfirmDialog`；`confirmDelete()` 现有逻辑与 `deleteError` 提示对话框**全部保留**（Review Focus 第 4 条）。

**不动**：`panelPadBottom` / `useKeyboardInset` / `sheet-fade` / `sheet-slide-up` / `z-40` / `z-50`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/RefSheet.test.ts && npm run test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/components/RefSheet.vue src/components/__tests__/RefSheet.test.ts
git commit -m "refactor(组件): RefSheet 改为搜索选择态 + 管理模式，新建走行内创建"
```

---

### Task 2: 调用点文案与下游测试

**Files:**
- Modify: `src/components/IngredientSheet.vue:172,183`（两处 `empty-hint`）
- Modify: `src/views/RecipeEdit.vue:510,520`（两处 `empty-hint`）
- Modify: `src/components/__tests__/IngredientSheet.test.ts`（一条用例 + `openSheet` 里的 `emptyHint`）

**Interfaces:**
- Consumes: Task 1 的 `ref-create` 钩子与单选「创建后立即 emit select」的行为。

- [ ] **Step 1: 改写下游测试（先红）**

`src/components/__tests__/IngredientSheet.test.ts` 的「在这一层新建食材后自动选中它并进入第二步」(L225) 走的是 `ref-new` → `ref-form-name` → `ref-form-save`，与新契约冲突（spec §9.1 已确认）。改成：

```ts
    await el('[data-test="ref-filter"]').setValue("酱油");
    await el('[data-test="ref-create"]').trigger("click");
    await flushPromises();
```

其余断言（进第二步、`bodyText()` 含「酱油」、`ingredients.items` 含「酱油」）**全部保留**。`openSheet` 里构造 `emptyHint` 的字符串改成与新的调用点文案一致（否则断言「列表为空时显示 emptyHint」会与真实文案漂移）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/IngredientSheet.test.ts`
Expected: FAIL — 找不到 `[data-test="ref-create"]`。

- [ ] **Step 3: 改文案**

四处 `empty-hint` 换成不带「点下面新建一个」的版本（面板底部已经没有新建按钮了）：

| 文件 · 位置 | 新文案 |
|---|---|
| `IngredientSheet.vue` 食材 sheet | `还没有食材，输入名称即可新建` |
| `IngredientSheet.vue` 单位 sheet | `还没有单位，输入名称即可新建` |
| `RecipeEdit.vue` 分类 sheet | `还没有分类，输入名称即可新建` |
| `RecipeEdit.vue` 标签 sheet | `还没有标签，输入名称即可新建` |

（四条是同一个模式，改完 grep 一遍 `点下面新建一个` 应为 0 命中。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test && npm run build`
Expected: 全绿（`RecipeEdit.test.ts` 不受影响：它没有断言 `empty-hint` 文案）。

- [ ] **Step 5: Commit**

```bash
git add src/components/IngredientSheet.vue src/views/RecipeEdit.vue src/components/__tests__/IngredientSheet.test.ts
git commit -m "chore(文案): sheet 空态不再指向已删除的新建按钮"
```

---

## 收尾验证（全部任务完成后）

```bash
npm run test
npm run build
```

真机（Android）走 spec §11 的 8–12 条：加食材 → 搜不存在的名字 → 出现创建行 → 点它直接进第二步；右上角「管理」→ 有菜谱在用的垃圾桶是灰的贴不动、没用的能删（弹确认）；管理模式点铅笔改名 → 保存后仍在管理模式；多选标签 → 建两个 → 都勾着 → 确定带出两个；**在各个 sheet 的搜索框打字，软键盘弹起时「确定」不被遮挡**（`useKeyboardInset` 不能被这次改造破坏）。
