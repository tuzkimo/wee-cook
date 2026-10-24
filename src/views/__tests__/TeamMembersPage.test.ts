import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TeamMembersPage from "@/views/TeamMembersPage.vue";
import type { TeamMember } from "@/types";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  members: [] as TeamMember[],
  invite: vi.fn(async () => "123456"),
  rename: vi.fn(async () => ({})),
  removeMember: vi.fn(async () => {}),
  transfer: vi.fn(async () => {}),
  leave: vi.fn(async () => {}),
  dissolve: vi.fn(async () => {}),
  uid: "u1" as string | null,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, back: mocks.back }),
  useRoute: () => ({ params: { id: "t1" } }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({
    get serverUserId() {
      return mocks.uid;
    },
  }),
}));
vi.mock("@/stores/team", () => ({
  useTeamStore: () => ({
    teams: [{ id: "t1", name: "自己家", role: "owner", member_count: 2 }],
    load: vi.fn(async () => {}),
    members: vi.fn(async () => mocks.members),
    invite: mocks.invite,
    rename: mocks.rename,
    removeMember: mocks.removeMember,
    transfer: mocks.transfer,
    leave: mocks.leave,
    dissolve: mocks.dissolve,
  }),
}));

const wrappers: VueWrapper[] = [];

function member(userId: string, nickname: string, role: TeamMember["role"]): TeamMember {
  return { user_id: userId, nickname, username: nickname, role };
}

async function page(): Promise<VueWrapper> {
  const wrapper = mount(TeamMembersPage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.members.length = 0;
  mocks.uid = "u1";
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("TeamMembersPage", () => {
  it("owner 视角：显示改名 / 邀请码 / 移除 / 转让 / 解散", async () => {
    mocks.members.push(member("u1", "我", "owner"), member("u2", "老王", "member"));

    const wrapper = await page();

    expect(wrapper.findAll('[data-test="member-name"]').map((node) => node.text())).toEqual([
      "我",
      "老王",
    ]);
    for (const test of ["team-rename", "team-invite", "team-dissolve"]) {
      expect(wrapper.find(`[data-test="${test}"]`).exists(), test).toBe(true);
    }
    // 只有别人的行才有「移除 / 转让」
    expect(wrapper.findAll('[data-test="member-remove"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-test="member-transfer"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="team-leave"]').exists()).toBe(false);
  });

  it("member 视角：只有「退出团队」", async () => {
    mocks.uid = "u2";
    mocks.members.push(member("u1", "我", "owner"), member("u2", "老王", "member"));

    const wrapper = await page();

    expect(wrapper.find('[data-test="team-leave"]').exists()).toBe(true);
    for (const test of ["team-rename", "team-invite", "team-dissolve", "member-remove"]) {
      expect(wrapper.find(`[data-test="${test}"]`).exists(), test).toBe(false);
    }
  });

  it("生成邀请码后显示 6 位码", async () => {
    mocks.members.push(member("u1", "我", "owner"));
    const wrapper = await page();

    await wrapper.get('[data-test="team-invite"]').trigger("click");
    await flushPromises();

    expect(mocks.invite).toHaveBeenCalledWith("t1");
    expect(wrapper.get('[data-test="team-invite-code"]').text()).toBe("123456");
  });

  it("改名走行内输入 + 保存", async () => {
    mocks.members.push(member("u1", "我", "owner"));
    const wrapper = await page();

    await wrapper.get('[data-test="team-rename"]').trigger("click");
    await wrapper.get('[data-test="team-rename-input"]').setValue("新名字");
    await wrapper.get('[data-test="team-rename-submit"]').trigger("click");
    await flushPromises();

    expect(mocks.rename).toHaveBeenCalledWith("t1", "新名字");
  });

  it("退出团队要过确认框", async () => {
    mocks.uid = "u2";
    mocks.members.push(member("u1", "我", "owner"), member("u2", "老王", "member"));
    const wrapper = await page();

    await wrapper.get('[data-test="team-leave"]').trigger("click");
    await flushPromises();
    const buttons = [...document.body.querySelectorAll("button")];
    const confirm = buttons.find((button) => button.textContent?.trim() === "退出");
    expect(confirm).toBeDefined();
    confirm!.click();
    await flushPromises();

    expect(mocks.leave).toHaveBeenCalledWith("t1");
    expect(mocks.replace).toHaveBeenCalledWith("/me/teams");
  });
});
