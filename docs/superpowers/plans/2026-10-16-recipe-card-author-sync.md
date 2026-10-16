# 菜谱卡片统一与作者信息 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把三种来源的菜谱列表卡统一成三行（标题 / 分类与标签 / 作者头像与昵称），给详情页加作者卡片，并让「我的」页的同步状态可点触发一次增量同步。

**Architecture:** 抽一个无状态的 `RecipeCard.vue`（三行 + `testPrefix` 产出两套既有 `data-test` 钩子），`RecipeList.vue` 与 `CommunityFeed.vue` 共用它；作者信息按来源走三条近路（我的用内存 `auth.*`、收藏用本地 `owner_nickname` / 新增的 `owner_avatar_url`、社区用 REST 响应）。后端只加派生的展示列（`owner_avatar_url` 走既有的 `recipeSelectColumns`，社区列表加 `category_name` / `tags`），服务端零 schema 变更。手动同步在 `services/sync.ts` 加一个「立刻跑一次」的薄入口与在途标志。

**Tech Stack:** Vue 3 + TypeScript（strict，禁 `any`）+ Pinia + Tailwind 4 + vue-router；vitest + happy-dom；Go 1.x + pgx + chi（`backend/`）。

**Spec:** `docs/superpowers/specs/2026-10-16-recipe-card-author-sync-design.md` —— 实现前通读。本计划只写「怎么做」，不重复「为什么」。

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**（测试里也不许，不许 `@ts-ignore`）。
- **服务端零 schema 变更**：`owner_avatar_url` / `category_name` / `tags` 全是 SELECT 派生的展示列，不写库。推送方向带上 `owner_avatar_url` 是无害的（服务端 `INSERT INTO recipes` 只写真实列、`owner_id` 取 token，见 `sync.go:183-187`）。
- 本地 `recipes` 加一列 `owner_avatar_url TEXT`，走既有的 `migrateTables` 模式（`PRAGMA table_info` → `ALTER TABLE ADD COLUMN`）。
- 头像尺寸照 spec §5.3（新表）：列表卡第三行 **20px**（`h-5 w-5` + `text-[10px]`），详情页作者卡 64px，「我的」页用户卡 48px，资料页预览 96px，用户页 64px。**不要**把上一轮的 32px 带回来。
- **`data-test` 钩子一律用 `testPrefix` 拼**，两套既有钩子逐字保留（`recipe-*` / `community-*`），不改任何既有断言。点击处理留在卡片根 `<button>` 上。
- 「作者是谁」的判定只写一处（`RecipeList.vue` 内的 `authorOf()`）：`owner_id` 为空或等于 `auth.serverUserId` → 用 `auth.nickname` / `auth.avatarUrl`；否则用本地 `owner_nickname` / `owner_avatar_url`。**作者的昵称与头像绝不落库到自己的菜谱行**。
- 手动同步 = **增量**同步的立刻触发，不是 `triggerFullPushAndSync`（那是认领存量用的）；`enqueueSync` 的签名与语义不动。
- 不可删改已有测试（本计划列出的人工确认例外除外：MePage 已登录态的断言换钩子、后端 fixture 补一列、`CommunityFeed.test.ts` / `RecipeList.test.ts` 的卡片结构断言）。
- 不重构无关代码，不改未被明确要求的文件。四个 `data-test` 钩子（`server-row` / `server-state` / `nickname` / `last-sync` / `logout`）保留；**`retry` 与 `sync-failed` 退休**（无任何用例引用它们，已 grep 核实）。
- commit 信息用中文，符合中文开发习惯。
- 每个任务结束都要能过 `npm run test` 与 `npm run build`；改了 Go 的任务额外过 `cd backend && go test ./... && go vet ./...`。
- 开发文档进 `docs/`（`docs/开发者-同步与社区.md`）。

## Review Focus

spec 没明说、但真实输入一定会撞上、撞上就没法解释的六件事。每条都在下文指定的任务里有对应断言：

1. **升级安装（不是全新安装）的存量菜谱**：落库是 LWW + 游标增量，本地已有行的 `updated_at` 不旧于远端 → 新加的 `owner_avatar_url` 永远是 NULL，老设备上第三个 tab 与详情页永远没头像。→ Task 3。
2. **旧服务端不发 `owner_avatar_url` 这个键**（自托管手动升级/回滚是常规场景）：不能把本地已经拿到的好头像抹成 NULL，也不能因为键缺失就崩。→ Task 3。
3. **社区数据里分类是空的**（`seedCommunityRecipe` 用的就是 `category_id = ''`，真实库里分类被软删也一样）：第二行只能画标签，不能画一个空 chip，也不能整行塌掉。→ Task 2 + Task 5。
4. **未登录 / 未认领的本机菜谱**：第三行整行不渲染，不能出现空圆圈或一个编出来的「我」。→ Task 6。
5. **连点三次同步卡**：不许出现两个并发 `/sync`；在途时整块 `disabled`。→ Task 8。
6. **作者就是自己**（详情接口连自己的公开菜谱也能查）：不出现「关注自己」的按钮。→ Task 7。

---

## 跨任务的既定接口

后面每个任务只看得到自己那一份，所以共用的名字与形状写死在这里。**一律照抄，不要改名。**

```ts
// src/types/index.ts
export interface Recipe {
  // ……现有字段不动，新增一行：
  owner_avatar_url: string | null;   // 作者头像的本地副本（别人发的菜谱才有；本机自建/未认领为 NULL）
}

// src/services/community.ts
export interface CommunityRecipe {
  id: string; name: string; cover_path: string | null;
  author_id: string; author_nickname: string; author_avatar_url: string | null;
  category_name: string | null;   // 新增
  tags: string[];                 // 新增（空数组，不是 null）
  updated_at: string; favorited: boolean;
}

// src/components/RecipeCard.vue
//   props: { name, coverSrc, category, tags, authorName, authorAvatarUrl, testPrefix }
//   testPrefix: "recipe" | "community" —— 钩子一律拼成 `${testPrefix}-card` / -name / -cover
//               / -cover-fallback / -category / -tag / -author / -author-avatar

// src/services/sync.ts —— 新增暴露
export const syncInFlight: Ref<boolean>;       // 有 /sync 在途
export function requestSyncNow(): void;        // 立刻跑一次增量同步（不等 3s 防抖）；不返回 Promise

// backend/internal/model/recipe.go
//   Recipe 加 OwnerAvatarURL *string   // json:"owner_avatar_url"

// backend/internal/model/community.go
//   CommunityRecipe 加 CategoryName *string  // json:"category_name"
//                      Tags []string          // json:"tags"

// 新增 data-test 钩子
me-sync-card           // 已登录态那张同步卡（整块按钮，点 = 手动同步）
syncing                // 在途文案「同步中…」
server-settings-row    // 已登录态的「服务器设置」入口
recipe-author-count    // 详情页作者卡的「公开 N 道」
recipe-author-follow   // 详情页作者卡里的关注按钮
// 退休：retry、sync-failed
```

---

### Task 1: 后端菜谱载荷带作者头像

**Files:**
- Modify: `backend/internal/model/recipe.go`
- Modify: `backend/internal/service/sync.go`（`recipeSelectColumns` 与 `scanRecipeRow`）
- Modify: `backend/internal/service/sync_pull_test.go`
- Modify: `backend/internal/service/community_test.go`（社区详情那条用例）
- Modify: `docs/开发者-同步与社区.md`（`/sync` 的菜谱样例）

**Interfaces:**
- Produces: `model.Recipe.OwnerAvatarURL *string`，json 名 `owner_avatar_url`；`recipeSelectColumns` 的最后一列变成 `u.avatar_url`（**追加在 `u.nickname` 之后**，两个消费方 `/sync` 与社区详情自动同形状）。

- [ ] **Step 1: 写失败测试**

`sync_pull_test.go` 的 `TestBackfillAddsReferencedDictRows`（约 L263）里，把 fake 查询的行 fixture 改掉：`"FROM recipes r"` 那一行的**末尾追加一个头像值**（列序照 `recipeSelectColumns`，头像在最末），

```go
"FROM recipes r": {{"r-1", "me", int16(0), "红烧肉", nil, "cat-1", now, now, nil, "测试", "data:image/jpeg;base64,AV"}},
```

并在 `r.OwnerNickname != "测试"` 那条断言下面补一条：

```go
	if r.OwnerAvatarURL == nil || *r.OwnerAvatarURL != "data:image/jpeg;base64,AV" {
		t.Errorf("作者头像要随 JOIN users 下发（收藏卡与详情页的作者头像靠它），got %v", r.OwnerAvatarURL)
	}
```

再在 `community_test.go` 的 `TestGetPublicRecipeReturnsDictRowsForOfflineRender` 里补一条同形状的断言（作者头像随详情下发）。该用例自己 seed 了菜谱与用户；照它既有的写法给作者 `UPDATE users SET avatar_url = ...` 后断言 `payload.Recipes[0].OwnerAvatarURL`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestBackfillAddsReferencedDictRows|TestGetPublicRecipeReturnsDictRowsForOfflineRender' -v`
Expected: 编译失败 `unknown field OwnerAvatarURL`（先看见它红）。

- [ ] **Step 3: 实现**

`model/recipe.go`：`OwnerNickname` 之后加

```go
	OwnerAvatarURL *string `json:"owner_avatar_url"`
```

`service/sync.go`：`recipeSelectColumns` 末尾加 `, u.avatar_url`；`scanRecipeRow` 在 `&r.OwnerNickname` 之后加 `&r.OwnerAvatarURL`。**列顺序与 Scan 顺序必须一一对应**，两处消费方（`sync.go` 的 `queryRecipes`、`community.go` 的 `GetPublicRecipe`）共用这两个常量，不要各写一份。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./... && go vet ./...`
Expected: 全绿（含既有的 `TestListReturnsAuthorAvatar`）。

- [ ] **Step 5: 更新接口文档**

`docs/开发者-同步与社区.md` 里 `/sync` 响应样例的菜谱字段补 `owner_avatar_url`（与既有 `owner_nickname` 相邻）。

- [ ] **Step 6: Commit**

```bash
git add backend/internal/model/recipe.go backend/internal/service/sync.go backend/internal/service/sync_pull_test.go backend/internal/service/community_test.go docs/开发者-同步与社区.md
git commit -m "feat(后端): 菜谱载荷带出作者头像，收藏卡与详情页才有头像可用"
```

---

### Task 2: 后端社区列表带分类与标签

**Files:**
- Modify: `backend/internal/model/community.go`
- Modify: `backend/internal/service/community.go`（`ListPublicRecipes` 的 SELECT 与 `Scan`）
- Modify: `backend/internal/service/community_test.go`
- Modify: `docs/开发者-同步与社区.md`（社区列表响应样例）

**Interfaces:**
- Consumes: Task 1 的 `model.Recipe.OwnerAvatarURL`（无直接依赖，只是同一个头文件风格）。
- Produces: `model.CommunityRecipe.CategoryName *string`（json `category_name`）、`Tags []string`（json `tags`，**空数组不是 null**）。

- [ ] **Step 1: 写失败测试**

在 `community_test.go` 末尾追加（`seedUser` / `seedCommunityRecipe` / `findCommunityRecipeByName` / `filesTestDB` 都是本文件已有 helper）：

```go
// 列表要带分类与标签：客户端列表卡的第二行靠它们（spec §6）。
func TestListReturnsCategoryAndTags(t *testing.T) {
	pool := filesTestDB(t)
	community := NewCommunityService(pool)
	ctx := context.Background()

	author := seedUser(t, pool)
	now := time.Now().UTC()
	withTags := seedCommunityRecipe(t, pool, author, "有标签的菜", 1, now, false)
	plain := seedCommunityRecipe(t, pool, author, "没分类的菜", 1, now.Add(-time.Minute), false)

	catID := "cat-" + uuid.NewString()
	if _, err := pool.Exec(ctx,
		`INSERT INTO labels (id, name, kind, created_at, updated_at, deleted_at) VALUES ($1,'家常菜','category',$2,$2,NULL)`,
		catID, now); err != nil {
		t.Fatalf("插分类失败: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE recipes SET category_id = $1 WHERE id = $2`, catID, withTags); err != nil {
		t.Fatalf("设分类失败: %v", err)
	}
	for _, name := range []string{"下饭", "快手"} {
		labID := "lab-" + uuid.NewString()
		if _, err := pool.Exec(ctx,
			`INSERT INTO labels (id, name, kind, created_at, updated_at, deleted_at) VALUES ($1,$2,'tag',$3,$3,NULL)`,
			labID, name, now); err != nil {
			t.Fatalf("插标签失败: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO recipe_labels (recipe_id, label_id) VALUES ($1,$2)`, withTags, labID); err != nil {
			t.Fatalf("挂标签失败: %v", err)
		}
	}

	got, _, err := community.ListPublicRecipes(ctx, seedUser(t, pool), model.CommunityListOptions{})
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}

	with := findCommunityRecipeByName(got, "有标签的菜")
	if with == nil || with.CategoryName == nil || *with.CategoryName != "家常菜" {
		t.Errorf("应带出分类名，实得 %+v", with)
	}
	if len(with.Tags) != 2 || with.Tags[0] != "快手" || with.Tags[1] != "下饭" {
		t.Errorf("标签应按名字升序全部带出，实得 %v", with.Tags)
	}
	without := findCommunityRecipeByName(got, "没分类的菜")
	if without == nil {
		t.Fatalf("列表应包含「没分类的菜」")
	}
	if without.CategoryName != nil {
		t.Errorf("没分类应为 nil（客户端第二行只画标签），实得 %v", *without.CategoryName)
	}
	if without.Tags == nil || len(without.Tags) != 0 {
		t.Errorf("没标签应是空数组而不是 null，实得 %#v", without.Tags)
	}
}
```

若 `uuid` 未 import，按文件顶部既有用法补。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestListReturnsCategoryAndTags -v`
Expected: 编译失败 `unknown field CategoryName`。

- [ ] **Step 3: 实现**

`model/community.go`：`CommunityRecipe` 在 `AuthorAvatarURL` 之后加

```go
	CategoryName *string  `json:"category_name"`
	Tags         []string `json:"tags"`
```

`service/community.go` 的 `ListPublicRecipes`：

- SELECT 追加两列 —— `LEFT JOIN labels c ON c.id = r.category_id AND c.deleted_at IS NULL` 取 `c.name`，标签用子查询：

```sql
	 COALESCE((SELECT array_agg(l.name ORDER BY l.name)
	           FROM recipe_labels rl JOIN labels l ON l.id = rl.label_id
	           WHERE rl.recipe_id = r.id AND l.kind = 'tag' AND l.deleted_at IS NULL), '{}')
```

- `rows.Scan(...)` 按同样的顺序追加 `&it.CategoryName, &it.Tags`。标签用**名字**不是 id（客户端只画 chip，列表项不落库）。`LEFT JOIN` 不改行数。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./... && go vet ./...`
Expected: 全绿。

- [ ] **Step 5: 更新接口文档**

`docs/开发者-同步与社区.md` 里 `GET /api/v1/community/recipes` 那一行的说明补上 `category_name` / `tags`（与上一轮补 `author_avatar_url` 同一处）。

- [ ] **Step 6: Commit**

```bash
git add backend/internal/model/community.go backend/internal/service/community.go backend/internal/service/community_test.go docs/开发者-同步与社区.md
git commit -m "feat(后端): 社区列表带出分类与标签，列表卡第二行才有内容"
```

---

### Task 3: 本地落库作者头像（含 LWW 穿透）

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/db/index.ts`（`migrateTables`）
- Modify: `src/services/sync.ts`（`applyRemoteChanges` 的菜谱分支：INSERT / UPDATE / LWW 跳过三条路径）
- Modify: `src/services/__tests__/sync.test.ts`（或该目录下既有的落库用例文件；先 grep `applyRemoteChanges` 找现有测试所在文件）
- Modify: `src/db/__tests__/*`（若建表迁移有断言）

**Interfaces:**
- Consumes: Task 1 的 `owner_avatar_url`（`/sync` 与社区详情都下发）。
- Produces: `Recipe.owner_avatar_url: string | null`；本地表新列；`applyRemoteChanges` 对**LWW 判等跳过的行**也刷新作者两列。

- [ ] **Step 1: 写失败测试**

在落库测试文件里新增两条（沿用该文件既有的 db 建库 helper）：

```ts
it("新菜谱落库带上作者头像", async () => { /* 远端一行带 owner_avatar_url → 断言 SELECT 回来的 owner_avatar_url */ });

it("远端更旧时菜谱本体不过 LWW，但作者两列仍被刷新", async () => {
  // 本地先有一行：name = "本地改过的名字"、updated_at 比远端新、owner_avatar_url = NULL
  // 远端下发同一 id：name = "服务端的名字"、updated_at 更旧、owner_avatar_url = "data:image/jpeg;base64,AV"
  // 断言：owner_avatar_url 变成远端值；name 仍是「本地改过的名字」（LWW 保护没被破坏）
});

it("载荷里没有 owner_avatar_url 这个键时不动本地的值", async () => {
  // 本地 owner_avatar_url = "🐱"；远端行不含该键（旧服务端）且 updated_at 更旧
  // 断言：本地仍是 "🐱"（不许抹成 NULL）
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/services/__tests__/sync.test.ts`
Expected: 第一条因列不存在/字段为 undefined 而红；第二、三条在旧实现下也红（LWW 直接 `continue`）。

- [ ] **Step 3: 实现**

`src/types/index.ts`：`Recipe` 在 `owner_nickname` 之后加

```ts
  /** 作者头像的本地副本（别人发的菜谱才有）；本机自建 / 未认领为 NULL。 */
  owner_avatar_url: string | null;
```

`src/db/index.ts` 的 `migrateTables`：照 `owner_nickname` 的写法加

```ts
  if (!names.has("owner_avatar_url"))
    await db.execute("ALTER TABLE recipes ADD COLUMN owner_avatar_url TEXT");
```

（DDL 里的 `CREATE TABLE recipes` 也补这一列，新库直接建好。）

`src/services/sync.ts` 的 `applyRemoteChanges` 菜谱分支，三处：

1. `const ownerAvatar = r.owner_avatar_url ?? null;`（与既有 `ownerNickname` 并列）
2. INSERT 与 UPDATE 的列清单各加 `owner_avatar_url`（占位符 / 值顺序同步补）
3. **LWW 判等跳过的分支**（现在是一句 `continue`）改成：

```ts
    if (!isNew && compareTimestamp(r.updated_at, local[0].updated_at) <= 0) {
      // 作者两列是服务端从 users 表派生的展示数据，本地从不改写：菜谱本体不过 LWW，
      // 这两列也要刷新（否则新加的 owner_avatar_url 对存量行永远是 NULL）。
      // 载荷里没有这个键说明是旧版服务端，保持本地值不动（别把好头像抹成 NULL）。
      if ("owner_avatar_url" in r) {
        await db.execute(
          "UPDATE recipes SET owner_nickname = ?, owner_avatar_url = ? WHERE id = ?",
          [ownerNickname, ownerAvatar, r.id],
        );
      }
      continue;
    }
```

**只改这两列**，不许顺手把 `name` / `cover_path` 等列也刷了（那会破坏 LWW 对本地编辑的保护，正是测试第二条在守的）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/services/__tests__/sync.test.ts && npm run test && npm run build`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/db/index.ts src/services/sync.ts src/services/__tests__/sync.test.ts
git commit -m "feat(同步): 本地落库作者头像，存量行靠 LWW 穿透补上"
```

---

### Task 4: RecipeCard 组件

**Files:**
- Create: `src/components/RecipeCard.vue`
- Create: `src/components/__tests__/RecipeCard.test.ts`
- Modify: `docs/superpowers/specs/2026-10-16-profile-avatar-refsheet-design.md`（§5.3 那一格指向本轮设计）

**Interfaces:**
- Consumes: `UserAvatar`（已有）。
- Produces: `RecipeCard`，props 见「跨任务的既定接口」；钩子由 `testPrefix` 拼出。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import RecipeCard from "@/components/RecipeCard.vue";

function mountCard(props: Record<string, unknown> = {}, prefix = "recipe") {
  return mount(RecipeCard, {
    props: { name: "红烧肉", coverSrc: null, category: null, tags: [], authorName: null, authorAvatarUrl: null, testPrefix: prefix, ...props },
  });
}

describe("RecipeCard", () => {
  it("三行都在：标题 / 分类与标签 / 作者", () => {
    const wrapper = mountCard({ category: "家常菜", tags: ["下饭", "快手"], authorName: "老王", authorAvatarUrl: "🐱" });

    expect(wrapper.get('[data-test="recipe-name"]').text()).toBe("红烧肉");
    expect(wrapper.get('[data-test="recipe-category"]').text()).toBe("家常菜");
    expect(wrapper.findAll('[data-test="recipe-tag"]').map((t) => t.text())).toEqual(["下饭", "快手"]);
    expect(wrapper.get('[data-test="recipe-author"]').text()).toBe("老王");
    expect(wrapper.get('[data-test="recipe-author-avatar"]').text()).toBe("🐱");
  });

  it("没有分类时只画标签", () => { /* category: null, tags: ["下饭"] → recipe-category 不存在、tag 存在 */ });

  it("分类与标签都为空时整个第二行不渲染", () => { /* 断言两个钩子都不存在 */ });

  it("作者为空时第三行整行不渲染", () => { /* authorName: null → recipe-author 与 recipe-author-avatar 都不存在 */ });

  it("封面没落盘时用菜名首字兜底", () => { /* coverSrc: null → recipe-cover 不存在、recipe-cover-fallback 是「红」 */ });

  it("有图源时画 <img> 且不做兜底", () => { /* coverSrc: "/x.jpg" → recipe-cover 的 src 是它，fallback 不存在 */ });

  it("testPrefix 决定钩子前缀，社区那套逐字保留", () => { /* prefix "community" → community-card / community-name / community-author-avatar 存在，recipe-* 不存在 */ });

  it("整张卡是一个按钮，点击 emit 到父组件的 handler", () => { /* 挂载时传 @click → 断言触发一次 */ });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/RecipeCard.test.ts`
Expected: FAIL — `Failed to resolve import "@/components/RecipeCard.vue"`。

- [ ] **Step 3: 实现**

`src/components/RecipeCard.vue`，`<script setup lang="ts">`：

```ts
const props = defineProps<{
  name: string;
  coverSrc: string | null;
  category: string | null;
  tags: string[];
  authorName: string | null;
  authorAvatarUrl: string | null;
  testPrefix: "recipe" | "community";
}>();
```

模板结构（类名照抄，宽高沿用现有卡片：封面 `h-11 w-11 rounded-lg`）：

- 外层 `<button type="button" :data-test="`${testPrefix}-card`" class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors hover:bg-gray-50">`
- 封面：`<img v-if="coverSrc" :data-test="`${testPrefix}-cover`" :src="coverSrc" :alt="name" loading="lazy" class="h-11 w-11 shrink-0 rounded-lg object-cover" />`，否则一个 `:data-test="`${testPrefix}-cover-fallback`"` 的 44px 方块显示 `name.charAt(0)`（**菜名首字**，与现状一致）。
- 右侧 `div.min-w-0.flex-1`：
  - 第一行：`<h3 :data-test="`${testPrefix}-name`" class="line-clamp-2 text-sm font-medium text-text">{{ name }}</h3>`
  - 第二行（`v-if="category || tags.length > 0"`）：`<div class="mt-1 flex flex-wrap items-center gap-1">`，分类 chip `<span :data-test="`${testPrefix}-category`" class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-text-secondary">{{ category }}</span>`，标签 chip 同款但钩子是 `-tag`。
  - 第三行（`v-if="authorName"`）：`<div class="mt-1 flex items-center gap-1.5">` + `<UserAvatar :data-test="`${testPrefix}-author-avatar`" :url="authorAvatarUrl" :name="authorName" class="h-5 w-5 shrink-0 rounded-full" text-class="text-[10px]" />` + `<span :data-test="`${testPrefix}-author`" class="truncate text-xs text-text-secondary">{{ authorName }}</span>`。
- 组件**不认识** `imageSrc` / `syncFiles`，封面可用性由调用方决定。

`docs/superpowers/specs/2026-10-16-profile-avatar-refsheet-design.md` §5.3 的「社区列表卡片 | 32px 圆」那一格改成一句指向本轮设计（`2026-10-16-recipe-card-author-sync-design.md` §5.3 是现行尺寸表），别让两份文档互相打脸。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/RecipeCard.test.ts && npm run test && npm run build`
Expected: 8 passed，其余全绿。

- [ ] **Step 5: Commit**

```bash
git add src/components/RecipeCard.vue src/components/__tests__/RecipeCard.test.ts docs/superpowers/specs/2026-10-16-profile-avatar-refsheet-design.md
git commit -m "feat(组件): 新增 RecipeCard，列表卡统一三行布局"
```

---

### Task 5: 社区卡换用 RecipeCard

**Files:**
- Modify: `src/services/community.ts`（`CommunityRecipe` 加两个字段）
- Modify: `src/components/CommunityFeed.vue`
- Modify: `src/components/__tests__/CommunityFeed.test.ts`
- Modify: `src/components/__tests__/RecipeCard.test.ts`?（不需要）
- Modify: 其余构造 `CommunityRecipe` fixture 的测试文件（加两个字段，**只补字段不改断言**）

**Interfaces:**
- Consumes: Task 2 的 `category_name` / `tags`、Task 4 的 `RecipeCard`。
- Produces: 社区卡 = `RecipeCard` + 收藏星标；钩子 `community-*` 全部保留。

- [ ] **Step 1: 写失败测试**

`CommunityFeed.test.ts`：给 `recipe()` fixture 补 `category_name: null, tags: []`（**补 fixture 字段，不改断言**），追加两条：

```ts
it("第二行显示分类与标签", () => {
  mocks.community!.items = [recipe("1", { category_name: "家常菜", tags: ["下饭", "快手"] })];
  const wrapper = mountFeed();

  expect(wrapper.get('[data-test="community-category"]').text()).toBe("家常菜");
  expect(wrapper.findAll('[data-test="community-tag"]').map((t) => t.text())).toEqual(["下饭", "快手"]);
});

it("没有分类时只画标签", () => {
  mocks.community!.items = [recipe("1", { category_name: null, tags: ["下饭"] })];
  const wrapper = mountFeed();

  expect(wrapper.find('[data-test="community-category"]').exists()).toBe(false);
  expect(wrapper.get('[data-test="community-tag"]').text()).toBe("下饭");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/CommunityFeed.test.ts`
Expected: FAIL — 找不到 `community-category`；`CommunityRecipe` 缺字段也会让 `npm run build` 报错。

- [ ] **Step 3: 实现**

`src/services/community.ts`：`CommunityRecipe` 在 `author_avatar_url` 之后加 `category_name: string | null;` 与 `tags: string[];`（照「跨任务的既定接口」逐字）。

其余测试文件里构造 `CommunityRecipe` 的 fixture（`src/stores/__tests__/community.test.ts`、`src/views/__tests__/RecipeList.test.ts`、`src/views/__tests__/UserPage.test.ts` 等）各补两行 `category_name: null, tags: []` —— **只补字段，不动断言**。

`src/components/CommunityFeed.vue`：把卡片那一段（`<li>` 里的 `<button data-test="community-card">…</button>`）换成

```html
<RecipeCard
  :name="item.name"
  :cover-src="item.cover_path && localCovers.has(item.cover_path) ? imageSrc(item.cover_path) : null"
  :category="item.category_name"
  :tags="item.tags"
  :author-name="item.author_nickname"
  :author-avatar-url="item.author_avatar_url"
  test-prefix="community"
  @click="open(item.id)"
/>
```

收藏星标（`Star`，`data-test="community-favorited"`）留在 `RecipeCard` **外面**：把 `<li>` 改成 `class="relative"`，星标绝对定位到右上角（`absolute right-3 top-3`）——钩子与显隐条件不变。`localCovers` / `open` / 加载与错误态整块不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/CommunityFeed.test.ts src/components/__tests__/RecipeCard.test.ts && npm run test && npm run build`
Expected: 全绿（既有 `community-card` / `community-cover` / `community-cover-fallback` / `community-author` / `community-author-avatar` / `community-favorited` 断言一行未改即通过）。

- [ ] **Step 5: Commit**

```bash
git add src/services/community.ts src/components/CommunityFeed.vue src/components/__tests__/CommunityFeed.test.ts src/stores/__tests__/community.test.ts src/views/__tests__/RecipeList.test.ts src/views/__tests__/UserPage.test.ts
git commit -m "feat(社区): 社区卡换用统一卡片，补上分类与标签"
```

---

### Task 6: 我的 / 收藏换用 RecipeCard

**Files:**
- Modify: `src/views/RecipeList.vue`
- Modify: `src/views/__tests__/RecipeList.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `Recipe.owner_avatar_url`、Task 4 的 `RecipeCard`、`auth.nickname` / `auth.avatarUrl` / `auth.serverUserId`。
- Produces: 「我的」「收藏」两个 tab 的卡片 = `RecipeCard` + `authorOf()`；钩子 `recipe-*` 全部保留。

- [ ] **Step 1: 写失败测试**

`RecipeList.test.ts` 追加（沿用文件既有的 `page()` / seed 方式）：

```ts
it("我的菜谱第三行是自己的昵称与头像", async () => { /* 登录 + 本地一条自己名下菜谱 → recipe-author 是自己昵称、recipe-author-avatar 是 auth 头像 */ });

it("未登录时我的菜谱不显示第三行", async () => { /* 未登录 + 一条 owner_id 为 NULL 的本机菜谱 → recipe-author 不存在 */ });

it("收藏的别人菜谱第三行是作者，用本地落库的昵称与头像", async () => { /* 本地有一条 owner_nickname/owner_avatar_url 的收藏 → 第三行是作者而不是我 */ });

it("该菜谱的 owner 是我自己时，收藏 tab 里也用我的头像", async () => { /* owner_id === serverUserId → 忽略本地两列，用 auth 的值 */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/RecipeList.test.ts`
Expected: FAIL — 找不到 `recipe-author`。

- [ ] **Step 3: 实现**

`src/views/RecipeList.vue`：

- import `RecipeCard`；删掉那段内联的卡片 `<button data-test="recipe-card">…</button>`，换成

```html
<RecipeCard
  :name="item.recipe.name"
  :cover-src="item.recipe.cover_path && localImages.has(item.recipe.cover_path) ? imageSrc(item.recipe.cover_path) : null"
  :category="item.category.name"
  :tags="item.tags.map((tag) => tag.name)"
  :author-name="authorOf(item).name"
  :author-avatar-url="authorOf(item).avatarUrl"
  test-prefix="recipe"
  @click="router.push(`/recipe/${item.recipe.id}`)"
/>
```

- 同文件内加一个函数（**唯一实现处**，模板里两处调用）：

```ts
/** 第三行的作者：自己的菜谱（或未认领）用内存里的我；别人的用本地落库的两列。 */
function authorOf(item: RecipeListItem): { name: string | null; avatarUrl: string | null } {
  const mine = item.recipe.owner_id === null || item.recipe.owner_id === auth.serverUserId;
  if (mine) return { name: auth.nickname, avatarUrl: auth.avatarUrl };
  return { name: item.recipe.owner_nickname, avatarUrl: item.recipe.owner_avatar_url };
}
```

（`auth.nickname` 未登录时为 `null` → `RecipeCard` 整行不渲染，正是 Review Focus 第 4 条。）

- 分类为空是历史数据可能出现的（`item.category` 一定存在，但名字可能是空串）：把 `category` 传成 `item.category.name || null`，避免画一个空 chip。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/RecipeList.test.ts && npm run test && npm run build`
Expected: 全绿（既有 `recipe-card` / `recipe-cover` / `recipe-cover-fallback` / `recipe-name` / `recipe-category` / `recipe-tag` 断言一行未改即通过）。

- [ ] **Step 5: Commit**

```bash
git add src/views/RecipeList.vue src/views/__tests__/RecipeList.test.ts
git commit -m "feat(菜谱列表): 我的与收藏换成统一卡片，第三行显示作者"
```

---

### Task 7: 详情页作者卡片

**Files:**
- Modify: `src/views/RecipeDetail.vue`
- Modify: `src/views/__tests__/RecipeDetail.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `Recipe.owner_avatar_url`、`useCommunityStore().profile(id)` / `follow(id)` / `unfollow(id)`（均已有）、`auth.serverUserId`。
- Produces: 钩子 `recipe-author`（保留，现在是整块卡片）、`recipe-author-avatar`、`recipe-author-count`、`recipe-author-follow`。

- [ ] **Step 1: 写失败测试**

`RecipeDetail.test.ts` 追加（沿用既有挂载方式与 profile/fetch 替身）：

```ts
it("作者卡片第一眼就有头像与昵称（本地那份就够）", async () => { /* 详情本地 owner_nickname/owner_avatar_url 有值、不联网 → recipe-author-avatar 是头像、昵称在卡片里 */ });

it("联网时补出公开菜谱数与关注按钮", async () => { /* profile 替身返回 public_count: 12, followed: false → recipe-author-count 含 12、recipe-author-follow 文案「关注」 */ });

it("作者就是自己时不出现关注按钮", async () => { /* owner_id === serverUserId → recipe-author-follow 不存在，数字照常 */ });

it("点关注按钮只调 follow，不跳用户页", async () => { /* 点 recipe-author-follow → store.follow 被调、router.push 未被调 */ });

it("点卡片本体进用户页", async () => { /* 保留既有断言：点 recipe-author → push /user/{id} */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/RecipeDetail.test.ts`
Expected: FAIL — 找不到 `recipe-author-avatar`。

- [ ] **Step 3: 实现**

`src/views/RecipeDetail.vue`：把现在那个 `<button data-test="recipe-author">{{ detail.recipe.owner_nickname }}</button>` 换成卡片（`v-if="detail.recipe.owner_id"` 不变）：

```html
<button type="button" data-test="recipe-author" class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left" @click="openAuthor">
  <UserAvatar data-test="recipe-author-avatar" :url="detail.recipe.owner_avatar_url" :name="detail.recipe.owner_nickname" class="h-16 w-16 shrink-0 rounded-full" text-class="text-2xl" />
  <div class="min-w-0 flex-1">
    <p class="truncate text-base font-medium text-text">{{ detail.recipe.owner_nickname }}</p>
    <p v-if="authorProfile" data-test="recipe-author-count" class="text-xs text-text-secondary">公开 {{ authorProfile.public_count }} 道</p>
  </div>
  <button v-if="authorProfile && !isSelf" type="button" data-test="recipe-author-follow" class="shrink-0 rounded-lg border px-4 py-2 text-sm" @click.stop="toggleFollow">
    {{ authorProfile.followed ? "取消关注" : "关注" }}
  </button>
</button>
```

（嵌套 `<button>` 是非法 HTML——外层改用 `<div role="button" tabindex="0" @click="openAuthor" @keydown.enter="openAuthor">` 或把关注按钮挪到外层 div 里、外层用 div。**实现时选一种不会产生嵌套 button 的结构**，`data-test="recipe-author"` 仍要能 `trigger("click")` 到。）

- 脚本：`const authorProfile = ref<UserProfile | null>(null);`、`const isSelf = computed(() => detail.value?.recipe.owner_id === auth.serverUserId)`；`owner_id` 存在且 `auth.isOnline` 时拉一次 `store.profile(ownerId)`，**失败静默**（`try/catch` 里只把 `authorProfile` 留在 null，不写错误提示、不阻塞页面）；`toggleFollow()` 调 `store.follow` / `store.unfollow` 后刷新 `authorProfile`。既有跳转逻辑（`openAuthor`）沿用。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/RecipeDetail.test.ts && npm run test && npm run build`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/views/RecipeDetail.vue src/views/__tests__/RecipeDetail.test.ts
git commit -m "feat(菜谱详情): 作者换成卡片，含公开菜谱数与关注按钮"
```

---

### Task 8: 手动同步入口

**Files:**
- Modify: `src/services/sync.ts`（`requestSyncNow` + `syncInFlight`）
- Modify: `src/services/__tests__/*`（同步调度既有用例所在文件；先 grep `enqueueSync` 找）
- Modify: `src/views/MePage.vue`
- Modify: `src/views/__tests__/MePage.test.ts`

**Interfaces:**
- Consumes: Task 6 的 MePage 现状、`enqueueSync` / `performSync` / 模块内 `isSyncing` / `syncQueued` / `syncTimer`（都在 `sync.ts` 内已有）。
- Produces: `export const syncInFlight: Ref<boolean>`、`export function requestSyncNow(): void`；MePage 钩子 `me-sync-card` / `syncing` / `server-settings-row`，退休 `retry` / `sync-failed`。

- [ ] **Step 1: 写失败测试**

`sync` 的调度用例文件里新增（沿用该文件既有的假定时器/替身写法）：

```ts
it("requestSyncNow 立刻跑，不等 3 秒防抖", async () => { /* 调一次 → 不等定时器就发出 /sync（断言 fetch 被调） */ });

it("在途时再调只安排一轮补跑，不出两个并发", async () => { /* 让第一次 /sync 挂住 → 再调两次 requestSyncNow → 放行 → 总请求数是 2，不是 3 */ });

it("syncInFlight 在跑与不跑之间正确翻转", async () => { /* 调用前 false，请求在途 true，结束后 false */ });
```

`MePage.test.ts` 追加（该文件现在需要 mock `@/services/sync`：用 `vi.hoisted` 造一个可控的 `inFlight` ref，把 `requestSyncNow` 换成 spy，并把 `syncInFlight` 指向那个 ref —— 否则测不到「在途时置灰」）：

```ts
it("点同步卡触发一次手动同步", async () => { /* 点 me-sync-card → requestSyncNow 被调 1 次 */ });

it("同步在途时显示「同步中…」且整块 disabled", async () => {
  // inFlight.value = true; await flushPromises();
  // → 有 [data-test="syncing"]、me-sync-card 的 attributes("disabled") 有定义
});

it("已登录时有「服务器设置」入口", async () => { /* 点 server-settings-row → mocks.push('/me/server') */ });
```

并把已登录那条既有用例里对卡片的断言对象换成 `me-sync-card`（`server-state` / `nickname` / `last-sync` 照旧）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/MePage.test.ts`
Expected: FAIL — 找不到 `me-sync-card`。

- [ ] **Step 3: 实现**

`src/services/sync.ts`：

- 模块级 `export const syncInFlight = ref(false);`（本文件已 import vue 的 `ref` 吗？没有就加）。
- 新增

```ts
/** 手动同步：立刻跑一次增量同步，不等 enqueueSync 的 3 秒防抖。
 *  并发互斥与「在途时补跑一轮」已经在 performSync 里（syncQueued），这里不再重复实现。 */
export function requestSyncNow(): void {
  if (!hasBaseUrl() || !getCurrentServerUserId()) return;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  void performSync().catch(() => {});
}
```

（`performSync` 自己就有互斥：在途时把 `syncQueued` 置位、本次结束后补跑一轮，见 `sync.ts:655-670`。**不要**在这里再写一遍那套逻辑。）

- 在 `performSync` 进入/退出处把 `syncInFlight` 翻 true/false：用 `try/finally` 包住既有的运行体，或者在与 `isSyncing = true` / `isSyncing = false` 同一位置一起翻——**必须与 `isSyncing` 同进同出**，否则界面会与真实在途状态漂移。`resetSyncTimers()` 里也把它复位为 false（登出时界面不许停在「同步中」）。

`src/views/MePage.vue`（**只有已登录那一态改**，未开启 / 未登录两态一行不动）：

- 状态：`const syncing = computed(() => syncInFlight.value)`。
- 文案：`同步中…` / `上次同步没成功` / `已同步 <时间>`（沿用既有 `lastSyncText` 与 `auth.lastSyncFailed`）。
- 结构：已登录态的那张卡整块是一个 `<button data-test="me-sync-card" :disabled="syncing" @click="requestSyncNow">`（`server-state` / `nickname` / `last-sync` 三个 `<span>` 原样留在里面）；删掉 `sync-failed` 的 `<p>` 与 `retry` 按钮，失败提示改成卡片内的一行文案（`data-test="syncing"` 只在 `syncing` 时出现）；卡片下方加 `<button data-test="server-settings-row" @click="router.push('/me/server')">服务器设置</button>`，`logout` 按钮保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/MePage.test.ts src/views/__tests__/placeholderPages.test.ts && npm run test && npm run build`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/services/sync.ts src/services/__tests__/ src/views/MePage.vue src/views/__tests__/MePage.test.ts
git commit -m "feat(我的): 同步卡可点触发增量同步，重试按钮退休"
```

---

## 收尾验证（全部任务完成后）

```bash
npm run test
npm run build
cd backend && go test ./... && go vet ./...
```

真机（Android）走 spec §11 的 0–7 条，其中三条最容易翻车：

- **第 0 条**（curl 看 `author_avatar_url` 有没有下发）——上一轮 #1 的收口判据，服务端要重新编译并重启。
- **第 3b 条**（**升级安装**，不是全新安装，再看收藏 tab 与详情页的作者头像）——LWW 穿透刷新的唯一验收。
- **第 7 条**（连点三次同步卡）——`syncInFlight` 不许出两个并发。
