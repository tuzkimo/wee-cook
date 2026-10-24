import { computed, ref, type Ref } from "vue";
import { defineStore } from "pinia";
import { getDb } from "@/db";
import * as api from "@/services/team";
import { LOCAL_SCOPE, scopeFor, setActiveScope } from "@/services/scope";
import { clearSyncCursorFor, requestSyncNow } from "@/services/sync";
import { useAuthStore } from "@/stores/auth";
import { useIngredientStore, useUnitStore } from "@/stores/ingredient";
import { useInventoryStore } from "@/stores/inventory";
import { useLabelStore } from "@/stores/label";
import { useRecipeStore } from "@/stores/recipe";
import type { TeamMember, TeamSummary } from "@/types";

/**
 * 团队列表与「当前范围」（spec §10.1 / §11.1）。
 *
 * 团队列表只走 REST，本地 `teams` 表是它的整表缓存（登录刷成这个账号的、登出清空）。
 * `currentTeamId` 是全局 UI 状态：菜谱页、库存页、字典选择器都读 `activeScope`，
 * 切换时把受范围影响的 store 全部重查一遍（不重新拉网络）。
 */
export const useTeamStore = defineStore("team", () => {
  const teams = ref<TeamSummary[]>([]);
  const currentTeamId = ref<string | null>(null);

  /** 当前范围键：选了团队就是团队，登录了就是个人，否则是本机范围。 */
  const scopeId = computed(() => scopeFor(authUserId(), currentTeamId.value));

  async function load(): Promise<void> {
    const uid = authUserId();
    if (!uid) {
      teams.value = [];
      currentTeamId.value = null;
      return;
    }
    const rows = await api.fetchTeams();
    teams.value = rows;
    await cacheTeams(rows);
    // 缓存的团队已经不在列表里（被解散 / 被移除）→ 回落「我的菜谱」
    if (currentTeamId.value && !rows.some((team) => team.id === currentTeamId.value)) {
      switchTo(null);
    }
  }

  function switchTo(id: string | null): void {
    currentTeamId.value = id;
    persistCurrentTeam();
    setActiveScope(scopeId.value);
    void refreshScopedStores();
  }

  async function create(name: string): Promise<void> {
    requireOnline();
    const team = await api.createTeam(name);
    await afterJoin(team.id);
  }

  async function join(code: string): Promise<void> {
    requireOnline();
    const team = await api.joinTeam(code);
    await afterJoin(team.id);
  }

  function rename(id: string, name: string): Promise<unknown> {
    return api.renameTeam(id, name).then(async (res) => {
      await load();
      return res;
    });
  }

  function members(id: string): Promise<TeamMember[]> {
    return api.fetchMembers(id);
  }

  function invite(id: string): Promise<string> {
    return api.createInvite(id);
  }

  async function removeMember(id: string, userId: string): Promise<void> {
    await api.removeMember(id, userId);
    if (userId === authUserId() && currentTeamId.value === id) switchTo(null);
    await load();
  }

  async function leave(id: string): Promise<void> {
    await api.leaveTeam(id);
    if (currentTeamId.value === id) switchTo(null);
    await load();
  }

  async function transfer(id: string, userId: string): Promise<void> {
    await api.transferOwner(id, userId);
    await load();
  }

  async function dissolve(id: string): Promise<void> {
    await api.dissolveTeam(id);
    if (currentTeamId.value === id) switchTo(null);
    await load();
  }

  /** 登出 / 换号：清掉本地缓存与当前范围（spec §8.5）。 */
  function resetFor(uid: string | null): void {
    teams.value = [];
    currentTeamId.value = null;
    void getDb()
      .execute("DELETE FROM teams")
      .catch(() => {});
    if (uid) localStorage.removeItem(PERSIST_PREFIX + uid);
    setActiveScope(LOCAL_SCOPE);
  }

  /**
   * 建团 / 入团之后：整表刷新 → 切到新团队 → 清游标 → 触发一次同步。
   * 清游标是必须的（spec §12.10）：只有一个全局游标，新团队里那些 server_seq
   * 早于游标的行否则永远拉不下来。切到新范围再同步，拉回来才落在这个团队里。
   */
  async function afterJoin(teamId: string): Promise<void> {
    await load();
    switchTo(teamId);
    clearSyncCursorFor(authUserId());
    requestSyncNow();
  }

  /** 切范围后把受范围影响的列表全部重查（纯本地，不发网络）。 */
  async function refreshScopedStores(): Promise<void> {
    const label = useLabelStore();
    await Promise.all([
      useRecipeStore().fetchAll(),
      useInventoryStore().fetchAll(),
      useIngredientStore().fetchAll(),
      useUnitStore().fetchAll(),
      label.fetchAll("category"),
      label.fetchAll("tag"),
    ]);
  }

  // --- 持久化：当前团队按账号隔离（spec §10.1）---

  const PERSIST_PREFIX = "current_team:";

  function persistCurrentTeam(): void {
    const uid = authUserId();
    if (!uid) return;
    if (currentTeamId.value) localStorage.setItem(PERSIST_PREFIX + uid, currentTeamId.value);
    else localStorage.removeItem(PERSIST_PREFIX + uid);
  }

  /** 冷启动恢复上次选中的范围；那个团队已不在缓存里就回落「我的菜谱」。 */
  async function restoreCurrentTeam(): Promise<void> {
    const uid = authUserId();
    if (!uid) return;
    const saved = localStorage.getItem(PERSIST_PREFIX + uid);
    if (saved && teams.value.some((team) => team.id === saved)) switchTo(saved);
  }

  /** teams 表是 GET /teams 的全量快照：整表替换，不做增量合并。 */
  async function cacheTeams(rows: TeamSummary[]): Promise<void> {
    const db = getDb();
    await db.execute("DELETE FROM teams");
    for (const team of rows) {
      await db.execute(
        "INSERT INTO teams (id, name, role, member_count) VALUES (?, ?, ?, ?)",
        [team.id, team.name, team.role, team.member_count],
      );
    }
  }

  /** 没登录就没有团队可言：提前报错，别让请求带着空身份打出去。 */
  function requireOnline(): void {
    if (!authUserId()) throw new Error("先连接服务器再使用团队");
  }

  function authUserId(): string | null {
    try {
      return useAuthStore().serverUserId;
    } catch {
      return null;
    }
  }

  return {
    teams: teams as Ref<TeamSummary[]>,
    currentTeamId,
    scopeId,
    load,
    switchTo,
    create,
    join,
    rename,
    members,
    invite,
    removeMember,
    leave,
    transfer,
    dissolve,
    resetFor,
    restoreCurrentTeam,
  };
});
