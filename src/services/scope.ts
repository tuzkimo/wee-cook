import { ref } from "vue";

// 范围键（spec §10.1）：'p:<uid>' 个人 / 't:<teamId>' 团队 / 'p:local' 未登录的本机范围。
// 服务端认的就是这个字符串形状，客户端不再翻译成 team_id + owner_id。
// 这个模块不 import 任何 store：store 全都依赖它，反向依赖会成环。

export const LOCAL_SCOPE = "p:local";

export function personalScope(userId: string): string {
  return `p:${userId}`;
}

export function teamScope(teamId: string): string {
  return `t:${teamId}`;
}

/** 当前生效的范围：选了团队就是团队，登录了就是个人，否则是本机范围。 */
export function scopeFor(userId: string | null, teamId: string | null): string {
  if (teamId) return teamScope(teamId);
  return userId ? personalScope(userId) : LOCAL_SCOPE;
}

/** 全局唯一的活动范围：菜谱页、库存页、字典选择器都读它。 */
export const activeScope = ref<string>(LOCAL_SCOPE);

export function setActiveScope(next: string): void {
  activeScope.value = next;
}
