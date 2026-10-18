# 一起做饭 · 语音指导模式设计

日期：2026-10-18
状态：待评审

本文是 `2026-10-16-ai-recipe-design.md`（下称 **AI 规格**）之后的**独立**设计，不覆盖也不修改 AI 检索的任何结论。

---

## 1. 目标与范围

一句话：**做菜时把手机放在厨房桌上，点进指导模式，随口问「小厨，面粉多少」，本地查表直接念出来。** 全程离线。

场景是用户自己描述的：做菜时手上有油有面，不方便看屏幕，但偶尔会忘了某个用量或某一步。手机放在旁边，有问题随口问。

**做：**

- 菜谱详情页顶栏第四个图标（电话/免提直觉）→ 全屏**指导模式**页
- 连续语音识别（系统 `SpeechRecognizer`）+ 唤醒词「小厨」
- 四类意图的本地解析 + 系统 TTS 朗读
- 屏幕常亮、当前步骤高亮、手动「结束指导」

**明确不做（YAGNI）：**

- **不接大模型、不接后端、不发业务网络请求。** 用户 2026-10-18 决策：只答菜谱里写了的。代价是「步骤里没写炒多久，它只能把原文念一遍」，这条已确认接受
- 不答菜谱以外的知识（「没有低筋粉能用中筋粉代替吗」→ 拒答兜底）
- 不做独立唤醒词引擎（Porcupine / openWakeWord / Vosk）。唤醒词只是文本包含检查，成本一次 `String.includes`
- 不做云端 STT（要自己断句 + 花钱 + 上传家里的声音）
- 不做后台常驻、不做前台服务：**离开页面即停麦**
- 不做音频落盘、不做录音回放
- 不做语音改菜谱（红线：指导模式全程只读）
- 不做计时器、自定义唤醒词、音量键/耳机线控
- 不做桌面端语音（桌面只是调试壳，Windows 上要跑 whisper 是另一个项目）

---

## 2. 现状约束（已核实）

**客户端**

- `src/views/RecipeDetail.vue` 顶栏走 `AppHeader` 的 `#action` slot，现有三个图标按钮（收藏 / 编辑 / 删除），加第四个零成本。该文件开头注释已写明：**「不做计时器 / 防熄屏 / 逐步高亮，那是下一轮的跟做模式，别在这里加」** —— 本设计正是那一轮，所以新开页面，不动详情页结构
- 路由已有 `meta.hideTab` 机制（新页设 `hideTab: true` 即可全屏，无底部 tab）
- `store.getDetail(id)` 一次取全 `RecipeDetail { recipe, category, tags, steps, ingredients }`，其中 `ingredients` 是 `RecipeIngredientRow`，已 JOIN 出 `ingredient_name` / `unit_name`。**指导模式不需要任何新 SQL、不需要任何新表**
- `src/utils/amount.ts` 的 `amountText()` 是「200 克 / 适量」的唯一格式化出口，答案直接复用，不另写一份
- 项目目前**没有**自写的原生桥代码；`src-tauri/gen/android` 里已有 `MainActivity.kt`（分享目标用），但本设计不需要改它

**官方与社区插件**

Tauri 官方插件列表里**没有**语音相关插件。社区有三个正好对上的（均为 MIT）：

| 用途 | 包 | 版本 | 状态 |
| --- | --- | --- | --- |
| 识别 | `tauri-plugin-stt` / `tauri-plugin-stt-api` | 0.2.2 | 23★，单作者，Android 侧委托系统 `SpeechRecognizer`（`SttPlugin.kt` 623 行） |
| 朗读 | `tauri-plugin-tts` / `tauri-plugin-tts-api` | 0.2.1 | 21★，16k 下载，Android 走 `TextToSpeech` |

**屏幕常亮没有可用的现成插件**：`tauri-plugin-keepawake` 0.1.1 只有 `src/desktop.rs`，没有 Android 实现（仓库已 404、无 npm 包）。所以常亮屏改为自写约 35 行 Kotlin 插件（`FLAG_KEEP_SCREEN_ON`），见 §3。

`tauri-plugin-stt` 的 Android 实现已包含本设计需要的全部能力：`continuous` 模式（拿到结果后延迟重启继续听）、`NO_MATCH` / `SPEECH_TIMEOUT` 自动重启、连续 3 次错误后停止、静音 3 秒断句提示、`interimResults`、`language`、运行时申请 `RECORD_AUDIO`、manifest 声明 `queries` for `RecognitionService`。

**已读源码确认的事件契约**（`SttPlugin.kt`，本设计据此写页面状态机）：

- `onResults` → `trigger("result", { transcript, isFinal: true })`，一次识别一句，必带 `isFinal`
- `interimResults: false` → `onPartialResults` 直接不触发，**JS 只会收到 final**
- 连续错误计数 `MAX_CONSECUTIVE_ERRORS = 3`，重启延迟 `RESTART_DELAY_MS = 500`；**只有 `NO_SPEECH` / `TIMEOUT` 会自动重启**，其它错误（网络、权限、`ERROR_CLIENT`）立刻停麦
- 第 3 次连续错误停下之前**仍会 `trigger("error")`**，所以 JS 侧 watchdog 收得到信号
- 成功后计数清零，不会因为一天里零散的误触发而累积到停麦

---

## 3. 关键决策记录

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 识别引擎 | **系统 `SpeechRecognizer`，经 `tauri-plugin-stt`** | 免费、自带断句（不用自己写 VAD）、中文质量够、桥接代码已有人写好。自己写同样的 Kotlin 只会更差 |
| 连续听 | `continuous: true`（**常驻会话，页面不自己续听**）+ 把插件的假 `ERROR_CLIENT` 当噪音丢弃 | 实机日志（§11）证明：插件在 continuous 下每 ~4.5s 抛一条双重重启造成的假错误，但会话一直是活的；反而「一句话一个会话 + 页面续听」会让同一个 recognizer 变哑，只能靠 15s 看门狗救。所以保留常驻会话，只过滤噪音 |
| 识别粒度 | `interimResults: false`，**只对 final 应答** | 开 interim 会让同一句话边识别边被回答三五遍。已确认关掉后 JS 只收 final |
| 朗读回灌 | **朗读期间先关麦**：停麦 → 念完 → 300ms 尾音静默 → 再开麦 | 原决策「不暂停识别」被实机推翻：识别会把朗读内容听回去，当成一句话再处理形成回声循环。停麦是唯一可靠解 |
| 权限被拒 | **不重试**，直接提示条 + 「去系统设置开麦克风」 | 按 `code === "PERMISSION_DENIED"` 分流，否则用户会看到一个永远在失败重试的按钮 |
| 桌面构建 | **无条件注册三个插件**；若 whisper-rs 拖垮 Windows 构建则退回 `#[cfg(mobile)]` 门控 | `tauri-plugin-stt` 桌面走 whisper.cpp（需要模型，未装时 `is_available()` 为 false），插件本身不该让构建失败。`cargo check` 一次就能证伪，属实现期可判定的问题 |
| 唤醒词 | 正则 `/小[厨橱刍除初处楚雏础]|扫除|消除/`，纯文本匹配 | 实机实测：「小厨」常被听成「扫除」/「消除」/「小初」。误触发代价只是回一句「在，问吧。」（§8.6）。不做独立引擎 |
| 没听清唤醒词 | **丢弃答案 + 语音提示一句**（8 秒冷却） | 这个功能就是不看屏幕用的，只给文字等于没提示。提示语故意不含唤醒词，避免自我触发；冷却避免厨房家常话每句都回话 |
| 答什么 | **只用当前菜谱的结构化数据** | 用户决策。换来离线、即时（< 300ms）、绝不编造 |
| 意图解析 | **固定优先级纯函数**，不堆正则 | 可单测、可解释、出错时能一眼看出命中哪条规则 |
| TTS | 系统 `TextToSpeech`，经 `tauri-plugin-tts` | 免费、离线中文可用。**不可用时降级成纯文字，不阻塞页面** |
| 入口范围 | **任何详情页都显示**，含别人的菜谱、含收藏的社区菜谱 | 全程只读，没有理由排除 |
| 屏幕常亮 | **自写 35 行 Kotlin 插件**（`@TauriPlugin` + `FLAG_KEEP_SCREEN_ON`） | 唯一可用的第三方插件没有 Android 实现。常亮屏是「手机上放一边做菜」这个场景的底线，不能省；35 行比改造一个死仓库便宜 |
| 语音不可用时 | 页面**照常可用**（看步骤、手动翻步），只在顶部显示提示条 | 指导模式的价值一半在「大字看步骤」；语音坏了不能变成白屏 |
| 音频 | 不落盘、不上传本服务端 | 是否上传取决于设备自己的识别服务（部分 ROM 会联网），这一点必须在页面上说明白 |

---

## 4. 模块划分

**新增四个文件**（净新增）。

**必须改动的既有文件共四个**，改动都是最小插入：

| 文件 | 改动 |
| --- | --- |
| `src/router/index.ts` | 加一条 `/recipe/:id/guide`，`meta.hideTab: true` |
| `src/views/RecipeDetail.vue` | `#action` slot 里加第四个图标按钮 |
| `src-tauri/src/lib.rs` | 注册插件（`tts` 全平台；`stt` 仅移动端；`keep-awake` 仅 Android） |
| `src-tauri/capabilities/default.json` | 加 `tts:default` |
| `src-tauri/capabilities/mobile.json` | 新增：`platforms: ["android","iOS"]`，放 `stt:default` 与 `keep-awake:default` |
| `src-tauri/build.rs` | 用 `InlinedPlugin` 给纯 Kotlin 的 `keep-awake` 生成 ACL 清单，否则 JS 侧 invoke 会被 ACL 拒 |

外加 §9 的两处注释。

### 4.1 `src/services/voice/answer.ts` — 纯函数，零依赖

```ts
export interface AnswerContext {
  ingredients: RecipeIngredientRow[];
  steps: RecipeStep[];
  currentStep: number; // 0-based
}
export interface Answer {
  text: string;   // 要念出来的话
  step?: number;  // 若命中步骤跳转，页面据此移动高亮
}
/** 返回 null = 不是在叫它（无唤醒词 / 空文本），页面直接丢弃 */
export function answerQuestion(transcript: string, ctx: AnswerContext): Answer | null;
```

### 4.2 `src/services/voice/speech.ts` — 插件封装

```ts
export type SpeechErrorKind = "permission" | "unavailable" | "silence" | "noise" | "transient";
export interface SpeechHandle { stop(): Promise<void>; }
export async function isSpeechAvailable(): Promise<boolean>;
export async function startSpeech(
  onResult: (text: string) => void,
  onError: (kind: SpeechErrorKind, message: string) => void,
): Promise<SpeechHandle>;
```

- 桌面端 / 插件加载失败 / `isRecognitionAvailable()` 为 false → `unavailable`，页面显示提示条
- 启动前先 `requestPermission()`：插件在缺 `RECORD_AUDIO` 时只会 reject + 弹系统框，授权后不会自己开麦
- `NO_SPEECH` / `TIMEOUT` → `silence`（正常安静）；`UNKNOWN`（`ERROR_CLIENT`）→ `noise`（插件的假错误，丢弃）；权限码 → `permission`；其余 → `transient`
- 所有插件异常在**本文件内**吞掉并转成 `onError`，页面不 import 插件

### 4.3 `src/services/voice/tts.ts` — 朗读封装

```ts
export async function speakAndWait(text: string): Promise<void>; // 念到结束（含 300ms 尾音静默）才 resolve，失败只 warn
export async function stopSpeaking(): Promise<void>;
```

### 4.4 `src/views/RecipeGuide.vue` — 页面与状态机

页面只做三件事：渲染步骤、串起 speech → answer → tts、管理生命周期。

---

## 5. 解析规则（顺序固定，先命中先返回）

**前置**：取 `transcript`，去首尾空白与标点；不含唤醒词（`/小[厨橱刍除初处楚雏础]|扫除|消除/`）→ 返回 `null`，页面改成语音提示一句。

步骤号正则容忍 ASR 把「步」听成同音的「部」：`/第\s*([一二三四五六七八九十]|\d{1,2})\s*[步部]/`。

| # | 条件 | 应答 | 副作用 |
| --- | --- | --- | --- |
| 1 | 含「下一步 / 下步 / 继续」 | 下一步原文 | `step = currentStep + 1` |
| 1 | 含「上一步 / 上步 / 前一步」 | 上一步原文 | `step = currentStep - 1` |
| 1 | 匹配「第 N 步」「步骤 N」（N = 一~十 或 1~10） | 第 N 步原文 | `step = N - 1` |
| 1 | 步骤号越界 | 「现在只有 N 步」 | 不改高亮 |
| 2 | 命中食材名 | 「低筋面粉，200 克」（`amountText`） | 无 |
| 3 | 含「多久 / 几分钟 / 多长时间 / 几秒」 | 从**当前步原文**抽 `\d+\s*(分钟\|分\|秒\|小时\|钟头)` → 「大约 5 分钟」；抽不到 → 念当前步全文 | 无 |
| 4 | 其它 | 「这个我菜谱里没写。可以问，面粉多少，或者，第三步是什么。」 | 无 |

**食材命中判定**：把食材名按长度降序排，`transcript.includes(name)` 或 `transcript.includes(name.slice(-2))`（`name.length >= 2`）即命中。取名字的最后两字是为了容忍 ASR 把「低筋面粉」听成「面粉」的情况——有意的宽松匹配，靠长度降序保证长名优先。**一次命中多个食材时按顺序念前 3 个**，超过 3 个只念「还有 N 样，都在清单里」。

**为什么步骤判断排在食材前面**：「第三步面粉放多少」这种句子两条都命中，先跳步更符合人的预期。

---

## 6. 页面

```
┌──────────────────────────────┐
│ ←  宫保鸡丁            结束指导 │  ← AppHeader（复用）
├──────────────────────────────┤
│ ● 正在聆听 · 说「小厨」开头      │  ← 状态条；异常时变红并给「重新开始听」
├──────────────────────────────┤
│                              │
│      2 / 6                   │  ← 步骤号
│                              │
│   热锅下油，油温六成热          │  ← 当前步骤，text-2xl，可上下滑
│   下鸡丁滑散，约 2 分钟         │
│                              │
│   ‹ 上一步        下一步 ›     │
├──────────────────────────────┤
│ 你：小厨面粉多少                 │
│ 答：低筋面粉，200 克             │  ← 最近 5 条，可滚动
└──────────────────────────────┘
```

- 进入页面：`keepScreenOn(true)` → 申请麦克风 → 播报当前步骤（朗读期间关麦，见下行）→ 念完开麦
- **朗读与识别互斥**：`announce()` = 停麦 → `speakAndWait` → 300ms 尾音静默 → 再开麦。不关麦会把朗读听回去形成回声循环
- 页面顶部显示「听到：<原文>」；没叫醒它时另行语音提示（8 秒冷却）
- 离开页面（`onUnmounted` / 返回 / 结束指导）：`stopSpeaking` → `handle.stop()` → `keepScreenOn(false)`。**顺序不能反**（先关麦再停朗读会听到半句话被切断后又恢复）
- 收到 `onError` 且用户没点结束：1.5s 后自动重启，最多 3 次；仍失败 → `unavailable` 提示条
- `code === "PERMISSION_DENIED"` → 直接进 `unavailable`，文案指向系统设置的麦克风权限，**不重试**
- 没有步骤的菜谱（steps 为空）：页面显示「这道菜没有步骤」，语音只答食材用量

---

## 7. 依赖与配置（实现时必须核对的清单）

1. 依赖：`tauri-plugin-stt` + `tauri-plugin-stt-api`、`tauri-plugin-tts` + `tauri-plugin-tts-api`。**版本钉死到当前小版本**（单作者 0.2.x，允许自动升级等于允许半夜自己坏掉）
2. `src-tauri/src/lib.rs`：注册两个插件
3. `src-tauri/capabilities/default.json`：加 `stt:default`、`tts:default`（**以各自 README 为准**，`tauri-plugin-tts` 的 `allow-register-listener` 容易漏，漏了 `onSpeechEvent` 会静默不触发）。权限标识写错会在构建期直接报错，不是静默失败
4. `RECORD_AUDIO` 由 `tauri-plugin-stt` 的 manifest 合并进来，**不手改** `src-tauri/gen/android/app/src/main/AndroidManifest.xml`；实现后用 merged manifest 确认（`src-tauri/gen/android/app/build/intermediates/merged_manifest/`）
5. 常亮屏：新增 `src-tauri/gen/android/app/src/main/java/cn/tuzkimo/wee_cook/KeepAwakePlugin.kt`（`@TauriPlugin` + `@Command start/stop`）。**Tauri 2 没有 `MainActivity.registerPlugin`**：Kotlin 插件由 Rust 侧 `src-tauri/src/keep_awake.rs` 用 `PluginApi::register_android_plugin` 实例化；纯 Kotlin 插件没有自己的 crate，ACL 清单在 `build.rs` 里用 `tauri_build::InlinedPlugin` 生成。JS 直接 `invoke("plugin:keep-awake|start")`
6. 后台行为：指导模式**不做前台服务**，锁屏或切后台即停麦。这是刻意的：不做常驻就不需要一套通知 + 唤醒锁 + 生命周期管理
7. 落地前先做一次**真机风险验证**（§8.1）。通不过时的两个出口，按代价排序：① fork `tauri-plugin-stt` 到 `src-tauri/vendor/` 走 path 依赖，删掉那一行 extra（半天内）；② 自写约 100 行 Kotlin 桥（一天）

---

## 8. 风险与未知

> `EXTRA_SECURE` 是**唯一**会让整个功能不成立的未知数，其余都是可控的实现细节。因此实施计划的第一步是真机验证门，不是写页面。

1. **`EXTRA_SECURE = true`（最高优先级未知数）**——插件给 `RecognizerIntent` 塞了这个 extra（注释写「防 ERROR_CLIENT」）。它的本意是给键盘语音输入用，某些 ROM 上可能因此强制走离线识别或直接失败。**实现第一件事：真机打 log 验证识别能不能出结果**；不通过就 fork `SttPlugin.kt` 删掉这一行
2. **单作者 0.2.x 插件**：钉版本 + MIT + 623 行 Kotlin，坏了能 fork 或照抄。这是接受它的前提
3. **OEM 识别服务差异**：无 Google 服务的国产 ROM 靠厂商识别服务，质量差别大。`isRecognitionAvailable()` 为 false 时给人话提示，不得崩溃、不得白屏
4. **静音断句参数只是 hint**（`EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS` 等），厂商可能忽略。`continuous` 重启循环才是真正的兜底
5. **一直听的电量与隐私**：页面常驻「正在聆听」标识；不落盘不上传本服务端；系统识别服务是否联网由 ROM 决定，页面提示里要说
6. **误触发**：唤醒词只能挡住一部分（家人说「小厨」也会触发）。接受，这是唤醒词路线的固有代价
7. **ASR 少字/错字**：靠 §5 的宽松匹配兜一部分，剩下的靠兜底话术承认不知道——不是 bug，是这条路线换取离线的代价

---

## 9. 与既有规格的关系

- **AI 规格 §1 的 YAGNI 里写着「不做语音识别」**。本设计覆盖指导模式的本地识别，**不改** AI 检索仍用系统输入法语音的结论。落地时在 AI 规格那一条后面补一句「（指导模式的本地语音另见 `2026-10-18-voice-guidance-design.md`）」——按 AGENTS.md 的约定，先改文档再改实现
- `src/views/RecipeDetail.vue` 开头「那是下一轮的跟做模式」的注释，在本设计落地后改写为指向 `RecipeGuide.vue`

---

## 10. 测试

- **`src/services/voice/__tests__/answer.test.ts`（重点，≥ 20 条）**：中文数字、步骤越界、多食材命中、无唤醒词返回 null、菜谱外问题走兜底、时间抽取成功/失败、ASR 少字（「低筋面粉」听成「面粉」）、空 steps、空 transcript
- **`src/views/__tests__/RecipeGuide.test.ts`**：mock `speech.ts` / `tts.ts`，断言进入即 start、离开即 stop、`onError` 触发 watchdog 重试、语音不可用时页面不白屏且步骤仍可手动翻
- **不写 E2E**；真机手测清单（识别可用性、朗读回声、唤醒词听错率、熄屏与切后台行为）写在实施计划里 + 见 §11

---

## 11. 实现期修正（真机调试记录）

落地过程中实测推翻了三条设计假设，记录在此以免以后又按旧设计改回去：

1. **`continuous: true` 是唯一活得住的形态**。插件在 continuous 下每 ~4.5s 抛一条假 `ERROR_CLIENT`（码 5 → `UNKNOWN`）：`onError(NO_MATCH)` 的重启分支提前 `return`、没先把 `isListening` 置 false，紧接着的 `onResults(matches=0)` 又排一次重启 ⇒ 两次 `startListening` 打在同一 recognizer 上。但那条假错误之后识别照常工作，且错误路径会把插件的连续错误计数归零（所以它永远不会真的「3 次放弃」）。
2. **「一句话一个会话 + 页面续听」行不通**：每次会话结束后同一个 recognizer 会变哑（无 result 也无 error），只有隔十几秒的看门狗才能救。因此页面不再自己续听。
3. **15 秒静默看门狗被删除**：continuous 模式下页面无法区分「厨房安静」与「识别哑了」，看门狗会在安静时空转重启，而重启正是最脆弱的动作。

仍未根治：插件那两行提前 `return` 只有 fork 才能改（§7.7 出口①）。当前用「过滤 `UNKNOWN` 噪音」绕过。

