// src/services/api.ts
//
// 在线服务的网络层：baseUrl、15s 超时兜底（长任务可按调用方传入覆盖）、401 → refresh 单飞、以及一组 auth 薄封装。
// 两条贯穿全层的约定：
//  1. **未配置服务器地址时不得发起任何网络请求**（`getBaseUrl()` 抛错，apiFetch 直接冒泡）。
//     `hasBaseUrl()` 是唯一的就绪判据，调用方靠 `baseUrlReady` 这个响应式视图决定何时探活。
//  2. `ApiResult` 只描述「服务端答了话」的情形；**拿不到 HTTP 响应**（超时 / 断网 / 地址未配）
//     一律抛异常。故 `status` 只会是真实状态码，不存在 wee-count 里那个 `status: 0` 分支。
import { computed, ref } from "vue";
import { deleteRefreshToken, readRefreshToken, writeRefreshToken } from "./tokenStorage";

let baseUrl: string | null = null

/**
 * `baseUrl` 的**响应式镜像**：它一变就通知订阅者。
 *
 * 为什么需要：`setBaseUrl()` 的调用点全在异步初始化之后（auth store 恢复会话、ServerConfig
 * 页保存地址），而「地址就绪之后才允许做网络探测」这件事在组件里**没有可 watch 的对象** ——
 * 模块级 `let` 变了不会触发任何重算，探测要么挂在 `onMounted`（早于就绪 ⇒ 真机上必然失败）
 * 要么靠轮询。这里只暴露一个布尔视图，`baseUrl` 仍是唯一真相源，取值口径与 `hasBaseUrl()`
 * 逐字相同（`!== null`）。
 */
const baseUrlSet = ref(false)

/** 只读视图：地址是否已配置。 */
export const baseUrlReady = computed(() => baseUrlSet.value)

let accessToken: string | null = null
let refreshToken: string | null = null
/** `authTokenReady` 的真相源；与上面两个 token 变量同生同灭 */
const authTokenSet = ref(false)

/**
 * 登录凭据（access / refresh token）是否**已经拿到**的响应式镜像。
 *
 * 为什么需要它：token 是**异步**恢复的，而「地址就绪」发生在恢复之前，于是"地址一就绪就发请求"
 * 的自动流程会在**一个凭据都没有**的时候发请求（`apiFetch` 只在有 accessToken 时才加
 * Authorization 头、且 refresh 分支要求 refreshToken 非空）⇒ 服务端如实回 401，
 * 界面把这种 401 误报成"登录已过期"。所以它有两个用途：
 *  1. 文案：没有凭据时的 401 **不是**"登录已过期"的证据；
 *  2. 时机：凭据就绪那一刻才允许自动补探一次。
 *
 * 取值口径与两个 token 变量逐字一致（任一非 null ⇒ 就绪）：赋值点（`setTokens` / `clearTokens`）
 * 都在同一处翻这个开关，别只改一边。
 */
export const authTokenReady = computed(() => authTokenSet.value)

// 当前会话归属的服务端用户 id：refresh_token 按它独立存取，避免同设备多账号串号。
let currentUserId: string | null = null

// 凭据世代：任何显式写/清凭据（setTokens / clearTokens）都递增。
// refresh 在发起前记下当时的世代，返回后世代已变就丢弃结果 —— 否则退登或换号后，
// 在途的那次 refresh 会把旧会话凭据写回来（复活已退出的会话 / 把 A 的凭据串成 B 的）。
let tokenGeneration = 0

// refresh 单飞：并发 401 时共享同一个 refresh promise，避免各自触发 refresh 导致竞态
// （多个 refresh 并发换新，后到的用过期 refresh token 把先到的结果覆盖掉）。
let refreshInFlight: Promise<boolean> | null = null

export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, '') // 去掉末尾斜杠
  baseUrlSet.value = true
}

export function getBaseUrl(): string {
  if (!baseUrl) throw new Error('API base URL not configured')
  return baseUrl
}

export function hasBaseUrl(): boolean {
  return baseUrl !== null
}

/**
 * 给裸 fetch 加超时兜底：服务端 TCP 可达但 HTTP 不响应（半死 / 代理丢包）时，原生 fetch 会
 * 永久 pending，把整条 await 链挂死（白屏事故的成因）。超时后 abort。
 *
 * `init.signal`（外部取消）不能覆盖：`{ ...init, signal: controller.signal }` 会让外部 signal
 * 静默失效（请求照发、结果照回），所以把两者串起来，外部一 abort 就转发给超时 controller。
 * 已经 abort 过的 signal 不会再派发事件，必须显式接一次，否则请求照样发出去。
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController()
  let timeoutFired = false
  const timer = setTimeout(() => {
    timeoutFired = true
    controller.abort()
  }, timeoutMs)

  const external = init.signal ?? null
  const onAbort = (): void => controller.abort()
  if (external !== null) {
    if (external.aborted) controller.abort()
    else external.addEventListener("abort", onAbort)
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (err) {
    // 兜底开火 ⇒ 换成调用方能读懂的文案；裸 fetch 自己的错（断网 / DNS）原样抛，
    // 上层只需要把两种情况都归成"连不上服务器"。
    if (timeoutFired) throw new Error("请求超时")
    throw err
  } finally {
    clearTimeout(timer)
    external?.removeEventListener("abort", onAbort)
  }
}

export function setTokens(userId: string, access: string, refresh: string): void {
  tokenGeneration++
  currentUserId = userId
  accessToken = access
  refreshToken = refresh
  authTokenSet.value = true
  void writeRefreshToken(userId, refresh)
}

export function clearTokens(): void {
  tokenGeneration++
  if (currentUserId) void deleteRefreshToken(currentUserId)
  currentUserId = null
  accessToken = null
  refreshToken = null
  authTokenSet.value = false
}

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  const generation = tokenGeneration
  refreshInFlight = (async () => {
    const stored = currentUserId ? await readRefreshToken(currentUserId) : null
    if (!stored || !hasBaseUrl()) return false

    try {
      const data = await postAuthRaw(
        "/api/v1/auth/refresh",
        { refresh_token: stored },
        "会话已过期，请重新登录",
      )
      // 在途期间退登或换号 ⇒ 这次刷新属于旧会话，写回只会复活/串号
      if (generation !== tokenGeneration) return false
      setTokens(data.user.id, data.access_token, data.refresh_token)
      return true
    } catch (err) {
      // 只有服务端明确答了 401/403 才算凭据失效；超时/断网拿不到响应时保留 refresh token，
      // 否则移动端网络一抖，用户下次冷启动就不会自动恢复会话了。
      if (err instanceof AuthError && (err.status === 401 || err.status === 403)) clearTokens()
      return false
    }
  })()
  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string }

/**
 * 带凭据请求的**原始响应**：默认头 + Authorization + 401 单飞刷新重试一次，**不解析 body**。
 *
 * 图片通道（spec §8）走裸二进制，需要它：`GET /api/v1/files/{name}` 的响应体就是 JPEG 字节，
 * 而 `apiFetch` 末尾的 `res.json()` 会把 body 读空，二进制就拿不回来了。这两个端点同样是受保护的
 * （spec §10.2），不带头会 401 —— 所以不能退回裸 `fetchWithTimeout`。
 */
export async function fetchWithAuth(
  path: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const url = `${getBaseUrl()}${path}`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) || {}),
  }
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`

  let res = await fetchWithTimeout(url, { ...init, headers }, timeoutMs)

  if (res.status === 401 && refreshToken && (await refreshAccessToken())) {
    headers["Authorization"] = `Bearer ${accessToken}`
    res = await fetchWithTimeout(url, { ...init, headers }, timeoutMs)
  }

  return res
}

/**
 * 带凭据请求。**未配置地址时抛错**（不发请求）；**拿不到 HTTP 响应**（超时 / 断网）同样抛错。
 * 服务端答了话就一定返回 `ApiResult`，500 也不抛。
 *
 * 401 时（且手上有 refresh token）先单飞刷新一次再重试**一次**；重试用的是 `fetchWithTimeout`
 * 而不是递归调 `apiFetch`，否则 401 会无限套娃。
 *
 * `timeoutMs` 只在「上游本身就慢」的端点上才需要传（AI 聊天等 120s）：默认 15s 是给普通接口的兜底，
 * 拿它套长任务会让客户端先撒手、服务端还在烧 token。
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<ApiResult<T>> {
  // 带凭据与 401 刷新走 fetchWithAuth；差别只在下面多一步解析 JSON
  const res = await fetchWithAuth(path, init, timeoutMs)

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return { ok: false, status: res.status, error: body.error || res.statusText }
  }

  const data = await res.json().catch(() => undefined)
  return { ok: true, status: res.status, data }
}

// --- Auth ---

export interface User {
  id: string
  username: string
  nickname: string
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export interface AuthResponse {
  user: User
  access_token: string
  refresh_token: string
}

/** auth 端点失败时带上状态码：调用方据此区分「服务端拒绝凭据」与「拿不到响应」。 */
class AuthError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * 三个 auth 端点的公共形状：POST 一个 JSON body。跑 `fetchWithTimeout` 而不是 `apiFetch`：
 * 这些端点不需要 Authorization，且 refresh 若再走 401 分支就会递归。
 *
 * 只负责取回响应体，**不写凭据** —— 是否提交由调用方决定，refresh 才能在响应在途、
 * 凭据已被改动时丢弃结果（见 `refreshAccessToken`）。
 */
async function postAuthRaw(path: string, body: unknown, fallback: string): Promise<AuthResponse> {
  const res = await fetchWithTimeout(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new AuthError(res.status, err.error || fallback)
  }
  return await res.json()
}

/** postAuthRaw + 成功即写凭据（login / register / 公开的 refreshSession 用）。 */
async function postAuth(path: string, body: unknown, fallback: string): Promise<AuthResponse> {
  const data = await postAuthRaw(path, body, fallback)
  setTokens(data.user.id, data.access_token, data.refresh_token)
  return data
}

export function login(username: string, password: string): Promise<AuthResponse> {
  return postAuth("/api/v1/auth/login", { username, password }, "登录失败")
}

export function register(username: string, password: string, nickname?: string): Promise<AuthResponse> {
  return postAuth("/api/v1/auth/register", { username, password, nickname }, "注册失败")
}

export async function refreshSession(refreshTokenValue: string): Promise<AuthResponse> {
  // 与 refreshAccessToken 同一条世代守卫：在途期间退登或换号时不写回，
  // 否则旧会话的凭据会复活已退出的会话 / 覆盖新账号的凭据。
  const generation = tokenGeneration;
  const data = await postAuthRaw(
    "/api/v1/auth/refresh",
    { refresh_token: refreshTokenValue },
    "会话已过期，请重新登录",
  );
  if (generation === tokenGeneration) setTokens(data.user.id, data.access_token, data.refresh_token);
  return data;
}

export async function getMe(): Promise<User> {
  const res = await apiFetch<{ user: User }>("/api/v1/me")
  if (!res.ok) throw new Error(res.error)
  return res.data.user
}

export interface UpdateProfileRequest {
  nickname?: string
  avatar_url?: string
}

export async function updateProfile(data: UpdateProfileRequest): Promise<User> {
  const res = await apiFetch<User>("/api/v1/auth/profile", {
    method: "PUT",
    body: JSON.stringify(data),
  })
  // 带 status：调用方要区分「服务端拒了」（用服务端文案）与「拿不到响应」（走通用文案）
  if (!res.ok) throw new AuthError(res.status, res.error)
  return res.data
}
