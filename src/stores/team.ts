// src/stores/team.ts
//
// 家庭/团队：我的团队列表、创建、邀请码、加入、成员列表。
// 后端接口形状以 `backend/internal/handler/team.go` 为准（非 brief）：
//   - `GET  /api/v1/teams`              → **裸数组** `[{id,name,created_by,member_count}]`
//   - `POST /api/v1/teams`              → `{"team":{...}}`
//   - `POST /api/v1/teams/{id}/invite`  → `{"invite_code":"...","expires_in":86400}`
//   - `POST /api/v1/teams/join`         body `{"invite_code":"..."}` → `{"team":{...}}`
//   - `GET  /api/v1/teams/{id}/members` → **裸数组** `[{user_id,username,nickname,avatar_url,role}]`
// 另：spec §9.4 —— **create 与 join 成功后都要清当前 uid 的同步游标**（少清一个就拉不到
// 该团队里 sync_seq 早于本地游标的存量菜谱）；两者都清，只有 join 额外触发一次全量重拉。
import { computed, ref, type ComputedRef } from "vue";
import { defineStore } from "pinia";
import { apiFetch } from "@/services/api";
import { clearCursor, performSync } from "@/services/sync";
import { useAuthStore } from "@/stores/auth";

export interface Team {
  id: string;
  name: string;
  created_by: string;
  member_count: number;
}

export type TeamRole = "owner" | "member";

export interface TeamMember {
  user_id: string;
  username: string;
  nickname: string;
  avatar_url: string | null;
  role: TeamRole;
}

/** 拿不到 HTTP 响应（超时 / 断网）时的文案，与 auth store 口径一致。 */
const NETWORK_MESSAGE = "连不上服务器，检查地址和网络";

export const useTeamStore = defineStore("team", () => {
  const teams = ref<Team[]>([]);
  const current = ref<Team | null>(null);

  const auth = useAuthStore();

  /** 新团队并入列表（同 id 覆盖）并设为 current。 */
  function adopt(team: Team): void {
    const idx = teams.value.findIndex((t) => t.id === team.id);
    if (idx >= 0) teams.value[idx] = team;
    else teams.value.push(team);
    current.value = team;
  }

  async function load(): Promise<void> {
    // 未登录 / 未配置地址：一次网络都不发
    if (!auth.serverUserId) return;
    let res: Awaited<ReturnType<typeof apiFetch<Team[]>>>;
    try {
      res = await apiFetch<Team[]>("/api/v1/teams");
    } catch {
      return; // 拿不到响应：保持现状，不误清空列表
    }
    if (res.ok) teams.value = res.data;
  }

  async function create(name: string): Promise<Team> {
    let res: Awaited<ReturnType<typeof apiFetch<{ team: Team }>>>;
    try {
      res = await apiFetch<{ team: Team }>("/api/v1/teams", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    } catch {
      throw new Error(NETWORK_MESSAGE);
    }
    if (!res.ok) throw new Error(res.error);
    adopt(res.data.team);
    // spec §9.4：新团队里已有的菜谱不在本地游标之后，清游标下次同步才全量拉得到。
    clearCursor(auth.serverUserId);
    return res.data.team;
  }

  async function createInvite(teamId: string): Promise<string> {
    let res: Awaited<ReturnType<typeof apiFetch<{ invite_code: string; expires_in: number }>>>;
    try {
      res = await apiFetch<{ invite_code: string; expires_in: number }>(
        `/api/v1/teams/${teamId}/invite`,
        { method: "POST" },
      );
    } catch {
      throw new Error(NETWORK_MESSAGE);
    }
    if (!res.ok) throw new Error(res.error);
    return res.data.invite_code;
  }

  async function joinByCode(code: string): Promise<Team> {
    let res: Awaited<ReturnType<typeof apiFetch<{ team: Team }>>>;
    try {
      res = await apiFetch<{ team: Team }>("/api/v1/teams/join", {
        method: "POST",
        body: JSON.stringify({ invite_code: code }),
      });
    } catch {
      throw new Error(NETWORK_MESSAGE);
    }
    if (!res.ok) throw new Error(res.error);
    adopt(res.data.team);
    // spec §9.4：加入前的存量菜谱不在本地游标之后，清游标再全量重拉，否则永远拉不到它们。
    clearCursor(auth.serverUserId);
    void performSync();
    return res.data.team;
  }

  async function loadMembers(teamId: string): Promise<TeamMember[]> {
    let res: Awaited<ReturnType<typeof apiFetch<TeamMember[]>>>;
    try {
      res = await apiFetch<TeamMember[]>(`/api/v1/teams/${teamId}/members`);
    } catch {
      throw new Error(NETWORK_MESSAGE);
    }
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }

  function isMemberOf(teamId: string): ComputedRef<boolean> {
    return computed(() => teams.value.some((t) => t.id === teamId));
  }

  return { teams, current, load, create, createInvite, joinByCode, loadMembers, isMemberOf };
});
