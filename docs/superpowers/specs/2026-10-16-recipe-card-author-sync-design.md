# 一起做饭 · 菜谱卡片统一与作者信息 设计

2026-10-16 · 状态：待实施

上一轮：`docs/superpowers/specs/2026-10-16-profile-avatar-refsheet-design.md`（已实施）。本轮四件事都是实机验证后提出的：社区列表的作者头像在真机上只显示文字头像、菜谱详情页的作者只有一行文字、三种来源的列表卡片排版不一致、「我的」页的同步状态点不动。

本轮**取代**上一轮 §5.3 里「社区列表卡片 32px 圆」那一格（见 §5.3）。

---

## 1. 要解决什么

**一、社区列表的作者头像在真机上没显示。** A 已经设了头像（点进 A 的用户页能看到真头像），B 在社区列表看到的却是文字头像（昵称首字）。代码路径已核对：后端 `ListPublicRecipes` 的 SELECT 里有 `u.avatar_url`、handler 直接序列化 `model.CommunityRecipe`（含 `author_avatar_url`）、客户端把它喂给了 `UserAvatar`；而用户页走的是**同一列** `users.avatar_url`。所以「用户页有、列表没有」只可能是两种情况之一：**服务端在跑旧进程**（响应里根本没有 `author_avatar_url` 这个键）或 **B 的 APK 是旧包**。两者一次分辨：看响应 JSON 里有没有这个键（§11 第 0 条）。**这不是代码缺陷**，本轮随重建一起收口。

**二、菜谱详情页的作者只有一行文字。** 现在是 `{{ detail.recipe.owner_nickname }}` 一个纯文字按钮，点头像进用户页。要像用户页那样给一张卡片：头像 + 昵称 + 公开菜谱数 + 关注按钮。

**三、菜谱列表的卡片三种来源排版不统一。** 「我的」和「收藏」tab 的卡片是「封面 + 菜名 + 分类 + 标签」，**完全没有作者这一行**；社区卡是「封面 + 菜名 + 作者头像 + 昵称」，**没有分类和标签**（服务端列表接口不返回它们）。要统一成三行：**标题 / 分类与标签 / 作者头像与昵称**。

**四、「我的」页的同步状态点不动。** 它只是一张信息卡（账号 / 上次同步 / 失败提示 / 重试按钮 / 退出登录）。wee-count 的同步状态整块可点、点一下就跑一次同步。本项目要做成一样：**点整块 = 立刻跑一次增量同步**。

**成功的样子**：社区列表里 A 的头像和他用户页上的一致；点开一道公开菜谱，第一眼看到作者是谁、能直接关注；菜谱列表切「我的 / 收藏 / 全部」，卡片长得一样，每张都能看到是谁做的（自己的那行就是我自己）；「我的」页点一下同步卡就真的在同步，转完告诉你结果。

---

## 2. 目标 / 非目标 / 反目标

**目标**
- 三种来源的菜谱列表卡共用一个组件，统一的**三行**布局。
- 社区列表接口补上分类与标签，社区卡的第二行不再是空的。
- 本地 `recipes` 表与 `/sync`、社区详情 payload 补上作者头像，收藏卡与详情页的作者头像有来源。
- 详情页作者卡片：头像 + 昵称 + 公开菜谱数 + 关注/已关注。
- 「我的」页同步卡整块可点，触发一次**立刻**的增量同步，并显示「同步中…」。

**非目标（本轮明确不做）**
- 用户页（`/user/:id`）里那份「ta 的公开菜谱」列表不做卡片改造：那张列表的作者行是冗余信息（整页就是 ta）。留到以后要统一时再说。
- 头像缓存 / 懒加载 / 去重（同一个作者在列表里出现 N 次仍下发 N 遍 base64）——上一轮就欠着。
- 作者信息的本地缓存表（不为「作者」建一张表）。
- 点作者头像/昵称直接进用户页（列表卡里先不做跳转，整张卡还是进菜谱）。
- 关注关系的变化（沿用现有关注/收藏语义）。
- 深色模式。
- 全量推送入口（`triggerFullPushAndSync`）不做成手动同步按钮。

**反目标（做出来了也算失败）**
- **为自己的菜谱落一份作者副本。** 「我的」菜谱的作者就是我自己，用内存里的 `auth.nickname` / `auth.avatarUrl`（唯一真相源）即可；往本地表写一份自己的昵称/头像会多一份必然会漂的副本。
- 未登录 / 未认领的菜谱卡上显示一行假的作者（编一个「我」或留一个空圈）。没有作者信息就**不渲染第三行**。
- 为社区卡的第二行**每张卡再发一次请求**去补分类标签。要么服务端列表一次给全，要么那一行空着。
- 改同步服务的既有契约：`enqueueSync` 的返回值/语义不动（仍是 fire-and-forget 入队），手动同步**不 await** 它、也不把它改成 Promise。
- 手动同步做成一次全量推送（`triggerFullPushAndSync` 是「认领存量」用的，不是日常同步）。
- 让「点整块同步」把「退出登录」「服务器设置」这些入口挤没。
- 为让测试变绿而放宽、删除或改弱任何断言。

---

## 3. 这些是你定的（不要改）

- 社区卡第二行要**真的填上**分类与标签（= 动后端列表接口，不是留空）。
- 自己的菜谱，第三行显示**我自己的**昵称与头像；未登录/未认领的老菜谱那一行不显示。
- 详情页作者卡片**带**关注按钮。
- 点同步状态 = 触发一次**增量**同步（不是全量推送）。

---

## 4. 我的取舍（可质疑，改之前先问）

### 4.1 作者头像三条来源，各走各的近路

不做一个统一的「作者缓存」，因为三个来源拿到的数据形态本来就不同：

| 来源 | 昵称 | 头像 | 是否需要落库 |
|---|---|---|---|
| 我的菜谱（本地） | `auth.nickname` | `auth.avatarUrl` | 否，内存里有 |
| 收藏（本地） | `recipes.owner_nickname` | **新增** `recipes.owner_avatar_url` | 是（别人的头像本地没有） |
| 社区（REST 列表） | `author_nickname` | `author_avatar_url` | 否，不落库（沿用上一轮结论） |

一个统一的作者表要把三种形态归一，代价是一个新的同步实体；而这三种形态的差异本来就只有「数据从哪来」。

### 4.2 本地 `owner_avatar_url` 走现成的 `recipeSelectColumns`

服务端 `sync.go` 里的 `recipeSelectColumns` 是**增量同步与社区详情共用**的列清单（`FROM recipes r LEFT JOIN users u`），加一列 `u.avatar_url` 就同时让 `/sync` 的 `remote_changes` 和 `GET /community/recipes/{id}` 带上作者头像，客户端只改一处落库。这也让「收藏了但从没点开过详情的菜谱」有头像可显示——它是由 `/sync` 下发到本地的。

### 4.3 作者两列要能「穿过 LWW」刷新，否则存量菜谱永远没有头像

落库是 LWW：`applyRemoteChanges` 遇到「远端 `updated_at` 不大于本地」的行直接 `continue`，而 `/sync` 又只下发游标之后的行。所以**新加的 `owner_avatar_url` 对本地已存在的行永远是 NULL**——存量收藏、升级前点开过的详情缓存全都拿不到作者头像，即便收藏动作把该菜谱的 `server_seq` 推新、服务端重发，也会判等跳过。上一轮的 `owner_nickname` 有同样的洞，只是当时没人在意。

处理：**LWW 判等跳过的分支里，单独把作者两列刷新一次**（而不是整体更新）。依据是这两列是服务端从 `users` 表派生的**展示数据**，本地从不改写它们，刷新它们不会覆盖任何本地编辑。加一个保险：**载荷里不存在 `owner_avatar_url` 这个键时不动本地值**（旧版服务端不发这个键，别把已经拿到的好头像抹成 NULL——这与 Task 上一轮 F1 那条 `typeof` 守卫是同一类问题）。

替代方案是清游标让 `/sync` 全量重发，但**光重发没用**：LWW 照样跳过，所以绕不过上面这一条，还得额外付一次全量载荷的代价。不做。

### 4.4 统一卡片是无状态组件，封面是否可用由调用方决定

`RecipeCard.vue` 接「已经解析好的图源」`coverSrc: string | null`，不认识的 `imageStore` / `syncFiles` 这套鉴权下载通道。现有的两个调用点本来就各自维护着「哪些封面已经落盘」（`localImages` / `localCovers`），那份逻辑留在它们那里，卡片只负责画。图没到时卡片自己用**菜名首字**兜底（沿用现有行为）。

### 4.5 第三行头像 20px（修正上一轮的 32px）

上一轮 spec §5.3 定了「社区列表卡片 32px 圆」，那是给「封面 + 菜名 + 作者」这种一行式卡片定的。三行卡里第三行跟的是 12px 的昵称文字，32px 的头像会把这一行撑成视觉主角。**本轮改为 20px**（`h-5 w-5` + `text-[10px]`），并把上一轮 §5.3 的表改过来——两处文档不能继续互相打脸。详情页的作者卡片仍是 64px（那是卡片主角，不受此影响）。

### 4.6 详情页作者卡片：本地先渲染，联网再补

本地已经有作者昵称与头像（§4.2 落库的那两列），所以卡片**立刻**能画出来；联网时再补一次 `GET /users/{id}` 拿到「公开 N 道」与「关注/已关注」，失败就不显示关注按钮（不显示错误、不阻塞页面）。离线时就是一张没有按钮的作者卡片。

不复用 `/me` 的用户卡位置与语义，也不做「作者资料缓存」：同一页只请求一次，离开即弃。

### 4.7 手动同步 = 立刻跑一次，不等 3 秒防抖

`enqueueSync` 是「入队 + 3 秒防抖」，用户点一下要等 3 秒才发请求，观感是「点了没反应」。所以新增一个薄入口（`requestSyncNow()`）：有同步在途就沿用现有的排队机制（`syncQueued`）安排再跑一轮，否则清掉防抖定时器立刻 `performSync()`。并且导出在途标志（`syncInFlight`）给界面用——没有它，点完不知道有没有在跑。

状态文案与 wee-count 对齐：**同步中… / 上次同步没成功 / 已同步 <时间>**。

「重试」按钮**退休**：整块可点之后它与卡片重复（wee-count 也没有这个按钮）。它没有测试断言（`data-test="sync-failed"` / `retry` 只在模板里，没有任何用例引用），代价只是 §6.3 的钩子清单少一项。

### 4.8 判断 #1 的方法写进验收，不靠猜

「社区卡显示文字头像」有两种原因，处理方式完全不同：响应 JSON 里没有 `author_avatar_url` → 服务端旧进程（重新 `go build` 起服务）；有而卡片还是文字 → APK 旧包（重装）。§11 第 0 条给出一次性分辨的命令。**代码在两种情况下都不改。**

---

## 5. 数据形态

### 5.1 服务端

| 结构 | 新增 | 说明 |
|---|---|---|
| `model.CommunityRecipe` | `CategoryName *string`（json `category_name`） | 分类可能被软删/未引用 → 可为空 |
| 同上 | `Tags []string`（json `tags`） | **空数组，不是 null**（客户端不必判空） |
| `model.Recipe` | `OwnerAvatarURL *string`（json `owner_avatar_url`） | 没设过是 null |

`ListPublicRecipes` 的 SELECT 增加：

- 分类：`LEFT JOIN labels c ON c.id = r.category_id AND c.deleted_at IS NULL`
- 标签：`COALESCE((SELECT array_agg(l.name ORDER BY l.name) FROM recipe_labels rl JOIN labels l ON l.id = rl.label_id WHERE rl.recipe_id = r.id AND l.kind = 'tag' AND l.deleted_at IS NULL), '{}')`

标签用**名字**而不是 id：客户端只是画几个 chip，不需要标签 id；列表项也不落库，没有引用完整性问题。

### 5.2 本地 SQLite

`recipes` 加一列 `owner_avatar_url TEXT`（走既有的 `migrateTables`：先 `PRAGMA table_info` 再 `ALTER TABLE ADD COLUMN`，与 `owner_nickname` 同一套）。写入点在 `services/sync.ts` 落库的 INSERT/UPDATE 两处（与 `owner_nickname` 相邻）。`src/types/index.ts` 的 `Recipe` 加 `owner_avatar_url: string | null`。

`CommunityRecipe` 的 TS 接口加 `category_name: string | null`、`tags: string[]`。

### 5.3 头像尺寸表（取代上一轮 §5.3）

| 位置 | 尺寸 | 数据来源 |
|---|---|---|
| 列表卡第三行（我的 / 收藏 / 社区） | **20px 圆** | 见 §4.1 三条来源 |
| 「我的」页用户卡 | 48px 圆 | `auth.avatarUrl` |
| 资料编辑页预览 | 96px 圆 + 相机角标 | 本地暂存态 |
| **菜谱详情页作者卡片** | 64px 圆 | 本地 `owner_avatar_url` |
| 用户页资料区 | 64px 圆 | `profile.avatar_url` |

---

## 6. 统一卡片 `RecipeCard.vue`

```
┌──────────────────────────────────────────────┐
│ ┌────┐  红烧肉                        ← 第一行 标题（最多两行）
│ │封面│  [家常菜] #下饭 #硬菜           ← 第二行 分类 + 标签
│ └────┘  (avatar) 老王                 ← 第三行 作者头像 + 昵称
└──────────────────────────────────────────────┘
```

props（除了 `testPrefix`，全是**已解析好的展示值**，组件不知道数据从哪来）：

```ts
defineProps<{
  name: string;
  coverSrc: string | null;      // 已落盘的图源；null → 菜名首字兜底
  category: string | null;      // null → 只画标签
  tags: string[];
  authorName: string | null;    // null → 第三行整行不渲染
  authorAvatarUrl: string | null;
  testPrefix: "recipe" | "community";
}>();
```

- 第二行：`category` 有值就画一个分类 chip，后面跟标签 chip，`flex flex-wrap gap-1`；两者都为空时整行不渲染。
- 第三行：`<UserAvatar class="h-5 w-5 shrink-0 rounded-full" text-class="text-[10px]" />` + `text-xs` 昵称（`truncate`）。
- 封面：`coverSrc` 有值才画 `<img>`，否则用菜名首字兜底（沿用现有行为）。

### 6.1 `data-test` 钩子：用一个 `testPrefix` prop 产出两套

一个 DOM 节点只能有一个 `data-test`，而**两套既有钩子都被真实用例依赖**（`CommunityFeed.test.ts` 读 `community-card` / `community-cover` / `community-cover-fallback` / `community-author-avatar` / `community-author`，并在 `community-card` 上 `trigger("click")`；`RecipeList.test.ts` 读 `recipe-cover` / `recipe-cover-fallback` / `recipe-card` / `recipe-name` / `recipe-category` / `recipe-tag`，还把 `community-card` 当独立元素取）。所以组件接一个 `testPrefix: "recipe" | "community"`，钩子一律拼出来：

```
`${testPrefix}-card`  `${testPrefix}-name`  `${testPrefix}-cover`
`${testPrefix}-cover-fallback`  `${testPrefix}-category`  `${testPrefix}-tag`
`${testPrefix}-author`  `${testPrefix}-author-avatar`
```

于是两套钩子逐字保留（社区那套是 `community-author` / `community-author-avatar`，本地那套是 `recipe-author` / `recipe-author-avatar`），**两个列表的既有断言一行都不用改**。

**点击处理留在卡片自己的根 `<button>` 上**（不是外层 wrapper）：社区卡点击用例是在 `community-card` 上 `trigger("click")`，事件不会往子元素冒泡，handler 挂错层会直接挂。`community-favorited` 星标不进 `RecipeCard`，由社区调用点放在卡片外部。

### 6.2 调用点与传参

| 调用点 | name | coverSrc | category | tags | authorName / authorAvatarUrl |
|---|---|---|---|---|---|
| `RecipeList.vue` 我的/收藏 | `item.recipe.name` | 落盘命中时 `imageSrc(...)` | `item.category.name` | `item.tags` | 见下 |
| `CommunityFeed.vue` 社区卡 | `item.name` | 同上 | `item.category_name` | `item.tags` | `item.author_nickname` / `item.author_avatar_url` |
| （用户页列表） | — | — | — | — | 本轮不动（非目标） |

「作者是谁」的判定（我的/收藏两处共用一个函数）：

```
owner_id 为空或等于 auth.serverUserId  → 用 auth.nickname / auth.avatarUrl（未登录时 nickname 为 null → 不渲染第三行）
否则                                  → 用 recipes.owner_nickname / owner_avatar_url（有才渲染）
```

社区卡另有收藏星标（`community-favorited`），作为卡片右上角的槽位保留在社区调用点的外层，不进 `RecipeCard`。

---

## 7. 详情页作者卡片

现在（`RecipeDetail.vue`）：

```html
<button data-test="recipe-author">{{ detail.recipe.owner_nickname }}</button>
```

改成卡片（只在 `owner_id` 存在时渲染，与现状一致）：

```
┌────────────────────────────────────┐
│ (avatar 64)  老王            [关注] │
│              公开 12 道              │
└────────────────────────────────────┘
```

- 头像 / 昵称来自本地那份（`owner_avatar_url` / `owner_nickname`），**立刻**画出来。
- 在线时 `useCommunityStore().profile(ownerId)`（已有函数，`/users/{id}`）补「公开 N 道」与关注按钮；离线或请求失败 → 不显示这两项，卡片其余部分照常。
- 点整块（头像/昵称/数字）进 `/user/{id}`；关注按钮 `@click.stop` 单独触发 `follow` / `unfollow`（沿用 store 的既有动作与错误处理）。
- **作者就是自己时（`owner_id === auth.serverUserId`）不渲染关注按钮**（关注自己没意义），公开菜谱数照常显示。
- 保留 `data-test="recipe-author"` 在整个卡片上，另加 `recipe-author-avatar` / `recipe-author-follow`；既有的「点作者进用户页」用例断言的是 `recipe-author` 存在与点击后跳转，**不改**。

---

## 8. 「我的」页同步卡

已登录态的形状：

```
┌──────────────────────────────────────┐   ← 整块是一个 <button>，点 = 手动同步
│ 多设备同步                   已开启    │
│ 账号                          阿丽     │
│ 上次同步            2026-10-16 14:03  │
│ 同步中… / 上次同步没成功               │   ← 只在需要时出现
└──────────────────────────────────────┘
  服务器设置                        ›      ← 新增一行，进 /me/server
  退出登录                                 ← 保留
```

- 点整块 → `requestSyncNow()`；在途时文案「同步中…」且整块 `disabled`（避免连点）。
- `data-test` 变化：`me-sync-card`（新，整块按钮）、`syncing`（新，在途文案）；`server-state` / `nickname` / `last-sync` / `sync-failed` / `logout` 保留；**`retry` 退休**，`server-row` 只在前两态（未开启 / 未登录）保留——已登录态的入口换成 `server-settings-row`（新）。
- 未开启 / 未登录两态一行不改（它们本来就该跳转，不是同步）。

---

## 9. 测试影响

**会变的既有断言（逐条列出，都是契约变化的直接冲突）**

| 文件 · 用例 | 冲突点 | 处理 |
|---|---|---|
| `src/views/__tests__/MePage.test.ts` · 已登录那条 | 卡片从「静态信息块 + 重试按钮」变成可点的同步卡 | 断言对象换成 `me-sync-card`，其余（`server-state` / `nickname` / `last-sync`）保留 |
| `src/components/__tests__/CommunityFeed.test.ts` · 卡片显示作者头像 | 卡片结构与社区卡原有钩子 | 结构调整，断言与钩子保留；新增「第二行显示分类与标签」 |
| `src/views/__tests__/RecipeList.test.ts` · 卡片相关用例 | 卡片结构统一后 `recipe-card` 内部的层数变化 | 保留既有断言，新增「第三行显示作者」 |
| `src/views/__tests__/UserPage.test.ts` | 无 | 不动（用户页列表在非目标里） |

`retry` / `sync-failed` 两个钩子**没有任何用例引用**（已 grep 核实），退休不掉断言。

**新增测试**

- `RecipeCard`：三行渲染；`category` 为空只画标签；`tags` 为空不画第二行；`authorName` 为 null 不画第三行；封面兜底用菜名首字。
- 作者判定函数：owner 是自己 / owner_id 为空且未登录 / owner 是别人但本地没有昵称（三种分支）。
- `CommunityFeed`：分类与标签来自 `category_name` / `tags`。
- `RecipeList`：我的菜谱第三行显示自己的昵称与头像；未登录时不显示第三行。
- 详情页作者卡片：本地先渲染；联网补公开菜谱数与关注按钮；离线只有卡片；关注按钮点击调用 store 的 follow（`@click.stop` 不进用户页）。
- 后端：`ListPublicRecipes` 返回 `category_name` 与 `tags`（有标签 / 无标签 / 分类为空三种）；`RecipePayload` 带 `owner_avatar_url`（`/sync` 与社区详情各一条）。
- `sync.ts`：`requestSyncNow()` 空闲时**立刻**跑（不等防抖）；在途时只安排一轮补跑；`syncInFlight` 在跑与不跑之间正确翻转。
- `sync.ts` 落库：**LWW 判等跳过的行，作者两列仍被刷新**（造一条本地 `updated_at` 更新的行 + 带作者头像的远端行，断言 `owner_avatar_url` 被写上、菜名等其它列**没**被远端覆盖）；载荷里没有 `owner_avatar_url` 键时本地值保持不动。

---

## 10. 后端改动

| 文件 | 改动 |
|---|---|
| `internal/model/community.go` | `CommunityRecipe` 加 `CategoryName *string` / `Tags []string` |
| `internal/model/recipe.go` | `Recipe` 加 `OwnerAvatarURL *string` |
| `internal/service/sync.go` | `recipeSelectColumns` 加 `u.avatar_url`，`scanRecipeRow` 加一项 |
| `internal/service/community.go` | `ListPublicRecipes` 的 SELECT 加分类 JOIN 与标签子查询、`Scan` 加两项 |
| `internal/service/*_test.go` | 上述三处的断言 |
| `docs/开发者-同步与社区.md` | 社区列表响应样例加 `category_name` / `tags`；`/sync` 的菜谱样例加 `owner_avatar_url` |

`users` 表、`PUT /auth/profile`、`/users/{id}`、`/sync` 的请求形状**全部不动**。

---

## 11. 验证

**命令**
```bash
npm run test
npm run build
cd backend && go test ./... && go vet ./...
```

**真机（Android）**
0. **先分辨 #1**：`curl -s -H "Authorization: Bearer <access_token>" 'http://<服务器>/api/v1/community/recipes?limit=5'` 看响应里有没有 `author_avatar_url` 这个键。没有 → 重新编译并重启后端（`go build ./cmd/server`）；有而卡片还是文字 → 重装 APK。这一步是 #1 的收口判据。
1. 社区列表：每张卡三行——菜名 / 分类与标签 / 作者头像与昵称；头像与作者用户页上的一致。
2. 「我的」tab：每张卡第三行是我自己的昵称与头像；退登后第三行消失。
3. 「收藏」tab：收藏的别人菜谱第三行是**作者**的头像与昵称（重启 App 后仍在，验证本地列真的落库了）。
3b. **升级安装（不是全新安装）**再走一遍第 3 条与第 4 条：这是 §4.3 那条 LWW 刷新的验收——存量菜谱的作者头像靠它才补得上。全新安装走不到这条路径。
4. 点开一道公开菜谱：作者卡片第一眼就有头像与昵称，联网时补出「公开 N 道」与关注按钮；点关注 → 变成「已关注」；点卡片进用户页。
5. 断网开一道已收藏的公开菜谱：作者卡片还在（没有数字与关注按钮），不报错。
6. 「我的」页：点同步卡 → 「同步中…」→ 回到「已同步 <刚才的时间>」；拔网再点 → 「上次同步没成功」。
7. 连点三次同步卡：只跑一轮（`syncInFlight` 不许出两个并发 `/sync`）。
8. 已登录时能找到「服务器设置」并进得去；退出登录仍然可用。

---

## 12. 留给下一轮

- 用户页那份「ta 的公开菜谱」列表是否也换统一卡片（那时要决定作者行是否冗余）。
- 列表卡里点作者头像/昵称直接进用户页（本轮整张卡进菜谱）。
- 头像/作者信息的缓存与去重（同一作者在列表里重复下发 base64）。
- 关注流、团队成员列表的头像。
- 深色模式。
