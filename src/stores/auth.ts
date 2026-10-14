// src/stores/auth.ts
//
// 单账号在线会话。三件事：restoreSession / login+register / logout。
// 持久化分工（规格 §7.2）：
//   - 地址与账号信息 → settings.json（server_url / server_user_id / server_username / server_nickname）
//   - refresh token   → tokens.json，由 api 层按服务端 user id 隔离存储
// 「登录/恢复会话成功即做一次全扫同步」接在三个会话入口的成功路径上（spec §9.5 / §9.3）。
import { createPinia, defineStore, getActivePinia } from "pinia";
import { computed, ref } from "vue";
import * as api from "@/services/api";
import { deleteRefreshToken, readRefreshToken } from "@/services/tokenStorage";
import { readSetting, writeSetting, type SettingLogContext } from "@/services/settingsFile";

export type AuthMode = "guest" | "online";

const KEY_URL = "server_url";
const KEY_USER_ID = "server_user_id";
const KEY_USERNAME = "server_username";
const KEY_NICKNAME = "server_nickname";

const LOG_SAVE: SettingLogContext = { tag: "auth", label: "同步设置", action: "保存" };

const NETWORK_MESSAGE = "连不上服务器，检查地址和网络";

/**
 * 会话刚变在线：认领存量 + 一次全扫推送（spec §9.3）。fire-and-forget，不阻塞登录返回。
 *
 * 这里刻意用动态 import：`auth → migration → sync/team → auth` 已是一个静态环，若改成顶部静态 import，
 * `team.test.ts` 的 `vi.mock("@/services/sync")`（用 importOriginal 加载原模块）会失效 ——
 * 环内 `team.ts` 绑到未 mock 的 `performSync`。实测后果（静态版本）：team.test 的
 * 「加入成功后清空同步游标」红（`expected "vi.fn()" to be called at least once`），
 * 并伴随未捕获的 `Error: 数据库未打开`。改回静态 import 前先跑一遍 `team.test.ts`。
 */
function triggerPostSessionSync(): void {
  void import("@/services/migration")
    .then((m) => m.triggerFullPushAndSync())
    .catch((e: unknown) => console.warn("[auth] 同步模块加载失败:", e));
}

/** 读字符串型设置：空串按未设置处理（地址与账号都不该是空串）。 */
function parseString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

async function readStringSetting(key: string): Promise<string | null> {
  const read = await readSetting(key, parseString);
  return read.kind === "found" ? read.value : null;
}

/**
 * 服务端答了话的错误（api.ts 的 AuthError 带 status）；网络层失败（超时 / 断网）
 * 没有任何状态码。两者的处理方向完全相反，必须分开。
 */
function isHttpError(err: unknown): err is Error & { status: number } {
  return err instanceof Error && typeof (err as { status?: unknown }).status === "number";
}

function loginErrorMessage(err: unknown): string {
  if (!isHttpError(err)) return NETWORK_MESSAGE;
  if (err.status === 401 || err.status === 403) return "账号或密码不对";
  return err.message;
}

function registerErrorMessage(err: unknown): string {
  if (!isHttpError(err)) return NETWORK_MESSAGE;
  if (err.status === 409) return "用户名已被占用";
  return err.message;
}

const useAuthStoreBase = defineStore("auth", () => {
  const mode = ref<AuthMode>("guest");
  const serverUser = ref<api.User | null>(null);
  const baseUrl = ref<string | null>(null);
  const nickname = ref<string | null>(null);
  const lastSyncFailed = ref(false);
  const lastSyncedTime = ref<string | null>(null);
  // 同步完成后刷新 UI 的版本号；notifySyncComplete() 递增，列表据此重拉。
  const syncVersion = ref(0);

  const isOnline = computed(() => mode.value === "online");
  const serverUserId = computed(() => serverUser.value?.id ?? null);

  // 会话世代：login / register / logout 每次主动改动会话都 +1。
  // api 层公开的 `refreshSession` 现在也做世代校验（见 services/api.ts 的 tokenGeneration），
  // 所以退登/换号时在途的恢复响应不会被写回 api 内存与磁盘。store 这道的职责是**语义兜底**：
  // 响应回来时判断这次恢复还算不算当前会话（是否切在线、是否写 settings）；最坏情况下
  // 新账号需要重新登录一次，但绝不会把旧账号的会话带进新账号。
  let sessionEpoch = 0;

  function goGuest(): void {
    mode.value = "guest";
    serverUser.value = null;
  }

  function adoptSession(user: api.User, url: string): void {
    baseUrl.value = url;
    serverUser.value = user;
    nickname.value = user.nickname;
    mode.value = "online";
  }

  async function persistSession(user: api.User, url: string): Promise<void> {
    await writeSetting(KEY_URL, url, LOG_SAVE);
    await writeSetting(KEY_USER_ID, user.id, LOG_SAVE);
    await writeSetting(KEY_USERNAME, user.username, LOG_SAVE);
    await writeSetting(KEY_NICKNAME, user.nickname, LOG_SAVE);
  }

  function normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, "");
  }

  /**
   * login 与 register 只差请求本身，其余一致：失败还原地址且不碰凭据/设置；
   * 成功时 api 层已经 setTokens（写内存 + 落盘 refresh token），这里不再重复写。
   */
  async function authenticate(
    url: string,
    request: () => Promise<api.AuthResponse>,
    toMessage: (err: unknown) => string,
  ): Promise<void> {
    const normalized = normalizeUrl(url);
    const previous = api.hasBaseUrl() ? api.getBaseUrl() : null;
    api.setBaseUrl(normalized);

    let resp: api.AuthResponse;
    try {
      resp = await request();
    } catch (err) {
      // 登录没成功：地址还原，既有凭据与设置一概不动
      if (previous !== null) api.setBaseUrl(previous);
      throw new Error(toMessage(err));
    }

    sessionEpoch++;
    adoptSession(resp.user, normalized);
    await persistSession(resp.user, normalized);
    // 会话刚变在线：认领存量 + 一次全扫推送（spec §9.3）
    triggerPostSessionSync();
  }

  async function login(url: string, username: string, password: string): Promise<void> {
    await authenticate(url, () => api.login(username, password), loginErrorMessage);
  }

  async function register(
    url: string,
    username: string,
    password: string,
    nick: string,
  ): Promise<void> {
    await authenticate(url, () => api.register(username, password, nick), registerErrorMessage);
  }

  async function restoreSessionOnce(): Promise<void> {
    // 世代采样必须早于本函数里所有 await：否则恢复过程中的退登/换号要等到几个设置读
    // 之后才被看见，中间这段窗口里旧会话会被当成当前会话写回。
    const epoch = sessionEpoch;

    const [url, userId, savedNickname] = await Promise.all([
      readStringSetting(KEY_URL),
      readStringSetting(KEY_USER_ID),
      readStringSetting(KEY_NICKNAME),
    ]);
    // 没配地址 → 一次网络都不发，保持 guest（App 行为与没开同步时完全一致）
    if (!url) {
      goGuest();
      return;
    }

    // 地址只要配了就算就绪（MePage 据此从「未开启」切到「未登录」并给出登录入口），
    // setBaseUrl 只是记地址，不发请求。
    api.setBaseUrl(url);
    baseUrl.value = url;
    if (!userId) {
      goGuest();
      return;
    }

    // 恢复失败时 MePage 仍能显示上次的昵称
    if (savedNickname) nickname.value = savedNickname;

    const stored = await readRefreshToken(userId);
    if (!stored) {
      goGuest();
      return;
    }
    // 读设置 / 读 token 期间用户可能已退登或换号：再调 api.refreshSession 的话，
    // 它内部采样到的世代已是退登之后，会判定「可写回」并把凭据重新写回 api 内存与磁盘，
    // 而 store 侧因 epoch 变了提前 return —— 结果 store 是 guest、api 却有凭据。
    // 这里在发请求前补一次检查，直接不发。
    if (epoch !== sessionEpoch) return;

    try {
      const resp = await api.refreshSession(stored);
      if (epoch !== sessionEpoch) {
        // 换新期间用户退登或换了账号：这次恢复属于旧会话，不切在线。
        // api.refreshSession 自带世代守卫，不会把旧凭据写回（退登不会复活已退出的会话；
        // 换号时不会串号，最坏是新账号需要重新登录一次）。这里**不能**再 clearTokens()：
        // 换号时它清的是刚登录的新账号的凭据。
        return;
      }
      if (resp.user.id !== userId) {
        // 凭据串号：换回来的不是 settings 里记的那个账号，清掉且不切在线
        api.clearTokens();
        await deleteRefreshToken(userId);
        goGuest();
        return;
      }
      serverUser.value = resp.user;
      nickname.value = resp.user.nickname;
      mode.value = "online";
      await persistSession(resp.user, url);
      // 冷启动恢复会话成功同样算「会话变在线」（spec §9.5）
      triggerPostSessionSync();
    } catch (err) {
      // 服务端明确说 refresh token 失效才清；超时 / 断网保留凭据与设置。
      // 无论哪种都保持 guest，绝不阻塞或清空本地菜谱。
      if (isHttpError(err) && (err.status === 401 || err.status === 403)) {
        api.clearTokens();
        await deleteRefreshToken(userId);
      }
      goGuest();
    }
  }

  // 会话恢复在途复用：启动钩子与 MePage 挂载可能同时触发，两次各自发一次 refresh 时，
  // 若服务端轮换 refresh token，后到的那次会拿 401 并把刚恢复好的会话清回 guest。
  let pendingRestore: Promise<void> | null = null;

  function restoreSession(): Promise<void> {
    if (mode.value === "online") return Promise.resolve();
    if (pendingRestore) return pendingRestore;
    pendingRestore = restoreSessionOnce().finally(() => {
      pendingRestore = null;
    });
    return pendingRestore;
  }

  async function logout(): Promise<void> {
    sessionEpoch++;
    const userId = serverUser.value?.id;
    // 冷启动恢复在途时退登：serverUser 还是 null、api 的 currentUserId 也还没设过，
    // 不补这一步就没人删磁盘上那个账号的 refresh token —— 下次冷启动会把用户刚退出的会话自动恢复回来。
    const persistedUserId = userId ?? (await readStringSetting(KEY_USER_ID));
    lastSyncFailed.value = false;
    lastSyncedTime.value = null;
    goGuest();
    api.clearTokens();
    // 兜底：api.clearTokens 按 currentUserId 删，这里再按已知的服务端 user id 删一次
    if (persistedUserId) await deleteRefreshToken(persistedUserId);
    // 刻意不动 settings 里的 server_url 与账号信息：下次登录不用重填地址
  }

  function notifySyncComplete(): void {
    lastSyncedTime.value = new Date().toISOString();
    lastSyncFailed.value = false;
    syncVersion.value++;
  }

  return {
    mode,
    isOnline,
    serverUser,
    serverUserId,
    nickname,
    baseUrl,
    lastSyncFailed,
    lastSyncedTime,
    syncVersion,
    restoreSession,
    login,
    register,
    logout,
    notifySyncComplete,
  };
});

/**
 * 单例 store。没有活跃 pinia 时传一个**显式实例**，不去 `setActivePinia`：
 * 设成全局 active 会让游离 store 抢先成为后续所有 `useStore()` 的落点 ——
 * 一旦有模块级 `useAuthStore()` 早于 `app.use(createPinia())`，登录就写进游离 store、
 * 界面读 app 的 store，表现为「登录成功但界面仍显示未登录」且完全静默。
 *
 * shortcut: 为不改已有测试（placeholderPages.test.ts 裸挂载 MePage）而留；
 * 升级时机：给 placeholderPages.test.ts 装 pinia 后删掉这个兜底。
 */
export function useAuthStore(): ReturnType<typeof useAuthStoreBase> {
  return useAuthStoreBase(getActivePinia() ?? createPinia());
}
