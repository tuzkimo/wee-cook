# AI 菜谱助手 · 第 3、4 刀：长截图收录、分享目标与隐私收口

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户把小红书 / 下厨房的长截图（分享或选图）交给 AI，识别成一份**预填好的本地菜谱编辑页**；用户改完点保存才落库。顺带补掉 v0.7.0 的两处遗留：AI 会话与 opt-in 按账号隔离、`content` 协议支持图片块。

**Architecture:** 客户端把长图按宽度缩放后切成若干段（纯函数算几何，canvas 只负责编码），一轮请求里全部发给自家后端；后端的上游适配层从 `string` 放宽成 `json.RawMessage`，做哑管道。模型只准调 `create_recipe_draft` 交回**名字**，客户端在本地把名字解析成 id，写进一个**内存草稿槽**；`RecipeEdit` 挂载时读走即清，未落定的食材行拦住保存。Android 分享目标整段移植 wee-count 的 `pending.json` 契约（去掉那边的自动锁部分）。

**Tech Stack:** Vue 3 + TypeScript 严格模式 / Pinia / vitest + happy-dom / node:sqlite；Tauri 2（dialog、fs、store 插件）；Kotlin（`MainActivity`）；Go 1.25 / chi（后端）。

**Spec:** `docs/superpowers/specs/2026-10-16-ai-recipe-design.md`（下称**规格**）。本计划实现规格 §10 的第 3、4 刀，并落实 §12 的四项修订。参考只读规格：`D:\projects\my\wee-count\docs\superpowers\specs\2026-09-21-ai-screenshot-m4-design.md`（下称 **M4**）与 `2026-09-28-android-share-target-design.md`（下称**分享目标规格**）。

**本刀边界（验收口径）**

- 结束时：截图入口存在（选图按钮 + 预览）、Android 分享目标可用（真机验收另标）、`create_recipe_draft` 只写内存草稿槽**不写库**
- 不做：步骤配图提取、图片入同步、多图输入、流式输出、AI 修改已有菜谱
- 不重做 v0.7.0 已发布的部分（后端路由、限流、错误映射、prompt 的检索段、聊天页骨架）

## Global Constraints

- TypeScript 严格模式，**禁止 `any`**；非 bugfix 必须带测试，**不可删改已有测试**（与新规格直接冲突的除外，且必须在 commit message 里点名改了哪条、为什么）
- 长图常量**逐字写死**，不许在实现时另算：
  - `MAX_WIDTH = 1080`
  - `MAX_SEGMENT_HEIGHT = 1500`
  - `SEGMENT_OVERLAP = 120`
  - `MAX_SEGMENTS = 6`
  - `MAX_SEGMENT_BYTES = 1 << 20`（1 MiB，**编码后**的 JPEG 字节）
  - `SEGMENT_JPEG_QUALITY = 0.8`
  - 封面高上限 `round(MAX_WIDTH × 4 / 3) = 1440`，取**顶部第一屏**
  - 缩放**只缩不放**：`scale = min(1, MAX_WIDTH / 原宽)`
- **段像素看门**：任一段的输出像素数必须 ≤ `1300 × 1300 = 1,690,000`（上游二次归一的阈值）；`1080 × 1500 = 1,620,000`
- 后端体积常量不变：`maxAIBodyBytes = 12 << 20`；6 段 × 1 MiB base64 ≈ 8.0 MiB，必须留出余量
- 图片块**只能出现在 `user` 消息里**；`assistant` / `tool` 消息永远发字符串
- 历史里的截图轮拼给模型时替换成 `[用户发过一张菜谱截图]`（有文字则后接原文字）；**本地存储与气泡渲染不替换**
- 食材只存 `ingredient_id + amount + unit_id`；**未落定的食材不静默新建、不静默丢弃**，带进编辑页并拦住保存
- 本地业务表带 `id / updated_at / deleted_at`；`ai_sessions` / `ai_messages` **永不参与同步**
- AI 会话与 opt-in 属于**账号**（`server user id`）：退登不清数据、不继承同意；旧全局键 `aiSendingEnabled` 不迁移
- 截图/图片相关的新代码只新增在 `src/services/ai/` 与 `src/components/ai/`；不重构无关代码
- 提交信息用中文；**不 push、不合并、不打 tag**

## Review Focus

这五类是规格隐含、但任何单任务的测试都不会自动覆盖的失败模式。每条都在它归属的任务里有对应断言：

1. **同设备换账号** —— B 不得看到 A 的聊天历史、不得继承 A 的同意；A 重新登录后历史与同意原样恢复（退登也不许改写 A 的数据）→ Task 2 / 3
2. **极端长图** —— 1:20 长图、横图、1px 短边、刚好 6 段 / 第 7 段：要么给出确定结果，要么给一句可读的拒绝文案，绝不出现 0 边 canvas 崩溃或静默截断 → Task 5 / 6
3. **模型不听话** —— 不调工具、调了但参数烂、或嘴上说「已经帮你存好了」：编辑页不跳、库里不多一行、文案不谎报 → Task 8 / 9 / 10
4. **未落定食材** —— 用户直接点保存：拦住并指到那几行，**不静默新建食材**，也不把 AI 给的数量/单位丢掉 → Task 11
5. **体积闸门** —— 单段编码后 > 1 MiB 时在**客户端**拒绝，不把 8 MiB 的请求发上去再报 `ai_upstream_error` → Task 6（后端 413 / 8 MiB 放行已由 v0.7.0 的 `TestAIChatDefaultBodyLimitAllows8MiB` 钉住）

---

### Task 1: `ai_sessions` 补 `user_id`

**Files:**
- Modify: `src/db/index.ts`（`DDL` 的 `ai_sessions` + `migrateTables`）
- Modify: `src/db/__tests__/schema.test.ts`、`src/db/__tests__/migrate.test.ts`（追加用例，不动已有断言）
- Test: `src/services/__tests__/sync.test.ts` 里既有的「AI 表不进同步」哨兵**不许改**

**Interfaces:**
- Consumes: 无
- Produces: `ai_sessions` 列为 `(id, user_id, created_at, updated_at, deleted_at)`；`user_id` 可空（老库无主行）

- [x] **Step 1: 写失败的测试**

追加到 `schema.test.ts`：

```ts
it("ai_sessions 带 user_id，且它不在同步载荷的键集里", async () => {
  const { db } = await freshTestDb();
  const cols = (await db.select<{ name: string }[]>("PRAGMA table_info(ai_sessions)")).map((c) => c.name);
  expect(cols).toContain("user_id");
});
```

追加到 `migrate.test.ts`（该文件已有「老库补列」的样板，照抄形状）：

```ts
it("老库的 ai_sessions 没有 user_id 时，initTables 会补上且可重复执行", async () => {
  // 先用裸连接建一张只有 (id, created_at, updated_at, deleted_at) 的 ai_sessions
  // 再 initTables(db) 两次：两次都不抛；PRAGMA 里有 user_id
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/db/`
Expected: FAIL —— `ai_sessions` 的列里没有 `user_id`

- [x] **Step 3: 实现**

`DDL` 的 `ai_sessions` 改成：

```sql
CREATE TABLE IF NOT EXISTS ai_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
)
```

`migrateTables` 追加一步（照现有「先 `PRAGMA table_info` 再 `ALTER`」的写法，**不要**用异常兜底）：

```ts
const sessionCols = await db.select<{ name: string }[]>("PRAGMA table_info(ai_sessions)");
if (!sessionCols.some((c) => c.name === "user_id")) {
  await db.execute("ALTER TABLE ai_sessions ADD COLUMN user_id TEXT");
}
```

注释写明：老库无主行 `user_id` 为 NULL ⇒ 永不匹配、也不再显示；**不删除**（无法判断属于谁）。

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/db/ src/services/__tests__/sync.test.ts`
Expected: PASS（含「AI 两张表不进同步」的既有哨兵）

- [x] **Step 5: 提交**

```bash
git add src/db/index.ts src/db/__tests__/schema.test.ts src/db/__tests__/migrate.test.ts
git commit -m "feat(数据): ai_sessions 补 user_id，老库无主会话不再匹配"
```

---

### Task 2: 账号态模块 + opt-in 按账号 + 退登语义

**Files:**
- Create: `src/services/ai/account.ts`
- Modify: `src/services/ai/privacy.ts`
- Modify: `src/stores/auth.ts`（`adoptSession` / `goGuest` / `restoreSession` 成功分支 / `logout`）
- Modify: `src/stores/aiSettings.ts`（`reset()`；`load()` 按账号）
- Modify: `src/stores/aiChat.ts`（先只加 `reset()`）
- Test: `src/services/ai/__tests__/privacy.test.ts`、`src/stores/__tests__/auth.test.ts`、`src/stores/__tests__/aiSettings.test.ts`、`src/stores/__tests__/aiChat.test.ts`

**Interfaces:**
- Consumes: Task 1 的表（本任务不用它）
- Produces:
  - `src/services/ai/account.ts`：`export function setAiAccount(id: string | null): void`、`export function aiAccount(): string | null`
  - `src/services/ai/privacy.ts`：
    - `export function aiSendingKey(userId: string): string` —— 返回 `` `aiSendingEnabled:${userId}` ``
    - `export async function readAiSendingEnabled(): Promise<boolean>` —— `aiAccount()` 为 `null` ⇒ `false`，**不读盘**
    - `export async function writeAiSendingEnabled(value: boolean): Promise<void>` —— 无账号时 `throw new Error("未登录")`
  - `useAiSettingsStore` 新增 `reset(): void`（内存置 `sendingEnabled=false`、`status=null`）
  - `useAiChatStore` 新增 `reset(): void`（`messages=[]`、`error=null`、清会话缓存与附件占位，本任务附件还不存在）

- [x] **Step 1: 写失败的测试**

`privacy.test.ts` 改为（**这是与 §12.1 直接冲突的既有断言，允许改**，commit 里点名）：

```ts
beforeEach(() => { localStorage.clear(); setAiAccount("u-A"); });

it("键按账号隔离：A 写 true 不影响 B", async () => {
  await writeAiSendingEnabled(true);
  expect(localStorage.getItem("aiSendingEnabled:u-A")).toBe("true");
  setAiAccount("u-B");
  expect(await readAiSendingEnabled()).toBe(false);
});

it("没有账号时读到 false，且一个键都不读", async () => {
  setAiAccount(null);
  localStorage.setItem("aiSendingEnabled:u-A", "true");
  expect(await readAiSendingEnabled()).toBe(false);
});

it("没有账号时写入直接抛错，不落盘", async () => {
  setAiAccount(null);
  await expect(writeAiSendingEnabled(true)).rejects.toThrow("未登录");
  expect(Object.keys({ ...localStorage })).toHaveLength(0);
});
```

`aiSettings.test.ts` 追加：

```ts
it("登录前 load() 不发探活、入口隐藏", async () => {
  setAiAccount(null);
  await store.load();
  expect(fetchAiStatus).not.toHaveBeenCalled();
  expect(store.tabVisible).toBe(false);
});

it("reset() 只清内存，不写盘", async () => {
  // sendingEnabled/status 归零；writeAiSendingEnabled 未被调用
});
```

`auth.test.ts` 追加 / 改写（既有那条「logout 关掉 AI 开关」**与新规格冲突，允许改**）：

```ts
it("logout 清空内存里的 AI 状态，但不动本账号已经写下的同意", async () => {
  setAiAccount("u-A");
  await writeAiSendingEnabled(true);          // A 的同意
  await store.logout();
  expect(aiAccount()).toBe(null);
  expect(useAiSettingsStore().sendingEnabled).toBe(false);
  expect(await readAiSendingEnabled()).toBe(false);   // 无账号 ⇒ 读不到
  setAiAccount("u-A");
  expect(await readAiSendingEnabled()).toBe(true);    // A 回来还是开着
});

it("登录成功 / 恢复会话成功都会设置账号态并重新 load 一次入口状态", async () => {
  // adoptSession 之后 aiAccount() === user.id；aiSettings.load 被调用一次
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/privacy.test.ts src/stores/__tests__/aiSettings.test.ts src/stores/__tests__/auth.test.ts`
Expected: FAIL —— `setAiAccount` 不存在 / 键名不符

- [x] **Step 3: 实现**

`account.ts`（三行 + 注释，注释写明「认证态是模块级唯一状态，与 `api.ts` 的 `baseUrl` 同款」）。

`privacy.ts`：`read` 先判 `aiAccount()`；`write` 无账号直接抛。

`auth.ts`：
- `adoptSession` 里 `setAiAccount(user.id)`，并在其后（`persistSession` 之后即可）`void useAiSettingsStore().load()`
- `restoreSessionOnce` 成功分支同样 `setAiAccount(resp.user.id)` + `load()`；`goGuest()` 里 `setAiAccount(null)`
- `logout`：`setAiAccount(null)`；`aiSettings.reset()`；**删除**原有的 `writeAiSendingEnabled(false)` 及其 try/catch；用动态 import 调 `useAiChatStore().reset()`（照 `resetSyncTimers` 的写法，注释写明为什么用动态 import：避免 `auth → aiChat → stores/recipe → sync → auth` 的静态环）

`aiSettings.ts`：`reset()`；`load()` 里若 `aiAccount() === null` 就 `sendingEnabled=false; status=null; return`（**不发请求**）。

`aiChat.ts`：只加 `reset()`（清 `messages/error` 与内部 `sessionId` 缓存）。

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/ src/stores/ && npm run build`
Expected: 全绿；`vue-tsc` 无错误

- [x] **Step 5: 提交**

```bash
git add src/services/ai/account.ts src/services/ai/privacy.ts src/stores/auth.ts \
  src/stores/aiSettings.ts src/stores/aiChat.ts \
  src/services/ai/__tests__/privacy.test.ts src/stores/__tests__/auth.test.ts \
  src/stores/__tests__/aiSettings.test.ts src/stores/__tests__/aiChat.test.ts
git commit -m "feat(AI): 会话与 opt-in 按账号隔离（退登不清数据、不继承同意）"
```

---

### Task 3: 会话按账号读写 + 历史占位 + 历史缩略图

**Files:**
- Modify: `src/services/ai/session.ts`
- Modify: `src/stores/aiChat.ts`
- Modify: `src/components/ai/ChatBubble.vue`（渲染 `image`）
- Test: `src/services/ai/__tests__/session.test.ts`、`src/stores/__tests__/aiChat.test.ts`、`src/components/ai/__tests__/ChatBubble.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `user_id`、Task 2 的 `aiAccount()`
- Produces:
  - `export const SCREENSHOT_PLACEHOLDER = "[用户发过一张菜谱截图]"`
  - `export function historyText(text: string, hasImage: boolean): string` —— `hasImage` 为真时返回 `text.trim() === "" ? SCREENSHOT_PLACEHOLDER : `${SCREENSHOT_PLACEHOLDER} ${text}``
  - `MessagePayload` 追加可选 `image?: string`（封面缩略图 dataUrl）
  - `loadOrCreateSession(): Promise<string>` —— 读 `aiAccount()`；为 `null` 时 **reject** `new Error("未登录")`；查询/插入都带 `user_id`
  - `ChatMessage` 追加 `image: string | null`
  - `aiChat.send()` 拼历史时用 `historyText(message.text, message.image !== null)`

- [x] **Step 1: 写失败的测试**

`session.test.ts` 追加（既有用例只需在 `beforeEach` 里 `setAiAccount("u-A")`，断言不动）：

```ts
it("两个账号各有一条会话，互不可见", async () => {
  setAiAccount("u-A");
  const a = await loadOrCreateSession();
  await appendMessage(a, msg("user", "A 的问题", null));
  setAiAccount("u-B");
  const b = await loadOrCreateSession();
  expect(b).not.toBe(a);
  expect(await loadMessages(b)).toHaveLength(0);
  setAiAccount("u-A");
  expect((await loadMessages(a)).map((m) => m.content)).toEqual(["A 的问题"]);
});

it("没有账号时不建会话", async () => {
  setAiAccount(null);
  await expect(loadOrCreateSession()).rejects.toThrow("未登录");
});

it("历史占位：有图 + 文字 ⇒ 占位符后接原文；有图无文字 ⇒ 只有占位符；无图 ⇒ 原文", () => {
  expect(historyText("", true)).toBe(SCREENSHOT_PLACEHOLDER);
  expect(historyText("这个怎么做", true)).toBe(`${SCREENSHOT_PLACEHOLDER} 这个怎么做`);
  expect(historyText("找红烧肉", false)).toBe("找红烧肉");
});

it("payload.image 往返仍然整份相等", async () => { /* appendMessage → loadMessages */ });
```

`aiChat.test.ts` 追加：

```ts
it("拼给模型的历史里，带图那一轮是占位符，本地 messages 仍是原文", async () => {
  // loadMessages 返回一条 image = "data:image/jpeg;base64,x"、content = "这个怎么做" 的 user 消息
  // await store.load(); await store.send("第二条")
  // 断言 runAgent 收到的 history[0].content === "[用户发过一张菜谱截图] 这个怎么做"
  // 且 store.messages[0].text === "这个怎么做"
});
```

`ChatBubble.test.ts`（新建）：

```ts
it("有 image 时渲染缩略图，没有时不渲染", () => { /* data-test="ai-bubble-image" */ });
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/session.test.ts src/stores/__tests__/aiChat.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

`session.ts`：`loadOrCreateSession` 里的两条 SQL 都加 `user_id = ?`，`INSERT` 写入 `user_id`；`loadMessages` / `clearMessages` 保持按 `session_id`（会话 id 已经按账号隔离，不必再带 uid）。`historyText` 是纯函数。

`aiChat.ts`：`toChatMessage` 映射 `image: message.payload?.image ?? null`；`send()` 拼 `history` 时用 `historyText(...)`；`load()` / `send()` 在 `aiAccount() === null` 时**直接返回**（不建会话、不抛）—— 未登录的人打开 `/ai` 不能看到未处理的 rejection。

`ChatBubble.vue`：`message.image !== null` 时在文本上方渲染 `<img :src="message.image" data-test="ai-bubble-image" class="mb-1 max-h-40 rounded-xl object-cover" />`。

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/ src/stores/ src/components/ai/ && npm run build`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/services/ai/session.ts src/stores/aiChat.ts src/components/ai/ChatBubble.vue \
  src/services/ai/__tests__/session.test.ts src/stores/__tests__/aiChat.test.ts \
  src/components/ai/__tests__/ChatBubble.test.ts
git commit -m "feat(AI): 会话按账号读写，历史截图轮替换成占位符并保留缩略图"
```

---

### Task 4: 后端 `content` 支持字符串或内容块数组

**Files:**
- Modify: `backend/internal/service/ai.go`
- Modify: `backend/internal/service/ai_test.go`、`backend/internal/handler/ai_test.go`
- Test: 同上

**Interfaces:**
- Consumes: 无
- Produces:
  - `AIMessage.Content` 与 `upstreamMessage.Content` 类型改为 `json.RawMessage`，JSON tag 仍是 `content,omitempty`
  - 语义：字符串透传、数组透传（不解析/不重排/不丢字段）、**字面 `null` 归一成「没有这个键」**

- [x] **Step 1: 写失败的测试**

追加到 `service/ai_test.go`（沿用文件里已有的「假上游捕获原始 JSON」helper）：

```go
// 字符串 content 老路径零回归（既有用例已覆盖，此处只补一条：数组）
func TestAIChatPassesContentBlocksThrough(t *testing.T) {
	// 客户端发 [{"type":"text","text":"看看这张"},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AAA"}}]
	// 断言上游收到的 messages[0].content 解回 []any 后长度 2、类型与 url 逐字段相等
}

// 字面 null ⇒ 转发时**不得**出现 content 键（否则上游判非法）
func TestAIChatTreatsNullContentAsAbsent(t *testing.T) {
	// 请求体 messages: [{"role":"assistant","content":null,"tool_calls":[...]}]
	// 断言上游那条消息的键集只有 role / tool_calls
}
```

`handler/ai_test.go:181` 的既有断言 `svc.gotReq.Messages[0].Content != "你好"` 会因类型改动编译失败 —— 改成
`string(svc.gotReq.Messages[0].Content) != \`"你好"\``（**这是与新规格直接冲突的既有测试，commit 里点名**）。

- [x] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestAI -v`
Expected: FAIL —— 编译错误 / 数组被当成字符串

- [x] **Step 3: 实现**

两个结构体的 `Content` 改 `json.RawMessage`。`upstreamMessages` 里补一步归一：

```go
content := m.Content
if len(content) == 0 || string(content) == "null" {
	content = nil // omitempty 的零值：role+tool_calls 的消息不得多出 content 键
}
```

**不要**解析块内容（保持哑管道）。注释写明「透传是语义等价，不保证字节原样（`json.Marshal` 会 compact 与 HTML 转义）」。

- [x] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./... && go vet ./...`
Expected: PASS（含既有 `TestAIChatForwardsToolCallMessageWithoutContentKey`、`TestAIChatPassesStringContentThrough`、`TestAIChatHandlesNullContent`）

- [x] **Step 5: 提交**

```bash
git add backend/internal/service/ai.go backend/internal/service/ai_test.go backend/internal/handler/ai_test.go
git commit -m "feat(后端): content 放宽为字符串或内容块数组，null 视同缺键"
```

---

### Task 5: `longImage.ts` —— 缩放、分段、封面几何（纯函数）

**Files:**
- Create: `src/services/ai/longImage.ts`
- Test: `src/services/ai/__tests__/longImage.test.ts`

**Interfaces:**
- Consumes: 无（无 DOM、无插件依赖）
- Produces:

```ts
export const MAX_WIDTH = 1080;
export const MAX_SEGMENT_HEIGHT = 1500;
export const SEGMENT_OVERLAP = 120;
export const MAX_SEGMENTS = 6;
export const MAX_SEGMENT_BYTES = 1 << 20;
/** 上游二次归一的像素阈值；段像素数不得超过它（§5.1 的看门） */
export const UPSTREAM_NORMALIZE_PIXELS = 1300 * 1300;

export interface Rect { x: number; y: number; w: number; h: number }
/** `source` 是**原图**坐标；`width/height` 是缩放后的输出尺寸 */
export interface Piece { source: Rect; width: number; height: number }
export interface LongImageLayout {
  width: number;      // 整图缩放后的宽（= min(原宽, 1080)）
  height: number;     // 整图缩放后的高
  cover: Piece | null;
  segments: Piece[];
}
export type LayoutResult =
  | { ok: true; layout: LongImageLayout }
  | { ok: false; reason: "invalid" | "too_long" };

export function planLongImage(size: { width: number; height: number }): LayoutResult;
```

- [x] **Step 1: 写失败的测试**

```ts
it("常量逐字钉死（改了就是换上游，必须连带改看门用例）", () => {
  expect([MAX_WIDTH, MAX_SEGMENT_HEIGHT, SEGMENT_OVERLAP, MAX_SEGMENTS]).toEqual([1080, 1500, 120, 6]);
  expect(MAX_SEGMENT_BYTES).toBe(1048576);
});

it("任意一段的输出像素数都不超过上游归一阈值 1300×1300", () => {
  const layout = planLongImage({ width: 1080, height: 1080 * 9 });
  // 先断言 ok，再逐段断言 width*height <= 1_690_000
  expect(MAX_WIDTH * MAX_SEGMENT_HEIGHT).toBeLessThanOrEqual(UPSTREAM_NORMALIZE_PIXELS);
});

it("宽度大于 1080 才缩；已经是 1080 或更窄时不放大", () => {
  expect(planLongImage({ width: 2160, height: 4000 })).toMatchObject({ ok: true, layout: { width: 1080 } });
  expect(planLongImage({ width: 720, height: 1000 })).toMatchObject({ ok: true, layout: { width: 720 } });
});

it("短图不分段，封面就是整张（高不超过 4/3 宽）", () => {
  const r = planLongImage({ width: 1080, height: 900 });
  // segments.length === 1，cover.height === 900
});

it("相邻段重叠 120px，最后一段可以更短", () => {
  const r = planLongImage({ width: 1080, height: 3000 });
  // seg[0] = 0..1500, seg[1] = 1380..2880, seg[2] = 2760..3000
  // 逐段断言 source.y / height，且相邻两段的输出重叠 = 120
});

it("第 7 段触发拒绝：too_long", () => {
  // 需要 ceil((H-1500)/1380) + 1 > 6 ⇒ H > 1500 + 5*1380 = 8400
  expect(planLongImage({ width: 1080, height: 8401 })).toEqual({ ok: false, reason: "too_long" });
  expect(planLongImage({ width: 1080, height: 8400 })).toMatchObject({ ok: true });
});

it("极端纵横比与 1px 短边不出现 0 边", () => {
  const r = planLongImage({ width: 20000, height: 1000 });   // 横图：缩放、单段
  const t = planLongImage({ width: 60, height: 1200 });      // 1:20
  for (const p of [...r.layout.segments, t.layout.segments[0]]) {
    expect(p.width).toBeGreaterThan(0);
    expect(p.height).toBeGreaterThan(0);
  }
});

it("宽或高为 0 / 负数 ⇒ invalid", () => {
  expect(planLongImage({ width: 0, height: 100 })).toEqual({ ok: false, reason: "invalid" });
  expect(planLongImage({ width: 100, height: 0 })).toEqual({ ok: false, reason: "invalid" });
  expect(planLongImage({ width: -1, height: 100 })).toEqual({ ok: false, reason: "invalid" });
});

it("cover 取顶部第一屏，且在整图范围内", () => {
  const r = planLongImage({ width: 1000, height: 5000 });
  expect(r.layout.cover).toMatchObject({ source: { x: 0, y: 0 }, width: 1000 });
  expect(r.layout.cover!.height).toBeLessThanOrEqual(1333);   // round(1000*4/3)
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/longImage.test.ts`
Expected: FAIL —— 模块不存在

- [x] **Step 3: 实现**

按 §5.1 的几何实现。要点（签名与测试已定，只有取舍需要写清）：

- `scale = Math.min(1, MAX_WIDTH / width)`；`outW = Math.max(1, Math.round(width * scale))`，`outH` 同理
- `step = MAX_SEGMENT_HEIGHT - SEGMENT_OVERLAP`；段在**输出坐标**上算，再除以 `scale` 换回原图坐标（`Math.round`），保证编码时 `drawImage` 的源矩形与输出尺寸一一对应
- 段数 `1 + Math.ceil(Math.max(0, outH - MAX_SEGMENT_HEIGHT) / step)`；`> MAX_SEGMENTS` ⇒ `too_long`
- 封面高 `Math.min(outH, Math.round(outW * 4 / 3))`
- 文件头注释：**这两个尺寸常量是从上游「总像素归一到 1300×1300」反推的**，换供应商要重算，并同步改本文件的看门用例（§5.1 / §6.1）

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/__tests__/longImage.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/services/ai/longImage.ts src/services/ai/__tests__/longImage.test.ts
git commit -m "feat(AI): 长图缩放与分段几何（1080/1500/120/6 段，含像素看门）"
```

---

### Task 6: 文案收口 + `image.ts` 选图、分段编码、封面

**Files:**
- Create: `src/services/ai/attachText.ts`
- Create: `src/services/ai/image.ts`
- Test: `src/services/ai/__tests__/attachText.test.ts`、`src/services/ai/__tests__/image.test.ts`

**Interfaces:**
- Consumes: `planLongImage` / `MAX_*`（Task 5）、`sniffImageMime`（`src/services/imageStore.ts`）、`open` / `readFile`（plugin-dialog / plugin-fs）
- Produces:

```ts
// attachText.ts —— 截图/分享链的用户可见文案，唯一一份
export const MSG_UNSUPPORTED = "只支持 JPEG / PNG / WebP / GIF 图片";
export const MSG_READ_FAILED = "读不到这张图片，请重试";
export const MSG_DECODE_FAILED = "这张图片打不开";
export const MSG_TOO_LARGE = "图片太大，换一张或先裁剪";
export const MSG_TOO_LONG = "这张图太长了，截短一点再发";
export const MSG_NO_STREAM = "这条分享里没有图片";
export const MSG_MULTIPLE_TAKEN = "一次只能收一张，已用第一张";
export type ShareErrorCode = "no_stream" | "read_failed" | "source_too_large";
export function messageForShareCode(code: ShareErrorCode): string;
```

```ts
// image.ts
export interface Screenshot {
  segments: string[];     // 每段 JPEG 的 dataUrl，1..6 个
  cover: string;          // 封面 JPEG 的 dataUrl
  coverBytes: Uint8Array; // 封面原始字节（跳转前交给 imageStore.saveImageBytes）
  width: number;          // 整图缩放后
  height: number;
}
export type ScreenshotResult = { ok: true; shot: Screenshot } | { ok: false; message: string };
/** 解码一次 → 拿着 bitmap 按布局编码；测试注入假实现（happy-dom 没有真 canvas） */
export interface Decoded {
  width: number;
  height: number;
  render(plan: LongImageLayout): Promise<{ segments: string[]; cover: string }>;
}
export interface ScreenshotDeps {
  pick(): Promise<Uint8Array | null>;               // 选择器 + 读字节；null = 用户取消
  decode(bytes: Uint8Array): Promise<Decoded>;
}
export async function toScreenshot(bytes: Uint8Array, deps: Pick<ScreenshotDeps, "decode">): Promise<ScreenshotResult>;
export async function pickScreenshot(deps?: ScreenshotDeps): Promise<ScreenshotResult | null>;
```

- [x] **Step 1: 写失败的测试**

`attachText.test.ts`：三条 code → 逐字文案；`MSG_*` 常量逐字（这些是用户可见文案，钉住）。

`image.test.ts`（注入假 `decode`，不需要真 canvas）：

```ts
const fakeDecoded = (w: number, h: number, segBytes = 200_000): Decoded => ({
  width: w, height: h,
  async render(plan) {
    // 用 'A'.repeat(...) 造出刚好对应字节数的 base64 串（4 字符 = 3 字节）
    return { segments: plan.segments.map(() => jpegDataUrl(segBytes)), cover: jpegDataUrl(100_000) };
  },
});

it("正常长图 ⇒ 6 段以内，段数与 planLongImage 一致", async () => {
  const r = await toScreenshot(pngBytes, { decode: async () => fakeDecoded(1080, 6000) });
  expect(r.ok && r.shot.segments).toHaveLength(5);
});

it("非图片魔数 ⇒ 拒绝，文案逐字", async () => {
  // %PDF- 与随机字节
  expect(r).toEqual({ ok: false, message: MSG_UNSUPPORTED });
});

it("GIF 改名成 .jpg 也接受（只取首帧由解码器决定）", async () => {
  // GIF89a 头 + 假 decode ⇒ ok
});

it("任何一段编码后 > 1 MiB ⇒ 整张拒绝", async () => {
  const r = await toScreenshot(..., { decode: async () => fakeDecoded(1080, 2000, 1 << 20) });
  expect(r).toEqual({ ok: false, message: MSG_TOO_LARGE });
});

it("段数 > 6 ⇒ 拒绝并提示太长了", async () => {
  const r = await toScreenshot(..., { decode: async () => fakeDecoded(1080, 9000) });
  expect(r).toEqual({ ok: false, message: MSG_TOO_LONG });
});

it("解码抛错 ⇒ 「这张图片打不开」，不冒泡", async () => { /* decode rejects */ });

it("pickScreenshot：取消返回 null；读文件失败给「读不到这张图片」", async () => {
  // deps.pick 返回 null / 抛错
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/attachText.test.ts src/services/ai/__tests__/image.test.ts`
Expected: FAIL —— 模块不存在

- [x] **Step 3: 实现**

`attachText.ts`：常量 + `messageForShareCode` 的三分支（`no_stream → MSG_NO_STREAM`、`read_failed → MSG_READ_FAILED`、`source_too_large → MSG_TOO_LARGE`）。

`image.ts`：

1. `toScreenshot`：`sniffImageMime` 认不出 ⇒ 再看 GIF 头（`GIF87a` / `GIF89a`），都不认 ⇒ `MSG_UNSUPPORTED`；`decode` 抛 ⇒ `MSG_DECODE_FAILED`；`planLongImage` 的 `too_long` / `invalid` ⇒ `MSG_TOO_LONG` / `MSG_DECODE_FAILED`；`render` 抛 ⇒ `MSG_DECODE_FAILED`
2. 段体积：`base64Bytes(dataUrl)` 用 `(len - indexOf(",") - 1) * 3 / 4` 估算；任一段 > `MAX_SEGMENT_BYTES` ⇒ `MSG_TOO_LARGE`
3. `coverBytes` = `cover` 的 dataUrl 解码成字节（`atob` 逐字节，照 `imageStore.dataUrlToBytes` 的写法；该函数是私有的，**在新文件里写一份**，不要为它改 `imageStore`）
4. 真实现 `realDeps`：`pick` 用 `open({ filters: [...jpg/jpeg/png/webp/gif], multiple: false })` + `readFile`；`decode` 用 `createImageBitmap`，`render` 按 `Piece.source` 逐段 `drawImage` 到新 canvas，`toDataURL("image/jpeg", SEGMENT_JPEG_QUALITY)`，封面同理；结束后 `bitmap.close()`
5. 文件头注释写明：**新代码只在本文件收口 canvas 与插件**，`imageStore` 的 1280/0.72 是「落盘封面」的规则，与这里的分段参数是两回事，别合并

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/ && npm run build`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/services/ai/attachText.ts src/services/ai/image.ts \
  src/services/ai/__tests__/attachText.test.ts src/services/ai/__tests__/image.test.ts
git commit -m "feat(AI): 截图选图与分段编码，含 1MiB/段与段数闸门"
```

---

### Task 7: 输入区的附件（store + 预览 + 选图接线）

**Files:**
- Modify: `src/stores/aiChat.ts`
- Create: `src/components/ai/AttachmentPreview.vue`
- Modify: `src/components/ai/ChatComposer.vue`
- Modify: `src/views/AiPage.vue`
- Test: `src/stores/__tests__/aiChat.test.ts`、`src/components/ai/__tests__/ChatComposer.test.ts`、`src/components/ai/__tests__/AttachmentPreview.test.ts`（新建）

**Interfaces:**
- Consumes: `Screenshot`（Task 6）、`pickScreenshot`（Task 6）、`MSG_*`（Task 6）
- Produces:
  - store 新增：`attachment: Ref<Screenshot | null>`、`setAttachment(shot: Screenshot | null): void`
  - `send(text)`：`attachment !== null` 时**允许空文字**；取走即清（发送开始就 `attachment = null`）
  - `ChatComposer` props 追加 `attachment: string | null`；emits 追加 `attach: []`、`detach: []`
  - `AttachmentPreview.vue` props `{ image: string }`，emits `{ remove: [] }`
  - `AiPage` 里 `const imageError = ref("")`（选图失败文案，**不复用** `chat.error`）

- [x] **Step 1: 写失败的测试**

```ts
// ChatComposer
it("有附件时允许空文字发送", async () => {
  // props: { disabled:false, sending:false, attachment:"data:image/jpeg;base64,x" }
  // 直接 submit ⇒ emit("send", "")
});
it("没有附件时空文字仍然不发", ...);          // 既有断言，不许改
it("点选图按钮 emit attach；点预览的 ✕ emit detach", ...);
it("disabled 或 sending 时选图按钮也不可用", ...);

// AttachmentPreview
it("渲染缩略图，点 ✕ emit remove", ...);

// store
it("setAttachment 后 send('')：user 消息 content 为空串、payload.image 是封面 dataUrl", ...);
it("发送开始即清空附件（失败也不把图留着）", ...);
it("reset() 清掉附件", ...);
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/aiChat.test.ts src/components/ai/`
Expected: FAIL

- [x] **Step 3: 实现**

- `aiChat.send` 的入口守卫改为 `if (sending.value || (content === "" && attachment.value === null)) return;`，并在 `sending.value = true` 之后立刻 `const shot = attachment.value; attachment.value = null;`
- user 消息的 payload 用 `{ filter: null, matched: 0, items: [], unresolved: { categories: [], tags: [], ingredients: [] }, image: shot.cover }`（本任务先不把 `shot.segments` 交给 `runAgent`，那是 Task 9；**但要在 `send` 里先把它取到局部变量**，供 Task 9 使用）
- `ChatComposer`：输入框左侧加一个按钮（`data-test="ai-attach"`，`aria-label="发送截图"`），`blocked || attachment === null ? ...` 不必；按钮受 `blocked` 约束；`attachment !== null` 时在表单上方渲染 `AttachmentPreview`；`submit()` 的空串判断改为 `content === "" && props.attachment === null`
- `AiPage`：`async function attach()` 调 `pickScreenshot()`；`ok` ⇒ `chat.setAttachment(shot)`；`{ok:false}` ⇒ `imageError = message`；`null` ⇒ 什么都不做。`imageError` 渲染在输入区上方（`data-test="ai-image-error"`），下一次选图或发送时清空

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/stores/ src/components/ai/ src/views/__tests__/AiPage.test.ts && npm run build`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/stores/aiChat.ts src/components/ai/AttachmentPreview.vue src/components/ai/ChatComposer.vue \
  src/views/AiPage.vue src/stores/__tests__/aiChat.test.ts \
  src/components/ai/__tests__/ChatComposer.test.ts src/components/ai/__tests__/AttachmentPreview.test.ts
git commit -m "feat(AI): 输入区的截图附件、预览与选图入口"
```

---

### Task 8: `draft.ts` —— 草稿槽、参数校验、名字解析

**Files:**
- Create: `src/services/ai/draft.ts`
- Modify: `src/services/ai/filter.ts`（`matchId` 加 `export`，不改行为）
- Test: `src/services/ai/__tests__/draft.test.ts`

**Interfaces:**
- Consumes: `Dict` / `matchId`（`filter.ts`）
- Produces:

```ts
export interface DraftIngredient {
  /** "" 表示未落定（配方 §4.4：带进编辑页、拦住保存） */
  ingredient_id: string;
  name: string;
  amount: number | null;
  unit_id: string | null;
  unit_name: string | null;
}
export interface RecipeDraft {
  name: string;
  category_id: string;     // "" = 没对上，编辑页让用户选
  category_name: string;
  tag_ids: string[];
  tag_names: string[];
  ingredients: DraftIngredient[];
  steps: string[];
  cover_path: string | null; // 由 store 在跳转前填
}
export type DraftArgs = { name: string; category?: string; tags?: string[]; ingredients?: { name: string; amount?: number | null; unit?: string | null }[]; steps?: string[] };
export type ValidateDraftResult = { ok: true; args: DraftArgs } | { ok: false; error: string };
export function validateDraftArgs(raw: string): ValidateDraftResult;
export function resolveDraft(args: DraftArgs, dict: Dict): RecipeDraft;
export function setDraft(draft: RecipeDraft): void;
/** 读走即清：读完再取一次是 null */
export function takeDraft(): RecipeDraft | null;
export function clearDraft(): void;
```

- [x] **Step 1: 写失败的测试**

```ts
it("菜名空 / 不是 JSON / 不是对象 ⇒ ok:false（调用方据此回 tool 错误）", ...);
it("amount：0、负数、NaN、字符串 ⇒ 一律 null（不是 0）", ...);
it("食材名字 trim 后为空的行被丢弃", ...);
it("食材多命中 / 零命中 ⇒ ingredient_id 为 \"\"，name 保留 AI 原文", ...);
it("单位未命中 ⇒ unit_id = null，amount 保留", ...);
it("分类未命中 ⇒ category_id = \"\"；标签未命中直接丢弃（不进草稿）", ...);
it("步骤逐条 trim，空串丢弃；多余字段忽略", ...);
it("草稿槽：setDraft → takeDraft 读到 → 第二次是 null；clearDraft 后读不到", ...);
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/draft.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

校验严格按规格 §12.3 的表；`resolveDraft` 复用 `matchId`（精确 → 唯一包含 → 否则 null）。`amount` 只在 `Number.isFinite(n) && n > 0` 时保留。模块级 `let slot: RecipeDraft | null = null`。

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/__tests__/draft.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/services/ai/draft.ts src/services/ai/filter.ts src/services/ai/__tests__/draft.test.ts
git commit -m "feat(AI): 草稿槽、create_recipe_draft 参数校验与名字解析"
```

---

### Task 9: `agent.ts` 双工具 + 内容块组装 + prompt v2

**Files:**
- Modify: `src/services/ai/transport.ts`（只放宽类型）
- Modify: `src/services/ai/agent.ts`
- Modify: `src/services/ai/prompt.ts`
- Test: `src/services/ai/__tests__/transport.test.ts`、`agent.test.ts`、`prompt.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `validateDraftArgs` / `resolveDraft` / `RecipeDraft`
- Produces:
  - `transport.ts`：`export type AiContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>`；`AiMessage.content: AiContent`；`callAiChat` 把入参原样放进 body（**不做组装**）
  - `agent.ts`：
    - `export const DRAFT_TOOL: AiTool`（工具名 `create_recipe_draft`）
    - `export function buildUserContent(text: string, images: string[]): AiContent` —— 无图返回字符串；有图返回 `[text 块（有文字才加）, ...image_url 块]`
    - `runAgent(userText: string, history: AiMessage[], deps: AgentDeps, extra?: { images?: string[] }): Promise<AgentOutcome>`
    - `AgentOutcome` 追加 `draft: RecipeDraft | null`
  - `prompt.ts`：`PROMPT_VERSION = "ai-recipe-v2"`

- [x] **Step 1: 写失败的测试**

`transport.test.ts` 追加：

```ts
it("块数组 content 原样进 body（不组装、不重排）", async () => {
  // callAiChat([{ role:"user", content:[{type:"text",text:"看看"},{type:"image_url",image_url:{url:"data:..."}}] }], [])
  // 断言 apiFetch 收到的 body.messages[0].content 与入参逐字段相等
});
```

`agent.test.ts` 追加：

```ts
it("带图轮：user 消息 content 是块数组，text 块在前、图片块在后", async () => {
  await runAgent("这个怎么做", [], deps, { images: ["data:image/jpeg;base64,A", "data:image/jpeg;base64,B"] });
  // callAiChat 收到的 messages.at(-1).content 深度相等
});

it("带图无文字：不出现空 text 块", ...);

it("无图轮：content 仍是字符串（老路径零回归）", ...);

it("历史消息原样进上下文（图片只在当前轮）", ...);

it("模型调 create_recipe_draft：写草稿、回 tool 结果、不写库", async () => {
  // 断言 outcome.draft.name；断言 deps 上没有任何写库调用（本任务 deps 里没有 db，靠"没有新增依赖"保证）
});

it("草稿参数烂：回 tool 错误并给纠正轮一次机会", ...);

it("同轮同时给 search 与 draft：只执行第一个，另一个回 {\"error\":\"skipped\"}，且每个 tool_call 都有回应", ...);

it("模型嘴上说已收录但没调工具：draft 为 null，text 原样带出（界面不跳转）", ...);
```

`prompt.test.ts` 追加：

```ts
it("prompt 里有 create_recipe_draft 的说明与四条 few-shot", ...);
it("工具描述写明「不得声称已经收录成功」", () => {
  expect(DRAFT_TOOL.function.description).toContain("不得声称已经收录成功");
});
it("prompt 提醒截图里的作者名/点赞数/水印/「展开」不是食材", ...);
it("PROMPT_VERSION 升到 ai-recipe-v2", ...);
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/`
Expected: FAIL

- [x] **Step 3: 实现**

- `agent.ts` 的 `messages` 最后一条改成 `{ role: "user", content: buildUserContent(userText, extra?.images ?? []) }`
- `applyToolCalls` 改成按名字分派：`search_recipes` / `create_recipe_draft`；只执行**第一个**可识别且未执行过的，其余 `{"error":"skipped"}`；不可识别 ⇒ `{"error":"unknown_tool"}`；参数校验失败 ⇒ `{"error":"bad_arguments"}`（让模型纠正一次）；draft 成功时回 `{"ok":true}` 一句，**不要**把草稿回灌给模型（它已经知道了，回灌只会诱导它复述）
- `DRAFT_TOOL.function.description` 必须含：「把识别出的菜谱写成草稿，等用户确认保存；**不得声称已经收录成功**」；参数的 JSON Schema 与 `DraftArgs` 对齐
- `prompt.ts`：工具段从「一个工具」改成两个；few-shot 至少五条（`找有五花肉的菜`→search、`今晚想吃辣的下饭的`→search、`（长截图）`→draft、`我库里有哪些分类`→直接答、`半小时能做完的`→直说做不到）；补一句截图噪声警告；`PROMPT_VERSION` 改 `ai-recipe-v2`
- `transport.ts` 仅改类型与注释（注释写明「块数组由 `agent.buildUserContent` 组装，transport 只透传」）

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/ && npm run build`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/services/ai/transport.ts src/services/ai/agent.ts src/services/ai/prompt.ts \
  src/services/ai/__tests__/transport.test.ts src/services/ai/__tests__/agent.test.ts \
  src/services/ai/__tests__/prompt.test.ts
git commit -m "feat(AI): create_recipe_draft 工具、图片内容块组装与 prompt v2"
```

---

### Task 10: 发送链收口 —— 图进请求、草稿进槽、封面落盘、跳编辑页

**Files:**
- Modify: `src/stores/aiChat.ts`
- Modify: `src/views/AiPage.vue`
- Test: `src/stores/__tests__/aiChat.test.ts`、`src/views/__tests__/AiPage.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `attachment`、Task 9 的 `runAgent(..., extra)` / `AgentOutcome.draft`、Task 8 的 `setDraft`、`saveImageBytes`（`imageStore`）
- Produces:
  - store 新增 `draftReady: Ref<boolean>` 与 `clearDraftReady(): void`（读走即清）
  - `send()` 的顺序写死：取附件 → 落 user 消息（含 `payload.image`）→ `runAgent(..., { images: shot.segments })` → 落 assistant 消息 → 有 draft 时：先 `saveImageBytes(shot.coverBytes)` 拿 `cover_path`（失败 ⇒ `null`）→ `setDraft({ ...draft, cover_path })` → `draftReady = true`
  - `AiPage`：`watch(() => chat.draftReady, ...)` 为真时 `chat.clearDraftReady()` 后 `router.push("/recipe/new")`

- [x] **Step 1: 写失败的测试**

```ts
// store
it("有附件时 runAgent 收到 segments，且 user 消息带封面缩略图", ...);
it("草稿产生时写进草稿槽、cover_path 来自 saveImageBytes", ...);
it("封面落盘失败：草稿照写、cover_path 为 null、draftReady 仍为 true", ...);
it("模型没给草稿：不写槽、draftReady 保持 false", ...);
it("send 抛错时不留半条 assistant 消息，也不写草稿槽", ...);   // 既有断言的延伸

// AiPage
it("draftReady 为真时跳 /recipe/new，且只跳一次", ...);
it("选图失败显示文案，不清空已有输入", ...);
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/stores/__tests__/aiChat.test.ts src/views/__tests__/AiPage.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

按 Interfaces 的顺序写。`saveImageBytes` 返回 `{ok:false}` 时只 `console.warn`（不打断），`cover_path = null`。
**`agent` 不接触 store、不接触 router**：它只返回 `draft`，写槽与跳转都在这一层。

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/stores/ src/views/__tests__/AiPage.test.ts && npm run build`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/stores/aiChat.ts src/views/AiPage.vue src/stores/__tests__/aiChat.test.ts \
  src/views/__tests__/AiPage.test.ts
git commit -m "feat(AI): 截图轮跑通到编辑页，草稿只写内存槽、封面在跳转前落盘"
```

---

### Task 11: `RecipeEdit` 预填 + 未落定食材拦截

**Files:**
- Modify: `src/views/RecipeEdit.vue`
- Test: `src/views/__tests__/RecipeEdit.test.ts`（追加用例，不动已有断言）

**Interfaces:**
- Consumes: `takeDraft` / `RecipeDraft`（Task 8）
- Produces: 无新导出；页面行为：
  - 新建模式 `onMounted` 先 `takeDraft()`，有草稿就填表单（在 `initial.value = snapshot()` **之前**，否则一进页面就是「有未保存改动」）
  - 未落定行（`ingredient_id === ""`）可点：打开 `RefSheet`（食材单选），选中后只替换 id/name
  - 保存时任何一行 `ingredient_id` 为空 ⇒ 错误文案「这几样食材没对上，点一下选一个」

- [x] **Step 1: 写失败的测试**

```ts
it("有草稿时新建页被预填：菜名/分类/标签/食材/步骤/封面", async () => {
  // setDraft({...}) 后挂载 /recipe/new
  // 断言 name 输入框、分类名、tag chip、食材行文案、步骤 textarea、ImagePicker 的 modelValue
});

it("草稿读走即清：第二次挂载不再预填", async () => { /* 重新 mount，表单是空的 */ });

it("未落定食材行显示「待选」，点它开 RefSheet，选中后保留数量与单位", async () => {
  // 断言 ingredient-row-name 变成选中的名字、amount 文案不变
});

it("有未落定行时点保存 → 报「这几样食材没对上，点一下选一个」，store.create 未被调用", ...);

it("全部落定后可以正常保存（食材行带 ingredient_id）", ...);

it("编辑模式不消费草稿槽（只在新建页取）", async () => {
  // setDraft 后进 /recipe/:id/edit ⇒ takeDraft 未被调用 / 槽还在
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/views/__tests__/RecipeEdit.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

- `fillDraft(draft: RecipeDraft)`：填 `form`，`labelNames` 用 `draft.category_name` / `draft.tag_names`；食材行 `key: nextKey()`、`ingredient_name: line.name`、`amount`、`unit_id`、`unit_name`
- `resolvingIndex = ref<number | null>(null)`；食材行在 `line.ingredient_id === ""` 时加 `data-test="ingredient-row-unresolved"`、右侧显示「待选」、整行可点；追加一个 `<RefSheet :visible="resolvingIndex !== null" title="选择食材" :store="ingredientStore" mode="single" :selected-ids="[]" empty-hint="还没有食材，输入名称即可新建" @close="resolvingIndex = null" @select="resolveIngredient" />`。⚠️ 现有的「+ 添加食材」用的 `IngredientSheet` 不动（它负责「选食材 + 数量 + 单位」三步，这里只需要换一个 id）
- `buildInput()` 在 `cleanAmount` 之前加：`if (line.ingredient_id === "") return { error: "这几样食材没对上，点一下选一个" };`
- 不给未落定行做「静默新建」：RefSheet 的「+ 创建」是用户显式点的，属于允许路径（§4.4）

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/views/__tests__/RecipeEdit.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/views/RecipeEdit.vue src/views/__tests__/RecipeEdit.test.ts
git commit -m "feat(编辑页): 草稿预填与未落定食材行，保存前必须落定"
```

---

### Task 12: Android 分享目标（Manifest + `MainActivity` + capabilities）

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/AndroidManifest.xml`
- Modify: `src-tauri/gen/android/app/src/main/java/cn/tuzkimo/wee_cook/MainActivity.kt`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: 无（原生 → JS 的文件契约见 Task 13）
- Produces:
  - `<cacheDir>/share-inbox/pending.json` + `<uuid>.bin`
  - `pending.json` 形状（v1，逐字）：
    ```json
    { "v": 1, "kind": "image", "file": "<uuid>.bin", "count": 2 }
    { "v": 1, "kind": "error", "code": "no_stream" | "read_failed" | "source_too_large", "id": "<uuid>" }
    ```

- [x] **Step 1: 改 Manifest**

给 `.MainActivity` 追加两个 `intent-filter`（各带 `DEFAULT` 分类）：

```xml
<intent-filter>
  <action android:name="android.intent.action.SEND" />
  <category android:name="android.intent.category.DEFAULT" />
  <data android:mimeType="image/*" />
</intent-filter>
<intent-filter>
  <action android:name="android.intent.action.SEND_MULTIPLE" />
  <category android:name="android.intent.category.DEFAULT" />
  <data android:mimeType="image/*" />
</intent-filter>
```

`launchMode="singleTask"` / `exported="true"` **已经是现状，不要动**。

- [x] **Step 2: 改 `MainActivity.kt`**

按分享目标规格 §4 / §6 移植，**去掉它 §4.5 的整套会话记录**（本仓没有自动锁，见规格 §12.4）。必须有的：

1. 常量：`SHARE_DIR = "share-inbox"`、`PENDING = "pending.json"`、`SHARE_SOURCE_MAX_BYTES = 8 * 1024 * 1024`（注释写明**必须大于**压缩后 1 MiB）、`STATE_HANDLED_SHARE = "weeCook.handledShare"`、日志 tag `"WeeCook/Share"`
2. `onCreate`：`super` 之后 → `shareDir().mkdirs()` → 按**分享指纹**（`action|type|第一张图 URI`）与 `savedInstanceState` 里恢复的指纹比较，不是同一份才 `dispatchSharedImage(intent)`。⚠️ 不能只认 `savedInstanceState == null`：Activity 被系统回收后重建时，**新的**分享也是从 `onCreate` 进来的
3. `onSaveInstanceState`：存已投递的指纹
4. `onNewIntent`：签名逐字 `override fun onNewIntent(intent: Intent)`，**总是**处理（`singleTask` 复用实例 ⇒ 一定是新的一次），并 `super.onNewIntent(intent)` + `setIntent(intent)`
5. 拷贝放在**单线程池**（`Executors.newSingleThreadExecutor()`）：`EXTRA_STREAM`（`SEND_MULTIPLE` 取第一张并记 `count`）→ `contentResolver.openInputStream` **边读边判** 8 MiB → 写 `<uuid>.bin` → 成功后 `sweepOrphanBinaries(keep)`（只删 `.bin`，只在这条成功路径上跑）→ **删旧 pending 引用的文件** → 原子写 `pending.json`（先写 `.tmp` 再 rename）
6. 失败路径写 `{v:1, kind:"error", code, id: UUID}`（`id` 是去重键，必须是唯一值）；`writeAtomicJson` 整体包 `runCatching` + `Log.w`
7. **不写** `wee-session/`、`session.json`、`reconcileTask()`、`onStop` / `onDestroy` 的记录逻辑
8. 不写任何用户可见中文：只出 code，文案在 JS

- [x] **Step 3: 改 capabilities**

`src-tauri/capabilities/default.json` 追加：

```json
{ "identifier": "fs:allow-remove", "allow": [{ "path": "$APPCACHE/share-inbox/*" }] }
```

读取**不加权限**：`fs:default` 的 `read-app-specific-dirs-recursive` 已覆盖 `$APPCACHE` 递归读（分享目标规格 §2 已核实）。**不要**顺手加 `$APPCONFIG/*` 之类的宽口径。

- [x] **Step 4: 验证（本环境只能做到这一步）**

> 收尾时重跑：三处 grep 均命中，`cargo check` 无输出即通过。Kotlin 编译与真机行为仍留待 Task 14 Step 4（未执行）。

Run:
```bash
cd D:/projects/my/wee-cook && grep -n "action.SEND\|share-inbox\|allow-remove" \
  src-tauri/gen/android/app/src/main/AndroidManifest.xml \
  src-tauri/gen/android/app/src/main/java/cn/tuzkimo/wee_cook/MainActivity.kt \
  src-tauri/capabilities/default.json && cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: 三处都能 grep 到；`cargo check` 无错误（Rust 侧未改动，只确认没被带坏）。
**Kotlin 编译与真机行为在本环境验不了**（rootless Docker 与本机 Android SDK 限制），列为 Task 14 的手动验收项。

- [x] **Step 5: 提交**

```bash
git add src-tauri/gen/android/app/src/main/AndroidManifest.xml \
  src-tauri/gen/android/app/src/main/java/cn/tuzkimo/wee_cook/MainActivity.kt \
  src-tauri/capabilities/default.json
git commit -m "feat(Android): 注册图片分享目标，按 pending.json 契约投递到 share-inbox"
```

---

### Task 13: `shareIntake.ts` 拉取与消费 + App 接线

**Files:**
- Create: `src/services/ai/shareIntake.ts`
- Modify: `src/App.vue`
- Modify: `src/stores/aiChat.ts`（`notice`）、`src/views/AiPage.vue`（渲染 notice）
- Test: `src/services/ai/__tests__/shareIntake.test.ts`

**Interfaces:**
- Consumes: Task 12 的文件契约、Task 6 的 `toScreenshot` / `messageForShareCode` / `MSG_MULTIPLE_TAKEN` / `MSG_NO_STREAM`
- Produces:

```ts
export type PendingPayload =
  | { v: 1; kind: "image"; file: string; count: number }
  | { v: 1; kind: "error"; code: ShareErrorCode; id: string };
/** 纯函数：形状/版本不认 ⇒ null（调用方按 read_failed 处理并消费） */
export function parsePending(raw: string): PendingPayload | null;

export interface ShareIntakeDeps {
  readPending(): Promise<string | null>;                    // 不存在 ⇒ null；其它读错误必须抛
  readBytes(file: string): Promise<Uint8Array>;
  consume(payload: PendingPayload | null, raw: string): Promise<void>;
  toScreenshot(bytes: Uint8Array): Promise<ScreenshotResult>;
  setAttachment(shot: Screenshot): void;
  setNotice(text: string): void;
  pushAi(): void;
}
export type IntakeOutcome = "none" | "attached" | "failed";
export async function intakeShare(deps: ShareIntakeDeps): Promise<IntakeOutcome>;

/** 注册拉取点：首次、visibilitychange、tauri://resumed、扑空后补一次（1200ms）、单飞；返回卸载函数 */
export function startShareIntake(deps: ShareIntakeDeps & { retryDelayMs?: number }): () => void;
```

- [x] **Step 1: 写失败的测试**

```ts
it("没有 pending ⇒ \"none\"，readBytes/consume/setAttachment 一次都没调", ...);
it("kind:image ⇒ 附加 + 消费 + pushAi；pending 与 file 都删", ...);
it("count > 1 ⇒ 附件照附，notice 逐字 = MSG_MULTIPLE_TAKEN", ...);
it("读图失败 / 图坏了 ⇒ 消费 + 对应文案 + pushAi（失败也要跳 AI 页，否则用户什么都看不到）", ...);
it("三个 error code ⇒ 各自文案，消费；console.warn 不带 URI", ...);
it("坏 JSON / v:2 / 未知 kind ⇒ 按 read_failed 处理并消费；紧接第二次调用是 \"none\"（防死循环）", ...);
it("同一份原文不重复处理（模块内去重）", ...);
it("consume 抛错 ⇒ console.warn，仍按成功返回，不把异常抛给调用方", ...);
it("单飞：并发两次 intakeShare ⇒ readPending 只走一次", ...);
it("parsePending 只挑已知键：多一个 id 之外的键不影响结果", ...);
it("startShareIntake：扑空后补一次重拉；补拉仍扑空不再排（不是轮询）", ...);
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/ai/__tests__/shareIntake.test.ts`
Expected: FAIL

- [x] **Step 3: 实现**

`shareIntake.ts` 按分享目标规格 §5.3 / §5.4 移植，**删掉 `isLocked`**（本仓没有锁）：

- `parsePending` 只挑 `v/kind/code/file/count`；`v !== 1` 或无 `kind` ⇒ `null`
- `consume` 的实现（在 `App.vue` 里，或本文件导出 `realDeps`）三步走：**先复核**（重读 pending 与手上的 `raw` 逐字比较，不一致或读失败 ⇒ 一个文件都不删）→ **删 `pending.json`** → **最后删图**
- 模块内 `consumedRaw`（只在内存）+ `inFlight` 单飞
- `realDeps`：`readTextFile` / `readFile` / `remove` 全部 `{ baseDir: BaseDirectory.AppCache }`，路径 `share-inbox/...`
- `startShareIntake`：初次 + `document.visibilitychange`（`visible`）+ `TauriEvent.WINDOW_RESUMED`（非 Tauri 环境静默跳过）+ 扑空后按 `retryDelayMs`（默认 1200）补一次；`attached` / `failed` 不补
- `App.vue`：`onMounted` 里 `const stop = startShareIntake({ ...realDeps, pushAi: () => { if (route.path !== "/ai") void router.push("/ai") } })`，`onUnmounted(stop)`
- `aiChat` 加 `notice: Ref<string | null>` + `setNotice(text)`；`AiPage` 在输入区上方渲染（`data-test="ai-share-notice"`）

- [x] **Step 4: 跑测试确认通过**

Run: `npm run test -- src/services/ai/ && npm run build`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add src/services/ai/shareIntake.ts src/App.vue src/stores/aiChat.ts src/views/AiPage.vue \
  src/services/ai/__tests__/shareIntake.test.ts
git commit -m "feat(Android): 分享图的拉取、附加与消费（compare-and-delete，无锁）"
```

---

### Task 14: 收尾验证 + 手动验收清单

**Files:** 无代码改动（只更新本文件的勾选与 `docs/` 里已有的自托管说明，如与实现不符再改）

- [x] **Step 1: 全套自动化验证**

```bash
npm run test
npm run build
cd backend && go test ./... && go vet ./...
cd .. && cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: 全绿；`vue-tsc` 无错误；`go vet` 无输出

- [x] **Step 2: 对着规格 §9 核覆盖**

本刀负责 §9 的 1～10、11～17（后端在 v0.7.0 已覆盖，Task 4 只补 12）、18～24。逐条打勾；缺哪条就在对应任务里补测试，别在收尾里补。

- [ ] **Step 3: 桌面端手动验收（可以本机做）**

> 本环境未执行：本轮只做了自动化验证（Step 1）与规格 §9 覆盖核对（Step 2），六条手动项一条都没跑，留待人工在桌面上过。

`npm run tauri dev` → 「我的」打开 AI → `/ai` 点选图 → 选一张长截图：

1. 输入区出现缩略图；点发送后模型返回草稿，**自动跳到新建菜谱页**
2. 编辑页菜名/分类/标签/步骤/食材都在；AI 没对上的食材行显示「待选」
3. 直接点保存 ⇒ 报「这几样食材没对上，点一下选一个」，**库里没有多出任何食材或菜谱**
4. 点未落定行选一个已有食材 ⇒ 保存成功，详情页的食材数量与单位与截图一致
5. 发一张非菜谱图 ⇒ 停在聊天页，没有跳转，也没有新菜谱
6. 换一个账号登录 ⇒ `/ai` 是空历史、开关是关的；换回原账号 ⇒ 历史与开关恢复（**Review Focus 1**）

- [ ] **Step 4: Android 真机手动验收（本环境做不了，必须留给真机）**

> 留待真机：本环境无法编译 Kotlin、也无法安装到设备，六条全部未执行。

标记为**手动**，逐条记录结果：

1. 从相册/小红书分享一张长截图到「一起做饭」⇒ 落在 `/ai`，输入区有缩略图（冷启动与热启动各一次）
2. 分享一张 8000px 以上的长图 ⇒ 提示「这张图太长了，截短一点再发」，且**下次进前台不再重复弹**
3. 分享多张图 ⇒ 只取第一张 + 一行提示
4. 分享过程中杀掉进程再回来 ⇒ 图不丢（`pending.json` 还在），也不重复附加
5. 拍照/相册选图走系统选择器仍正常（`ImagePicker` 未被改动）
6. `adb logcat -s WeeCook/Share` 能看到落盘/清理日志，且**不含图片 URI 或内容**

- [x] **Step 5: 提交**

```bash
git add docs/superpowers/plans/2026-10-17-ai-screenshot-plan.md
git commit -m "docs: 第 3、4 刀执行结果与真机验收记录"
```

---

## 自审记录（写计划时已核）

- 规格 §9 第 1、3、5、6、7、8、18～24 条都在 Task 5～13 里有归属；第 11～17 条由 v0.7.0 的用例承担，Task 4 只补第 12 条
- 常量只有一个来源（`longImage.ts`）；`image.ts` 与后端 handler 都从那里 import/引用，不各写一份
- `AiMessage.content` 的类型在 Task 9 一次改完；Task 7 不发图片，避免中间态出现「块数组没类型」的编译红
- 草稿槽只在 Task 8 定义、Task 10 写入、Task 11 消费；没有第二处写库路径
- 分享链的`consume` 顺序（复核 → 删 pending → 删图）与分享目标规格一致，且**没有**引入本仓不存在的自动锁
