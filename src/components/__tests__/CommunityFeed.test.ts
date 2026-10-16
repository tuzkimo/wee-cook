import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { CommunityRecipe } from "@/services/community";

const NOW = "2026-10-15T00:00:00.000Z";

type CommunityMock = {
  items: CommunityRecipe[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  followedOnly: boolean;
  load: ReturnType<typeof vi.fn>;
  openRecipe: ReturnType<typeof vi.fn>;
};

// reactive 包过：组件 watch followedOnly 时需要能追到变化
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  community: null as CommunityMock | null,
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/stores/community", async () => {
  const { reactive } = await import("vue");
  mocks.community = reactive({
    items: [] as CommunityRecipe[],
    hasMore: false,
    loading: false,
    error: null as string | null,
    followedOnly: false,
    load: vi.fn(async () => {}),
    openRecipe: vi.fn(async (id: string) => id),
  });
  return { useCommunityStore: () => mocks.community };
});
vi.mock("@/services/imageStore", () => ({
  imageSrc: (name: string) => `asset://localhost/images/${name}`,
}));
// I1：封面补下载走鉴权通道，网络层换成替身，文件 IO 用 setFileSyncDeps 注入假文件系统。
vi.mock("@/services/api", () => ({
  hasBaseUrl: () => true,
  fetchWithAuth: vi.fn(),
  authTokenReady: { value: true },
}));

import CommunityFeed from "@/components/CommunityFeed.vue";
import { fetchWithAuth } from "@/services/api";
import { setFileSyncDeps, type FileSyncDeps } from "@/services/syncFiles";

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function store(): CommunityMock {
  return mocks.community!;
}

function recipe(id: string, overrides: Partial<CommunityRecipe> = {}): CommunityRecipe {
  return {
    id,
    name: `菜 ${id}`,
    cover_path: null,
    author_id: "a1",
    author_nickname: "老王",
    author_avatar_url: null,
    updated_at: NOW,
    favorited: false,
    ...overrides,
  };
}

const wrappers: VueWrapper[] = [];

function mountFeed(): VueWrapper {
  const wrapper = mount(CommunityFeed);
  wrappers.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  const community = store();
  community.items = [];
  community.hasMore = false;
  community.loading = false;
  community.error = null;
  community.followedOnly = false;
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  setFileSyncDeps(null);
});

/** 只喂 downloadOne 用到的 ok/status/arrayBuffer。 */
function fileRes(status: number, bytes: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  } as unknown as Response;
}

/** 内存假文件系统：只实现封面通道用到的 exists / writeFile / rename。 */
function fakeIo(): { deps: FileSyncDeps; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    deps: {
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
    },
  };
}

describe("CommunityFeed", () => {
  it("点一条公开菜谱：先落库再跳详情", async () => {
    store().items = [recipe("c1")];
    const wrapper = mountFeed();
    await flushPromises();

    await wrapper.get('[data-test="community-card"]').trigger("click");
    await flushPromises();

    expect(store().openRecipe).toHaveBeenCalledWith("c1");
    expect(mocks.push).toHaveBeenCalledWith("/recipe/c1");
    // 顺序：openRecipe（落库）必须排在 push（跳转）之前
    expect(store().openRecipe.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.push.mock.invocationCallOrder[0],
    );
  });

  it("加载更多按 has_more 显隐", async () => {
    store().items = [recipe("c1")];
    let wrapper = mountFeed();
    await flushPromises();
    expect(wrapper.find('[data-test="community-load-more"]').exists()).toBe(false);
    wrapper.unmount();

    store().items = [recipe("c2")];
    store().hasMore = true;
    wrapper = mountFeed();
    await flushPromises();
    expect(wrapper.find('[data-test="community-load-more"]').exists()).toBe(true);

    store().load.mockClear();
    await wrapper.get('[data-test="community-load-more"]').trigger("click");
    expect(store().load).toHaveBeenCalledWith();
  });

  it("followedOnly 变化时从第一页重拉（feed 在「全部」与「关注」之间不卸载）", async () => {
    mountFeed();
    await flushPromises();
    store().load.mockClear();

    store().followedOnly = true;
    await flushPromises();

    expect(store().load).toHaveBeenCalledWith(true);
  });

  it("封面图下载到本地后才渲染 <img>，未落盘时用字母兜底（I1 回归）", async () => {
    const io = fakeIo();
    setFileSyncDeps(io.deps);
    fetchWithAuthMock.mockResolvedValue(fileRes(200, new Uint8Array([1, 2])));
    store().items = [recipe("c1", { name: "红烧肉", cover_path: "cover.jpg" })];
    const wrapper = mountFeed();

    await vi.waitFor(() =>
      expect(wrapper.find('[data-test="community-cover"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-test="community-cover"]').attributes("src")).toBe(
      "asset://localhost/images/cover.jpg",
    );
    expect(wrapper.find('[data-test="community-cover-fallback"]').exists()).toBe(false);
  });

  it("卡片显示作者头像", () => {
    store().items = [recipe("1", { author_avatar_url: "🐱" })];
    const wrapper = mountFeed();

    expect(wrapper.get('[data-test="community-author-avatar"]').text()).toBe("🐱");
  });

  it("作者没设头像 → 退回作者昵称首字", () => {
    store().items = [recipe("1", { author_avatar_url: null, author_nickname: "老王" })];
    const wrapper = mountFeed();

    expect(wrapper.get('[data-test="community-author-avatar"]').text()).toBe("老");
  });

  it("封面图下载失败时不渲染 <img>，出字母兜底（I1 回归）", async () => {
    const io = fakeIo();
    setFileSyncDeps(io.deps);
    fetchWithAuthMock.mockRejectedValue(new Error("断网"));
    store().items = [recipe("c1", { name: "红烧肉", cover_path: "cover.jpg" })];
    const wrapper = mountFeed();

    await vi.waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await flushPromises();
    expect(wrapper.find('[data-test="community-cover"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="community-cover-fallback"]').text()).toBe("红");
  });
});
