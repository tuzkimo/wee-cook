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
vi.mock("@/services/imageStore", () => ({
  imageSrc: (name: string) => `asset://localhost/images/${name}`,
}));
// I1：封面补下载走鉴权通道，网络层换成替身，文件 IO 用 setFileSyncDeps 注入假文件系统。
vi.mock("@/services/api", () => ({
  hasBaseUrl: () => true,
  fetchWithAuth: vi.fn(),
  authTokenReady: { value: true },
}));

import UserPage from "@/views/UserPage.vue";
import { fetchWithAuth } from "@/services/api";
import { setFileSyncDeps, type FileSyncDeps } from "@/services/syncFiles";

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

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

function recipe(id: string, name: string, cover: string | null = null): CommunityRecipe {
  return {
    id,
    name,
    cover_path: cover,
    author_id: "u2",
    author_nickname: "老王",
    author_avatar_url: null,
    category_name: null,
    tags: [],
    updated_at: NOW,
    favorited: false,
  };
}

/** 只喂 downloadOne 用到的 ok/status/arrayBuffer。 */
function fileRes(status: number, bytes: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  } as unknown as Response;
}

/** 内存假文件系统：只实现封面通道用到的 exists / writeFile / rename。 */
function fakeIo(): FileSyncDeps {
  const store = new Map<string, Uint8Array>();
  return {
    readFile: async () => new Uint8Array(),
    exists: async (path) => store.has(path),
    writeFile: async (path, bytes) => {
      store.set(path, bytes);
    },
    rename: async (from, to) => {
      const bytes = store.get(from);
      store.delete(from);
      if (bytes) store.set(to, bytes);
    },
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
  setFileSyncDeps(null);
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

  it("资料区显示头像", async () => {
    mocks.profile.mockResolvedValue(profile({ avatar_url: "🐱" }));
    const wrapper = await page();

    expect(wrapper.get('[data-test="user-avatar"]').text()).toBe("🐱");
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

    expect(wrapper.get('[data-test="user-follow"]').attributes("aria-label")).toBe("关注");

    await wrapper.get('[data-test="user-follow"]').trigger("click");
    await flushPromises();

    expect(mocks.follow).toHaveBeenCalledWith("u2");
    expect(mocks.unfollow).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="user-follow"]').attributes("aria-label")).toBe("取消关注");

    await wrapper.get('[data-test="user-follow"]').trigger("click");
    await flushPromises();

    expect(mocks.unfollow).toHaveBeenCalledWith("u2");
    expect(wrapper.get('[data-test="user-follow"]').attributes("aria-label")).toBe("关注");
  });

  it("关注失败时按钮回到原状并提示", async () => {
    mocks.follow.mockRejectedValue(new Error("网络不可用"));
    const wrapper = await page();

    await wrapper.get('[data-test="user-follow"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="user-follow-error"]').text()).toContain("网络不可用");
    expect(wrapper.get('[data-test="user-follow"]').attributes("aria-label")).toBe("关注");
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

  it("封面图下载到本地后才渲染 <img>，下载失败时出字母兜底（I1 回归）", async () => {
    setFileSyncDeps(fakeIo());
    fetchWithAuthMock.mockResolvedValue(fileRes(200, new Uint8Array([1, 2])));
    mocks.list.mockResolvedValue({
      items: [recipe("c1", "红烧肉", "cover.jpg")],
      has_more: false,
    });
    const wrapper = await page();

    await vi.waitFor(() => expect(wrapper.find("img").exists()).toBe(true));
    expect(wrapper.get("img").attributes("src")).toBe("asset://localhost/images/cover.jpg");

    // 同一页换成下载失败：不出 <img>，走字母兜底
    fetchWithAuthMock.mockRejectedValue(new Error("断网"));
    setFileSyncDeps(fakeIo());
    mocks.list.mockResolvedValue({
      items: [recipe("c2", "番茄炒蛋", "broken.jpg")],
      has_more: false,
    });
    const failed = await page();
    await vi.waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await flushPromises();
    expect(failed.find("img").exists()).toBe(false);
    expect(failed.text()).toContain("番");
  });
});
