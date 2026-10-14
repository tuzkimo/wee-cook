import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as api from "@/services/api";
import { getLastSyncedAtFor, performSync, setLastSyncedAtFor } from "@/services/sync";
import { useAuthStore } from "@/stores/auth";
import { useTeamStore, type Team, type TeamMember } from "@/stores/team";

// sync 模块只 mock performSync：游标的读/写/清是真的（落在 localStorage 上），
// 否则「加入后清游标」这条钉子就测不到了。performSync 会发网络请求，mock 掉并断言被触发。
vi.mock("@/services/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/sync")>();
  return { ...actual, performSync: vi.fn().mockResolvedValue(true) };
});

const NOW = "2026-10-14T10:00:00.000Z";

/** 只喂 `ok/status/json` 的 Response 替身。 */
function res(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => payload,
  } as unknown as Response;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** 直接种当前会话：serverUserId 由 serverUser 派生，不用真跑一遍登录。 */
function loginAs(id: string): void {
  useAuthStore().serverUser = {
    id,
    username: id,
    nickname: id,
    avatar_url: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function team(overrides: Partial<Team> = {}): Team {
  return { id: "t1", name: "一家人", created_by: "u1", member_count: 1, ...overrides };
}

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    user_id: "u1",
    username: "alice",
    nickname: "阿丽",
    avatar_url: null,
    role: "member",
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  localStorage.clear();
  api.clearTokens();
  api.setBaseUrl("https://srv");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("teamStore", () => {
  it("load 未登录时不做任何网络请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const store = useTeamStore();

    await store.load();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.teams).toEqual([]);
  });

  it("创建团队后列表里出现它并成为 current", async () => {
    loginAs("u1");
    const created = team({ id: "t9", name: "亲家", created_by: "u1", member_count: 1 });
    const fetchMock = stubFetch((url, init) => {
      expect(url).toBe("https://srv/api/v1/teams");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ name: "亲家" });
      return res(201, { team: created });
    });
    const store = useTeamStore();

    const got = await store.create("亲家");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(got).toEqual(created);
    expect(store.teams).toEqual([created]);
    expect(store.current).toEqual(created);
    expect(store.isMemberOf("t9").value).toBe(true);
  });

  it("加入成功后清空同步游标（否则拉不到加入前的存量菜谱）", async () => {
    loginAs("u1");
    setLastSyncedAtFor("u1", "128");
    const joined = team({ id: "t2", name: "亲家", created_by: "u9", member_count: 2 });
    stubFetch((url, init) => {
      expect(url).toBe("https://srv/api/v1/teams/join");
      expect(JSON.parse(String(init?.body))).toEqual({ invite_code: "123456" });
      return res(200, { team: joined });
    });
    const store = useTeamStore();

    await store.joinByCode("123456");

    expect(getLastSyncedAtFor("u1")).toBeNull();
    expect(performSync).toHaveBeenCalled();
    expect(store.teams).toEqual([joined]);
    expect(store.current).toEqual(joined);
  });

  it("加入失败（码无效/已是成员）时不清游标", async () => {
    loginAs("u1");
    setLastSyncedAtFor("u1", "128");
    const store = useTeamStore();

    stubFetch(() => res(400, { error: "invalid or expired invite code" }));
    await expect(store.joinByCode("000000")).rejects.toThrow();
    expect(getLastSyncedAtFor("u1")).toBe("128");

    stubFetch(() => res(409, { error: "already a member of this team" }));
    await expect(store.joinByCode("123456")).rejects.toThrow();
    expect(getLastSyncedAtFor("u1")).toBe("128");
    expect(performSync).not.toHaveBeenCalled();
  });

  it("成员列表按接口返回渲染，不改动顺序", async () => {
    loginAs("u1");
    const members = [
      member({ user_id: "u9", username: "owner", nickname: "家长", role: "owner" }),
      member({ user_id: "u1", username: "alice", nickname: "阿丽", role: "member" }),
    ];
    stubFetch((url) => {
      expect(url).toBe("https://srv/api/v1/teams/t1/members");
      return res(200, members);
    });
    const store = useTeamStore();

    const got = await store.loadMembers("t1");

    expect(got.map((m) => m.user_id)).toEqual(["u9", "u1"]);
    expect(got.map((m) => m.role)).toEqual(["owner", "member"]);
  });
});
