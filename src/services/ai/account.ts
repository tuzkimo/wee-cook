// 当前 AI 账号（服务端 user id）的模块级单例，由 auth 写（spec §12.1）。
// 认证态本来就是模块级唯一状态，与 api.ts 的 baseUrl 同款：塞进每个 store 只会多出几份会漂移的副本。
let currentUserId: string | null = null;

export function setAiAccount(id: string | null): void {
  currentUserId = id;
}

export function aiAccount(): string | null {
  return currentUserId;
}
