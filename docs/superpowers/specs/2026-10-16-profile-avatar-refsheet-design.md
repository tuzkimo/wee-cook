# 一起做饭 · 用户资料与 RefSheet 改造 设计

2026-10-16 · 状态：待实施

参考项目：`D:\projects\my\wee-count` 的 `src/views/MePage.vue`（「我的」页布局）、`src/views/ProfilePage.vue`（头像与昵称编辑）、`src/components/AvatarCropper.vue` + `src/utils/crop.ts`（裁剪）、`src/components/TagSheet.vue`（底部 sheet 的形态）。视觉与交互照抄那一套，**标了「不照抄」的地方是有意偏离**。

对应上一轮：`docs/superpowers/specs/2026-10-15-community-design.md`（社区，已实施）。本轮给它补「作者是谁」这件事——社区列表现在只有昵称，没有头像。

---

## 1. 要解决什么

两个各自独立的问题，一起做只因为它们都落在「人」这件东西上。

**一、社区里认不出作者。** 社区列表只有 `author_nickname`，用户页也只显示昵称。看一圈公开菜谱，不知道哪几道是同一个人做的，也不知道这个人是不是我关注的那个。昵称可以重名、可以改，头像是唯一一眼能认的东西。

**二、「我的」页没有「我」。** 这个页面现在只有一张同步状态卡（未开启 / 未登录 / 已开启），从头到尾没出现过用户自己。已登录的人打开它，看不到自己是谁、长什么样，也没法改昵称——服务端 `PUT /api/v1/auth/profile` 早就支持改昵称和头像了，客户端**一行都没接**（`2026-10-14-sync-team-design.md` §6.2 原文：「本轮没有上传头像的界面」）。

**三、底部 sheet 的增删改藏得太深。** `RefSheet`（选食材/单位/分类/标签）现在每行都挂着「编辑」「删除」两个文字按钮，底部还有「新建」进表单模式。选东西的时候，这四个动作是噪音；管理动作应该收起来，只在需要时出现。

**成功的样子**：社区列表里一眼看出哪几道菜是同一个人发的，点进去能看到 ta 的头像；「我的」页打开第一眼是自己；想改昵称和头像，两步之内到位，离线重开 App 头像还在；选食材时满屏只有食材名，想改字典就点右上角「管理」。

---

## 2. 目标 / 非目标 / 反目标

**目标**
- 「我的」页顶部加用户卡：头像 + 昵称 + 状态 + 进入资料页。
- 新增资料编辑页 `/me/profile`：换头像（拍照/相册 + 裁剪 + emoji 备选）、改昵称。
- 头像在「我的」页、资料编辑页、社区列表卡片、用户页四处显示。
- 社区列表接口带上作者头像（`author_avatar_url`）。
- 头像离线可见：最后一次同步下来的头像落 settings.json，冷启动/断网时「我的」页照样显示。
- `RefSheet` 改成 tag sheet 的形态：默认就是搜索+选择态，搜索无同名时行内直接创建，增删改收进右上角「管理」。

**非目标（本轮明确不做）**
- 头像走文件通道（`/api/v1/files`）——见 §4.1 的取舍与迁移路径。
- 服务端做图片处理（缩略图、格式转换、裁剪）。头像字节由客户端裁好再传。
- 头像历史版本、多头像、头像审核。
- 菜谱详情页显示作者头像（本轮只做列表 + 用户页）。
- 团队成员列表加头像（`TeamMember.avatar_url` 服务端早就返回了，但客户端还没有团队界面）。
- `RefSheet` 的排序、分组、拖拽；字典条目的合并。
- 深色模式（前几轮就欠着）。

**反目标（做出来了也算失败）**
- **头像被塞进 `images/` 目录、参与文件同步。** 头像是用户资料的一部分，不是菜谱图片；它进了 `syncFiles` 的上传/下载队列，就会污染「菜谱引用到的图」这套语义。头像只进 `avatar_url` 字符串。
- 为头像引入组件库、图片处理库或状态管理容器。
- 头像以 base64 的体积把社区列表响应撑到 1MB 以上（§4.1 的尺寸上限就是为这条定的）。
- 改动 `/me` 现有的三态同步契约：`data-test="server-state"`/`server-row`/`nickname`/`last-sync`/`retry`/`logout` 钩子与文案全部保留，本轮只在其上方加内容。
- `RefSheet` 把「编辑/删除」换个位置继续每行常驻（比如收进「⋯」菜单）——那是把噪音藏起来，不是消除它。
- 为让测试变绿而放宽、删除或改弱任何断言（§9 列出的冲突例外除外，那些要人工确认）。

---

## 3. 这些是你定的（不要改）

- **头像与昵称要能改**，不是只读展示。
- **社区列表和用户页也要显示头像**，用来认作者。
- **头像存 data URL 进 `users.avatar_url`，裁剪输出 192px**（服务端零改动）。
- **`RefSheet` 的删除保持软删 + 引用保护**：有菜谱在用就不能删，不做「删掉标签但记录保留」那种弱引用语义。
- **`RefSheet` 照 tag sheet 改**：默认搜索选择态、搜索没有就提示新增、增删改收进右上角「管理」。
- **「我的」页的布局和样式参考 wee-count 的 `MePage.vue`**。

---

## 4. 我的取舍（可质疑，改之前先问）

### 4.1 头像存 data URL，192px

`users.avatar_url` 是一个 `TEXT` 列，`PUT /api/v1/auth/profile` 收的是任意字符串（handler 侧 `MaxBytesReader` 限 1MiB）。所以客户端把图片裁好、压成 JPEG、`toDataURL()`，直接把那串丢进去，**后端一行都不用改**，别人打开用户页也立刻能看到。

代价是社区列表每行都会带一份 base64。列表默认 20 条、上限 50：

| 裁剪输出 | 单张（含 base64） | 20 行最坏 |
|---|---|---|
| 256px（wee-count 原值） | 27–40KB | 0.55–0.8MB |
| **192px（本轮采用）** | 16–25KB | 0.3–0.5MB |
| 160px | 11–17KB | 0.25–0.35MB |

选 192 是因为列表里头像只显示 32px（3x 屏要 96px），192 绰绰有余；「我的」页 48px 圆（144px @3x）也够；只有资料编辑页 96px 的预览按 3x 算要 288px，会略微发糊——**这一处是本方案唯一牺牲画质的地方**，换来的是社区列表不满屏都是 base64。

真嫌慢再迁到文件通道：`avatar_url` 以 `data:` 开头的旧数据可以脚本化搬成文件名，表结构不用动。这就是不现在上文件通道的原因——文件通道要改服务端 `CanRead`（现在只放行「被菜谱引用到的图」，头像传上去**连自己都读不到**）、客户端加一套头像下载缓存、保存时显式上传，首屏还会先闪一下首字母。

### 4.2 emoji 头像保留

照抄 wee-count 的 20 个 emoji 备选。它是「不想传照片」时的零成本出口，也让 `avatar_url` 的三个渲染分支有第二种真实形态（不是理论分支）。

**再点一次同一个 emoji = 取消选择 = 回到无头像**（不是「回退到已保存的头像」）。两次点击的语义就是「选 / 取消选」，保存时发空串（§5.1）。**不照抄**：wee-count 这里是有 bug 的——取消后它发 `avatar_url: null`，服务端的 UPDATE 不执行，头像根本清不掉。

### 4.3 头像不进 `images/`、不落盘

资料编辑页选图走 webview 的 `<input type="file" accept="image/*">` + `FileReader`，**不接 `services/imageStore.ts`**。原因是那个模块的职责是「压缩到 1280px 落盘、返回裸文件名给菜谱用」（它文件头写着「全仓唯一接触 canvas 与文件系统的地方」），头像不需要落盘（不参与同步），走它反而要复制一份「不写盘」的旁路。裁剪组件自带 canvas 重编码，够用。

**不照抄**：wee-count 的 `ProfilePage` 只认 `image/*` 里的静态图；安卓默认拍的 HEIC 在 webview 里能不能 `new Image()` 解码，`AvatarCropper` 读不出来会 `emit("error")`，页面显示「图片无法读取，请换一张」（这条路径照抄 wee-count，不额外做格式准入）。

### 4.4 抽 `UserAvatar.vue`

头像的渲染规则（三分支）现在有四个使用点，且以后社区详情、关注流都会要。规则本身只有三行，但四处各写一遍就会漂移——特别是「空头像退回昵称首字」和「单字符当 emoji」这两条。抽成一个无状态组件，接口就两个 prop。

不抽的部分：**头像的尺寸与形状由调用方用 class 决定**（`h-8 w-8` / `h-12 w-12`），组件不接 `size` prop。Tailwind 的类在调用点一眼看得见，塞进组件反而要维护一套尺寸映射。

### 4.5 单一选模式去掉勾选框

`RefSheet` 现在 single 模式也画一个勾选框。单选场景（选食材、选单位、选分类）里，勾选框在暗示「可以多选」，而点下去立刻关窗——这是错的暗示。single 模式改成纯文字行，点即选中并 `emit("select")`；multiple 模式保留勾选框 + 底部「确定」。

### 4.6 管理模式用图标，不用文字

照 tag sheet：行尾是「N 道菜谱在用」+ 铅笔 + 垃圾桶三个元素。铅笔/垃圾桶用 lucide 图标（`lucide-vue-next` 全仓已用），不再用「编辑」「删除」两个文字按钮——文字按钮会把每行撑宽，而管理模式本来就是低频动作。

### 4.7 重命名 inline，不进整页表单

tag sheet 的做法：点铅笔 → 标题变「重命名」，列表让位给一个输入框 + 取消/保存。整页表单模式（`showForm`）连根删掉，它只为「新建/编辑名字」服务，而新建已经改走搜索框行内创建了。

---

## 5. 头像的数据形态与渲染

### 5.1 存法

`users.avatar_url`（`TEXT NULL`）三种取值，没有第四种：

| 值 | 含义 | 例子 |
|---|---|---|
| `data:image/jpeg;base64,...` | 上传的照片 | 裁到 192px、q0.85 的 JPEG |
| 单个 emoji / 字符 | 表情头像 | `🐱` |
| `NULL` / 空串 | 没设过头像 | — |

**清头像必须发空串 `""`，不能发 JSON `null`。** 服务端是 `AvatarURL *string` + `json:"avatar_url,omitempty"`，且只在 `if req.AvatarURL != nil` 时执行 UPDATE——发 `null` 解码成 nil 指针，那段 UPDATE 直接不跑，头像静默清不掉；发 `""` 才是非 nil 指针、能落到 `avatar_url = ''`。所以 `updateProfile` 的入参类型是 `avatar_url: string`（不给 null），渲染侧把 `NULL` 与空串一并当「没设过」（§5.2）。服务端仍然零改动。

`http(s)://` 和 `/` 开头的值本轮**不会产生**，但渲染规则认它们（见 §5.2）——服务端列是自由文本，将来接了 CDN 不改渲染。

### 5.2 渲染规则（`UserAvatar.vue`，唯一实现处）

```
url 以 data: / http / / 开头  → <img :src="url" class="object-cover">
否则 url 非空              → 当文本渲染（emoji / 字符）
否则                        → 昵称首字；昵称也空则 "?"
```

props：`url: string | null`、`name: string`。外层是 `<div>`，宽高与圆角由调用方的 class 给（如 `h-12 w-12 rounded-full`），内部 `<img>` 铺满（`h-full w-full object-cover`）。文本分支字号由调用方给（`text-sm` / `text-lg` / `text-2xl`）。

三个分支的降级顺序不能调：**有 url 就绝不显示首字**（即使图挂了也是浏览器出破图图标，不静默换成首字——静默替换会让人以为头像保存失败了）。

### 5.3 使用点

| 位置 | 尺寸 | 数据来源 |
|---|---|---|
| 「我的」页用户卡 | 48px 圆 | `auth.avatarUrl`，昵称 `auth.nickname ?? username` |
| 资料编辑页预览 | 96px 圆 + 相机角标 | 本地暂存态（`selectedAvatar`） |
| 社区列表卡片 | 32px 圆 | `item.author_avatar_url`，昵称 `item.author_nickname` |
| 用户页资料区 | 64px 圆 | `profile.avatar_url`，昵称 `profile.nickname` |

社区列表与用户页的头像是**服务端原样返回的字符串**，没有本地文件、没有缓存、没有异步加载，所以不存在「先闪首字母再换头像」——要么 imgsrc 直接可用，要么就没有。

---

## 6. 「我的」页

### 6.1 布局（照 wee-count，分组卡片）

```
AppHeader「我的」
├─ 用户卡          bg-surface px-4 py-4，整块可点，右侧 ›
├─ 分组「多设备同步」  mt-3：分组标题（px-4 py-2 text-xs uppercase text-text-secondary）
│                    + border-y border-gray-100 bg-surface 的卡片（现有内容，一字不改）
└─ （在线时）退出登录按钮，mt-6 px-4
```

**不照抄**：wee-count 的「我的账本」「团队管理」「安全」「备份与恢复」四组本仓都没有，不搬空壳。

### 6.2 用户卡的四种状态

整块是一个 `<button>`，点击去向按登录态分叉：

| 状态 | 头像 | 昵称位 | 副标题 | 点击去向 |
|---|---|---|---|---|
| 未配置服务器 | `UserAvatar(null, "")` | 未登录 | 点这里登录或注册 | `/me/login` |
| 配了地址没登录 | 同上 | 未登录 | 点这里登录或注册 | `/me/login` |
| **离线（配了地址 + 有存档档案 + 当前不在线）** | `UserAvatar(avatarUrl, nickname)` | 昵称 | 离线使用中，连上网络后自动恢复 | `/me/login` |
| 已登录 | `UserAvatar(avatarUrl, nickname)` | 昵称（`nickname ?? username`） | 已开启多设备同步 | `/me/profile` |

第三态判定用「`!auth.isOnline && auth.nickname !== null`」，**不引入任何新的在线探测**。它存在是因为手机在厨房断网打开 App 时，用户根本没退登，此时显示「未登录」是句假话；现有的「三态同步卡」也一直在认真区分「未开启 / 未登录」这两种不可用的原因，用户卡没理由粗糙。

**未登录（前两态）时昵称位固定写「未登录」**，绝不显示存档昵称。「settings 里有昵称」之所以能等价于「上次会话没退登」，靠的是 §7.5 里退登清设置这一步。

现有同步卡片的三态（`server-row` + `server-state`）不动，它和用户卡回答的是两个问题：**「我是谁」** 与 **「同步开了没」**。

### 6.3 钩子

新增：`data-test="me-user-card"`、`data-test="me-user-name"`、`data-test="me-user-status"`。
保留：`server-row`、`server-state`、`nickname`、`last-sync`、`sync-failed`、`retry`、`logout`。

---

## 7. 资料编辑页 `/me/profile`

路由 `{ path: "/me/profile", name: "me-profile", component: ProfilePage, meta: { hideTab: true } }`，与 `/me/server`、`/me/login` 同族。

```
AppHeader「个人信息」showBack
├─ 头像：96px 圆按钮 + 右下相机角标（点击 → 隐藏的 file input）
│        下方 hint「点击更换头像，或选择下方 emoji」
├─ emoji 备选：20 个，点中高亮，再点取消
├─ 昵称：输入框，maxlength 50
├─ 账号：只读一行，显示 username（照 wee-count 的灰底块）
└─ 保存按钮：无改动或保存中时 disabled
```

### 7.1 进入即校验

`onMounted` 时 `auth.isOnline === false` → `router.replace("/me/login")`。已登录是这一页的前置条件（`PUT /api/v1/auth/profile` 需要 token），不留一个必然保存失败的页面。

### 7.2 交互细节

- 选图 → 裁剪弹层（`AvatarCropper`）→ confirm 拿到 dataURL → **只暂存到本地态，不立即提交**。立即提交会让「无改动」判定失效、保存按钮一直灰着（wee-count 踩过这个坑，注释写在那）。
- 裁剪 `cancel` / `error`：关掉弹层，已有头像不动；`error` 额外提示「图片无法读取，请换一张」。
- 昵称 `trim()` 后为空 → 阻止保存 + 提示「昵称不能为空」。服务端只校验长度（>50 报 400），空昵称它照收，会在社区里显示成一片空白。
- `maxlength="50"`：服务端 `users.nickname` 是 `VARCHAR(50)`，按**码点**算（`auth.go` 的注释），中文昵称 50 个汉字合法。前端给 50 是后端真实上限，不用自己收紧。
- 「无改动」判定：`nickname.trim() !== (auth.nickname ?? "")` 或 `selectedAvatar !== auth.avatarUrl`（两边都是 `string | null`）。
- 保存成功 → `router.back()`。失败 → 留在页面显示文案（`AuthError` 用服务端文案，网络层失败用「保存失败，检查网络后重试」）。

### 7.3 保存的动作链（`auth.updateProfile`）

store 里**现在没有这个方法**，要新增：

```
async updateProfile(input: { nickname: string; avatar_url: string })   // 清头像传 ""，见 §5.1
  → api.updateProfile(...)            // 已有的 PUT /api/v1/auth/profile
  → serverUser.value = 返回的 user    // 服务端回的是完整 User
  → nickname.value / avatarUrl.value  // 就地更新，用户卡立刻变
  → persistSession(user, baseUrl)     // 落 settings，见 §7.4
```

### 7.4 离线可见（新增设置项）

现在 `persistSession` 只写 `server_url`/`server_user_id`/`server_username`/`server_nickname`。**头像没地方存，断网冷启动后就没了**——而头像恰恰是那个最需要「一眼看到」的东西。

- 新增设置键 `server_avatar_url`（`settings.json`）。
- `persistSession` 一并写入；`restoreSessionOnce` 与现有 `savedNickname` 同一位置读回，赋给新的 `avatarUrl` ref。
- 空头像写 `null`：`readStringSetting` 走的 `parseString` 把空串按未设置处理，读回来是 `null`，正好对上「没设过头像」。

`auth` store 新增暴露：`avatarUrl`、`updateProfile`。

### 7.5 `avatarUrl` / `nickname` 的生命周期（唯一真相源）

头像有两个可能的来源（内存里的 `serverUser.avatar_url`、settings 里的存档），必须钉死一个，否则「资料页预览的基准」和「用户卡显示的值」会打架。规则：

| 时机 | `nickname` | `avatarUrl` |
|---|---|---|
| `adoptSession`（login / register 成功） | `user.nickname`（现有） | `user.avatar_url`（**新增**） |
| `restoreSessionOnce` 恢复成功 | `resp.user.nickname`（现有） | `resp.user.avatar_url`（**新增**） |
| `restoreSessionOnce` 从 settings 读存档 | 现有 `savedNickname` | 新增 `savedAvatarUrl` |
| `updateProfile` 成功 | 返回值 | 返回值 |
| `logout` | **清空** | **清空** |

**`avatarUrl` 是唯一真相源**：`MePage` 与资料编辑页只读它，不读 `serverUser.avatar_url`（那东西冷启动时是 null、只在会话恢复成功后才填上，做基准会误判「无改动」）。

`logout()` 额外清掉 `server_nickname` 与 `server_avatar_url` 两个**设置项**（用 `settingsFile` 已有的 `deleteSetting`；保留 `server_url` / `server_user_id` / `server_username`——登录页要用后两者预填用户名，那是「下次登录不用重填」这条既有承诺，不动）。这样存档昵称只会在「会话真在、只是连不上」时存在，第四态才不会把「退登过的人」误判成「离线的人」。

---

## 8. `RefSheet` 改造

### 8.1 形态

```
┌─────────────────────────────────────────┐
│ 选择食材                     管理   ✕   │   ← 右上角：管理/完成 + 关闭
│ [ 搜索名称                        ]     │
│ ─────────────────────────────────────── │
│  ☐ 五花肉                                │   ← 选择态：整行可点
│  ☐ 生抽                                  │
│  + 创建「xxx」                            │   ← 搜索词非空且无同名时出现
│ ─────────────────────────────────────── │
│ [            确定            ]           │   ← 仅 multiple
└─────────────────────────────────────────┘

管理模式（点「管理」后）：
│ 管理食材                          完成   ✕
│ [ 搜索名称                        ]
│ 五花肉                    3 道菜谱在用 ✏️ 🗑️   ← 行不可点选
│ 生抽                       0 道菜谱在用 ✏️ 🗑️   ← 垃圾桶可用
```

### 8.2 状态机

两个模式，`select`（默认）与 `manage`。打开时一律回到 `select` 且清空搜索词（现有 `watch(visible)` 的行为，不动）。

| 动作 | single | multiple |
|---|---|---|
| 点行 | `emit("select", [id])`，**不自己关窗**（父组件翻 visible，现有约定 R3） | 切换勾选，留在面板 |
| 确定 | 不出现（点了就走） | `emit("select", [...selected])` |
| 创建 | 建 → 立即 `emit("select", [newId])` | 建 → 勾上，留在面板 |
| 管理 | 同 | 同 |

### 8.3 搜索框的双重身份

列表底部的「创建」入口由搜索词决定：

- 搜索词 `trim()` 后为空 → 不出现。
- 已有条目的名字里有**完全同名**（忽略大小写，照 tag sheet 的 `toLowerCase()` 比对）→ 不出现。
- 其余 → 出现「+ 创建「<搜索词>」」，点击调 `store.add(name)`，成功即选中。

前缀命中不影响创建（已有「五花肉」时搜「五」照常能建「五」）。`store.add` 内部有 `assertNameFree`（SQL 精确匹配），它会挡住大小写不同的同名条目——那是数据库层的事，前端这行只是**提示入口**，不是准入校验。

### 8.4 管理模式

- 行不可点选（勾选态在模板里整块换掉，不是加 `pointer-events-none`）。
- 行尾：`{{ item.usage_count }} 道菜谱在用`（`text-xs text-text-secondary`）+ 铅笔 + 垃圾桶。
- **`usage_count > 0` 时垃圾桶 `disabled` 且置灰**：`store.remove` 对这种条目必定抛「有 N 道菜谱在用「xx」，不能删除」，置灰比让用户点了吃报错好。
- `usage_count === 0` → `ConfirmDialog` 确认 → `store.remove`。
- 切模式时清空搜索词与错误文案（不清会让人以为搜索被吞了）。
- 保留删除失败的 `ConfirmDialog`：置灰挡住了绝大多数情况，但读到 `usage_count` 与真正删除之间仍有窗口（别的菜谱刚引用了它），store 的异常要有人接。

### 8.5 重命名

点铅笔 → `editingId` 有值，标题变「重命名」，模板切成：一个输入框（预填原名）+ 取消/保存；其余（列表、确定、管理按钮）隐藏。保存调 `store.update(id, name)`，失败显示在输入框下方（沿用现在的 `formError` 位置）。

### 8.6 删掉的东西

- 整页表单模式：`showForm`、`editingId` 的「新建」分支、底部「新建」按钮。
- 每行的「编辑」「删除」文字按钮。
- `data-test="ref-new"`、`ref-form-name`、`ref-form-save`、`ref-form-error`（`ref-edit`/`ref-delete` 保留，只是挪进管理模式）。

props / emits 签名**一个都不变**（`visible` / `title` / `store` / `mode` / `selectedIds` / `emptyHint`），所以三个调用点（`RecipeEdit.vue` ×2、`IngredientSheet.vue` ×2）不需要改结构，只改 `empty-hint` 文案。

新增钩子：`data-test="ref-manage"`、`ref-create`、`ref-usage`。

---

## 9. 测试影响

### 9.1 必须人工确认的例外

`AGENTS.md`：已有断言与新的规格要求**直接冲突**时，经人工确认可修改；禁止为让代码变绿而放宽、删除或改弱断言。以下是对照 §8 的契约变化**逐条列出的冲突**，改成新契约的等价断言，不是删除：

| 文件 · 用例 | 冲突点 | 处理 |
|---|---|---|
| `RefSheet.test.ts` ·「点『新建』进表单模式…」 | `ref-new` 与 `ref-form-name` 不存在了 | 改写成：搜索框输入名称 → 点 `ref-create` → `store.add` 被调用、条目被选中 |
| `RefSheet.test.ts` ·「点『编辑』进表单，改名保存…」 | 同上（`ref-edit` 现在要先点「管理」） | 改写成：点 `ref-manage` → 点 `ref-edit` → 保存 |
| `RefSheet.test.ts` ·「保存时名称纯空格 → 显示错误」 | 校验从「保存按钮」移到创建行前（空搜索词不出创建行） | 改写成等价断言：纯空格搜索词 → 不出现 `ref-create` |
| `RefSheet.test.ts` ·「`store.add` 抛同名 → 错误显示在表单里」 | 前端不出现创建行（同名），由 SQL 层兜 | 改写成：已有同名条目时 `ref-create` 不出现；`store.add` 的错误路径改由 `IngredientSheet`/store 测试覆盖 |
| `RefSheet.test.ts` ·「点『删除』弹 ConfirmDialog…」 | 删除按钮移进管理模式 | 改写成：`ref-manage` → `ref-delete` → 确认 |
| `RefSheet.test.ts` ·「`store.remove` 抛错 → 弹提示，条目还在」 | 同上；且需新造「usage_count 为 0 但 remove 抛」的场景 | 改写成：管理模式 + 构造抛错的 store |
| `RefSheet.test.ts` ·「single 模式…只有一个勾」 | single 模式不再画勾（§4.5） | 改写成：single 模式点行即 `select`，行内无 `ref-check` |
| `RefSheet.test.ts` ·「列表为空时显示 emptyHint」 | 文案里的「点下面新建一个」不再成立 | 只改断言的文案字符串 |
| `IngredientSheet.test.ts` ·「在这一层新建食材后自动选中它并进入第二步」 | 走 `ref-new` 路径 | 改写成走搜索 + `ref-create` |
| 四个调用点的 `empty-hint` 文案 | 与新形态不符 | 「还没有食材，输入名称即可新建」等 |

`createRefStore` 的删除保护（`remove` 抛「有 N 道菜谱在用」）**是 store 层的既有断言，一个字不改**——它才是保护本身，UI 只是提前把它说出来。

### 9.2 新增测试

- `UserAvatar`：三分支（data URL → `<img>`；emoji → 文本；空 → 昵称首字；昵称也空 → `?`）。
- `MePage`：未登录 → 用户卡显示「未登录」、点击去 `/me/login`；**离线但存档有昵称 → 显示存档昵称与头像、副标题为「离线使用中」**；已登录 → 显示昵称、点击去 `/me/profile`；**原有三条同步态用例全部保留**。
- `UserAvatar`：`url` 为空串与 `url` 为 `null` 走同一条降级（服务端可能返回空串，见 §5.1）。
- `ProfilePage`：未登录进入 → `router.replace("/me/login")`；选图 → 裁剪 confirm → 保存时 `api.updateProfile` 收到 data URL；emoji 选择；空昵称被拒（不调 api）；无改动时保存按钮 disabled；失败显示文案。
- `auth` store：`updateProfile` 更新 `nickname`/`avatarUrl`/`serverUser` 并写 `server_avatar_url`，**清头像传空串后不做一次「以为没改」的误判**；`restoreSession` 读回头像（无网络时也要读回）；**退登后 `server_nickname` / `server_avatar_url` 被清掉、`server_url` / `server_username` 保留**。既有的「logout 清掉凭据但保留 server_url」用例只断言了 `server_url` 与 `server_username`，与这一步不冲突，不改它。
- `RefSheet`：创建行的三条出现/不出现规则；管理模式行不可点选、禁用删除；内联重命名。
- 后端：`ListPublicRecipes` 返回 `author_avatar_url`（service 测试两个用例：有头像、没头像）。
- 搬运 `wee-count/src/utils/__tests__/crop.test.ts`（整份，`computeCrop` 纯函数，不依赖 DOM）。

---

## 10. 后端改动

只有一处，在社区列表：

| 文件 | 改动 |
|---|---|
| `backend/internal/model/community.go` | `CommunityRecipe` 加 `AuthorAvatarURL *string`（json `author_avatar_url`） |
| `backend/internal/service/community.go` | `ListPublicRecipes` 的 SELECT 加一列 `u.avatar_url`，`rows.Scan` 加一项（`$1` 之后的占位符顺序不变） |
| `backend/internal/service/community_test.go` | 断言带出作者头像；再补一条「作者没设头像 → null」 |
| `backend/cmd/server/router_e2e_test.go` | **无改动**：e2e 对列表只有一条「未带 token 必须 401」，不覆盖列表的 JSON 形状，所以没有断言可以加 |
| `docs/开发者-同步与社区.md` | 「公开菜谱列表」的响应样例加 `author_avatar_url` |

`users` 表、`PUT /api/v1/auth/profile`、`GET /api/v1/me`、`GET /api/v1/users/{id}`、`GET /api/v1/auth/login|register|refresh` **全部不动**——它们本来就返回 `avatar_url`。

---

## 11. 验证

**命令**
```bash
npm run test          # 前端单测
npm run build         # vue-tsc 类型检查 + 构建
cd backend && go test ./... && go vet ./...
```

**真机（Android）**
1. 「我的」页 → 换头像（相册选一张非方图，拖动缩放裁剪）→ 改昵称 → 保存 → 用户卡立刻变。
2. 杀掉 App、**断网**重开 →「我的」页显示离线态：头像和昵称还在，副标题是「离线使用中」（§6.2 / §7.4）；连上网络后自动恢复成「已登录」。
3. 换 emoji 头像 → 再点同一个 emoji 取消 → 保存 →「我的」页、社区列表、用户页都退回昵称首字（验证空串真的落库了，而不是发 `null` 被服务端忽略）。
4. 社区列表滚动 → 每张卡片能看到作者头像；点进用户页头像一致（这是本轮的目标本身）。
5. 换一个 emoji 头像 → 社区列表与用户页跟着变（`avatar_url` 三条分支的第二种形态）。
6. 未登录状态打开「我的」页 → 用户卡显示「未登录」，点击进登录页；手输 `/me/profile` 被弹回登录页。
7. **退登后再打开「我的」页 → 用户卡是「未登录」，不是「离线使用中」**（验证 §7.5 清设置那一步真的生效）。
8. 编辑菜谱 → 加食材 → 搜索框输入一个不存在的名字 → 出现「+ 创建「xxx」」→ 点它 → **直接进第二步（数量）**。
9. 同一个 sheet → 右上角「管理」→ 行尾显示用量、有菜谱在用的垃圾桶是灰的、点不动；没用的能删（弹确认）。
10. 管理模式点铅笔 → 重命名 → 保存 → 列表里的名字变了，且**没退出管理模式**。
11. 多选（标签 sheet）→ 创建两个新标签 → 两个都勾着 → 点确定 → 菜谱拿到两个标签。
12. **软键盘**：在各个 sheet 的搜索框打字，键盘弹起时「确定」不被遮挡（`useKeyboardInset` 的现有行为不能被这次改造破坏）。

---

## 12. 留给下一轮

- 头像改走文件通道（当社区列表响应体积真的成为问题时，§4.1 的迁移路径）。
- 社区列表头像是内联 base64，**没有缓存也没有懒加载**；同一作者在列表里出现 N 次就传 N 遍。要做去重得先有列表渲染之外的缓存层。
- 菜谱详情页显示作者头像 + 点击作者进用户页。
- 关注流 / 收藏列表里的作者头像。
- 团队成员列表的头像（服务端数据已经在返回了）。
- 资料编辑页的「修改密码」（服务端 `PUT /api/v1/auth/password` 有没有？本轮没查）。
- 深色模式。
