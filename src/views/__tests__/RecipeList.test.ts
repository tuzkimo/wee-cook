import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { Label, LabelKind, RecipeListItem } from "@/types";
import RecipeList from "@/views/RecipeList.vue";
import { setFileSyncDeps } from "@/services/syncFiles";

const NOW = "2026-10-13T00:00:00.000Z";

/** 登录态替身：第三行的作者判定要读 nickname / avatarUrl / serverUserId */
type AuthMock = {
  isOnline: boolean;
  syncVersion: number;
  nickname: string | null;
  avatarUrl: string | null;
  serverUserId: string | null;
};

// 页面只测「拿到 store 的数据怎么画、点了往哪跳」；范围过滤本身由 recipe 与 refStore 的测试覆盖。
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  fetchAll: vi.fn(async () => {}),
  imageSrc: vi.fn((name: string) => `asset://localhost/images/${name}`),
  recipes: [] as RecipeListItem[],
  apply: vi.fn(),
  clear: vi.fn(),
  auth: null as AuthMock | null,
  scope: { value: "p:local" },
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/stores/recipe", () => ({
  useRecipeStore: () => ({ recipes: mocks.recipes, fetchAll: mocks.fetchAll }),
}));
vi.mock("@/services/imageStore", () => ({ imageSrc: mocks.imageSrc }));
vi.mock("@/services/scope", () => ({
  activeScope: mocks.scope,
  LOCAL_SCOPE: "p:local",
  personalScope: (uid: string) => `p:${uid}`,
  teamScope: (id: string) => `t:${id}`,
  scopeFor: () => mocks.scope.value,
  setActiveScope: (next: string) => {
    mocks.scope.value = next;
  },
}));
// syncVersion 必须 reactive：组件 watch 它来重拉列表。
// 切换器是另一个组件的事（有自己的用例），这里只给一个不渲染任何东西的替身。
vi.mock("@/components/TeamSwitcher.vue", () => ({
  default: { name: "TeamSwitcher", render: () => null },
}));
vi.mock("@/stores/team", () => ({
  useTeamStore: () => ({
    teams: [],
    currentTeamId: null,
    load: vi.fn(async () => {}),
    restoreCurrentTeam: vi.fn(async () => {}),
  }),
}));
vi.mock("@/stores/auth", async () => {
  const { reactive } = await import("vue");
  mocks.auth = reactive({
    isOnline: true,
    syncVersion: 0,
    nickname: null as string | null,
    avatarUrl: null as string | null,
    serverUserId: null as string | null,
  });
  return { useAuthStore: () => mocks.auth };
});
vi.mock("@/stores/recipeFilter", async () => {
  const { reactive } = await import("vue");
  const filter = reactive({
    keyword: "",
    categoryIds: [] as string[],
    tagIds: [] as string[],
    ingredientIds: [] as string[],
  });
  return {
    useRecipeFilterStore: () => ({ filter, apply: mocks.apply, clear: mocks.clear }),
  };
});

const wrappers: VueWrapper[] = [];

function label(id: string, name: string, kind: LabelKind): Label {
  return { id, scope_id: "p:local", name, kind, created_at: NOW, updated_at: NOW, deleted_at: null };
}

function item(
  id: string,
  name: string,
  opts: { cover?: string | null; category?: string; tags?: string[] } = {},
): RecipeListItem {
  return {
    recipe: {
      id,
      scope_id: mocks.scope.value,
      name,
      cover_path: opts.cover ?? null,
      category_id: `cat-${id}`,
      owner_nickname: null,
      owner_avatar_url: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      owner_id: null,
    },
    category: label(`cat-${id}`, opts.category ?? "炒菜", "category"),
    tags: (opts.tags ?? []).map((tag) => label(`tag-${tag}`, tag, "tag")),
    ingredients: [],
  };
}

async function mountList(items: RecipeListItem[]): Promise<VueWrapper> {
  mocks.recipes.splice(0, mocks.recipes.length, ...items);
  // 图片都当已落盘，除了名字里带 "not-yet" 的（那条用来验「没下载完不出破图」）
  setFileSyncDeps({
    readFile: async () => new Uint8Array(),
    exists: async (path: string) => !path.includes("not-yet"),
    writeFile: async () => {},
    rename: async () => {},
  });
  const wrapper = mount(RecipeList);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

beforeEach(async () => {
  const filter = (await import("@/stores/recipeFilter")).useRecipeFilterStore();
  filter.filter.keyword = "";
  filter.filter.categoryIds = [];
  filter.filter.tagIds = [];
  filter.filter.ingredientIds = [];
  mocks.recipes.length = 0;
  mocks.scope.value = "p:local";
  mocks.auth!.nickname = null;
  mocks.auth!.avatarUrl = null;
  mocks.auth!.serverUserId = null;
  mocks.auth!.syncVersion = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()!.unmount();
  setFileSyncDeps(null);
});

describe("菜谱列表", () => {
  it("渲染当前范围拿到的列表", async () => {
    mocks.scope.value = "t:t1";
    const wrapper = await mountList([item("r1", "红烧肉"), item("r2", "番茄炒蛋")]);

    const names = wrapper.findAll('[data-test="recipe-name"]').map((node) => node.text());
    expect(names).toEqual(["红烧肉", "番茄炒蛋"]);
    // 没有 tab 行、没有社区段落（社区功能已删除）
    expect(wrapper.find('[data-test="tab-all"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="community-card"]').exists()).toBe(false);
  });

  it("空态文案随范围变", async () => {
    let wrapper = await mountList([]);
    expect(wrapper.get('[data-test="empty-state"]').text()).toBe(
      "还没有菜谱，点右上角加号记一道",
    );

    mocks.scope.value = "t:t1";
    wrapper.unmount();
    wrappers.pop();
    wrapper = await mountList([]);
    expect(wrapper.get('[data-test="empty-state"]').text()).toBe(
      "这个团队还没有菜谱，点右上角加号记一道",
    );
  });

  it("有筛选条件但一条都不匹配时说「没有符合条件的菜谱」", async () => {
    const wrapper = await mountList([item("r1", "红烧肉")]);
    const filter = (await import("@/stores/recipeFilter")).useRecipeFilterStore();
    filter.filter.keyword = "不存在的菜";
    await flushPromises();

    expect(wrapper.get('[data-test="empty-state"]').text()).toBe("没有符合条件的菜谱");
  });

  it("还没下载完的封面不出 <img>，用字母兜底", async () => {
    const wrapper = await mountList([item("r1", "红烧肉", { cover: "not-yet.jpg" })]);

    expect(wrapper.find('[data-test="recipe-cover"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="recipe-cover-fallback"]').text()).toBe("红");
  });

  it("点卡片进详情页，右上角两个按钮各去各的页面", async () => {
    const wrapper = await mountList([item("r1", "红烧肉")]);

    await wrapper.get('[data-test="recipe-card"]').trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/recipe/r1");

    await wrapper.get('[data-test="recipe-add"]').trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/recipe/new");

    await wrapper.get('[data-test="recipe-filter"]').trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/recipe/filter");
  });

  it("搜到的菜谱才渲染（关键字走筛选 store）", async () => {
    const wrapper = await mountList([item("r1", "红烧肉"), item("r2", "番茄炒蛋")]);
    const filter = (await import("@/stores/recipeFilter")).useRecipeFilterStore();

    filter.filter.keyword = "番茄";
    await flushPromises();

    expect(wrapper.findAll('[data-test="recipe-name"]').map((node) => node.text())).toEqual([
      "番茄炒蛋",
    ]);
  });

  it("同步完成后重拉列表", async () => {
    await mountList([]);
    expect(mocks.fetchAll).toHaveBeenCalledTimes(1);

    mocks.auth!.syncVersion = 1;
    await flushPromises();

    expect(mocks.fetchAll).toHaveBeenCalledTimes(2);
  });
});
