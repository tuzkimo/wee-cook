# 用户资料与头像 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「我的」页显示当前用户、让昵称和头像可改、让社区列表和用户页显示作者头像。

**Architecture:** 头像以 data URL 字符串存在 `users.avatar_url`（图片不进 `images/` 目录、不参与文件同步），客户端裁剪到 192px 后直接随 `PUT /api/v1/auth/profile` 提交。头像的渲染规则收在一个无状态组件 `UserAvatar.vue` 里，四个使用点共用。`auth` store 新增 `avatarUrl` 作为「我是谁」的唯一真相源，并让它在退登后被清掉——这样「settings 里有存档昵称」就等价于「上次会话没退登」，离线冷启动才能显示成「离线使用中」而不是「未登录」。后端只改一处：社区列表 SQL 多取一列 `u.avatar_url`。

**Tech Stack:** Vue 3 + TypeScript（strict，禁 `any`）+ Pinia + Tailwind 4 + vue-router；vitest + happy-dom；Go 1.x + pgx + chi（`backend/`）。

**Spec:** `docs/superpowers/specs/2026-10-16-profile-avatar-refsheet-design.md` —— 实现前通读。本计划只写「怎么做」，不重复「为什么」；`RefSheet` 的改造在另一份计划 `2026-10-16-refsheet-redesign.md` 里，两份没有共享文件，可任选先做。

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**（测试里也不许）。
- **本轮零数据库 schema 变更**：不往本地 `recipes` 表加 `owner_avatar_url`，社区列表的头像直接来自 REST 响应（`CommunityRecipe` 是接口视图，不落库）。菜谱详情页的作者头像本轮不做（spec §2 非目标）。
- 头像存法：`users.avatar_url` 里放 `data:image/jpeg;base64,...` 或单个 emoji/字符；没设过是 `NULL` 或空串。**清头像发空串 `""`，绝不发 `null`**（后端 `AvatarURL *string` + `omitempty`，发 `null` 那段 UPDATE 不执行）。
- 裁剪输出 **192px**、JPEG 质量 **0.85**（`V = 280` 是视窗边长，输出 192）。
- 头像**不进 `images/` 目录、不参与 `syncFiles` 的上传/下载**。`services/imageStore.ts` 一个字节不改。
- 不可删改已有测试（两份计划各自列出的人工确认例外除外；本计划的例外见 Task 6）。
- commit 信息用中文，符合中文开发习惯。
- 每个任务结束都要能过 `npm run test` 与 `npm run build`；改了 Go 的任务额外过 `cd backend && go test ./... && go vet ./...`。
- 开发文档进 `docs/`；README 只写普通用户看的内容。

## Review Focus

spec 没有明说、但真实输入一定会撞上、撞上就没法解释的五件事。每条都在下文指定的任务里有对应断言：

1. **服务端的 `avatar_url` 可能是空串**（清头像走的就是空串），渲染必须与 `NULL` 走同一条降级——否则界面出现空圆圈。→ Task 3。
2. **昵称以 emoji 开头**（`🐱阿花`）：`charAt(0)` 会切出半个 UTF-16 代理对，显示成乱码方块；必须按码点取首字。→ Task 3。
3. **昵称粘贴超长**（60 个汉字）：输入框要截到 50 再发，否则服务端 400，用户只看到一句「保存失败」却不知道是字数。→ Task 5。
4. **断网冷启动**（存档有昵称、refresh token 在、refresh 抛网络错）：昵称头像必须还在、`mode` 是 guest、副标题是「离线使用中」。→ Task 2 + Task 6。
5. **`avatar_url` 是坏掉的 data URL**（`data:image/jpeg;base64,!!!`）：必须交给 `<img>` 出破图，**不能静默换成昵称首字**——静默替换会让人以为头像没保存上。→ Task 3。

---

## 跨任务的既定接口

后面每个任务只看得到自己那一份，所以共用的名字与形状写死在这里。**一律照抄，不要改名。**

```ts
// src/services/api.ts —— 只收紧类型，不动请求
export interface UpdateProfileRequest { nickname?: string; avatar_url?: string }   // 删掉 `| null`
export async function updateProfile(data: UpdateProfileRequest): Promise<User>    // 已有

// src/stores/auth.ts —— 新增暴露（其余照旧）
avatarUrl: Ref<string | null>                                  // 「我的头像」的唯一真相源
updateProfile(input: { nickname: string; avatar_url: string }): Promise<void>

// src/components/UserAvatar.vue
//   props: { url: string | null; name: string; textClass?: string }   // textClass 默认 "text-sm"
//   尺寸/圆角由调用方 class 决定（落到外层 div），组件不接 size prop

// src/services/community.ts
export interface CommunityRecipe {
  id: string; name: string; cover_path: string | null;
  author_id: string; author_nickname: string; author_avatar_url: string | null;   // 新增
  updated_at: string; favorited: boolean;
}

// backend/internal/model/community.go
//   CommunityRecipe 加 AuthorAvatarURL *string   // json:"author_avatar_url"

// settings.json 新增键
//   server_avatar_url : string   // 与 server_nickname 同源同命，退登时一起删
```

---

### Task 1: 后端社区列表带作者头像

**Files:**
- Modify: `backend/internal/model/community.go`
- Modify: `backend/internal/service/community.go`（`ListPublicRecipes` 的 SELECT 与 scan）
- Modify: `backend/internal/service/community_test.go`
- Modify: `docs/开发者-同步与社区.md`（§7 接口表的社区列表一行）

**Interfaces:**
- Produces: `model.CommunityRecipe.AuthorAvatarURL *string`，json 名 `author_avatar_url`；没设头像时是 `nil`（客户端拿到 JSON `null`）。

- [ ] **Step 1: 写失败测试**

在 `backend/internal/service/community_test.go` 末尾追加（`seedUser` / `seedCommunityRecipe` / `findCommunityRecipe` / `filesTestDB` 都是本文件已有的 helper）：

```go
// 列表要带作者头像：客户端靠它认出「哪几道菜是同一个人发的」。
func TestListReturnsAuthorAvatar(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	withAvatar := seedUser(t, pool)
	noAvatar := seedUser(t, pool)
	if _, err := pool.Exec(ctx,
		`UPDATE users SET avatar_url = 'data:image/jpeg;base64,AAA' WHERE id = $1`, withAvatar); err != nil {
		t.Fatalf("设头像失败: %v", err)
	}
	now := time.Now().UTC()
	seedCommunityRecipe(t, pool, withAvatar, "有头像的菜", 1, now, false)
	seedCommunityRecipe(t, pool, noAvatar, "没头像的菜", 1, now.Add(-time.Minute), false)

	got, _, err := community.ListPublicRecipes(ctx, seedUser(t, pool), model.CommunityListOptions{})
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}

	with := findCommunityRecipeByName(got, "有头像的菜")
	if with == nil || with.AuthorAvatarURL == nil || *with.AuthorAvatarURL != "data:image/jpeg;base64,AAA" {
		t.Errorf("有头像的作者应带出 data URL，实得 %+v", with)
	}
	without := findCommunityRecipeByName(got, "没头像的菜")
	if without == nil {
		t.Fatalf("列表应包含「没头像的菜」")
	}
	if without.AuthorAvatarURL != nil {
		t.Errorf("没设头像的作者应为 nil，实得 %v", *without.AuthorAvatarURL)
	}
}
```

同时在文件里补一个按名字查找的 helper（`findCommunityRecipe` 只按 id 找）：

```go
func findCommunityRecipeByName(recipes []model.CommunityRecipe, name string) *model.CommunityRecipe {
	for i := range recipes {
		if recipes[i].Name == name {
			return &recipes[i]
		}
	}
	return nil
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestListReturnsAuthorAvatar -v`
Expected: 编译失败 `unknown field AuthorAvatarURL`（这就是「先看见它红」）。

- [ ] **Step 3: 实现**

`model/community.go`：`CommunityRecipe` 在 `AuthorNickname` 之后插入一行

```go
	AuthorAvatarURL *string `json:"author_avatar_url"`
```

`service/community.go` 的 `ListPublicRecipes`：SELECT 列里 `u.nickname` 之后加 `u.avatar_url`，`rows.Scan(...)` 在 `&it.AuthorNickname` 之后加 `&it.AuthorAvatarURL`。**列顺序与 Scan 顺序必须一一对应**，`LEFT JOIN` 不变（作者被删也不该让整行消失）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./... && go vet ./...`
Expected: 全绿（含既有的 `TestListExcludesOwnPublicRecipes` 等）。

- [ ] **Step 5: 更新接口文档**

`docs/开发者-同步与社区.md` §7 接口表里 `GET /api/v1/community/recipes` 那一行的说明，把每项字段补成：`每项含 author_nickname / author_avatar_url / favorited`。

- [ ] **Step 6: Commit**

```bash
git add backend/internal/model/community.go backend/internal/service/community.go backend/internal/service/community_test.go docs/开发者-同步与社区.md
git commit -m "feat(后端): 社区列表带出作者头像，供客户端认出作者"
```

---

### Task 2: auth store 的 avatarUrl 与资料更新

**Files:**
- Modify: `src/services/api.ts:292-303`（`UpdateProfileRequest` 收紧为 `string`）
- Modify: `src/stores/auth.ts`
- Modify: `src/stores/__tests__/auth.test.ts`

**Interfaces:**
- Consumes: `api.updateProfile`（已有）、`settingsFile.deleteSetting`（已有）、`readStringSetting` / `writeSetting` / `LOG_SAVE`（本文件已有）。
- Produces: `auth.avatarUrl`（`string | null`）、`auth.updateProfile(input: { nickname: string; avatar_url: string }): Promise<void>`；settings 键 `server_avatar_url`。

- [ ] **Step 1: 写失败测试**

`src/stores/__tests__/auth.test.ts` 追加四条（`user()` helper 已带 `avatar_url: null`，用 `overrides` 传头像；`storedSetting()` 直接读 localStorage，`: undefined` 表示已删）：

```ts
it("登录成功后 avatarUrl 跟着会话走", async () => {
  stubFetch(() => res(200, authBody(user("u1", { avatar_url: "🐱" }), "access-1", "refresh-1")));
  const store = useAuthStore();

  await store.login("https://srv", "alice", "pw");

  expect(store.avatarUrl).toBe("🐱");
});

it("updateProfile 更新内存与 settings（含 server_avatar_url）", async () => {
  stubFetch((url) =>
    url.includes("/auth/profile")
      ? res(200, user("u1", { username: "alice", nickname: "阿丽", avatar_url: "data:image/jpeg;base64,AAA" }))
      : res(200, authBody(user("u1", { username: "alice" }), "access-1", "refresh-1")),
  );
  const store = useAuthStore();
  await store.login("https://srv", "alice", "pw");

  await store.updateProfile({ nickname: "阿丽", avatar_url: "data:image/jpeg;base64,AAA" });

  expect(store.nickname).toBe("阿丽");
  expect(store.avatarUrl).toBe("data:image/jpeg;base64,AAA");
  expect(storedSetting("server_nickname")).toBe("阿丽");
  expect(storedSetting("server_avatar_url")).toBe("data:image/jpeg;base64,AAA");
});

it("清头像（空串）在 store 里就是「没设过」", async () => {
  stubFetch((url) =>
    url.includes("/auth/profile")
      ? res(200, user("u1", { username: "alice", nickname: "阿丽", avatar_url: "" }))
      : res(200, authBody(user("u1", { username: "alice", avatar_url: "🐱" }), "access-1", "refresh-1")),
  );
  const store = useAuthStore();
  await store.login("https://srv", "alice", "pw");

  await store.updateProfile({ nickname: "阿丽", avatar_url: "" });

  expect(store.avatarUrl).toBeNull();
});

it("断网冷启动：昵称与头像从存档读回，且不切在线", async () => {
  seedSetting("server_url", "https://srv");
  seedSetting("server_user_id", "u1");
  seedSetting("server_nickname", "阿丽");
  seedSetting("server_avatar_url", "🐱");
  await writeRefreshToken("u1", "refresh-1");
  stubFetch(() => Promise.reject(new Error("network down")));

  const store = useAuthStore();
  await store.restoreSession();

  expect(store.isOnline).toBe(false);
  expect(store.nickname).toBe("阿丽");
  expect(store.avatarUrl).toBe("🐱");
});

it("退登清掉存档昵称与头像，保留地址与用户名", async () => {
  stubFetch((url) =>
    url.includes("/auth/profile")
      ? res(200, user("u1", { username: "alice", nickname: "阿丽" }))
      : res(200, authBody(user("u1", { username: "alice", nickname: "阿丽", avatar_url: "🐱" }), "access-1", "refresh-1")),
  );
  const store = useAuthStore();
  await store.login("https://srv", "alice", "pw");
  expect(storedSetting("server_avatar_url")).toBe("🐱");

  await store.logout();

  expect(store.nickname).toBeNull();
  expect(store.avatarUrl).toBeNull();
  expect(storedSetting("server_nickname")).toBeUndefined();
  expect(storedSetting("server_avatar_url")).toBeUndefined();
  expect(storedSetting("server_url")).toBe("https://srv");
  expect(storedSetting("server_username")).toBe("alice");
});
```

若该文件没有 `writeRefreshToken` / `seedSetting` / `stubFetch` 的 import，按文件顶部既有用例的用法补 import，别自己新写 helper。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/auth.test.ts`
Expected: FAIL — `store.avatarUrl` 是 `undefined`、`store.updateProfile` 不是函数。

- [ ] **Step 3: 实现**

`src/services/api.ts`：`UpdateProfileRequest.avatar_url` 从 `string | null` 改成 `string`（请求体照样 `JSON.stringify`，不传键就是不更新）。

`src/stores/auth.ts`：
- 常量区加 `const KEY_AVATAR = "server_avatar_url";`
- ref 区加 `const avatarUrl = ref<string | null>(null);`
- `adoptSession` 里加 `avatarUrl.value = user.avatar_url;`
- `persistSession` 里加 `await writeSetting(KEY_AVATAR, user.avatar_url, LOG_SAVE);`（传 `undefined` 时 JSON 序列化成 `null` 也读回 `null`，行为与「没设过」一致）
- `restoreSessionOnce`：`Promise.all` 里多读一个 `readStringSetting(KEY_AVATAR)`，紧挨现有 `if (savedNickname) nickname.value = savedNickname;` 写 `if (savedAvatarUrl) avatarUrl.value = savedAvatarUrl;`（位置必须在读 token 与 `goGuest()` 之前，否则离线冷启动读不到）
- 恢复成功分支里加 `avatarUrl.value = resp.user.avatar_url;`
- 新增 `async function updateProfile(input: { nickname: string; avatar_url: string }): Promise<void>`：调 `api.updateProfile(input)` → `serverUser.value = updated` → `nickname.value = updated.nickname` → `avatarUrl.value = updated.avatar_url` → `await persistSession(updated, baseUrl.value ?? "")`
- `logout()` 里，在 `goGuest()` 之后加 `nickname.value = null; avatarUrl.value = null;` 与 `await deleteSetting(KEY_NICKNAME, LOG_SAVE); await deleteSetting(KEY_AVATAR, LOG_SAVE);`（**不要**动 `KEY_URL` / `KEY_USER_ID` / `KEY_USERNAME`）
- 返回对象里加 `avatarUrl`、`updateProfile`

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/auth.test.ts && npm run test`
Expected: 全绿。既有的「logout 清掉凭据但保留 server_url」用例只断言 `server_url` 与 `server_username`，**不要改它**。

- [ ] **Step 5: Commit**

```bash
git add src/services/api.ts src/stores/auth.ts src/stores/__tests__/auth.test.ts
git commit -m "feat(账号): auth 增加头像唯一真相源与资料更新，退登清掉存档昵称头像"
```

---

### Task 3: UserAvatar 组件

**Files:**
- Create: `src/components/UserAvatar.vue`
- Test: `src/components/__tests__/UserAvatar.test.ts`

**Interfaces:**
- Produces: `UserAvatar`，props `{ url: string | null; name: string; textClass?: string }`（`textClass` 默认 `"text-sm"`）。外层的 `class` 由调用方给（宽高/圆角），组件不接 `size` prop。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import UserAvatar from "@/components/UserAvatar.vue";

describe("UserAvatar", () => {
  it("data URL → <img>", () => {
    const wrapper = mount(UserAvatar, {
      props: { url: "data:image/jpeg;base64,AAA", name: "阿花" },
    });

    expect(wrapper.get("img").attributes("src")).toBe("data:image/jpeg;base64,AAA");
    expect(wrapper.text()).toBe("");
  });

  it("http 地址 → <img>", () => {
    const wrapper = mount(UserAvatar, { props: { url: "https://e.com/a.png", name: "阿花" } });
    expect(wrapper.get("img").attributes("src")).toBe("https://e.com/a.png");
  });

  it("空串与 null 走同一条降级：昵称首字", () => {
    for (const url of [null, ""]) {
      const wrapper = mount(UserAvatar, { props: { url, name: "阿花" } });
      expect(wrapper.find("img").exists(), String(url)).toBe(false);
      expect(wrapper.text()).toBe("阿");
    }
  });

  it("单个 emoji 当文本渲染", () => {
    const wrapper = mount(UserAvatar, { props: { url: "🐱", name: "阿花" } });
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.text()).toBe("🐱");
  });

  it("昵称以 emoji 开头时首字是整个 emoji，不是半个代理对", () => {
    const wrapper = mount(UserAvatar, { props: { url: null, name: "🐱阿花" } });
    expect(wrapper.text()).toBe("🐱");
  });

  it("坏掉的 data URL 交给 <img>，不静默换成首字", () => {
    const wrapper = mount(UserAvatar, { props: { url: "data:image/jpeg;base64,!!!", name: "阿花" } });
    expect(wrapper.find("img").exists()).toBe(true);
    expect(wrapper.text()).toBe("");
  });

  it("昵称也为空 → 问号", () => {
    const wrapper = mount(UserAvatar, { props: { url: null, name: "" } });
    expect(wrapper.text()).toBe("?");
  });

  it("尺寸与圆角由调用方 class 决定，文本字号由 textClass 决定", () => {
    const wrapper = mount(UserAvatar, {
      props: { url: "🐱", name: "阿花", textClass: "text-2xl" },
      attrs: { class: "h-12 w-12 rounded-full" },
    });

    expect(wrapper.classes()).toContain("h-12");
    expect(wrapper.classes()).toContain("rounded-full");
    expect(wrapper.get("span").classes()).toContain("text-2xl");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/UserAvatar.test.ts`
Expected: FAIL — `Failed to resolve import "@/components/UserAvatar.vue"`。

- [ ] **Step 3: 实现**

`src/components/UserAvatar.vue`，`<script setup lang="ts">` 里：

```ts
const props = withDefaults(defineProps<{ url: string | null; name: string; textClass?: string }>(), {
  textClass: "text-sm",
});
const isImage = computed(() => isImageUrl(props.url));          // data: / http / / 开头
const text = computed(() => (props.url ? props.url : firstChar(props.name)));
// ↑ 用真值判断，不用 `??`：空串不是 null，`??` 会让空串原样渲染成一片空白
```

`firstChar` 用 `Array.from(name.trim())[0] ?? "?"`（**不用 `charAt(0)`**：它会把 emoji 切成半个代理对，出乱码方块）。

模板固定这个分支顺序：`<img v-if="isImage" class="h-full w-full object-cover" :src="url!">` → `<span v-else :class="['flex h-full w-full items-center justify-center', textClass]">{{ text }}</span>`。外层是 `<div class="flex items-center justify-center overflow-hidden bg-gray-100 text-text-secondary">`，`class` 由调用方通过默认属性继承落到它上面。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/UserAvatar.test.ts`
Expected: 8 passed。

- [ ] **Step 5: Commit**

```bash
git add src/components/UserAvatar.vue src/components/__tests__/UserAvatar.test.ts
git commit -m "feat(组件): 新增 UserAvatar，统一头像三分支渲染"
```

---

### Task 4: 移植头像裁剪

**Files:**
- Create: `src/utils/crop.ts`（从 `D:\projects\my\wee-count\src\utils\crop.ts` 整份复制）
- Create: `src/utils/__tests__/crop.test.ts`（从 `D:\projects\my\wee-count\src\utils\__tests__\crop.test.ts` 整份复制）
- Create: `src/components/AvatarCropper.vue`（从 `D:\projects\my\wee-count\src\components\AvatarCropper.vue` 整份复制，只改一个常量）

**Interfaces:**
- Produces: `computeCrop(input: CropInput): CropOutput`（纯函数，签名照抄）；`AvatarCropper` 组件，props `{ file: File }`，emits `confirm: [dataUrl: string]` / `cancel: []` / `error: []`。

- [ ] **Step 1: 复制并改常量**

三个文件整份复制过来（它们是自包含的：只依赖 vue 与 canvas/FileReader，路径别名 `@/utils/crop` 两仓一致）。唯一改动是 `AvatarCropper.vue` 里：

```ts
// 视窗 280 → 输出 256，两步降采样意图在此显式
const OUTPUT_SIZE = 256;
```
→ 把 `256` 改成 `192`（spec §4.1：社区列表每行都要带这份 base64，192 是列表画质与体积的平衡点），注释里的 `256` 一并改成 `192`。`V = 280`、`JPEG_QUALITY = 0.85` 不动。

- [ ] **Step 2: 跑测试确认通过**

Run: `npx vitest run src/utils/__tests__/crop.test.ts`
Expected: 全部通过（`computeCrop` 是纯数学，与 DOM 无关）。

- [ ] **Step 3: 确认类型与构建**

Run: `npm run build`
Expected: `vue-tsc` 无错（复制过来的两个文件不许出现 `any`；有就补类型，不要加 `@ts-ignore`）。

- [ ] **Step 4: Commit**

```bash
git add src/utils/crop.ts src/utils/__tests__/crop.test.ts src/components/AvatarCropper.vue
git commit -m "feat(组件): 从 wee-count 移植头像裁剪，输出改为 192px"
```

---

### Task 5: 资料编辑页 /me/profile

**Files:**
- Create: `src/views/ProfilePage.vue`
- Create: `src/views/__tests__/ProfilePage.test.ts`
- Modify: `src/router/index.ts`（加路由）
- Modify: `src/router/__tests__/routes.test.ts`（加断言）

**Interfaces:**
- Consumes: `auth.avatarUrl` / `auth.nickname` / `auth.serverUser` / `auth.isOnline` / `auth.updateProfile`（Task 2）、`UserAvatar`（Task 3）、`AvatarCropper`（Task 4）、`AppHeader`。
- Produces: 路由 `/me/profile`（name `me-profile`，`meta.hideTab: true`）；测试钩子 `me-profile-avatar`（打开选图的按钮）、`me-avatar-input`（隐藏的 file input）、`me-nickname`、`me-save`、`me-error`。

- [ ] **Step 1: 写失败测试**

新建 `src/views/__tests__/ProfilePage.test.ts`。**必须 mock 掉 `AvatarCropper`**（happy-dom 解不了真图片，`new Image()` 拿不到 `naturalWidth`）：

```ts
const mocks = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), push: vi.fn() }));
vi.mock("vue-router", () => ({ useRouter: () => ({ replace: mocks.replace, back: mocks.back, push: mocks.push }) }));
vi.mock("@/components/AvatarCropper.vue", () => ({
  default: defineComponent({
    props: { file: { type: Object, required: true } },
    emits: ["confirm", "cancel", "error"],
    template: `<button data-test="fake-cropper" @click="$emit('confirm', 'data:image/jpeg;base64,NEW')">裁剪</button>`,
  }),
}));
```

用真 `auth` store + `fetch` 替身（`setActivePinia(createPinia())` / `localStorage.clear()` / `seedSetting` / `res()` 照 `src/views/__tests__/MePage.test.ts`）。**服务端替身要按路径分流**：`/auth/profile` 回完整 `User`，其余（`/auth/refresh`）回 `AuthResponse`，并**记下 profile 那次请求的 body**：

```ts
function stubProfileFetch(returns: Partial<api.User> = {}): { body: () => unknown } {
  let profileBody: unknown = null;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/auth/profile")) {
      profileBody = JSON.parse(String(init?.body));
      return Promise.resolve(response(200, { id: "u1", username: "alice", nickname: "阿丽", avatar_url: "🐱", created_at: NOW, updated_at: NOW, ...returns }));
    }
    return Promise.resolve(response(200, { user: { id: "u1", username: "alice", nickname: "阿丽", avatar_url: "🐱", created_at: NOW, updated_at: NOW }, access_token: "a", refresh_token: "r" }));
  }));
  return { body: () => profileBody };
}

async function onlinePage(): Promise<VueWrapper> {
  seedSetting("server_url", "https://srv");
  seedSetting("server_user_id", "u1");
  await writeRefreshToken("u1", "refresh-1");
  const wrapper = mount(ProfilePage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** 给隐藏的 file input 塞一个文件（happy-dom 里只能用 defineProperty）。 */
async function pickFile(wrapper: VueWrapper): Promise<void> {
  const input = wrapper.get('[data-test="me-avatar-input"]');
  Object.defineProperty(input.element, "files", {
    value: [new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })],
  });
  await input.trigger("change");
}
```

用例（六条，断言照抄）：

```ts
it("未登录进入 → 弹回登录页", async () => {
  vi.stubGlobal("fetch", vi.fn());
  await onlinePage();

  expect(mocks.replace).toHaveBeenCalledWith("/me/login");
});

it("保存：昵称与裁剪结果一起提交，data URL 进 JSON body", async () => {
  const stub = stubProfileFetch();
  const wrapper = await onlinePage();

  await pickFile(wrapper);
  await wrapper.get('[data-test="fake-cropper"]').trigger("click");
  await wrapper.get('[data-test="me-nickname"]').setValue("阿丽");
  await wrapper.get('[data-test="me-save"]').trigger("click");
  await flushPromises();

  expect(stub.body()).toEqual({ nickname: "阿丽", avatar_url: "data:image/jpeg;base64,NEW" });
  expect(mocks.back).toHaveBeenCalled();
});

it("昵称纯空格 → 不提交并显示错误", async () => {
  const stub = stubProfileFetch();
  const wrapper = await onlinePage();

  await wrapper.get('[data-test="me-nickname"]').setValue("   ");
  await wrapper.get('[data-test="me-save"]').trigger("click");
  await flushPromises();

  expect(stub.body()).toBeNull();
  expect(wrapper.get('[data-test="me-error"]').text()).toBe("昵称不能为空");
});

it("粘贴超长昵称被截到 50 个码点", async () => {
  const stub = stubProfileFetch();
  const wrapper = await onlinePage();

  await wrapper.get('[data-test="me-nickname"]').setValue("汉".repeat(60));
  await wrapper.get('[data-test="me-save"]').trigger("click");
  await flushPromises();

  expect(Array.from((stub.body() as { nickname: string }).nickname).length).toBe(50);
});

it("点已选中的 emoji → 取消选择，保存发空串（不是 null）", async () => {
  const stub = stubProfileFetch();          // 存档头像就是 "🐱"，所以它开屏就是选中态
  const wrapper = await onlinePage();

  await wrapper.get('[data-test="me-emoji-🐱"]').trigger("click");   // 只点一次：取消选中
  await wrapper.get('[data-test="me-save"]').trigger("click");
  await flushPromises();

  expect(stub.body()).toEqual({ nickname: "阿丽", avatar_url: "" });
});

it("没有改动时保存按钮 disabled", async () => {
  stubProfileFetch();
  const wrapper = await onlinePage();

  expect(wrapper.get('[data-test="me-save"]').attributes("disabled")).toBeDefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/ProfilePage.test.ts`
Expected: FAIL — 找不到 `@/views/ProfilePage.vue`。

- [ ] **Step 3: 实现**

`src/views/ProfilePage.vue`，结构照 spec §7：

- `onMounted`：`await auth.restoreSession()`；随后 `if (!auth.isOnline) router.replace("/me/login")`（`restoreSession` 在 store 里会复用同一个在途 Promise，重复调用无副作用）。
- 本地态：`const nickname = ref(auth.nickname ?? "");`、`const selectedAvatar = ref<string | null>(auth.avatarUrl);`
- 头像按钮（`data-test="me-profile-avatar"`）：`<UserAvatar :url="selectedAvatar" :name="nickname || auth.serverUser?.username || ''" text-class="text-2xl" class="pointer-events-none h-24 w-24 rounded-full" />` 外面套一个 `<button>`，右下角相机角标（`Camera` 图标来自 `lucide-vue-next`，全仓已用）。点击 → `fileInput?.click()`。
- 隐藏 input：`data-test="me-avatar-input" type="file" accept="image/*"`（**不加 `capture`**，让安卓自己弹「相机 / 相册」选择），`change` 时把 `files[0]` 存进 `cropperFile`，然后 `input.value = ""`（否则同一张图选第二次不触发 change）。
- `<AvatarCropper v-if="cropperFile" :file="cropperFile" @confirm="..." @cancel="cropperFile = null" @error="..." />`：confirm 只写 `selectedAvatar.value = dataUrl`（**不立即提交**，否则「无改动」判定失效、保存按钮永远灰着），error 关掉裁剪并显示「图片无法读取，请换一张」。
- emoji 行：`AVATAR_EMOJIS` 是 20 个（`["😀","🐱","🐶","🦊","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🐦","🐤","🦄","🐌","🐛","🦋"]`），每个按钮带 `:data-test="\`me-emoji-${emoji}\`"`，点击 `selectedAvatar = selectedAvatar === emoji ? null : emoji`——**再点已选中的那个就是「取消选择」= 无头像**（不是回退到已保存的头像）。
- 昵称输入（`data-test="me-nickname"`）：`maxlength="50"`，**外加一层显式截断** `@input` 时 `nickname = Array.from(nickname).slice(0, 50).join("")`（按码点截，不是因为 `maxlength` 没用，而是粘贴/输入法与部分 webview 能绕过它；服务端 `>50` 直接 400，用户只会看到一句没头没尾的「保存失败」）。
- 只读一行显示 `auth.serverUser?.username ?? ""`（无用户名时整块不渲染）。
- 保存（`data-test="me-save"`）：`disabled = saving || !hasChanges`；`hasChanges` = `nickname.trim() !== (auth.nickname ?? "") || selectedAvatar !== auth.avatarUrl`。
- `save()`：`trim()` 为空 → `error = "昵称不能为空"` 并 return；否则 `await auth.updateProfile({ nickname: trimmed, avatar_url: selectedAvatar.value ?? "" })` → `router.back()`；catch 里 `error = e instanceof Error ? e.message : "保存失败，检查网络后重试"`。

`src/router/index.ts`：在 `/me/login` 那一行后面加

```ts
    { path: "/me/profile", name: "me-profile", component: ProfilePage, meta: { hideTab: true } },
```

并在顶部加 `import ProfilePage from "@/views/ProfilePage.vue";`。

`src/router/__tests__/routes.test.ts` 追加一条：

```ts
  it("/me/profile 隐藏 tab 栏", () => {
    const route = router.getRoutes().find((r) => r.path === "/me/profile");

    expect(route).toBeDefined();
    expect(route?.meta.hideTab).toBe(true);
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/ProfilePage.test.ts src/router && npm run test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/views/ProfilePage.vue src/views/__tests__/ProfilePage.test.ts src/router/index.ts src/router/__tests__/routes.test.ts
git commit -m "feat(我的): 新增资料编辑页，可换头像与改昵称"
```

---

### Task 6: 「我的」页用户卡（四态）

**Files:**
- Modify: `src/views/MePage.vue`
- Modify: `src/views/__tests__/MePage.test.ts`

**Interfaces:**
- Consumes: `auth.avatarUrl` / `auth.nickname` / `auth.serverUser`（Task 2）、`UserAvatar`（Task 3）。
- Produces: 钩子 `me-user-card`、`me-user-name`、`me-user-status`。

**人工确认过的例外**：本任务**不动**现有三条同步态用例与那六个 `data-test` 钩子（`server-row` / `server-state` / `nickname` / `last-sync` / `sync-failed` / `retry` / `logout`），只在它们上方插一块用户卡。新增用例不算改断言。

- [ ] **Step 1: 写失败测试**

`src/views/__tests__/MePage.test.ts` 追加（沿用文件里已有的 `page()` / `seedSetting()` / `writeRefreshToken()` / `response()`）：

```ts
describe("MePage 用户卡", () => {
  it("未配置服务器：显示「未登录」，点击进登录页", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const wrapper = await page();

    expect(wrapper.get('[data-test="me-user-name"]').text()).toBe("未登录");
    await wrapper.get('[data-test="me-user-card"]').trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/me/login");
  });

  it("离线但有存档昵称：显示存档昵称与头像，副标题写明离线", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    seedSetting("server_nickname", "阿丽");
    seedSetting("server_avatar_url", "🐱");
    await writeRefreshToken("u1", "refresh-1");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));

    const wrapper = await page();

    expect(wrapper.get('[data-test="me-user-name"]').text()).toBe("阿丽");
    expect(wrapper.get('[data-test="me-user-card"]').text()).toContain("🐱");
    expect(wrapper.get('[data-test="me-user-status"]').text()).toBe("离线使用中，连上网络后自动恢复");
  });

  it("已登录：显示昵称，点击进资料页", async () => {
    // 已登录的 seed 照本文件第三条用例
    const wrapper = await page();

    expect(wrapper.get('[data-test="me-user-name"]').text()).toBe("阿丽");
    await wrapper.get('[data-test="me-user-card"]').trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/me/profile");
  });

  it("退登后用户卡回到「未登录」，不再显示存档昵称", async () => {
    // 已登录 + 点 me-user-card 之外的方式触发退登：seed 之后手动 await useAuthStore().logout() 再挂载
    expect(wrapper.get('[data-test="me-user-name"]').text()).toBe("未登录");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/MePage.test.ts`
Expected: FAIL — 找不到 `[data-test="me-user-name"]`。

- [ ] **Step 3: 实现**

`src/views/MePage.vue` 脚本区加三个 computed（照 spec §6.2 的四种状态；`displayName` 已有，保留）：

```ts
// 离线但存档里有账号档案：会话是真的，只是连不上（退登过的账号不会走到这里，见 spec §7.5）
const offlineWithProfile = computed(() => !auth.isOnline && auth.nickname !== null);
const cardName = computed(() =>
  auth.isOnline || offlineWithProfile.value ? displayName.value : "未登录",
);
const cardStatus = computed(() => {
  if (auth.isOnline) return "已开启多设备同步";
  if (offlineWithProfile.value) return "离线使用中，连上网络后自动恢复";
  return "点这里登录或注册";
});
function openCard(): void {
  void router.push(auth.isOnline ? "/me/profile" : "/me/login");
}
```

模板：把现有那个 `<section>` 上面插入用户卡（满宽、`bg-surface`，整块是一个 `<button data-test="me-user-card">`）：

- 左：`<UserAvatar :url="auth.avatarUrl" :name="displayName" class="h-12 w-12 shrink-0 rounded-full" text-class="text-lg" />`
- 中：`<p data-test="me-user-name">{{ cardName }}</p>` + `<p data-test="me-user-status">{{ cardStatus }}</p>`
- 右：`<ChevronRight :size="16" class="text-text-secondary" />`（`lucide-vue-next` 本文件已 import）

**不搬** wee-count 的「我的账本」「团队管理」「安全」「备份与恢复」四组（本仓没有对应功能）。现有同步卡一行不改。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/MePage.test.ts src/views/__tests__/placeholderPages.test.ts && npm run test`
Expected: 全绿（`placeholderPages.test.ts` 裸挂载 MePage，靠 `auth.ts` 里那个显式 pinia 兜底，不要删那个兜底）。

- [ ] **Step 5: Commit**

```bash
git add src/views/MePage.vue src/views/__tests__/MePage.test.ts
git commit -m "feat(我的): 顶部加用户卡，含离线态与资料页入口"
```

---

### Task 7: 社区列表与用户页显示作者头像

**Files:**
- Modify: `src/services/community.ts`（`CommunityRecipe` 加字段）
- Modify: `src/components/CommunityFeed.vue`
- Modify: `src/components/__tests__/CommunityFeed.test.ts`
- Modify: `src/views/UserPage.vue`
- Modify: `src/views/__tests__/UserPage.test.ts`

**Interfaces:**
- Consumes: 后端 `author_avatar_url`（Task 1）、`UserAvatar`（Task 3）。
- Produces: 卡片钩子 `community-author-avatar`；用户页资料区钩子 `user-avatar`。

- [ ] **Step 1: 写失败测试**

`CommunityFeed.test.ts`：给 `recipe()` fixture 补 `author_avatar_url: null`（**补 fixture 字段，不改断言**），再追加两条：

```ts
it("卡片显示作者头像", () => {
  mocks.community!.items = [recipe("1", { author_avatar_url: "🐱" })];
  const wrapper = mountFeed();

  expect(wrapper.get('[data-test="community-author-avatar"]').text()).toBe("🐱");
});

it("作者没设头像 → 退回作者昵称首字", () => {
  mocks.community!.items = [recipe("1", { author_avatar_url: null, author_nickname: "老王" })];
  const wrapper = mountFeed();

  expect(wrapper.get('[data-test="community-author-avatar"]').text()).toBe("老");
});
```

`UserPage.test.ts`：`profile()` fixture 已带 `avatar_url: null`，追加一条：

```ts
it("资料区显示头像", async () => {
  mocks.profile.mockResolvedValue(profile({ avatar_url: "🐱" }));
  // 挂载 + flushPromises 的写法照本文件既有用例
  expect(wrapper.get('[data-test="user-avatar"]').text()).toBe("🐱");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/CommunityFeed.test.ts src/views/__tests__/UserPage.test.ts`
Expected: FAIL — 找不到 `community-author-avatar` / `user-avatar`。`CommunityRecipe` 类型缺字段时 `npm run build` 也会报。

- [ ] **Step 3: 实现**

`src/services/community.ts`：`CommunityRecipe` 在 `author_nickname` 之后加 `author_avatar_url: string | null;`。

`src/components/CommunityFeed.vue`：卡片里作者那行从「只有昵称」改成「头像 + 昵称」——把现有的

```html
            <p data-test="community-author" class="text-xs text-text-secondary">
              {{ item.author_nickname }}
            </p>
```
换成 `<div class="mt-0.5 flex items-center gap-1.5">` 包住 `<UserAvatar data-test="community-author-avatar" :url="item.author_avatar_url" :name="item.author_nickname" class="h-4 w-4 shrink-0 rounded-full" text-class="text-[9px]" />` 和原来的 `<p data-test="community-author">`（**钩子与文案都不动**，封面兜底 `item.name.charAt(0)` 也不动——那是菜名不是人名，本轮不管）。

`src/views/UserPage.vue`：资料区（现用 `AppHeader :title="profile?.nickname"`）在页面顶部资料块里加 `<UserAvatar data-test="user-avatar" :url="profile?.avatar_url ?? null" :name="profile?.nickname ?? ''" class="h-16 w-16 shrink-0 rounded-full" text-class="text-2xl" />`，位置放在昵称/关注按钮那一行之前。没有资料（`profile === null`）时整块不渲染，与现有逻辑一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/CommunityFeed.test.ts src/views/__tests__/UserPage.test.ts && npm run test && npm run build`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/services/community.ts src/components/CommunityFeed.vue src/components/__tests__/CommunityFeed.test.ts src/views/UserPage.vue src/views/__tests__/UserPage.test.ts
git commit -m "feat(社区): 列表卡片与用户页显示作者头像"
```

---

## 收尾验证（全部任务完成后）

```bash
npm run test
npm run build
cd backend && go test ./... && go vet ./...
```

真机（Android）走 spec §11 的 1–7 条：换头像裁剪 → 断网冷启动看离线态 → 社区列表与用户页头像 → 换 emoji → 取消 emoji 后头像真的消失（这条验证的是空串真的落库）→ 未登录点用户卡进登录页 → 退登后用户卡回「未登录」。
