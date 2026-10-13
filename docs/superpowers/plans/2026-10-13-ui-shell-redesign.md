# UI 基础框架（外壳 + 五个页面）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给应用补上「顶栏 + 底部 tab + 内容」三栏外壳，并把三个已有页面与四个共享组件的视觉统一到姊妹项目 WeeCount 的设计语言。

**Architecture:** 新增一个共享顶栏组件 `AppHeader.vue` 和一组 Tailwind 主题变量；`App.vue` 从空的 `<RouterView />` 改成真正的外壳（状态栏占位 + 内容区 + tab 栏），tab 显隐由路由 `meta.hideTab` 决定；三个已有页面各自删掉手写的 `pt-[env(safe-area-inset-top)]` 和自绘顶栏，换成 `AppHeader`。

**Tech Stack:** Vue 3（`<script setup>` + TS）+ Vite 8 + Tailwind 4（`@tailwindcss/vite`）+ Tauri 2 + lucide-vue-next + vitest / @vue/test-utils / happy-dom。

**Spec:** `docs/superpowers/specs/2026-10-13-ui-shell-redesign-design.md`

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**。
- **测试优先**：每个新组件/新页面都要带单测。
- **已有测试只允许改一处**：`src/views/__tests__/RecipeList.test.ts` 里那两处空状态文案（用例名第 108 行 + 断言第 111 行），见 Task 4。**其余任何一段断言都不许放宽、删除或改弱。**
- **不改无关文件**。`docs/superpowers/plans/2026-10-13-recipe-crud.md` 是上一轮的历史记录，里面的旧文案**不要动**。
- commit 信息用中文。
- 颜色、字号、圆角一律用 §1 建立的主题变量与约定，**不新增 `dark:` 类，不新增 `slate-*` 色**。
- 只新增一个依赖：`lucide-vue-next`。不引入任何组件库。
- 顶栏上的动作**一律图标，不用文字**。

---

## Review Focus

按「最可能咬到真实用户」排序。前三条不是任何人会主动去测的输入，但一定会遇到：

1. **二级页面隐藏 tab 栏后，Android 手势条压住最后一行内容。** 详情页最后一条步骤、编辑页最后的「+ 添加步骤」，都会贴到屏幕最下沿，被手势条盖住一半。使用者期望内容停在手势条之上。→ Task 3 的测试。
2. **页面里残留的 `pt-[env(safe-area-inset-top)]` 与外壳的状态栏占位叠加，真机上出现双倍留白。** 这是本轮最容易漏的一处，因为单看任何一个文件都"没问题"。→ Task 4/5/6 各自的测试。
3. **超长菜名把详情页顶栏的图标挤出屏幕。** 菜名进顶栏后如果不加 `min-w-0 truncate`，一个 80 字的菜名会把编辑/删除按钮顶出可视区，那两页就没法操作了。→ Task 5 的测试。
4. **桌面上 `env(safe-area-inset-top)` 计算为 0，顶栏贴到窗口最上沿。** 需要 `max(..., 1.5rem)` 兜底，否则桌面调试时窗口标题栏和顶栏挤在一起。→ Task 3 的测试。
5. **空状态文案说的位置与实际位置不一致。** 加号搬到右上角后，文案还写着「点下面的加号」。→ Task 4 的测试。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `src/assets/main.css` | 主题变量（颜色 token），全项目唯一的颜色出处 |
| `src/components/AppHeader.vue`（新增） | 共享顶栏：返回按钮 + 标题（可插槽覆盖）+ 右侧动作插槽 |
| `src/App.vue`（重写） | 外壳：状态栏占位 + 内容区 + tab 栏 |
| `src/router/index.ts` | 路由表：新增 `/ai`、`/me`，三个菜谱路由加 `meta.hideTab` |
| `src/views/AiPage.vue`、`src/views/MePage.vue`（新增） | 占位页 |
| `src/views/RecipeList.vue` / `RecipeDetail.vue` / `RecipeEdit.vue` | 套用外壳与主题变量 |
| `src/components/ConfirmDialog.vue` / `ImagePicker.vue` / `RefSheet.vue` / `IngredientSheet.vue` | 只换颜色类，不动结构 |

任务顺序按依赖排：主题与顶栏 → 路由与占位页 → 外壳 → 三个页面 → 共享组件 → 收尾。

---

## Task 1: 主题变量与共享顶栏

**Files:**
- Modify: `src/assets/main.css`（全文，现在只有一行 `@import "tailwindcss";`）
- Create: `src/components/AppHeader.vue`
- Test: `src/components/__tests__/AppHeader.test.ts`
- Modify: `package.json`（加 `lucide-vue-next`）

**Interfaces:**
- Produces: `AppHeader` 组件 —— props `{ title: string; showBack?: boolean }`，事件 `back`，插槽 `title`（覆盖标题）与 `action`（右侧动作）。返回按钮元素带 `data-test="back"`。**后续 Task 4/5/6 都用这个组件，不要再自己写顶栏。**

- [ ] **Step 1: 安装图标库**

```bash
npm install lucide-vue-next
```

- [ ] **Step 2: 写 `main.css` 的主题变量**

全文替换为：

```css
@import "tailwindcss";

@theme {
  --color-primary: #3b82f6;
  --color-primary-dark: #2563eb;
  --color-bg: #f8fafc;
  --color-surface: #ffffff;
  --color-text: #0f172a;
  --color-text-secondary: #64748b;
  --color-danger: #ef4444;
}
```

**不要**加 `@custom-variant dark`——本轮明确不做深色模式（spec §2）。

变量名必须落在 Tailwind 4 的 `--color-*` 命名空间里：写成 `--color-surface` 才能用 `bg-surface`。**已实测这组写法能被 Tailwind 4.3.3 正确编译**出 `.bg-surface{background-color:var(--color-surface)}`、`.text-text-secondary{color:var(--color-text-secondary)}`、`.bg-primary\/10{background-color:color-mix(in oklab, var(--color-primary) 10%, transparent)}`、`.hover\:bg-primary-dark:hover` 这类规则。不要改写成 `--primary: #3b82f6` 这种简写——那样一个类都不会生成。

- [ ] **Step 3: 写失败测试**

`src/components/__tests__/AppHeader.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import AppHeader from "@/components/AppHeader.vue";

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

function header(props: { title: string; showBack?: boolean }): VueWrapper {
  const wrapper = mount(AppHeader, { props });
  wrappers.push(wrapper);
  return wrapper;
}

describe("AppHeader", () => {
  it("渲染标题", () => {
    const wrapper = header({ title: "菜谱" });
    expect(wrapper.get("h1").text()).toBe("菜谱");
  });

  it("不传 showBack 时没有返回按钮", () => {
    expect(header({ title: "菜谱" }).find('[data-test="back"]').exists()).toBe(false);
  });

  it("传 showBack 时有返回按钮，点了发 back 事件", async () => {
    const wrapper = header({ title: "红烧肉", showBack: true });
    await wrapper.get('[data-test="back"]').trigger("click");
    expect(wrapper.emitted("back")).toHaveLength(1);
  });

  it("title 插槽覆盖默认标题（详情页要靠它挂 data-test）", () => {
    const wrapper = mount(AppHeader, {
      props: { title: "会被覆盖" },
      slots: { title: '<h1 data-test="detail-name">红烧肉</h1>' },
    });
    wrappers.push(wrapper);
    expect(wrapper.get('[data-test="detail-name"]').text()).toBe("红烧肉");
    expect(wrapper.find("h1:not([data-test])").exists()).toBe(false);
  });

  it("action 插槽渲染在标题右侧", () => {
    const wrapper = mount(AppHeader, {
      props: { title: "菜谱" },
      slots: { action: '<button data-test="act">x</button>' },
    });
    wrappers.push(wrapper);
    expect(wrapper.get('[data-test="act"]').exists()).toBe(true);
  });
});
```

- [ ] **Step 4: 跑测试确认红**

Run: `npx vitest run src/components/__tests__/AppHeader.test.ts`
Expected: FAIL —— `Failed to resolve import "@/components/AppHeader.vue"`

- [ ] **Step 5: 实现 `src/components/AppHeader.vue`**

从 `D:\projects\my\wee-count\src\components\AppHeader.vue` 抄，只有两处偏离：

```vue
<script setup lang="ts">
import { ArrowLeft } from "lucide-vue-next";

defineProps<{
  title: string;
  showBack?: boolean;
}>();

defineEmits<{
  back: [];
}>();
</script>

<template>
  <header class="flex min-h-14 items-center bg-surface px-4 py-2">
    <button
      v-if="showBack"
      type="button"
      data-test="back"
      aria-label="返回"
      class="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-gray-100"
      @click="$emit('back')"
    >
      <ArrowLeft :size="20" class="text-text" />
    </button>
    <slot name="title">
      <h1 class="flex-1 text-lg font-semibold text-text">{{ title }}</h1>
    </slot>
    <slot name="action" />
  </header>
</template>
```

偏离 1：返回按钮上加 `data-test="back"`（WeeCount 原版没有，但 `RecipeEdit.test.ts` 靠它，没有它 Task 6 会红）。
偏离 2：**不要**把 `data-test` 透传到根元素上。
顶部**不画**底边线；需要断开的页面（详情页）由调用方传 `class="border-b border-gray-100"`——`AppHeader` 是单根元素，class 会自动透传到 `<header>`。

- [ ] **Step 6: 跑测试确认绿**

Run: `npx vitest run src/components/__tests__/AppHeader.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json src/assets/main.css src/components/AppHeader.vue src/components/__tests__/AppHeader.test.ts
git commit -m "feat: 加入主题变量与共享顶栏组件"
```

---

## Task 2: 路由表与两个占位页

**Files:**
- Create: `src/views/AiPage.vue`、`src/views/MePage.vue`
- Modify: `src/router/index.ts`
- Test: `src/views/__tests__/placeholderPages.test.ts`、`src/router/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AppHeader`。
- Produces: 路由 `/ai` → AiPage、`/me` → MePage；三条菜谱路由带 `meta: { hideTab: true }`。**Task 3 的 tab 栏依赖这三个路径存在。**

- [ ] **Step 1: 写失败测试**

`src/views/__tests__/placeholderPages.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import AiPage from "@/views/AiPage.vue";
import MePage from "@/views/MePage.vue";

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

function page(component: typeof AiPage): VueWrapper {
  const wrapper = mount(component);
  wrappers.push(wrapper);
  return wrapper;
}

describe("占位页", () => {
  it("AI 页有顶栏与说明文字", () => {
    const wrapper = page(AiPage);
    expect(wrapper.get("h1").text()).toBe("AI");
    expect(wrapper.text()).toContain("还在做");
  });

  it("我的页有顶栏与说明文字", () => {
    const wrapper = page(MePage);
    expect(wrapper.get("h1").text()).toBe("我的");
    expect(wrapper.text().length).toBeGreaterThan(2);
  });
});
```

`src/router/__tests__/routes.test.ts`（路由表在 happy-dom 下能直接导入，已实测）：

```ts
import { describe, expect, it } from "vitest";
import router from "@/router";

describe("路由表", () => {
  it("有 /ai 与 /me", () => {
    const paths = router.getRoutes().map((r) => r.path);
    expect(paths).toContain("/ai");
    expect(paths).toContain("/me");
  });

  it("三个菜谱页面都隐藏 tab 栏", () => {
    for (const path of ["/recipe/new", "/recipe/:id", "/recipe/:id/edit"]) {
      const route = router.getRoutes().find((r) => r.path === path);
      expect(route?.meta.hideTab, path).toBe(true);
    }
  });

  it("三个 tab 页不隐藏 tab 栏", () => {
    for (const path of ["/", "/ai", "/me"]) {
      const route = router.getRoutes().find((r) => r.path === path);
      expect(route?.meta.hideTab, path).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run src/views/__tests__/placeholderPages.test.ts src/router/__tests__/routes.test.ts`
Expected: FAIL —— 找不到 `@/views/AiPage.vue`；路由表里没有 `/ai`

- [ ] **Step 3: 写两个占位页**

`src/views/AiPage.vue` 与 `src/views/MePage.vue` 同形状（标题与文案不同）：

```vue
<script setup lang="ts">
import AppHeader from "@/components/AppHeader.vue";
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="AI" />
    <div class="flex flex-1 items-center justify-center px-8 text-center text-sm text-text-secondary">
      用截图收录菜谱的 AI 助手还在做，之后会放在这里。
    </div>
  </div>
</template>
```

`MePage.vue`：标题「我的」，文案自定一行（例：「设置、数据导出和多设备同步之后放在这里」）。

- [ ] **Step 4: 改路由表**

`src/router/index.ts` 加两条路由，并给三条菜谱路由加 `meta`：

```ts
{ path: "/", name: "recipe-list", component: RecipeList },
{ path: "/recipe/new", name: "recipe-new", component: RecipeEdit, meta: { hideTab: true } },
{ path: "/recipe/:id/edit", name: "recipe-edit", component: RecipeEdit, meta: { hideTab: true } },
{ path: "/recipe/:id", name: "recipe-detail", component: RecipeDetail, meta: { hideTab: true } },
{ path: "/ai", name: "ai", component: AiPage },
{ path: "/me", name: "me", component: MePage },
```

路由顺序不要动（`/recipe/new` 必须在 `/recipe/:id` 之前，否则 `new` 会被当成 id）。

- [ ] **Step 5: 跑测试确认绿**

Run: `npx vitest run src/views/__tests__/placeholderPages.test.ts src/router/__tests__/routes.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/views/AiPage.vue src/views/MePage.vue src/views/__tests__/placeholderPages.test.ts src/router/index.ts src/router/__tests__/routes.test.ts
git commit -m "feat: 新增 AI 与我的占位页，菜谱页面隐藏 tab 栏"
```

---

## Task 3: 外壳 `App.vue`

**Files:**
- Modify: `src/App.vue`（重写，现在只有 `<RouterView />`）
- Test: `src/__tests__/App.test.ts`（新建目录）

**Interfaces:**
- Consumes: Task 2 的三个 tab 路径 `/`、`/ai`、`/me`。
- Produces: 外壳 —— 内容容器带 `data-test="content"`，状态栏占位带 `data-test="statusbar"`。**Task 4/5/6 的页面根元素必须是 `<div class="flex h-full flex-col">`，靠外壳给的 `flex-1 min-h-0` 撑高。**

- [ ] **Step 1: 写失败测试**

`src/__tests__/App.test.ts`。三个要点：`vue-router` 整个替换掉（**注意用 `await import("vue" i)`** —— `vi.mock` 的工厂函数被提升到 import 之前，不能直接引用顶部 import 的 `defineComponent`）；`RouterLink` 没有全局注册，用 `global.components` 给一个渲染成 `<a>` 的桩：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import App from "@/App.vue";

const mocks = vi.hoisted(() => ({
  route: { path: "/", meta: {} as Record<string, unknown> },
}));

vi.mock("vue-router", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    useRoute: () => mocks.route,
    RouterView: defineComponent({
      name: "RouterView",
      render: () => h("div", { "data-test": "page" }),
    }),
  };
});

const RouterLink = defineComponent({
  name: "RouterLink",
  props: { to: { type: String, required: true } },
  setup: (props, { slots }) => () => h("a", { href: props.to }, slots.default?.()),
});

const wrappers: VueWrapper[] = [];

function mountApp(): VueWrapper {
  const wrapper = mount(App, { global: { components: { RouterLink } } });
  wrappers.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  mocks.route = { path: "/", meta: {} };
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

describe("App 外壳", () => {
  it("渲染状态栏占位、内容区与三个 tab", () => {
    const wrapper = mountApp();
    expect(wrapper.get('[data-test="statusbar"]').classes()).toContain("bg-surface");
    expect(wrapper.get('[data-test="page"]').exists()).toBe(true);

    const tabs = wrapper.findAll("nav a");
    expect(tabs.map((t) => t.text())).toEqual(["菜谱", "AI", "我的"]);
    expect(tabs.map((t) => t.attributes("href"))).toEqual(["/", "/ai", "/me"]);
  });

  it("状态栏占位高度有 1.5rem 最小值（桌面 env() 为 0 时顶栏不贴边）", () => {
    expect(mountApp().get('[data-test="statusbar"]').classes()).toContain(
      "h-[max(env(safe-area-inset-top),1.5rem)]",
    );
  });

  it("当前路径的 tab 是主色，其余是次要色", () => {
    mocks.route.path = "/ai";
    const tabs = mountApp().findAll("nav a");
    expect(tabs[1].classes()).toContain("text-primary");
    expect(tabs[0].classes()).toContain("text-text-secondary");
    expect(tabs[2].classes()).toContain("text-text-secondary");
  });

  it("meta.hideTab 时没有 tab 栏，且内容区补上底部安全区", () => {
    mocks.route.meta = { hideTab: true };
    const wrapper = mountApp();
    expect(wrapper.find("nav").exists()).toBe(false);
    expect(wrapper.get('[data-test="content"]').classes()).toContain(
      "pb-[env(safe-area-inset-bottom)]",
    );
  });

  it("tab 栏可见时内容区不加底部安全区（tab 栏自己已经补了）", () => {
    expect(mountApp().get('[data-test="content"]').classes()).not.toContain(
      "pb-[env(safe-area-inset-bottom)]",
    );
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run src/__tests__/App.test.ts`
Expected: FAIL —— 找不到 `[data-test="statusbar"]`

- [ ] **Step 3: 重写 `src/App.vue`**

```vue
<script setup lang="ts">
import { computed } from "vue";
import { RouterView, useRoute } from "vue-router";
import { BookOpen, Sparkles, User } from "lucide-vue-next";

const route = useRoute();

const TABS = [
  { path: "/", label: "菜谱", icon: BookOpen },
  { path: "/ai", label: "AI", icon: Sparkles },
  { path: "/me", label: "我的", icon: User },
];

const showTab = computed(() => !route.meta.hideTab);

function isActive(path: string): boolean {
  return route.path === path;
}
</script>

<template>
  <div class="flex h-dvh flex-col bg-bg">
    <div
      data-test="statusbar"
      class="h-[max(env(safe-area-inset-top),1.5rem)] shrink-0 bg-surface"
    />
    <div
      data-test="content"
      class="flex-1 min-h-0"
      :class="showTab ? '' : 'pb-[env(safe-area-inset-bottom)]'"
    >
      <RouterView />
    </div>
    <nav
      v-if="showTab"
      class="flex shrink-0 border-t border-gray-100 bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <RouterLink
        v-for="tab in TABS"
        :key="tab.path"
        :to="tab.path"
        class="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors"
        :class="isActive(tab.path) ? 'text-primary' : 'text-text-secondary'"
      >
        <component :is="tab.icon" :size="20" />
        <span>{{ tab.label }}</span>
      </RouterLink>
    </nav>
  </div>
</template>
```

要点（每条都对应 Review Focus 或 spec §6.1）：

- `RouterLink` **不 import**，靠 `app.use(router)` 的全局注册；测试里用 `global.components` 给桩。
- 状态栏占位必须是 `bg-surface`（不是 `bg-bg`）——这就是「状态栏和顶栏连成一整块白」。
- 高度写成 `h-[max(env(safe-area-inset-top),1.5rem)]` 任意值类，**不要用 `:style` 绑定**：happy-dom 会把 `style` 属性里的 `max(env(...))` 丢掉（实测属性直接变成 `undefined`），写成 `:style` 这步断言就无从写起。任意值里不能有空格。已实测 Tailwind 4.3.3 能生成 `height: max(env(safe-area-inset-top), 1.5rem)`。
- `min-h-0` 不能省：缺了它内容超长会把 tab 栏顶出屏幕。
- 内容区的 `pb-[env(safe-area-inset-bottom)]` **只在 `hideTab` 时加**——tab 栏自己已经补过一次，两边都加会双层留白。这是对 WeeCount 骨架的必要偏离（它每个页面自己补，本项目不这么做）。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run src/__tests__/App.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 5: 确认没碰坏既有测试**

Run: `npm run test`
Expected: 全绿（此时还有 131 个老用例 + Task 1/2 新增的）

- [ ] **Step 6: 提交**

```bash
git add src/App.vue src/__tests__/App.test.ts
git commit -m "feat: 补齐应用外壳（状态栏占位、内容区与底部 tab 栏）"
```

---

## Task 4: 菜谱列表页

**Files:**
- Modify: `src/views/RecipeList.vue`（全文）
- Modify: `src/views/__tests__/RecipeList.test.ts`（**只改空状态文案的两处，其他一个字不动**）

**Interfaces:**
- Consumes: Task 1 的 `AppHeader`；Task 3 的外壳（页面根必须是 `flex h-full flex-col`）。
- Produces: `data-test="recipe-add"` 现在落在顶栏 `action` 插槽里的图标按钮上。**Task 5/6 不用管这个钩子，只管别把它删了。**

- [ ] **Step 1: 改空状态文案的测试断言（spec §7.4 已确认的唯一一处允许改动）**

`src/views/__tests__/RecipeList.test.ts`：

- 第 108 行用例名 `it("空列表显示「还没有菜谱，点下面的加号记一道」和加号", ...)` → 文案改成 `还没有菜谱，点右上角加号记一道`
- 第 111 行 `expect(wrapper.text()).toContain("还没有菜谱，点下面的加号记一道")` → 同上

- [ ] **Step 2: 加两条新测试**

在同一个 describe 里追加：

```ts
it("根元素不再自带状态栏内边距（外壳已经统一留过）", () => {
  const wrapper = mountList([item("r1", "红烧肉")]);
  expect(wrapper.html()).not.toContain("safe-area-inset-top");
});

it("空状态说的「右上角」与加号的实际位置一致", () => {
  const wrapper = mountList([]);
  const add = wrapper.get('[data-test="recipe-add"]');
  expect(add.element.closest("header")).not.toBeNull();
});
```

- [ ] **Step 3: 跑测试确认红**

Run: `npx vitest run src/views/__tests__/RecipeList.test.ts`
Expected: FAIL —— 新文案找不到；`html()` 里仍有 `pt-[env(safe-area-inset-top)]`；`recipe-add` 不在 header 里

- [ ] **Step 4: 重写 `src/views/RecipeList.vue`**

结构（script 部分只多一个 `Plus` 图标 import，逻辑一行不动）：

```
<div class="flex h-full flex-col">
  <AppHeader title="菜谱">
    <template #action>
      <button data-test="recipe-add" aria-label="新建菜谱" type="button"
              class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
              @click="router.push('/recipe/new')">
        <Plus :size="20" class="text-text" />
      </button>
    </template>
  </AppHeader>
  <div class="flex-1 min-h-0 overflow-auto px-4 py-3">
    <p v-if="空" class="py-12 text-center text-text-secondary">
      还没有菜谱，点右上角加号记一道
    </p>
    <ul v-else class="flex flex-col gap-2.5"> ... </ul>
  </div>
</div>
```

每张卡片（`<li>` 里包 `<button data-test="recipe-card">`）：

```
class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors hover:bg-gray-50"
```

卡片内部：
- 封面 `data-test="recipe-cover"`：`h-11 w-11 shrink-0 rounded-lg object-cover`
- 无封面 `data-test="recipe-cover-fallback"`：同尺寸，`flex items-center justify-center rounded-lg bg-gray-100 text-lg font-semibold text-text-secondary`，内容仍是菜名首字
- 文字列：`min-w-0 flex-1`，菜名 `data-test="recipe-name" class="line-clamp-2 text-sm font-medium text-text"`，分类 `data-test="recipe-category" class="text-xs text-text-secondary"`
- 标签行：`mt-1 flex flex-wrap gap-1`，每个 `data-test="recipe-tag" class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-text-secondary"`

**必须删掉的**：根元素的 `min-h-screen bg-slate-50 pt-[env(safe-area-inset-top)] pb-24 dark:bg-slate-900`；右下角那个 `fixed` 的圆形加号按钮。

**绝对不许动的**：`line-clamp-2`（测试断言）、标签胶囊必须留在列表里（测试断言标签文本）、`data-test="recipe-card"` 必须是能点的元素（`<button>`，测试 `trigger("click")`）。

- [ ] **Step 5: 跑测试确认绿**

Run: `npx vitest run src/views/__tests__/RecipeList.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/views/RecipeList.vue src/views/__tests__/RecipeList.test.ts
git commit -m "feat: 菜谱列表套用外壳与新顶栏，加号移到右上角"
```

---

## Task 5: 菜谱详情页

**Files:**
- Modify: `src/views/RecipeDetail.vue`
- Modify: `src/views/__tests__/RecipeDetail.test.ts`（只加新用例，**不改已有断言**）

**Interfaces:**
- Consumes: Task 1 的 `AppHeader`；Task 3 的外壳。
- Produces: 无（叶子页面）。

- [ ] **Step 1: 加两条新测试**

在 `src/views/__tests__/RecipeDetail.test.ts` 的 describe 里追加：

```ts
it("根元素不再自带状态栏内边距（外壳已经统一留过）", async () => {
  const wrapper = await page();
  expect(wrapper.html()).not.toContain("safe-area-inset-top");
});

it("超长菜名不会把顶栏图标挤出去", async () => {
  mocks.getDetail.mockResolvedValue({ ...detail(), recipe: { ...detail().recipe, name: "红烧".repeat(40) } });
  const wrapper = await page();

  const name = wrapper.get('[data-test="detail-name"]');
  expect(name.classes()).toContain("truncate");
  expect(name.classes()).toContain("min-w-0");
});
```

（`page()` 是文件里已有的挂载辅助函数；按它的实际签名组织即可。）

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run src/views/__tests__/RecipeDetail.test.ts`
Expected: FAIL —— `html()` 里仍有 `safe-area-inset-top`；`detail-name` 没有 `truncate`

- [ ] **Step 3: 改 `src/views/RecipeDetail.vue`**

顶栏（**这是本任务的关键**：用 `title` **插槽**而不是 `title` prop，否则 `data-test="detail-name"` 没有落脚点）：

```vue
<AppHeader class="border-b border-gray-100" show-back @back="router.back()">
  <template #title>
    <h1
      data-test="detail-name"
      class="min-w-0 flex-1 truncate text-lg font-semibold text-text"
    >
      {{ detail.recipe.name }}
    </h1>
  </template>
  <template #action>
    <button data-test="edit" type="button" aria-label="编辑"
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="edit">
      <Pencil :size="18" class="text-text-secondary" />
    </button>
    <button data-test="delete" type="button" aria-label="删除"
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="showDeleteConfirm = true">
      <Trash2 :size="18" class="text-danger" />
    </button>
  </template>
</AppHeader>
```

其余改动：

- 根元素：`<main class="min-h-screen bg-slate-50 pt-[env(safe-area-inset-top)] pb-10 dark:bg-slate-900">` → `<div class="flex h-full flex-col">`；内容包一层 `<div class="flex-1 min-h-0 overflow-auto px-4 py-4">`。
- 分类胶囊：`rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary`；标签胶囊：`rounded-full bg-surface px-2.5 py-1 text-xs text-text-secondary`。
- 分组小标题（「食材」「步骤」）：`mb-2 text-xs font-medium text-text-secondary`。
- 食材行：**行内插值一个字都不改**（`{{ amountText(line) }} {{ line.ingredient_name }}`），只把 class 换成 `rounded-xl bg-surface px-3 py-3 text-sm font-medium text-text`。**不要**改成左右两端对齐——测试按整行文本断言。
- 步骤行：`flex gap-3 rounded-xl bg-surface p-3`；序号 `data-test="step-order"` 用 `flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-text-secondary`；步骤文字 `text-sm leading-relaxed text-text`；步骤图 `mt-2 w-full rounded-lg object-cover`。
- 空状态（食材/步骤为空）：`rounded-xl border border-dashed border-gray-300 py-6 text-center text-sm text-text-secondary`。
- 删除失败提示：`data-test="delete-error"`，`mx-4 mb-2 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger`。
- 未找到块（`data-test="not-found"`）保留；「返回列表」按钮 `rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white`。
- 删掉原来自绘的 `<header>` 整块（含那个 `←` 字符按钮）。**`data-test="back"` 现在由 `AppHeader` 提供，不要重复。**

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run src/views/__tests__/RecipeDetail.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/views/RecipeDetail.vue src/views/__tests__/RecipeDetail.test.ts
git commit -m "feat: 菜谱详情套用外壳，编辑删除改为图标按钮"
```

---

## Task 6: 菜谱编辑页

**Files:**
- Modify: `src/views/RecipeEdit.vue`
- Modify: `src/views/__tests__/RecipeEdit.test.ts`（只加新用例，**不改已有断言**）

**Interfaces:**
- Consumes: Task 1 的 `AppHeader`；Task 3 的外壳。
- Produces: 无（叶子页面）。

- [ ] **Step 1: 加一条新测试**

```ts
it("根元素不再自带状态栏内边距，底部也没有 fixed 的按钮条", async () => {
  const wrapper = await page();
  expect(wrapper.html()).not.toContain("safe-area-inset-top");
  expect(wrapper.find('[data-test="cancel"]').exists()).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run src/views/__tests__/RecipeEdit.test.ts`
Expected: FAIL —— `html()` 里仍有 `safe-area-inset-top`

- [ ] **Step 3: 改 `src/views/RecipeEdit.vue`**

顶栏（保存挪上来）：

```vue
<AppHeader
  :title="recipeId ? '编辑菜谱' : '新建菜谱'"
  show-back
  @back="goBack"
>
  <template #action>
    <button
      data-test="save"
      type="button"
      aria-label="保存"
      :disabled="!form.name.trim() || saving"
      class="flex h-8 w-8 items-center justify-center rounded-full disabled:opacity-30"
      @click="save"
    >
      <Check :size="20" class="text-primary" />
    </button>
  </template>
</AppHeader>
```

其余改动：

- 根元素：`<main class="min-h-screen ... pb-28 dark:bg-slate-900">` → `<div class="flex h-full flex-col">`。
- 表单容器：`<div class="flex flex-col gap-6 px-4">` → 外层滚动容器 `<div class="flex-1 min-h-0 overflow-auto px-4 py-4">`，里面保留原来的 `flex flex-col gap-6`。
- **删掉**原来的 `<header>` 整块（`←` 字符按钮 + `data-test="back"`）——`AppHeader` 提供了。**注意别留下两个 `data-test="back"`。**
- **删掉**底部 `fixed inset-x-0 bottom-0 ...` 的取消/保存条整块，`data-test="cancel"` 随之消失（没有任何测试用它，spec §4.5）。
- 输入框统一：`w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary`；label：`mb-1 block text-xs text-text-secondary`。
- 步骤卡 `rounded-xl bg-surface p-3`；序号 `h-6 w-6 ... bg-gray-100 text-xs font-semibold text-text-secondary`；上移/下移 `text-text-secondary disabled:opacity-30`；删除步骤按钮 `text-danger`。
- 「+ 添加食材」「+ 添加步骤」：`w-full rounded-lg border border-dashed border-gray-300 py-2.5 text-sm font-medium text-primary hover:bg-primary/10`。
- 空状态：`rounded-lg border border-dashed border-gray-300 py-6 text-center text-sm text-text-secondary`。
- `data-test="form-error"`：`text-sm text-danger`。

**绝对不许动的**：`save()` 里的 `saving` 早退与 `disabled` 表达式（测试断言空菜名时 disabled、保存中不可重复提交、失败后恢复可点）；`onBeforeRouteLeave` 守卫；所有 `data-test`（除 `cancel`）。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx vitest run src/views/__tests__/RecipeEdit.test.ts`
Expected: PASS —— 特别是那三条离页/守卫用例和两条保存用例

- [ ] **Step 5: 提交**

```bash
git add src/views/RecipeEdit.vue src/views/__tests__/RecipeEdit.test.ts
git commit -m "feat: 菜谱编辑页保存移到顶栏，去掉底部按钮条"
```

---

## Task 7: 四个共享组件换色

**Files:**
- Modify: `src/components/ConfirmDialog.vue`、`src/components/ImagePicker.vue`、`src/components/RefSheet.vue`、`src/components/IngredientSheet.vue`
- Test: 不改任何测试文件（这四个组件只换 class，结构、钩子、文案全不动）

**Interfaces:**
- Consumes: Task 1 的主题变量。
- Produces: 无。

- [ ] **Step 1: 按对照表机械替换**

只改 `class` 属性里的字符串，**不动任何结构、事件、`data-test`、文案**：

| 旧 | 新 |
|---|---|
| `text-slate-900` | `text-text` |
| `text-slate-700` / `text-slate-600` / `text-slate-500` / `text-slate-400` | `text-text-secondary` |
| `bg-slate-50` | `bg-bg` |
| `bg-slate-100` / `bg-slate-200` | `bg-gray-100` |
| `bg-white` | `bg-surface` |
| `bg-blue-600` | `bg-primary` |
| `hover:bg-blue-700` | `hover:bg-primary-dark` |
| `hover:bg-blue-50` | `hover:bg-primary/10` |
| `text-blue-600` | `text-primary` |
| `focus:border-blue-600` / `border-blue-600` | `focus:border-primary` / `border-primary` |
| `ring-blue-600` | `ring-primary` |
| `bg-red-600` / `hover:bg-red-700` | `bg-danger` / `hover:bg-danger/90` |
| `text-red-600` / `hover:text-red-600` | `text-danger` |
| `bg-red-50` / `hover:bg-red-50` | `bg-danger/10` |
| `dark:*`（本批共 51 处） | **整段删掉** |

保留不动：`border-gray-200`（输入框描边）、`border-gray-300`（虚线框）、`hover:bg-gray-100` / `hover:bg-gray-50`、`bg-black/40`（遮罩）、`text-white`。

- [ ] **Step 2: 确认没有漏网的旧色**

```bash
grep -rn "dark:\|slate-\|blue-600\|blue-700\|red-600\|red-50" src --include=*.vue
```

Expected: **无输出**。（此时三个页面应当已被 Task 4/5/6 清干净，四个组件被这一步清干净。）

- [ ] **Step 3: 跑这四个组件与页面的测试**

Run: `npx vitest run src/components/__tests__ src/views/__tests__`
Expected: PASS（换了颜色类之后，所有 `data-test` 与断言都不受影响；若红，说明结构被误改，回退结构改动）

- [ ] **Step 4: 提交**

```bash
git add src/components
git commit -m "refactor: 共享组件配色统一到主题变量，去掉深色类"
```

---

## Task 8: 收尾与真机验收

**Files:**
- Modify: `.gitignore`（加 `.superpowers/`）
- Modify: `docs/superpowers/specs/2026-10-13-ui-shell-redesign-design.md`（状态改「已实施」）

- [ ] **Step 1: 全量验证**

```bash
npm run test
npm run build
```

Expected: 测试全绿；`vue-tsc --noEmit` 无错、Vite 构建成功。**任何一条红都不许往下走。**

- [ ] **Step 2: 确认测试改动只有那一处**

```bash
git log --oneline
git diff HEAD~7 -- src/views/__tests__/RecipeList.test.ts
```

Expected: `RecipeList.test.ts` 的 diff 只有空状态文案两行。

- [ ] **Step 3: 忽略演示目录**

`.gitignore` 加一行 `.superpowers/`（这一轮头脑风暴的演示页面存在那儿，不该进仓库）。

- [ ] **Step 4: 真机构建**

```bash
npm run tauri -- android build --apk --debug
```

安装后**逐条肉眼过**（这几条没有自动化测试，只能人看）：

1. 状态栏区域和顶栏是不是一整块白，有没有出现双层留白。
2. 底部 tab 栏在 Android 手势条位置有没有被遮住。
3. 详情页 / 编辑页**没有** tab 栏；列表页、AI、我的**有**。
4. 详情页 / 编辑页滚到最后一行，内容不被手势条压住（Review Focus 1）。
5. 系统开深色的手机上，界面是全亮的（spec §2 已确认的代价）。

- [ ] **Step 5: 更新设计文档状态并提交**

把 spec 头部的「状态：待确认」改成「状态：已实施」。

```bash
git add .gitignore docs/superpowers/specs/2026-10-13-ui-shell-redesign-design.md
git commit -m "docs: UI 外壳设计标记为已实施，忽略演示目录"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §5（变量）→ Task 1；§6.1（外壳）→ Task 3；§6.2（顶栏）→ Task 1；§6.3（五页）→ Task 2/4/5/6；§6.4（路由）→ Task 2；§6.5（依赖）→ Task 1；§7（测试约束）→ Task 4 的 Step 1 与各任务的「绝对不许动」；§8（验证）→ Task 8。§2 的「四个共享组件」原本漏了，已补成 Task 7。
- **Review Focus 落点**：1 → Task 3；2 → Task 4/5/6 各自第一条新用例；3 → Task 5；4 → Task 3；5 → Task 4。
- **类型/命名一致性**：`AppHeader` 的 props/事件/插槽名在 Task 1 定义，Task 4/5/6 一律照用；外壳的 `data-test="content"` / `"statusbar"` 只在 Task 3 定义与使用。
