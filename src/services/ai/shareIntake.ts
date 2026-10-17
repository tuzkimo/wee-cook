// 系统分享进来的截图（Kotlin 写 `<cacheDir>/share-inbox/`）：拉取 → 解析 → 读字节 → 截图分段
// → 写进 aiChat → 进 AI 页 → 消费掉。
//
// 四条边界（都有能红的用例，见 __tests__/shareIntake.test.ts）：
//  1. **必须消费**：成功、失败、甚至形状不认，都要把 inbox 清掉；不清就会每次回前台弹一次文案。
//  2. **彻底失败也要进 AI 页**：提示行只渲染在 /ai，不跳页用户就什么都看不到。
//  3. **按 `pending.json` 原文去重**（模块内内存）：删除失败也不重试，但同一份原文本进程内不再处理；
//     每次分享的文件名带 uuid、错误 payload 带唯一 `id` ⇒ 原文必变。
//  4. **compare-and-delete**：只有盘上还是"我处理的那一份"才删，否则一个文件都不删。
//
// 本仓没有自动锁 ⇒ 姊妹仓的 `isLocked` / `"skipped"` 一律不要（规格 §12.4）。
import { TauriEvent } from "@tauri-apps/api/event";
import { BaseDirectory, readFile, readTextFile, remove } from "@tauri-apps/plugin-fs";
import {
  MSG_MULTIPLE_TAKEN,
  MSG_READ_FAILED,
  messageForShareCode,
  type ShareErrorCode,
} from "@/services/ai/attachText";
import type { Screenshot, ScreenshotResult } from "@/services/ai/image";

/** `pending.json` 只认这个版本：开发期 Vite 的新 JS 可能配到旧 APK 的 Kotlin */
const SHARE_PAYLOAD_VERSION = 1;

/** 与 Kotlin 侧逐字一致（`MainActivity.kt` 的 INBOX_DIR / PENDING_NAME） */
const INBOX_DIR = "share-inbox";
const PENDING_NAME = "pending.json";
/** 扑空后补拉的默认延迟：本地图够落盘，又不至于让用户等出感觉 */
const RETRY_DELAY_MS = 1200;

export type PendingPayload =
  | { v: 1; kind: "image"; file: string; count: number }
  | { v: 1; kind: "error"; code: ShareErrorCode };

export interface ShareIntakeDeps {
  /** pending.json 原文；文件不存在 ⇒ null（绝大多数启动走这条）；**其它读错误必须抛** */
  readPending(): Promise<string | null>;
  readBytes(file: string): Promise<Uint8Array>;
  /**
   * 消费掉这份分享。第二个参数是**读到的那份原文**：实现方据此 compare-and-delete ——
   * 只有盘上还是这一份才允许删（原生写新分享时会连带删掉旧 payload 引用的图，latest wins）。
   */
  consume(payload: PendingPayload | null, raw: string): Promise<void>;
  toScreenshot(bytes: Uint8Array): Promise<ScreenshotResult>;
  setAttachment(shot: Screenshot): void;
  setNotice(text: string): void;
  pushAi(): void;
}

export type IntakeOutcome = "none" | "attached" | "failed";

/**
 * 已知的原生错误 code。用 `Record<ShareErrorCode, true>`：加第 4 个 code 时忘改这里就是编译错。
 *
 * ⚠️ 成员校验必须用 `Object.prototype.hasOwnProperty.call`，不能用 `code in ERROR_CODES`：
 * `in` 走原型链（`"constructor" in ERROR_CODES === true`）⇒ 查表拿到 `Object` 构造函数 ⇒
 * AI 页渲染出 `function Object() { [native code] }`。tsconfig 的 lib 是 ES2020，也没有 `Object.hasOwn`。
 */
const ERROR_CODES: Record<ShareErrorCode, true> = {
  no_stream: true,
  read_failed: true,
  source_too_large: true,
};

/**
 * 解析 `pending.json` 原文。`null` = 形状/版本不认（调用方按读失败处理**并消费掉**）。
 *
 * 只挑已知键：`id` / `mime` 之类的多余字段一律不进结果 —— 准入判据只有字节头，
 * 把声明的类型带下去等于给"第二道否决权"留口子。
 */
export function parsePending(raw: string): PendingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const rec = parsed as Record<string, unknown>;
  if (rec.v !== SHARE_PAYLOAD_VERSION) return null;

  if (rec.kind === "error") {
    const code = rec.code;
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
      return { v: 1, kind: "error", code: code as ShareErrorCode };
    }
    return null;
  }

  if (rec.kind === "image") {
    const file = rec.file;
    if (typeof file !== "string" || file === "") return null;
    const count = typeof rec.count === "number" && Number.isFinite(rec.count) ? rec.count : 1;
    return { v: 1, kind: "image", file, count };
  }

  return null;
}

/** `payload.file` 来自磁盘，是**不可信**输入：只接受 inbox 里的普通 `*.bin` 文件名，绝不接受路径 */
function isInboxBinary(file: string): boolean {
  return file.endsWith(".bin") && !file.includes("/") && !file.includes("\\") && !file.includes("..");
}

/** 本进程内"处理过"的那份原文。只在内存：重启后会再处理一次。 */
let consumedRaw: string | null = null;
/** 单飞：多个拉取点（挂载 / 回前台 / resumed / 补拉）撞在一起时只跑一条。 */
let inFlight: Promise<IntakeOutcome> | null = null;

export async function intakeShare(deps: ShareIntakeDeps): Promise<IntakeOutcome> {
  if (inFlight !== null) return inFlight;
  inFlight = runIntake(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runIntake(deps: ShareIntakeDeps): Promise<IntakeOutcome> {
  let raw: string | null;
  try {
    raw = await deps.readPending();
  } catch (e) {
    // 读不到 ≠ 这次没有分享：不能静默。走统一出口（文案 + 跳页），但没有原文可比 ⇒
    // 传空串给 consume，真实的 compare-and-delete 必然不匹配 ⇒ 盘上一个文件都不删。
    console.warn("[ai/share] 读 pending.json 失败：", e);
    await noticeAndConsume(deps, null, "", MSG_READ_FAILED);
    return "failed";
  }
  if (raw === null || raw === consumedRaw) return "none";

  // 从这一行起这份原文就"记账"了：无论成功、失败还是删除失败，同一份原文不再处理第二次
  consumedRaw = raw;

  const payload = parsePending(raw);
  // 已记账之后任何一步抛错（动态 import 的 chunk 加载失败、store 写入抛错）都不能就这么漏出去，
  // 否则用户看不到任何提示、这份分享也白丢了
  try {
    return await handlePayload(deps, payload, raw);
  } catch (e) {
    console.warn("[ai/share] 处理中抛错：", errorTag(e));
    await noticeAndConsume(deps, payload, raw, MSG_READ_FAILED);
    return "failed";
  }
}

/** 原文已记账后的正常分支：所有失败都走 noticeAndConsume，不抛。 */
async function handlePayload(
  deps: ShareIntakeDeps,
  payload: PendingPayload | null,
  raw: string,
): Promise<IntakeOutcome> {
  if (payload === null) {
    console.warn("[ai/share] pending.json 形状不认，按读失败处理并消费");
    await noticeAndConsume(deps, null, raw, MSG_READ_FAILED);
    return "failed";
  }

  if (payload.kind === "error") {
    await noticeAndConsume(deps, payload, raw, messageForShareCode(payload.code));
    return "failed";
  }

  if (!isInboxBinary(payload.file)) {
    // 只消费 payload：一个越界的文件名不值得读，更不值得按它删东西
    console.warn("[ai/share] pending.json 的 file 不是普通 .bin 文件名，只消费 payload");
    await noticeAndConsume(deps, null, raw, MSG_READ_FAILED);
    return "failed";
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.readBytes(payload.file);
  } catch (e) {
    // 只记文件名（uuid + .bin，已过白名单）与错误类型：分享源可能带相册路径 / 原文件名，不进日志
    console.warn("[ai/share] 读图片字节失败：", payload.file, errorTag(e));
    await noticeAndConsume(deps, payload, raw, MSG_READ_FAILED);
    return "failed";
  }

  const made = await deps.toScreenshot(bytes);
  if (!made.ok) {
    await noticeAndConsume(deps, payload, raw, made.message);
    return "failed";
  }

  deps.setAttachment(made.shot);
  // 成功路径**一律写**：多图给"只取第一张"，单图给空串（= 清掉上一次的提示）
  deps.setNotice(payload.count > 1 ? MSG_MULTIPLE_TAKEN : "");
  await consumeQuietly(deps, payload, raw);
  pushAiQuietly(deps);
  return "attached";
}

/** 失败路径的唯一出口：出文案 + 消费 + 进 AI 页（漏掉任何一步用户都看不到这句话） */
async function noticeAndConsume(
  deps: ShareIntakeDeps,
  payload: PendingPayload | null,
  raw: string,
  message: string,
): Promise<void> {
  deps.setNotice(message);
  await consumeQuietly(deps, payload, raw);
  pushAiQuietly(deps);
}

/** 消费失败不影响本次结果（这次分享本身已经处理完了），但必须留痕 */
async function consumeQuietly(
  deps: ShareIntakeDeps,
  payload: PendingPayload | null,
  raw: string,
): Promise<void> {
  try {
    await deps.consume(payload, raw);
  } catch (e) {
    console.warn("[ai/share] 消费 pending.json 失败（不影响本次结果）：", e);
  }
}

/** 进 AI 页：路由失败不回滚附件 —— 图已经在 store 里，用户自己进 AI 页照样看得到 */
function pushAiQuietly(deps: ShareIntakeDeps): void {
  try {
    deps.pushAi();
  } catch (e) {
    console.warn("[ai/share] 进 AI 页失败：", e);
  }
}

/** 日志里只留错误类型名（见读字节失败处） */
function errorTag(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function inboxPath(name: string): string {
  return `${INBOX_DIR}/${name}`;
}

/**
 * plugin-fs 对"文件不存在"的报错来自 Rust `io::Error` 的 Display（含 `"os error 2"`）。
 * 失手是良性的：把"不存在"误判成错误 ⇒ 多一条日志；把真错误误判成"不存在" ⇒ 与不区分时逐字相同。
 */
function isNotFound(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /not found|no such file|os error 2/i.test(text);
}

/** 首次读取与消费前的复核共用这一个读法：两处各写各的读法就是两份真相 */
async function readPendingRaw(): Promise<string | null> {
  // 没有原生那一半（浏览器 dev / 单测）：inbox 根本不存在，不该刷出与"ACL 配错"一样的日志
  if (!isTauri()) return null;
  try {
    return await readTextFile(inboxPath(PENDING_NAME), { baseDir: BaseDirectory.AppCache });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** 生产依赖：AppCache 下的 share-inbox。三个状态写入方（store / router）由 App.vue 装配 */
export const realDeps: Omit<ShareIntakeDeps, "setAttachment" | "setNotice" | "pushAi"> = {
  readPending: readPendingRaw,
  readBytes: (file) => readFile(inboxPath(file), { baseDir: BaseDirectory.AppCache }),
  consume: async (payload, raw) => {
    // 复核：只有盘上还是**我刚刚处理的那一份**才允许删。读字节 + canvas 压缩要几十~几百毫秒，
    // 原生完全可能在这个窗口里写进下一次分享（并顺手删掉旧 payload 引用的图）。
    let current: string | null;
    try {
      current = await readPendingRaw();
    } catch (e) {
      // 读不出来（不是"不存在"）：无从判断，一个都不删 —— 宁可留残留让下次拉取自愈
      console.warn("[ai/share] 复核 pending.json 失败，本次不删任何文件：", e);
      return;
    }
    if (current !== raw) return;

    // 顺序是规格：pending.json 才是"这份分享已经处理过"的权威标记。先删它 ⇒ 即使随后删图失败
    // 或进程在这一刻被杀，也不会留下"指着一个不存在文件的 pending.json"（那会每次回前台弹一句）。
    await remove(inboxPath(PENDING_NAME), { baseDir: BaseDirectory.AppCache });
    if (payload !== null && payload.kind === "image" && isInboxBinary(payload.file)) {
      try {
        await remove(inboxPath(payload.file), { baseDir: BaseDirectory.AppCache });
      } catch (e) {
        // 图已经不在（被原生 latest wins 删掉）不该影响本次结果
        console.warn("[ai/share] 删 inbox 图片失败（不影响本次结果）：", e);
      }
    }
  },
  // 动态引：image.ts 会把 canvas / 选图插件拉进模块图，分享链的其它部分用不上
  toScreenshot: async (bytes) => {
    const { toScreenshot } = await import("@/services/ai/image");
    return toScreenshot(bytes);
  },
};

/**
 * 注册拉取点：初次 + `visibilitychange → visible` + `tauri://resumed`（非 Tauri 静默跳过），
 * 外加**一次**扑空后的延迟补拉（原生侧的拷贝在后台线程里跑，拉取可能早于落盘）。
 * 返回卸载函数：拆掉监听与待命定时器。
 */
export function startShareIntake(
  deps: ShareIntakeDeps & { retryDelayMs?: number },
): () => void {
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let unlisten: (() => void) | null = null;

  /**
   * `mayRetry`：本次是"事件触发"（true）还是"补拉定时器触发"（false）。扑空 ⇒ 排一次补拉；
   * 定时器触发的那次不再排（只补一次，绝不变成轮询）。
   */
  async function pull(mayRetry: boolean): Promise<void> {
    let outcome: IntakeOutcome;
    try {
      outcome = await intakeShare(deps);
    } catch (e) {
      // 拉取点都是事件回调，异常抛出去没人接
      console.warn("[ai/share] 拉取失败：", e);
      return;
    }
    if (outcome === "none" && mayRetry) scheduleRetry();
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void pull(false);
    }, retryDelayMs);
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "visible") void pull(true);
  }

  document.addEventListener("visibilitychange", onVisibilityChange);
  void pull(true);

  if (isTauri()) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().listen(TauriEvent.WINDOW_RESUMED, () => void pull(true)),
      )
      .then((stop) => {
        // 订阅是异步完成的：卸载发生在 await 期间就地退订
        if (stopped) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // 非 Tauri 环境 / 订阅失败：还有 visibilitychange 这条腿
      });
  }

  return () => {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unlisten?.();
    unlisten = null;
  };
}
