import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import { activeScope, setActiveScope } from "@/services/scope";
import { clearSyncCursorFor, requestSyncNow } from "@/services/sync";
import { useTeamStore } from "@/stores/team";
import type { TeamSummary } from "@/types";

// 网络与同步调度都换替身：这个 store 只负责「缓存 / 当前范围 / 切换后重查」。
const mocks = vi.hoisted(() => ({
  fetchTeams: vi.fn(),
  createTeam: vi.fn(),
  joinTeam: vi.fn(),
  renameTeam: vi.fn(),
  fetchMembers: vi.fn(),
  createInvite: vi.fn(),
  removeMember: vi.fn(),
  leaveTeam: vi.fn(),
  transferOwner: vi.fn(),
  dissolveTeam: vi.fn(),
  uid: "u1" as string | null,
  fetchRecipeAll: vi.fn(async () => {}),
  fetchInventoryAll: vi.fn(async () => {}),
  fetchRefAll: vi.fn(async () => {}),
  fetchLabelAll: vi.fn(async () => {}),
}));

vi.mock("@/services/team", () => mocks);
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({
    get serverUserId() {
      return mocks.uid;
    },
  }),
}));
vi.mock("@/services/sync", () => ({
  clearSyncCursorFor: vi.fn(),
  requestSyncNow: vi.fn(),
}));
vi.mock("@/stores/recipe", () => ({ useRecipeStore: () => ({ fetchAll: mocks.fetchRecipeAll }) }));
vi.mock("@/stores/inventory", () => ({
  useInventoryStore: () => ({ fetchAll: mocks.fetchInventoryAll }),
}));
vi.mock("@/stores/ingredient", () => ({
  useIngredientStore: () => ({ fetchAll: mocks.fetchRefAll }),
  useUnitStore: () => ({ fetchAll: mocks.fetchRefAll }),
}));
vi.mock("@/stores/label", () => ({ useLabelStore: () => ({ fetchAll: mocks.fetchLabelAll }) }));

function team(id: string, name: string, role: TeamSummary["role"] = "owner"): TeamSummary {
  return { id, name, role, member_count: 1 };
}

async function cachedTeams(db: Db): Promise<{ id: string; name: string; role: string }[]> {
  return db.select("SELECT id, name, role FROM teams ORDER BY id");
}

let db: Db;

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
  localStorage.clear();
  setActiveScope("p:local");
  mocks.uid = "u1";
  vi.clearAllMocks();
  mocks.fetchTeams.mockResolvedValue([team("t1", "自己家")]);
  mocks.createTeam.mockResolvedValue(team("t2", "新家"));
  mocks.joinTeam.mockResolvedValue(team("t3", "爸妈家", "member"));
  mocks.leaveTeam.mockResolvedValue({});
  mocks.removeMember.mockResolvedValue({});
  mocks.dissolveTeam.mockResolvedValue({});
});

describe("teamStore", () => {
  it("load 把 GET /teams 的快照整表替换进本地缓存", async () => {
    await db.execute("INSERT INTO teams (id, name, role, member_count) VALUES ('gone','旧团队','owner',2)");

    const store = useTeamStore();
    await store.load();

    expect(store.teams.map((row) => row.id)).toEqual(["t1"]);
    expect(await cachedTeams(db)).toEqual([{ id: "t1", name: "自己家", role: "owner" }]);
  });

  it("create 之后切到新团队、清游标、触发同步", async () => {
    const store = useTeamStore();
    await store.load();

    await store.create("新家");

    expect(store.currentTeamId).toBe("t2");
    expect(activeScope.value).toBe("t:t2");
    expect(clearSyncCursorFor).toHaveBeenCalledWith("u1");
    expect(requestSyncNow).toHaveBeenCalled();
    expect(localStorage.getItem("current_team:u1")).toBe("t2");
    expect(mocks.fetchRecipeAll).toHaveBeenCalled();
    expect(mocks.fetchInventoryAll).toHaveBeenCalled();
  });

  it("join 同构：入组后直接在那个团队的范围里", async () => {
    const store = useTeamStore();
    await store.load();

    await store.join("123456");

    expect(store.currentTeamId).toBe("t3");
    expect(activeScope.value).toBe("t:t3");
    expect(clearSyncCursorFor).toHaveBeenCalledWith("u1");
  });

  it("退出当前团队后回落到「我的菜谱」", async () => {
    const store = useTeamStore();
    await store.load();
    store.switchTo("t1");
    expect(activeScope.value).toBe("t:t1");

    await store.leave("t1");

    expect(store.currentTeamId).toBeNull();
    expect(activeScope.value).toBe("p:u1");
    expect(localStorage.getItem("current_team:u1")).toBeNull();
  });

  it("被移除 / 解散当前团队也回落", async () => {
    const store = useTeamStore();
    await store.load();
    store.switchTo("t1");
    await store.removeMember("t1", "u1");
    expect(store.currentTeamId).toBeNull();

    store.switchTo("t1");
    await store.dissolve("t1");
    expect(store.currentTeamId).toBeNull();
  });

  it("resetFor 清空缓存与当前范围（登出）", async () => {
    const store = useTeamStore();
    await store.load();
    store.switchTo("t1");
    expect(await cachedTeams(db)).toHaveLength(1);

    store.resetFor(null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.teams).toEqual([]);
    expect(store.currentTeamId).toBeNull();
    expect(await cachedTeams(db)).toEqual([]);
  });

  it("未登录时 create 抛「先连接服务器」，一个请求都不发", async () => {
    mocks.uid = null;
    const store = useTeamStore();

    await expect(store.create("新家")).rejects.toThrow("先连接服务器");
    expect(mocks.createTeam).not.toHaveBeenCalled();
  });
});

describe("登录后的活动范围", () => {
  it("没有保存过范围时，恢复也把活动范围切到个人范围（否则认领后是一屏空态）", async () => {
    const store = useTeamStore();
    await store.load();
    expect(activeScope.value).toBe("p:u1");

    setActiveScope("p:local");
    await store.restoreCurrentTeam();

    expect(store.currentTeamId).toBeNull();
    expect(activeScope.value).toBe("p:u1");
  });

  it("保存过的团队还在缓存里就恢复它", async () => {
    localStorage.setItem("current_team:u1", "t1");
    const store = useTeamStore();
    await store.load();

    await store.restoreCurrentTeam();

    expect(store.currentTeamId).toBe("t1");
    expect(activeScope.value).toBe("t:t1");
  });

  it("保存过的团队已经不在缓存里就回落个人范围", async () => {
    localStorage.setItem("current_team:u1", "gone");
    const store = useTeamStore();
    await store.load();

    await store.restoreCurrentTeam();

    expect(store.currentTeamId).toBeNull();
    expect(activeScope.value).toBe("p:u1");
  });
});
