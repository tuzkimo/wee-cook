import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { useAuthStore } from "@/stores/auth";
import type { CommunityRecipe, UserProfile } from "@/services/community";

const NOW = "2026-10-15T00:00:00.000Z";

// 页面只负责「拿到资料与列表怎么画、点了往哪跳」；取数落在 store / 服务层，由它们自己的测试覆盖。
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  routeParams: {} as Record<string, string>,
  profile: vi.fn(),
  follow: vi.fn(),
  unfollow: vi.fn(),
  openRecipe: vi.fn(),
  list: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, back: mocks.back }),
  useRoute: () => ({ params: mocks.routeParams }),
}));

vi.mock("@/stores/community", () => ({
  useCommunityStore: () => ({
    profile: mocks.profile,
    follow: mocks.follow,
    unfollow: mocks.unfollow,
    openRecipe: mocks.openRecipe,
  }),
}));

// 用户页的菜谱列表不走社区的 load（它不接受 author_id），直接调服务层
vi.mock("@/services/community", () => ({ listCommunityRecipes: mocks.list }));

import UserPage from "@/views/UserPage.vue";

const wrappers: VueWrapper[] = [];

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: "u2",
    nickname: "老王",
    avatar_url: null,
    followed: false,
    public_count: 3,
    ...overrides,
  };
}

function recipe(id: string, name: string): CommunityRecipe {
  return {
    id,
    name,
    cover_path: null,
    author_id: "u2",
    author_nickname: "老王",
    updated_at: NOW,
    favorited: false,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  useAuthStore().mode = "online";
  vi.clearAllMocks();
  mocks.routeParams = { id: "u2" };
  mocks.profile.mockResolvedValue(profile());
  mocks.follow.mockResolvedValue(undefined);
  mocks.unfollow.mockResolvedValue(undefined);
  mocks.openRecipe.mockResolvedValue("c1");
  mocks.list.mockResolvedValue({ items: [recipe("c1", "社区红烧肉")], has_more: false });
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  vi.restoreAllMocks();
});

async function page(): Promise<VueWrapper> {
  const wrapper = mount(UserPage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("UserPage", () => {
  it("显示昵称与公开菜谱数", async () => {
    const wrapper = await page();

    expect(mocks.profile).toHaveBeenCalledWith("u2");
    // 列表按作者过滤，从第一页拿
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ authorId: "u2", offset: 0 }));
    expect(wrapper.get('[data-test="user-nickname"]').text()).toBe("老王");
    expect(wrapper.get('[data-test="user-public-count"]').text()).toContain("3");
    expect(wrapper.get('[data-test="user-recipe"]').text()).toContain("社区红烧肉");
  });

  it("点 ta 的公开菜谱：先落库再跳详情", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="user-recipe"]').trigger("click");
    await flushPromises();

    expect(mocks.openRecipe).toHaveBeenCalledWith("c1");
    expect(mocks.push).toHaveBeenCalledWith("/recipe/c1");
    // 顺序：openRecipe（落库）必须排在 push（跳转）之前，详情页才读得到本地副本
    expect(mocks.openRecipe.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.push.mock.invocationCallOrder[0],
    );
  });

  it("点关注后按钮变「取消关注」，再点回到未关注", async () => {
    const wrapper = await page();

    expect(wrapper.get('[data-test="user-follow"]').text()).toBe("关注");

    await wrapper.get('[data-test="user-follow"]').trigger("click");
    await flushPromises();

    expect(mocks.follow).toHaveBeenCalledWith("u2");
    expect(mocks.unfollow).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="user-follow"]').text()).toBe("取消关注");

    await wrapper.get('[data-test="user-follow"]').trigger("click");
    await flushPromises();

    expect(mocks.unfollow).toHaveBeenCalledWith("u2");
    expect(wrapper.get('[data-test="user-follow"]').text()).toBe("关注");
  });

  it("关注失败时按钮回到原状并提示", async () => {
    mocks.follow.mockRejectedValue(new Error("网络不可用"));
    const wrapper = await page();

    await wrapper.get('[data-test="user-follow"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="user-follow-error"]').text()).toContain("网络不可用");
    expect(wrapper.get('[data-test="user-follow"]').text()).toBe("关注");
  });

  it("掉线后关注按钮变为不可用（disabled，且视觉上也灰着）", async () => {
    const wrapper = await page();
    expect(wrapper.get('[data-test="user-follow"]').attributes("disabled")).toBeUndefined();

    useAuthStore().mode = "guest";
    await flushPromises();

    const follow = wrapper.get('[data-test="user-follow"]');
    expect(follow.attributes("disabled")).toBeDefined();
    expect(follow.classes()).toContain("disabled:opacity-50");
  });

  it("离线时不发任何请求，显示离线提示、重试按钮不可用", async () => {
    useAuthStore().mode = "guest";
    const wrapper = await page();

    // 两个端点对 guest 一律 401：一个请求都不该发出去
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="user-error"]').text()).toContain("需要联网");
    expect(wrapper.get('[data-test="user-retry"]').attributes("disabled")).toBeDefined();
  });

  it("恢复在线后重试可用，能拉到资料", async () => {
    useAuthStore().mode = "guest";
    const wrapper = await page();
    expect(mocks.profile).not.toHaveBeenCalled();

    useAuthStore().mode = "online";
    await flushPromises();

    expect(wrapper.get('[data-test="user-retry"]').attributes("disabled")).toBeUndefined();
    await wrapper.get('[data-test="user-retry"]').trigger("click");
    await flushPromises();

    expect(mocks.profile).toHaveBeenCalledWith("u2");
    expect(wrapper.get('[data-test="user-nickname"]').text()).toBe("老王");
  });

  it("加载失败显示失败与重试", async () => {
    mocks.profile.mockRejectedValue(new Error("网络不可用"));
    const wrapper = await page();

    expect(wrapper.get('[data-test="user-error"]').text()).toContain("网络不可用");
    expect(wrapper.find('[data-test="user-nickname"]').exists()).toBe(false);

    mocks.profile.mockResolvedValue(profile());
    await wrapper.get('[data-test="user-retry"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="user-nickname"]').text()).toBe("老王");
  });
});
