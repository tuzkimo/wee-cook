import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TeamListPage from "@/views/TeamListPage.vue";
import type { TeamSummary } from "@/types";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  load: vi.fn(async () => {}),
  create: vi.fn(async () => {}),
  join: vi.fn(async () => {}),
  teams: [] as TeamSummary[],
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push, back: mocks.back }) }));
vi.mock("@/stores/team", () => ({
  useTeamStore: () => ({
    get teams() {
      return mocks.teams;
    },
    get currentTeamId() {
      return null;
    },
    load: mocks.load,
    create: mocks.create,
    join: mocks.join,
  }),
}));

const wrappers: VueWrapper[] = [];

function team(id: string, name: string, role: TeamSummary["role"], count = 2): TeamSummary {
  return { id, name, role, member_count: count };
}

async function page(): Promise<VueWrapper> {
  const wrapper = mount(TeamListPage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.teams.length = 0;
  vi.clearAllMocks();
});

describe("TeamListPage", () => {
  it("列出我加入的团队（名字 / 角色 / 成员数）", async () => {
    mocks.teams.push(team("t1", "自己家", "owner", 2), team("t2", "爸妈家", "member", 3));

    const wrapper = await page();

    expect(mocks.load).toHaveBeenCalled();
    expect(wrapper.findAll('[data-test="team-name"]').map((node) => node.text())).toEqual([
      "自己家",
      "爸妈家",
    ]);
    expect(wrapper.text()).toContain("owner · 2 人");
    expect(wrapper.text()).toContain("成员 · 3 人");
  });

  it("点一行进成员页", async () => {
    mocks.teams.push(team("t1", "自己家", "owner"));
    const wrapper = await page();

    await wrapper.get('[data-test="team-row"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/me/teams/t1");
  });

  it("点「创建团队」填名字后调 create 并进新团队", async () => {
    mocks.create.mockResolvedValueOnce(undefined);
    const wrapper = await page();

    await wrapper.get('[data-test="team-create"]').trigger("click");
    await wrapper.get('[data-test="team-name-input"]').setValue("新家");
    await wrapper.get('[data-test="team-create-submit"]').trigger("click");
    await flushPromises();

    expect(mocks.create).toHaveBeenCalledWith("新家");
  });

  it("点「邀请码加入」填码后调 join", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="team-join"]').trigger("click");
    await wrapper.get('[data-test="team-code-input"]').setValue("123456");
    await wrapper.get('[data-test="team-join-submit"]').trigger("click");
    await flushPromises();

    expect(mocks.join).toHaveBeenCalledWith("123456");
  });

  it("空名字不发请求，给出提示", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="team-create"]').trigger("click");
    await wrapper.get('[data-test="team-create-submit"]').trigger("click");

    expect(mocks.create).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="team-error"]').text()).toBe("请输入团队名称");
  });

  it("一条团队都没有时给空态", async () => {
    const wrapper = await page();
    expect(wrapper.get('[data-test="team-empty"]').text()).toContain("还没有团队");
  });
});
