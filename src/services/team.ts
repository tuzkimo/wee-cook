// 团队接口的薄封装（spec §9）：全部走 apiFetch，团队只走 REST、不进同步载荷。
// 服务端用错误码回答（invite_invalid / owner_cannot_leave …），这里翻译成一句人话，
// 页面直接显示 error.message。
import { apiFetch } from "./api";
import type { TeamMember, TeamSummary } from "@/types";

const MESSAGES: Record<string, string> = {
  invite_invalid: "邀请码无效或已过期",
  owner_cannot_leave: "owner 要先转让或解散团队",
  cannot_remove_owner: "不能移除 owner",
  not_member: "对方不是这个团队的成员",
  forbidden: "没有权限",
  "team not found": "团队不存在",
};

function translate(code: string, fallback: string): Error {
  return new Error(MESSAGES[code] ?? fallback);
}

async function call<T>(path: string, init: RequestInit = {}, fallback: string): Promise<T> {
  const res = await apiFetch<T>(path, init);
  if (!res.ok) throw translate(res.error, fallback);
  return res.data as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

export async function fetchTeams(): Promise<TeamSummary[]> {
  const data = await call<{ teams: TeamSummary[] }>("/api/v1/teams", {}, "获取团队失败");
  return data.teams ?? [];
}

export function createTeam(name: string): Promise<TeamSummary> {
  return call<TeamSummary>("/api/v1/teams", json("POST", { name }), "创建团队失败");
}

export function joinTeam(code: string): Promise<TeamSummary> {
  return call<TeamSummary>("/api/v1/teams/join", json("POST", { code }), "加入团队失败");
}

export function renameTeam(id: string, name: string): Promise<unknown> {
  return call(`/api/v1/teams/${id}`, json("PUT", { name }), "改名失败");
}

export async function fetchMembers(id: string): Promise<TeamMember[]> {
  const data = await call<{ members: TeamMember[] }>(
    `/api/v1/teams/${id}/members`,
    {},
    "获取成员失败",
  );
  return data.members ?? [];
}

export async function createInvite(id: string): Promise<string> {
  const data = await call<{ code: string }>(
    `/api/v1/teams/${id}/invite`,
    { method: "POST" },
    "生成邀请码失败",
  );
  return data.code;
}

export function removeMember(id: string, userId: string): Promise<unknown> {
  return call(`/api/v1/teams/${id}/members/${userId}`, { method: "DELETE" }, "移除成员失败");
}

export function leaveTeam(id: string): Promise<unknown> {
  return call(`/api/v1/teams/${id}/members/me`, { method: "DELETE" }, "退出团队失败");
}

export function transferOwner(id: string, userId: string): Promise<unknown> {
  return call(`/api/v1/teams/${id}/owner`, json("PUT", { user_id: userId }), "转让失败");
}

export function dissolveTeam(id: string): Promise<unknown> {
  return call(`/api/v1/teams/${id}`, { method: "DELETE" }, "解散团队失败");
}
