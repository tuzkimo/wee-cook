# 一起做饭 · UI 基础框架（外壳 + 五个页面）设计

2026-10-13 · 状态：待确认

对应上一轮：`docs/superpowers/specs/2026-10-13-recipe-crud-design.md`（菜谱增删改查，已完成）。

---

## 1. 要解决什么

菜谱 CRUD 做完了，但**界面还没有一个"App"的样子**：

- `App.vue` 里只有一行 `<RouterView />`。没有任何全局外壳，每个页面各自写 `min-h-screen` + `pt-[env(safe-area-inset-top)]`，各写各的顶栏。
- **没有底部 tab**。进了详情页或编辑页，唯一的回头路是左上角那个 `←` 字符。
- **状态栏和顶栏不同色**。`pt-[env(safe-area-inset-top)]` 让状态栏区域露出页面底色 `#f8fafc`，下面才是白色内容，中间一条明显的断层。
- **顶栏按钮是文字**（"编辑""删除"），不是图标。
- **颜色写死在页面里**：`bg-slate-50`、`blue-600`、`gray-200` 散落在三个页面和四个共享组件里（ConfirmDialog / ImagePicker / RefSheet / IngredientSheet）。
- **深浅两套颜色只做了一半**：三份页面里写了一大堆 `dark:` 类，但没有任何开关。注意 Tailwind 4 里 `dark:` 默认是 `prefers-color-scheme` 媒体查询（`main.css` 里没有 `@custom-variant dark` 覆盖它），**所以这些类在系统开了深色的手机上是真生效的**——不是一个开关坏了的死代码，而是「跟着系统走」。

这次要做的：补齐外壳，把视觉语言统一到姊妹项目 WeeCount 已经跑在真机上的那一套。

**成功的样子**：随便进哪一层，都能一键回首页；状态栏和顶栏是一整块白；同一个东西（卡片、输入框、图标按钮）在三个页面里长得完全一样。

**为什么是现在**：后面还要加筛选、跟做模式、AI 收录、我的（设置）、多设备同步。现在不把外壳和设计变量定下来，每加一个页面就多抄一遍颜色，越往后越难统一。

---

## 2. 目标 / 非目标 / 反目标

**目标**
- 顶部导航栏 + 底部 tab 栏 + 中间内容的三栏结构。
- 视觉语言与 WeeCount 一致：颜色、字号、圆角、图标按钮的用法。
- 新页面「AI」「我的」的占位页。
- 现有三个页面（列表 / 详情 / 编辑）套进这套语言。
- 四个共享组件（ConfirmDialog / ImagePicker / RefSheet / IngredientSheet）一起换成主题变量——不换的话，`bg-blue-600`（Tailwind 4 里是 `oklch(54.6% 0.245 262.881)`，约 `#155dfc`）会和 `--color-primary`（`#3b82f6`）并排出现，同一个对话框里两种蓝。
- **除深色模式外，行为零变化**：任何操作结果、跳转、提示都与现在完全相同。

**非目标（本轮明确不做）**
- **深色模式**。现有的 `dark:` 类一并删掉，等真要做时用一套主题变量统一切换，而不是靠每个页面手写两套类名。
  **代价已经你确认过**：删掉之后，系统开了深色的手机上，App 会从深色变成通亮。这是本轮唯一的可见行为变化。
- 筛选页 / 搜索。菜谱列表右上角这轮**只有加号**，没有漏斗。
- 详情页显示封面图（库里已有 `cover_path`，详情页从来没画过它——这属于功能，不属于样式）。
- 跟做模式（计时器、防熄屏、逐步大字）。详情页代码注释里已经写明"别在这里加"。
- 「AI」「我的」两个页面的实际内容，只做占位。

**反目标（做出来了也算失败）**
- **改完之后有任何一个测试需要放宽、删除或改弱断言。**
- 为了统一样式引入一套组件库或抽象层——五个页面、二十来种元素，抄类名比建抽象便宜。
- 手机上首屏因为多出来一个顶栏和一个 tab 栏而明显变挤。
- 状态栏区域在 Android 上出现第二次留白（原生已经留过，WebView 里再留一次就是双倍）。

---

## 3. 这些是你定的（不要改）

- 底部 tab 三個：**菜谱 / AI / 我的**；AI 和我的这轮是占位页。
- **顶栏上的动作一律用图标，不用文字**（筛选、加号、编辑、删除、返回）。
- **顶栏标题左对齐，紧跟在返回按钮后面**，18px 粗体，不居中。
- **少用蓝色主色**：蓝色只出现在主按钮底色、选中的选项、输入框 focus 边框、链接和 tab 选中态上；图标、标题、正文一律黑白灰。
- **状态栏区域与顶栏同色，连成一整块**（WeeCount 就是这个效果）。
- **新建/编辑菜谱的保存按钮放顶栏右上角**（蓝色对勾），底部那条"取消 / 保存"整条去掉。
- **卡片不要描边**，靠底色反差分层。

## 4. 这些是我做的判断（可以推翻，但要知道）

1. **不新增筛选页**。你问的"列表要不要留筛选入口"——留入口就得有页面，筛选属于新功能。这轮右上角只有加号，筛选留到下一轮和搜索一起做。
2. **删掉三份页面里的 `dark:` 类**。理由见非目标。删的是死代码，不影响任何行为。
3. **详情页食材行不做"名称左 / 用量右"的两端对齐**，保持"500 克 五花肉"这样一整段文字。原因是现有测试断言的是行文本，两端对齐会把文本顺序打乱（见 §7.1）。
4. **列表页继续显示标签**。我原本想把标签收到详情页，但现有测试要求列表显示全部分类与标签（见 §7.1）。
5. 编辑页底部去掉按钮条之后，`data-test="cancel"` 这个钩子**直接丢掉**。理由：它没有任何测试在用（三份测试里搜不到 `cancel`），而保持它的唯一可行做法是挂在顶栏返回按钮上——那个按钮必须留给 `data-test="back"`（`RecipeEdit.test.ts` 用它触发返回），一个元素挂不了一个属性。返回即取消，行为不变。
6. 二级页面（详情 / 编辑）隐藏 tab 栏，用路由 `meta.hideTab` 控制，跟 WeeCount 同一套。

---

## 5. 设计变量

`src/assets/main.css` 补齐（现在只有一行 `@import "tailwindcss"`）：

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

WeeCount 的同名文件里还有 `--color-expense` / `--color-income`，都是记账专用的，本项目不需要；`--color-danger` 是本项目加的（删除按钮的红）。

**用法约定**（这是本轮最容易被违反的一条，写代码时对着看）：

| 用途 | 类 |
|---|---|
| 页面底色 | `bg-bg` |
| 卡片 / 顶栏 / tab 栏底色 | `bg-surface` |
| 主文案、标题 | `text-text` |
| 副文案、图标 | `text-text-secondary` |
| 危险（删除） | `text-danger` |
| 需要断开的极浅分隔线 | `border-gray-100` |
| 输入框描边 | `border-gray-200` |
| 卡片圆角 | `rounded-xl`（12px） |
| 页面内边距 | `px-4` |

**字号**：页面标题 `text-lg font-semibold`（18px）；正文 / 列表主文案 `text-sm`（14px）；副文案、分组小标题 `text-xs`（12px）。**不要用 15/16/17px**，WeeCount 里没有这些字号。

**分层只靠两件事**：底色反差（`bg` vs `surface`）和留白。`shadow-sm` 在 WeeCount 全项目只出现 12 次，本轮基本不用。

---

## 6. 逐块设计

### 6.1 外壳 `src/App.vue`（重写，现在几乎是空的）

```
<div class="flex h-dvh flex-col bg-bg">
  <div class="shrink-0 bg-surface h-[max(env(safe-area-inset-top),1.5rem)]" />   ← 状态栏占位，白色
  <div class="flex-1 min-h-0"><RouterView /></div>
  <nav v-if="showTab" class="flex shrink-0 border-t border-gray-100 bg-surface pb-[env(safe-area-inset-bottom)]">
    ... 三个 tab
  </nav>
</div>
```

三个要点，每条都对应一个已经踩过的坑：

- **状态栏占位是 `bg-surface` 而不是页面底色**，这就是"连成一整块白"的实现方式。它由 `App.vue` 统一画，**各页面不许再写 `pt-[env(safe-area-inset-top)]`**（现在三页都写了，要删）。
- **高度写成 Tailwind 任意值类 `h-[max(env(safe-area-inset-top),1.5rem)]`，不用 `:style` 绑定。** 那个 `1.5rem` 最小值不能省：桌面上 `env()` 是 0，没有最小值时顶栏会贴着窗口上沿。另一个理由是**可测**：happy-dom 会把 `style` 属性里的 `max(env(...))` 直接丢掉（实测 `style` 属性变成 `undefined`），写成 `:style` 就没办法写断言；写成类名则可以断言 `classes()`。已实测 Tailwind 4.3.3 能正确生成 `height: max(env(safe-area-inset-top), 1.5rem)`。
- **`flex-1 min-h-0` 不能省**：`min-h-0` 缺了的话，内容超长时 `flex-1` 会被内容撑开，把 tab 栏顶出屏幕——WeeCount 的 `MePage.vue` 里为此专门写了注释。
- **tab 栏隐藏时要自己补底部安全区**：WeeCount 的 `pb-[env(safe-area-inset-bottom)]` 只挂在 `<nav>` 上，二级页面 `hideTab` 之后 nav 不渲染，滚动内容会一直顶到屏幕最下沿，被 Android 手势条压住。所以内容容器要写成 `:class="{ 'pb-[env(safe-area-inset-bottom)]': !showTab }"`。这是对外壳骨架的**必要偏离**，WeeCount 那边没有这个问题是因为它每个页面自己补了。

tab 项：`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors`，选中 `text-primary`、未选中 `text-text-secondary`；图标来自 `lucide-vue-next`，`size="20"`（菜谱 `BookOpen`、AI `Sparkles`、我的 `User`）。

激活判定照 WeeCount：首页（`/`）精确匹配；`/ai`、`/me` 精确匹配。

### 6.2 顶栏 `src/components/AppHeader.vue`（新增）

从 `D:\projects\my\wee-count\src\components\AppHeader.vue` 抄过来：`min-h-14`、白底、无底边线、`px-4 py-2`；返回按钮是 32px 圆按钮 + `hover:bg-gray-100`，图标 `ArrowLeft size=20`；标题 `flex-1 text-lg font-semibold text-text`；`title` + `action` 两个具名插槽；`title` / `showBack` 两个 prop、`back` 一个事件。

**唯一的两处改动**（其余照抄）：
1. 返回按钮上加 `data-test="back"`。WeeCount 那个按钮没有这个属性，而 `RecipeEdit.test.ts` 有两处 `wrapper.get('[data-test="back"]').trigger("click")`——没有它，编辑页的返回与离页确认测试全红。
2. 不要 `data-test` 透传。属性只写在具体元素上，透传到根 `<header>` 会让测试点到 header 而不是按钮。

**为什么顶栏下面不画线**：WeeCount 首页实机截图里，顶栏和内容区之间没有线，白顶栏直接接到浅灰内容区。只有需要明确断开的页面（详情页）才加一条 `border-b border-gray-100`。

### 6.3 三个页面

统一形状（WeeCount 每页都是这个骨架）：

```
<div class="flex h-full flex-col">
  <AppHeader ... />
  <div class="flex-1 min-h-0 overflow-auto px-4 py-3"> ... </div>
</div>
```

**菜谱列表 `views/RecipeList.vue`**
- 顶栏：标题「菜谱」，右侧 action 一个加号图标按钮 → `/recipe/new`（`data-test="recipe-add"` 跟着挪到这儿）。
- 内容：`flex flex-col gap-2.5`，每行一张 `rounded-xl bg-surface px-3 py-3`，行内 44px 缩略图 + 菜名（`text-sm font-medium text-text`）+ 分类（`text-xs text-text-secondary`）+ 标签胶囊。
- 去掉现在悬浮在右下角的圆形加号按钮。
- 空状态：居中灰字，文案按 §7.4 改成「还没有菜谱，点右上角加号记一道」。

**菜谱详情 `views/RecipeDetail.vue`**
- 顶栏：`show-back`，**用 `title` 具名插槽**放 `<h1 data-test="detail-name">{{ detail.recipe.name }}</h1>`（套 `min-w-0 truncate text-lg font-semibold text-text`），action 槽里铅笔（→ 编辑）和红垃圾桶（→ 删除确认）。
  **这里不能用 `title` prop**：`RecipeDetail.test.ts` 断言 `wrapper.get('[data-test="detail-name"]').text()` **精确等于**「红烧肉」。名字只出现在顶栏，正文里不再重复；靠插槽把钩子和标题合成一个元素，页面上不会出现两个菜名。
- 内容：分类胶囊（`rounded-full bg-primary/10 text-xs text-primary`）+ 标签胶囊（白底 `text-text-secondary`）；「食材」分组标题 + 白卡行；「步骤」分组标题 + 白卡行（序号圆用灰底深灰字，不用蓝）。
- 删除失败的红色提示条保留，底色改成 `bg-red-50 text-danger`。

**菜谱编辑 `views/RecipeEdit.vue`**
- 顶栏：`:title="recipeId ? '编辑菜谱' : '新建菜谱'"`，`show-back`，action 槽里蓝色对勾（`data-test="save"` 跟着挪到这儿）。
- **底部那条 `fixed bottom-0` 的取消/保存栏整条删掉**（它现在是 `fixed`，在外壳里会盖住 tab 栏区域并脱离文档流）。
- 表单：label `mb-1 block text-xs text-text-secondary` + 输入框 `w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary`。形状跟现在基本一样，只是颜色换成变量、圆角对齐。
- 步骤卡、食材行、`+ 添加食材 / + 添加步骤` 的虚线按钮：换色，不改结构。
- **编辑页是二级页面，不显示 tab 栏。**

**AI `views/AiPage.vue`、我的 `views/MePage.vue`（新增，占位）**
- 顶栏 + 中间居中一行灰字（例：「AI 助手还在做，之后可以用截图收录菜谱」）。
- 我的页可以顺手放一条「关于」，写版本号——但这不是必须的，builder 自己定。

### 6.4 路由 `src/router/index.ts`

- 新增 `/ai`（AiPage）、`/me`（MePage）。
- 给 `/recipe/new`、`/recipe/:id/edit`、`/recipe/:id` 加 `meta: { hideTab: true }`。
- 保持 `createWebHistory`。

### 6.5 依赖

`lucide-vue-next` 是唯一要新增的依赖（WeeCount 也在用同一个）。图标：`BookOpen`、`Sparkles`、`User`、`Plus`、`ArrowLeft`、`Pencil`、`Trash2`。**不要引入组件库（Vant / Element / Nuxt UI 之类）。**

---

## 7. 现有测试给的约束（本轮最容易踩的坑）

三份测试**只有一处允许改**（§7.4，你已经点头），其余一行不动。以下是逐条核对出来的、会直接撞车的断言：

### 7.1 详情页食材行必须保持"数量 单位 名称"的单段文本

`RecipeDetail.test.ts` 用 `wrapper.findAll('[data-test="ingredient-row"]').map(n => n.text())`，断言的行文本是 `"2 个 鸡蛋"` / `"200 克 五花肉"` / `"适量 盐"`。

所以食材行**不能**改成"名称靠左、用量靠右"的两端对齐布局——那样拼接出来的文本会变成 `"鸡蛋2 个"`，测试直接红。

可行做法：**整行插值不动，只改外层的 class**（字号、内边距、底色）。

想拆成两个 `<span>` 做层次的话要特别小心：Vue 3 模板对**含换行**的元素间空白是**删除**（不是压成一个空格），所以两个 span 分两行写，拼出来是 `"2 个鸡蛋"`，照样红。真要做就得把两个插值写在同一个元素里，或者显式写一个 `&#32;`。**最省事的做法是整行不动。**

### 7.2 列表页必须继续显示分类与全部标签

`RecipeList.test.ts` 断言 `[data-test="recipe-tag"]` 的文本是 `["家常", "下饭"]`。标签胶囊可以改小改淡，但不许从列表里拿掉。

### 7.3 列表卡片必须带 `line-clamp-2`

`expect(name.classes()).toContain("line-clamp-2")`。菜名元素上这个类不能丢。

### 7.4 空状态文案已确认改成「右上角」

**你已确认：文案要改。** 这一处允许改测试断言（属于「新规格与旧断言直接冲突」的 `AGENTS.md` 例外）。

改动只有两处，字符串必须完全一致：

| 文件 | 从 | 到 |
|---|---|---|
| `views/RecipeList.vue` | `还没有菜谱，点下面的加号记一道` | `还没有菜谱，点右上角加号记一道` |
| `views/__tests__/RecipeList.test.ts`（第 108 行的用例名和第 111 行的断言） | 同上 | 同上 |

注意 `docs/superpowers/plans/2026-10-13-recipe-crud.md:645` 里也引用了旧文案——那是上一轮的**已完成**计划文档，属于历史记录，**不要改它**。

### 7.5 其它必须原样保留的钩子

`data-test` 全部保留：列表页 `recipe-card` / `recipe-cover` / `recipe-cover-fallback` / `recipe-name` / `recipe-category` / `recipe-tag` / `recipe-add`；详情页 `back` / `edit` / `delete` / `delete-error` / `detail-name` / `detail-category` / `detail-tag` / `ingredient-row` / `step-row` / `step-order` / `step-text` / `step-image` / `not-found` / `back-to-list`；编辑页 `back` / `save` / `form-error` / `name` / `category-row` / `category-name` / `tag-row` / `tag-chip` / `tag-chip-name` / `tag-remove` / `ingredient-row` / `ingredient-row-name` / `ingredient-row-amount` / `ingredient-row-remove` / `add-ingredient` / `step-row` / `step-order` / `step-text` / `step-up` / `step-down` / `step-remove` / `add-step`。

**`image-preview` 不算可选钩子**：`RecipeEdit.test.ts` 断言 `findAll('[data-test="image-preview"]')` **恰好两个**（封面一张、步骤图一张）。编辑页里 ImagePicker 的实例数不能变。

**没有测试在用的钩子**：`image-camera-input` / `image-options` / `opt-camera` / `opt-gallery` / `opt-remove` / `image-placeholder` / `image-error` 这些在 `ImagePicker.test.ts` 里用着，但那份测试测的是组件本身；本轮对 ImagePicker **只换颜色，不动结构**。

另外 `ConfirmDialog` 的根元素必须保留 `max-w-sm` 类——测试靠 `.max-w-sm` 在 `document.body` 里找对话框（它 Teleport 到 body，`wrapper.get` 找不到）。

编辑页的 `[data-test="save"]` 挪到顶栏后，仍然必须是 `<button>`，并且 `disabled` 属性的有无仍然由"菜名是否为空 / 是否正在保存"决定——测试直接读这个属性。

---

## 8. 验证

```bash
npm run test        # 全绿；三份页面测试只有 §7.4 那一处文案断言改过，其余一行未动
npm run build       # vue-tsc 类型检查 + 构建
npm run tauri -- android build --apk --debug   # 真机装上，肉眼过一遍
```

改测试那一步**单独提交或单独说明**，别把它混在功能改动里——“测试改了一行”必须在 diff 里一眼能看见。

真机上要盯的四件事：
1. 状态栏区域和顶栏是不是一整块白，有没有出现双层留白；
2. 底部 tab 栏在 Android 手势条位置有没有被遮住（靠 `pb-[env(safe-area-inset-bottom)]`）；
3. 详情页 / 编辑页没有 tab 栏（`hideTab` 生效），列表页有；**并且这两页最后一行内容不被手势条压住**；
4. 系统开深色的手机上，改完之后是全亮的（见 §2 的代价说明）。

---

## 9. 留给下一轮

- 筛选页 / 搜索（列表右上角补漏斗图标）。
- 深色模式：换成一套主题变量 + `prefers-color-scheme`（或独立开关），不要再回到手写 `dark:` 类。
- 详情页显示封面图。
- 「我的」页的实际内容（版本号、数据导出、同步设置）。
- 跟做模式。
