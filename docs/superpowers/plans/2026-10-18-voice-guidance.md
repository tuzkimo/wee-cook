# 语音指导模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 菜谱详情页进入全屏指导模式，常开麦克风、听「小厨」开头的短句，用本地菜谱数据回答用量与步骤，并朗读出来。

**Architecture:** 三个服务层文件（语音识别封装 / 常亮屏封装 / 朗读封装）+ 一个纯函数答案解析 + 一个页面。识别与朗读都委托 Android 系统能力（`SpeechRecognizer` / `TextToSpeech`），经社区插件；常亮屏用自写 Kotlin 插件（第三方无 Android 实现）。**零网络、零后端、零模型、零数据库写入。**

**Tech Stack:** Vue 3 + TypeScript（严格模式）+ Tauri 2（Android）+ `tauri-plugin-stt` 0.2.2 + `tauri-plugin-tts` 0.2.1 + Kotlin（仅常亮屏）。

**Spec:** `docs/superpowers/specs/2026-10-18-voice-guidance-design.md`（下称**规格**）

## Global Constraints

- TypeScript 严格模式，禁止 `any`。
- 测试优先：新增功能必须带单元测试；不得删改已有测试。
- 不重构无关代码；除本计划列出的文件外不改动其它文件。
- 指导模式**全程只读**：不写数据库、不写文件、不发业务网络请求、音频不落盘。
- 唤醒词固定 `小厨`；`interimResults: false`，只对 final 结果应答。
- 插件版本钉死：`tauri-plugin-stt` / `tauri-plugin-stt-api` = `0.2.2`，`tauri-plugin-tts` / `tauri-plugin-tts-api` = `0.2.1`。**不用 `^`**。
- 桌面端不实现语音：一律降级为「不可用」，页面照常可用。
- commit message 用中文，符合中文开发习惯。

## Review Focus

1. **麦克风权限被永久拒绝** → 用户应该看到一句「去系统设置开麦克风」，而不是一个永远在失败重试的红条。测试落在 Task 3。
2. **没有步骤的菜谱** → 页面不能白屏，翻步按钮禁用，语音只答食材。测试落在 Task 2 + Task 3。
3. **识别服务不存在 / 桌面端** → 步骤仍可看、可手动翻。测试落在 Task 1（`isSpeechAvailable`）+ Task 3（页面降级）。
4. **没听到唤醒词、或「小厨」被识别成别的字** → 安静丢弃，绝不出声。测试落在 Task 2（返回 `null`）。
5. **离开页面后还有残留监听** → `unmount` 时必须调用 `handle.stop()` 与 `stopSpeaking()`。测试落在 Task 3。

---

### Task 1: 原生接线 + 语音/常亮屏封装 + 真机验证门

本任务是整个功能的**门禁**：`EXTRA_SECURE` 在真机上的行为通过验证之前，后面的任务不该开始。

**Files:**
- Modify: `package.json`、`src-tauri/Cargo.toml`、`src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`
- Create: `src/services/voice/speech.ts`、`src/services/voice/keepAwake.ts`、`src/services/voice/__tests__/speech.test.ts`
- Create: `src-tauri/gen/android/app/src/main/java/cn/tuzkimo/wee_cook/KeepAwakePlugin.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/cn/tuzkimo/wee_cook/MainActivity.kt`
- Modify（临时，Task 3 删除）：`src/views/MePage.vue`

**Interfaces:**
- Consumes: 无（本任务是第一环）
- Produces:
  - `src/services/voice/speech.ts`
    ```ts
    export type SpeechErrorKind = "permission" | "unavailable" | "transient";
    export interface SpeechHandle { stop(): Promise<void> }
    export function isSpeechAvailable(): Promise<boolean>;
    export function startSpeech(
      onResult: (text: string) => void,
      onError: (kind: SpeechErrorKind, message: string) => void,
    ): Promise<SpeechHandle>;
    ```
  - `src/services/voice/keepAwake.ts`
    ```ts
    /** Android 常亮屏；其它平台静默 no-op，永不 reject */
    export function keepScreenOn(on: boolean): Promise<void>;
    ```

- [ ] **Step 1: 装依赖（钉死版本）**

```bash
npm install --save-exact tauri-plugin-stt-api@0.2.2 tauri-plugin-tts-api@0.2.1
cd src-tauri && cargo add tauri-plugin-stt@=0.2.2 tauri-plugin-tts@=0.2.1
```

- [ ] **Step 2: 注册插件**

`src-tauri/src/lib.rs` 的 `Builder::default()` 链上加两行（顺序无关，放在 `tauri_plugin_store` 之后）：

```rust
.plugin(tauri_plugin_stt::init())
.plugin(tauri_plugin_tts::init())
```

- [ ] **Step 3: 加权限**

`src-tauri/capabilities/default.json` 的 `permissions` 数组追加两项：`"stt:default"`、`"tts:default"`。

- [ ] **Step 4: 桌面构建验证**

Run: `cd src-tauri && cargo check`
Expected: 通过。**若失败**且报错来自 `whisper-rs` / `cmake` / 未知权限标识，按规格 §3 的决策把两个 `.plugin(...)` 用 `#[cfg(mobile)]` 门控（桌面端本来就不做语音），再重跑一次，通过后继续。

- [ ] **Step 5: 写常亮屏 Kotlin 插件**

`src-tauri/gen/android/app/src/main/java/cn/tuzkimo/wee_cook/KeepAwakePlugin.kt`（整文件）：

```kotlin
package cn.tuzkimo.wee_cook

import android.view.WindowManager
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@TauriPlugin
class KeepAwakePlugin(private val activity: android.app.Activity) : Plugin(activity) {
    @Command
    fun start(invoke: Invoke) {
        activity.runOnUiThread {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            invoke.resolve()
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        activity.runOnUiThread {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            invoke.resolve()
        }
    }
}
```

`MainActivity.kt` 的 `onCreate` 里、`super.onCreate(savedInstanceState)` 之前加一行：

```kotlin
registerPlugin(KeepAwakePlugin::class.java)
```

- [ ] **Step 6: 写 `keepAwake.ts`**

`keepScreenOn(on)` 调 `invoke("plugin:keep-awake|start")` / `"plugin:keep-awake|stop"`（`@tauri-apps/api/core` 的 `invoke`），整个函数体包在 `try { } catch { }` 里，**永不 reject**：桌面端没有这个插件，抛错是正常的。

插件名由类名推导（`KeepAwakePlugin` → `keep-awake`）。若 Step 12 发现常亮不生效，logcat 里会直接列出已注册的插件名，按实际名字改正 `keepAwake.ts` 里的两个字符串即可。

- [ ] **Step 7: 写 `speech.ts` 的失败测试**

`src/services/voice/__tests__/speech.test.ts`，用 `vi.hoisted` + `vi.mock("tauri-plugin-stt-api", ...)` 提供 `isAvailable / startListening / stopListening / onResult / onError` 五个桩。断言：

```ts
it("isAvailable 返回 available:false 时视为不可用", ...)          // → false
it("isAvailable 抛错（桌面端无插件）时视为不可用", ...)              // → false，不冒泡
it("插件 error code 为 PERMISSION_DENIED 时报 permission", ...)     // onError 收到 "permission"
it("插件 error code 为 NO_SPEECH 时报 transient", ...)              // onError 收到 "transient"
it("插件 error code 为 NOT_AVAILABLE 时报 unavailable", ...)        // onError 收到 "unavailable"
it("startSpeech 以 continuous:true / interimResults:false / language zh-CN 启动", ...)
it("stop() 会调用 stopListening", ...)
```

- [ ] **Step 8: 跑测试确认失败**

Run: `npm run test -- src/services/voice/__tests__/speech.test.ts`
Expected: FAIL，`speech.ts` 不存在 / 导不出对应函数。

- [ ] **Step 9: 实现 `speech.ts`**

要点（签名见 Interfaces）：
- `isSpeechAvailable()`：`isAvailable()` → `res.available`；任何异常 → `false`
- `startSpeech()`：先 `onResult` 订阅（**只接受 `isFinal === true`**，其余丢弃），再 `onError` 订阅并按码分流（`PERMISSION_DENIED` / `SPEECH_PERMISSION_DENIED` → `permission`；`NOT_AVAILABLE` / `LANGUAGE_NOT_SUPPORTED` → `unavailable`；其它 → `transient`），最后 `startListening({ language: "zh-CN", continuous: true, interimResults: false })`
- 返回的 `handle.stop()`：取消两个监听（保存 `onResult`/`onError` 返回的 `UnlistenFn`）再 `stopListening()`；**幂等**（重复调用不抛）
- 文件内不 export 任何插件类型，页面层不 import 插件

- [ ] **Step 10: 跑测试**

Run: `npm run test -- src/services/voice/__tests__/speech.test.ts`
Expected: PASS（7 条）

- [ ] **Step 11: 加临时自检按钮（Task 3 会删掉）**

`src/views/MePage.vue` 顶部加一个 `data-test="voice-smoke"` 按钮，`@click` 时：`keepScreenOn(true)` → `startSpeech(console.log, console.warn)`，把识别到的文字写到按钮下方的 `<p data-test="voice-smoke-text">`，并把 `handle` 存在 `ref` 里（再点一次就 stop）。10 行以内，**不放任何样式打磨**。

- [ ] **Step 12: 真机验证门（人工步骤，必须做）**

```bash
npm run tauri android dev
```

在手机上点「语音自检」，说「小厨，面粉多少」。判定：

- **Expected A**：`npm` 终端里 `adb logcat` 出现 `onResults` / 页面显示识别文字 → 门通过，继续 Step 13
- **Expected B**：日志里只有 `Speech recognition error`、或识别立刻失败 → **停下来，不要继续后面的任务**，报告这一结果并按规格 §7.7 走出口（fork `tauri-plugin-stt` 删掉 `EXTRA_SECURE` 那一行，或自写 Kotlin 桥）
- 同时确认屏幕在 30 秒后**没有自动变暗**（`FLAG_KEEP_SCREEN_ON` 生效）

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs \
  src-tauri/capabilities/default.json src-tauri/gen/android/app/src/main/java/cn/tuzkimo/wee_cook/ \
  src/services/voice src/views/MePage.vue
git commit -m "feat(语音): 接入系统语音识别与朗读插件，补常亮屏 Kotlin 插件"
```

---

### Task 2: `answerQuestion` 答案解析纯函数

本任务是整个功能里唯一的业务逻辑，也是唯一能脱离真机验证的部分。

**Files:**
- Create: `src/services/voice/answer.ts`
- Test: `src/services/voice/__tests__/answer.test.ts`

**Interfaces:**
- Consumes: `RecipeIngredientRow` / `RecipeStep`（`src/types/index.ts`）、`amountText`（`src/utils/amount.ts`）
- Produces:
  ```ts
  export interface AnswerContext {
    ingredients: RecipeIngredientRow[];
    steps: RecipeStep[];      // 已按 sort_order 排好
    currentStep: number;      // 0-based
  }
  export interface Answer {
    text: string;             // 要念出来的话
    step?: number;            // 命中步骤跳转时给出，0-based
  }
  /** null = 不是在叫它（无唤醒词 / 空文本） */
  export function answerQuestion(transcript: string, ctx: AnswerContext): Answer | null;
  ```

- [ ] **Step 1: 写失败测试**

`src/services/voice/__tests__/answer.test.ts`。固定夹具：

```ts
const ingredients = [
  { id: "1", ingredient_name: "低筋面粉", amount: 200, unit_name: "克" },
  { id: "2", ingredient_name: "盐", amount: 3, unit_name: "克" },
  { id: "3", ingredient_name: "鸡胸肉", amount: 300, unit_name: "克" },
  { id: "4", ingredient_name: "鸡蛋", amount: 2, unit_name: "个" },
  { id: "5", ingredient_name: "淀粉", amount: 20, unit_name: "克" },
  { id: "6", ingredient_name: "食用油", amount: null, unit_name: null },
] as RecipeIngredientRow[];
const steps = [
  { text: "鸡胸肉切丁，加盐和淀粉抓匀，腌 10 分钟" },
  { text: "热锅下油，油温六成热下鸡丁滑散，约 2 分钟" },
  { text: "倒掉多余的油，留底油下配料" },
  { text: "大火翻炒均匀出锅" },
] as RecipeStep[];
```

用例（每条一个 `it`，共 22 条）：

| # | transcript | ctx | 期望 |
| --- | --- | --- | --- |
| 1 | `"面粉多少"` | 默认，currentStep 0 | `null` |
| 2 | `""` | 默认 | `null` |
| 3 | `"小厨"` | 默认 | `text` 含「在」 |
| 4 | `"小厨，面粉多少"` | 默认 | `text === "低筋面粉，200 克"`，无 `step` |
| 5 | `"小厨，低筋面粉多少"` | 默认 | 同上 |
| 6 | `"小厨，盐放多少"` | 默认 | `text === "盐，3 克"` |
| 7 | `"小厨，面粉和盐各多少"` | 默认 | `text` 同时含「低筋面粉，200 克」与「盐，3 克」 |
| 8 | `"小厨，面粉盐鸡肉鸡蛋淀粉各多少"` | 默认 | `text` 含前三个（低筋面粉/盐/鸡胸肉），且含「还有 2 样」 |
| 9 | `"小厨，食用油呢"` | 默认 | `text === "食用油，适量"` |
| 10 | `"小厨，第三步是什么"` | 默认 | `step === 2`，`text` 为 steps[2].text |
| 11 | `"小厨，第3步"` | 默认 | `step === 2` |
| 12 | `"小厨，第十步"` | 默认 | `text === "现在只有 4 步"`，无 `step` |
| 13 | `"小厨，下一步"` | currentStep 0 | `step === 1`，`text` 为 steps[1].text |
| 14 | `"小厨，继续"` | currentStep 0 | 同 13 |
| 15 | `"小厨，上一步"` | currentStep 0 | `text` 含「已经是第一步」，无 `step` |
| 16 | `"小厨，上一步"` | currentStep 2 | `step === 1` |
| 17 | `"小厨，要炒多久"` | currentStep 1 | `text === "大约 2 分钟"` |
| 18 | `"小厨，这个要多久"` | currentStep 2（无时间词） | `text === steps[2].text` |
| 19 | `"小厨，今天天气怎么样"` | 默认 | `text` 含「菜谱里没写」 |
| 20 | `"小厨，第三步是什么"` | `steps: []` | `text === "这道菜没有步骤"` |
| 21 | `"小厨，面粉多少"` | `steps: []` | 仍答 `"低筋面粉，200 克"` |
| 22 | `"小厨第三步面粉放多少"` | 默认 | `step === 2`（步骤优先于食材） |

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- src/services/voice/__tests__/answer.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `answerQuestion`**

规则顺序固定（规格 §5）：

1. `transcript` 不含 `小厨` → `null`
2. 去掉所有 `小厨`、去首尾空白与标点；**去掉后为空** → `{ text: "在，问吧。" }`
3. 相对步骤：含「下一步 / 下步 / 继续」→ `currentStep + 1`；含「上一步 / 上步 / 前一步」→ `currentStep - 1`。越界时用固定文案（上越界：「已经是第一步了」；下越界：「已经是最后一步了」；`steps` 为空：「这道菜没有步骤」），不带 `step`
4. 绝对步骤：`/第\s*([一二三四五六七八九十]|\d{1,2})\s*步/` 或 `/步骤\s*([一二三四五六七八九十]|\d{1,2})/`，中文数字映射 一~十 → 1~10。越界文案「现在只有 N 步」，不带 `step`
5. 食材：按 `ingredient_name.length` **降序**遍历，`text.includes(name)` 或 `text.includes(name.slice(-2))`（`name.length >= 2`）即命中；取前 3 个，`text = hits.map(h => \`${h.ingredient_name}，${amountText(h)}\`).join("；")`，命中数 > 3 时追加「；还有 N 样」
6. 时间：text 含「多久 / 几分钟 / 多长时间 / 几秒 / 多少分钟」→ 在当前步原文里匹配 `/\d+\s*(分钟|分|秒|小时|钟头)/`；命中 → `{ text: \`大约 ${match[0]}\` }`；未命中或没有当前步 → `{ text: 当前步原文 }`（没有步骤时走第 7 条）
7. 兜底：`{ text: "这个我菜谱里没写。可以问，面粉多少，或者，第三步是什么。" }`

`currentStep` 越界时先 clamp 到 `[0, steps.length - 1]`，`steps` 为空时视为 0。

- [ ] **Step 4: 跑测试**

Run: `npm run test -- src/services/voice/__tests__/answer.test.ts`
Expected: PASS（22 条）

- [ ] **Step 5: Commit**

```bash
git add src/services/voice/answer.ts src/services/voice/__tests__/answer.test.ts
git commit -m "feat(语音): 添加指导模式的本地答案解析纯函数"
```

---

### Task 3: 指导模式页面 + 入口 + 朗读封装 + 收尾

**Files:**
- Create: `src/services/voice/tts.ts`、`src/services/voice/__tests__/tts.test.ts`
- Create: `src/views/RecipeGuide.vue`
- Test: `src/views/__tests__/RecipeGuide.test.ts`
- Modify: `src/router/index.ts`
- Modify: `src/views/RecipeDetail.vue`（`#action` slot 加按钮，`import` 加图标）
- Modify: `src/views/MePage.vue`（删除 Task 1 的临时自检按钮）
- Modify: `docs/superpowers/specs/2026-10-16-ai-recipe-design.md`（§1 YAGNI 那条补一句引用）
- Modify: `src/views/RecipeDetail.vue` 文件头注释（「下一轮的跟做模式」改成指向 `RecipeGuide.vue`）

**Interfaces:**
- Consumes: Task 1 的 `startSpeech` / `isSpeechAvailable` / `SpeechHandle` / `SpeechErrorKind` / `keepScreenOn`；Task 2 的 `answerQuestion` / `AnswerContext` / `Answer`
- Produces:
  ```ts
  // src/services/voice/tts.ts
  export function speak(text: string): Promise<void>;   // 失败只 console.warn，不抛
  export function stopSpeaking(): Promise<void>;
  ```

- [ ] **Step 1: 写 `tts.ts` 的失败测试**

`src/services/voice/__tests__/tts.test.ts`，`vi.mock("tauri-plugin-tts-api")` 提供 `speak` / `stop`。断言：`speak` 以 `{ text, language: "zh-CN" }` 调用插件；插件抛错时 `speak()` **不 reject**；`stopSpeaking()` 调插件 `stop`。

- [ ] **Step 2: 实现 `tts.ts` 并跑测试**

Run: `npm run test -- src/services/voice/__tests__/tts.test.ts`
Expected: PASS

- [ ] **Step 3: 加路由**

`src/router/index.ts` 在 `/recipe/:id/edit` 与 `/recipe/:id` 之间插入：

```ts
{ path: "/recipe/:id/guide", name: "recipe-guide", component: RecipeGuide, meta: { hideTab: true } },
```

并按现有风格加 `import RecipeGuide from "@/views/RecipeGuide.vue";`

- [ ] **Step 4: 写页面失败测试**

`src/views/__tests__/RecipeGuide.test.ts`。`vi.mock` 掉 `vue-router`（沿用 `src/views/__tests__/RecipeDetail.test.ts` 的写法）、`@/stores/recipe`（`getDetail` 返回固定 `RecipeDetail`）、`@/services/voice/speech`、`@/services/voice/tts`、`@/services/voice/keepAwake`。断言的 `data-test` 契约：

| 元素 | data-test |
| --- | --- |
| 状态条文案 | `guide-status` |
| 步骤号 `2 / 4` | `guide-step-order` |
| 当前步骤正文 | `guide-step-text` |
| 上一步 / 下一步 | `guide-prev` / `guide-next` |
| 最近问答行 | `guide-qa` |
| 语音异常提示条 | `guide-mic-error` |
| 结束指导 | `guide-end` |

用例：

```ts
it("进入时启动识别并播报第一步")
it("识别结果命中时追加一行问答并朗读答案")
it("识别结果没有唤醒词时不朗读、不加问答行")
it("transient 错误后 1.5 秒自动重启一次（fake timers）")
it("连续 3 次 transient 错误后显示异常提示条，不再重启")
it("permission 错误不重试，提示去系统设置开麦克风")            // Review Focus 1
it("语音不可用时页面仍渲染步骤，下一步按钮仍可用")               // Review Focus 3
it("没有步骤的菜谱：显示没有步骤、翻步按钮禁用、语音仍答食材")     // Review Focus 2
it("卸载时调用 stop()、stopSpeaking()、keepScreenOn(false)")     // Review Focus 5
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npm run test -- src/views/__tests__/RecipeGuide.test.ts`
Expected: FAIL，组件不存在。

- [ ] **Step 6: 实现 `RecipeGuide.vue`**

结构（照规格 §6）：`AppHeader`（返回 + 菜名 + `结束指导`）+ 状态条 + 步骤大字区 + 上下步按钮 + 问答列表。

实现要点：
- `onMounted`：`store.getDetail(recipeId)` → `steps` 按 `sort_order` 排序 → `keepScreenOn(true)` → 若 `isSpeechAvailable()` 为 false 则进 `unavailable` 并**跳过** `startSpeech` → 否则 `startSpeech(handleResult, handleError)` → 最后 `speak(当前步原文)`（播报与识别互不依赖：识别不可用也照报）
- `handleResult(text)`：`answerQuestion(text, { ingredients, steps, currentStep })`；`null` 直接返回（不朗读、不入列表）；命中时 `speak(answer.text)`、`qa` 前插并截断到 5 条、`answer.step !== undefined` 时更新 `currentStep`
- 同文本去重：`lastText` / `lastAt` 记住上一次朗读的答案，5 秒内重复不再朗读
- `handleError(kind, message)`：`permission` → 进 `unavailable`，提示「需要麦克风权限，请在系统设置里允许」；`unavailable` → 直接进 `unavailable`；`transient` → 记数，`< 3` 时 `setTimeout(1500)` 后重新 `startSpeech`，`>= 3` 时进 `unavailable` 并提示「语音识别暂时不可用，点这里重试」
- 手动翻步按钮与语音共用同一个 `goStep(i)`（clamp 到合法范围）
- `onUnmounted`：清掉 timer → `stopSpeaking()` → `handle?.stop()` → `keepScreenOn(false)`
- `unavailable` 状态下页面其余部分（步骤、翻步）完全可用

- [ ] **Step 7: 跑页面测试**

Run: `npm run test -- src/views/__tests__/RecipeGuide.test.ts`
Expected: PASS（9 条）

- [ ] **Step 8: 详情页入口**

`src/views/RecipeDetail.vue` 的 `#action` slot 里、收藏按钮**之前**插入：

```vue
<button
  type="button"
  data-test="guide"
  aria-label="指导模式"
  class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
  @click="router.push(`/recipe/${recipeId}/guide`)"
>
  <PhoneCall :size="18" class="text-text-secondary" />
</button>
```

`import { Pencil, PhoneCall, Star, Trash2, UserCheck, UserPlus } from "lucide-vue-next";`

- [ ] **Step 9: 删临时自检按钮**

`src/views/MePage.vue` 回到 Task 1 之前的样子（只删自己加的那段）。

- [ ] **Step 10: 改两处文档**

1. `docs/superpowers/specs/2026-10-16-ai-recipe-design.md` §1 的「语音识别。系统输入法自带……」那一条末尾追加：「（指导模式的本地语音另见 `2026-10-18-voice-guidance-design.md`，仅限指导模式，不影响本节结论）」
2. `src/views/RecipeDetail.vue` 文件头注释里「⚠️ 不做计时器 / 防熄屏 / 逐步高亮，那是下一轮的跟做模式，别在这里加。」改为指向已实现的 `RecipeGuide.vue`

- [ ] **Step 11: 全量验证**

```bash
npm run test        # 全绿，含已有测试
npm run build       # vue-tsc 严格模式通过 + 构建成功
cd src-tauri && cargo check
```

Expected: 三条都通过。任何已有测试变红 → 停下来修根因，**不许改已有断言**。

- [ ] **Step 12: 真机手测清单**

```bash
npm run tauri android dev
```

- 详情页右上角出现电话图标 → 点进指导模式
- 说「小厨，第三步是什么」→ 高亮的步骤跳到第 3 步并朗读
- 说「小厨，面粉多少」→ 朗读用量，页面出现问答行
- 不说话 30 秒 → 屏幕不熄灭
- 点「结束指导」→ 返回详情页，麦克风停下（系统状态栏的麦克风指示消失）
- 锁屏再回来 → 麦克风已停，页面提示「语音识别暂时不可用，点这里重试」并能点回来

- [ ] **Step 13: Commit**

```bash
git add src/services/voice src/views/RecipeGuide.vue src/views/__tests__/RecipeGuide.test.ts \
  src/router/index.ts src/views/RecipeDetail.vue src/views/MePage.vue \
  docs/superpowers/specs/2026-10-16-ai-recipe-design.md
git commit -m "feat(语音): 菜谱指导模式上线，支持本地用量与步骤语音问答"
```
