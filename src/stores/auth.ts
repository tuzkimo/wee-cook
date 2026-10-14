// src/stores/auth.ts
//
// 单账号在线会话。三件事：restoreSession / login+register / logout。
// 持久化分工（规格 §7.2）：
//   - 地址与账号信息 → settings.json（server_url / server_user_id / server_username / server_nickname）
//   - refresh token   → tokens.json，由 api 层按服务端 user id 隔离存储
// 「登录/恢复会话成功即做一次全扫同步」的接线由 Task 8 的 Step 5 负责；
// 本任务按裁定 R2 不引入同步模块（那个模块到 Task 8 才存在，现在调用会编译不过）。
import { createPinia, defineStore, getActivePinia, setActivePinia } from "pinia";
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
  // `api.refreshSession` 成功后**无条件**写回凭据（Task 2 的既定行为），
  // 恢复会话与用户退登/换号并发时，那次写回属于旧会话 —— 用世代比对把它作废。
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

  async function restoreSession(): Promise<void> {
    if (mode.value === "online") return;

    const [url, userId, savedNickname] = await Promise.all([
      readStringSetting(KEY_URL),
      readStringSetting(KEY_USER_ID),
      readStringSetting(KEY_NICKNAME),
    ]);
    // 没配地址（或没登录过）→ 一次网络都不发，保持 guest（App 行为与没开同步时完全一致）
    if (!url || !userId) {
      goGuest();
      return;
    }

    api.setBaseUrl(url);
    baseUrl.value = url;
    // 恢复失败时 MePage 仍能显示上次的昵称
    if (savedNickname) nickname.value = savedNickname;

    const stored = await readRefreshToken(userId);
    if (!stored) {
      goGuest();
      return;
    }

    const epoch = sessionEpoch;
    try {
      const resp = await api.refreshSession(stored);
      if (epoch !== sessionEpoch) {
        // 换新期间用户退登或换了账号：refreshSession 写回的是旧会话凭据，作废。
        // 安全方向明确：宁可让这次恢复白做，也不能把旧账号的会话带进新账号。
        api.clearTokens();
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

  async function logout(): Promise<void> {
    sessionEpoch++;
    const userId = serverUser.value?.id;
    lastSyncFailed.value = false;
    lastSyncedTime.value = null;
    goGuest();
    api.clearTokens();
    // 兜底：api.clearTokens 按 currentUserId 删，这里再按已知的服务端 user id 删一次
    if (userId) await deleteRefreshToken(userId);
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
 * 单例 store。没有活跃 pinia 时临时建一个：组件外 / 未装 pinia 的裸挂载
 * （单元测试、脚本）也能取到实例，行为与应用内一致。应用里 main.ts 先 `app.use(createPinia())`，
 * 走的是同一份 pinia，不会出现两个实例。
 */
export function useAuthStore(): ReturnType<typeof useAuthStoreBase> {
  if (!getActivePinia()) setActivePinia(createPinia());
  return useAuthStoreBase();
}
