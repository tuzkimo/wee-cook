import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { Label, LabelKind, Recipe, RecipeListItem } from "@/types";
import type { CommunityRecipe } from "@/services/community";
import RecipeList from "@/views/RecipeList.vue";
import { useRecipeFilterStore } from "@/stores/recipeFilter";
import { setFileSyncDeps, type FileSyncDeps } from "@/services/syncFiles";

const NOW = "2026-10-13T00:00:00.000Z";

/** 社区 store 的替身形状；items 等用 reactive 包过，CommunityFeed 的 watch 才追得到变化 */
type CommunityMock = {
  items: CommunityRecipe[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  followedOnly: boolean;
  load: ReturnType<typeof vi.fn>;
  openRecipe: ReturnType<typeof vi.fn>;
};

// 页面只测「拿到 store 的数据怎么画、点了往哪跳」；真 store 的查询已由 Task 4 覆盖，
// 跳转用 mock 的 router 断言（真路由是 Task 9 的事）。
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  fetchAll: vi.fn(async () => {}),
  fetchFavorites: vi.fn(async () => {}),
  imageSrc: vi.fn((name: string) => `asset://localhost/images/${name}`),
  recipes: [] as RecipeListItem[],
  favorites: [] as RecipeListItem[],
  apply: vi.fn(),
  clear: vi.fn(),
  community: null as CommunityMock | null,
  auth: null as { isOnline: boolean; syncVersion: number } | null,
  enqueueSync: vi.fn(),
  // 已配地址但未登录的场景：hasBaseUrl 为真、凭据为假
  authReady: { value: false },
  fetchWithAuth: vi.fn(),
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/stores/recipe", () => ({
  useRecipeStore: () => ({
    recipes: mocks.recipes,
    favorites: mocks.favorites,
    fetchAll: mocks.fetchAll,
    fetchFavorites: mocks.fetchFavorites,
  }),
}));
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
vi.mock("@/services/imageStore", () => ({ imageSrc: mocks.imageSrc }));
// 未登录时社区段不渲染（C3）；默认站在登录态，个别用例自己改。
// syncVersion 必须 reactive：组件 watch 它来重拉列表。
vi.mock("@/stores/auth", async () => {
  const { reactive } = await import("vue");
  mocks.auth = reactive({ isOnline: true, syncVersion: 0 });
  return { useAuthStore: () => mocks.auth };
});
// 收藏 tab 会催一次同步；这里只关心「有没有催」，真调度由 sync 自己的测试覆盖。
vi.mock("@/services/sync", () => ({ enqueueSync: mocks.enqueueSync }));
// 图片通道的闸门：已配地址（hasBaseUrl 真）但 guest（authTokenReady 假）时不得发请求
vi.mock("@/services/api", () => ({
  hasBaseUrl: () => true,
  fetchWithAuth: mocks.fetchWithAuth,
  authTokenReady: mocks.authReady,
}));
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
  return { id, name, kind, created_at: NOW, updated_at: NOW, deleted_at: null };
}

function item(
  id: string,
  name: string,
  opts: {
    cover?: string | null;
    category?: string;
    tags?: string[];
    ingredients?: string[];
  } = {},
): RecipeListItem {
  const recipe: Recipe = {
    id,
    name,
    cover_path: opts.cover ?? null,
    category_id: `cat-${id}`,
    is_public: 0,
    owner_nickname: null,
    owner_avatar_url: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    owner_id: null,
  };
  return {
    recipe,
    category: label(recipe.category_id, opts.category ?? "家常菜", "category"),
    tags: (opts.tags ?? []).map((tag, index) => label(`${id}-t${index}`, tag, "tag")),
    ingredients: (opts.ingredients ?? []).map((name, index) => ({
      id: `${id}-i${index}`,
      name,
    })),
  };
}

function mountList(items: RecipeListItem[]): VueWrapper {
  mocks.recipes.splice(0, mocks.recipes.length, ...items);
  const wrapper = mount(RecipeList);
  wrappers.push(wrapper);
  return wrapper;
}

function names(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-test="recipe-name"]').map((node) => node.text());
}

function communityStore(): CommunityMock {
  return mocks.community!;
}

function auth(): { isOnline: boolean; syncVersion: number } {
  return mocks.auth!;
}

/** 内存假文件系统：只实现图片通道用到的 exists / writeFile / rename。 */
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

function communityRecipe(id: string, name: string): CommunityRecipe {
  return {
    id,
    name,
    cover_path: null,
    author_id: "a1",
    author_nickname: "老王",
    author_avatar_url: null,
    category_name: null,
    tags: [],
    updated_at: NOW,
    favorited: false,
  };
}

/** 每个用例从空筛选开始；filter 是 mock 工厂里的单例 reactive 对象，必须手动重置 */
function resetFilter(): void {
  const { filter } = useRecipeFilterStore();
  filter.keyword = "";
  filter.categoryIds = [];
  filter.tagIds = [];
  filter.ingredientIds = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  auth().isOnline = true;
  auth().syncVersion = 0;
  mocks.authReady.value = false;
  resetFilter();
  // recipes 由 mountList 重置；favorites 得自己清，否则上一条用例的收藏会漏进下一条
  mocks.favorites.length = 0;
  const community = communityStore();
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

describe("RecipeList", () => {
  it("按 store.recipes 的顺序渲染卡片，显示菜名", () => {
    const wrapper = mountList([item("r1", "红烧肉"), item("r2", "番茄炒蛋")]);

    expect(wrapper.findAll('[data-test="recipe-card"]')).toHaveLength(2);
    expect(names(wrapper)).toEqual(["红烧肉", "番茄炒蛋"]);
  });

  it("显示分类名与全部标签", () => {
    const wrapper = mountList([
      item("r1", "红烧肉", { category: "荤菜", tags: ["家常", "下饭"] }),
    ]);

    expect(wrapper.get('[data-test="recipe-category"]').text()).toBe("荤菜");
    expect(wrapper.findAll('[data-test="recipe-tag"]').map((node) => node.text())).toEqual([
      "家常",
      "下饭",
    ]);
  });

  it("封面已落盘时用 imageSrc 出来的地址，无封面时显示菜名首字", async () => {
    const io = fakeIo();
    io.store.set("images/a.jpg", new Uint8Array([1]));
    setFileSyncDeps(io.deps);
    const wrapper = mountList([
      item("r1", "红烧肉", { cover: "a.jpg" }),
      item("r2", "番茄炒蛋"),
    ]);
    await flushPromises();

    const cards = wrapper.findAll('[data-test="recipe-card"]');
    expect(cards[0].get('[data-test="recipe-cover"]').attributes("src")).toBe(
      "asset://localhost/images/a.jpg",
    );
    expect(mocks.imageSrc).toHaveBeenCalledWith("a.jpg");

    // 库里是 NULL 时绝不能把 null 交给 imageSrc
    expect(mocks.imageSrc).not.toHaveBeenCalledWith(null);
    expect(cards[1].find("img").exists()).toBe(false);
    expect(cards[1].get('[data-test="recipe-cover-fallback"]').text()).toBe("番");
  });

  it("封面还没落盘时不渲染 <img>，出字母兜底（收藏里社区菜谱首次打开的破图回归）", async () => {
    setFileSyncDeps(fakeIo().deps);
    mocks.favorites.splice(0, mocks.favorites.length, item("r2", "红烧肉", { cover: "not-yet.jpg" }));
    const wrapper = mountList([]);

    await wrapper.get('[data-test="tab-fav"]').trigger("click");
    await flushPromises();

    const card = wrapper.get('[data-test="recipe-card"]');
    expect(card.find('[data-test="recipe-cover"]').exists()).toBe(false);
    expect(card.get('[data-test="recipe-cover-fallback"]').text()).toBe("红");
  });

  it("已配地址但未登录（guest）时进「收藏」tab：零图片请求，出兜底不出破图", async () => {
    setFileSyncDeps(fakeIo().deps);
    mocks.favorites.splice(0, mocks.favorites.length, item("r2", "红烧肉", { cover: "not-yet.jpg" }));
    const wrapper = mountList([]);

    await wrapper.get('[data-test="tab-fav"]').trigger("click");
    await flushPromises();

    // 未登录不发任何网络请求（spec §3）：已配地址也不行
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="recipe-cover-fallback"]').text()).toBe("红");
  });

  it("空列表显示「还没有菜谱，点右上角加号记一道」和加号", () => {
    const wrapper = mountList([]);

    expect(wrapper.text()).toContain("还没有菜谱，点右上角加号记一道");
    expect(wrapper.find('[data-test="recipe-add"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-test="recipe-card"]')).toHaveLength(0);
  });

  it("超长菜名有截断类，不撑破卡片", () => {
    const longName = "红烧".repeat(40);
    const wrapper = mountList([item("r1", longName)]);

    const name = wrapper.get('[data-test="recipe-name"]');
    expect(name.text()).toBe(longName);
    expect(name.classes()).toContain("line-clamp-2");
  });

  it("点卡片跳到 /recipe/:id", async () => {
    const wrapper = mountList([item("r1", "红烧肉"), item("r2", "番茄炒蛋")]);

    await wrapper.findAll('[data-test="recipe-card"]')[1].trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/recipe/r2");
  });

  it("点加号跳到 /recipe/new", async () => {
    const wrapper = mountList([item("r1", "红烧肉")]);

    await wrapper.get('[data-test="recipe-add"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/recipe/new");
  });

  it("onMounted 时调 store.fetchAll", async () => {
    mountList([item("r1", "红烧肉")]);
    await flushPromises();

    expect(mocks.fetchAll).toHaveBeenCalledTimes(1);
  });

  it("根元素不再自带状态栏内边距（外壳已经统一留过）", () => {
    const wrapper = mountList([item("r1", "红烧肉")]);
    expect(wrapper.html()).not.toContain("safe-area-inset-top");
  });

  it("空状态说的「右上角」与加号的实际位置一致", () => {
    const wrapper = mountList([]);
    const add = wrapper.get('[data-test="recipe-add"]');
    expect(add.element.closest("header")).not.toBeNull();
  });

  it("搜索框按菜名子串过滤，且过滤后不动 store 里的原数组", async () => {
    const wrapper = mountList([item("r1", "红烧肉"), item("r2", "番茄炒蛋")]);

    await wrapper.get('[data-test="recipe-search"]').setValue("红烧");

    expect(names(wrapper)).toEqual(["红烧肉"]);
    expect(mocks.recipes.map((i) => i.recipe.name)).toEqual(["红烧肉", "番茄炒蛋"]);
  });

  it("没有筛选时不渲染信息条", () => {
    const wrapper = mountList([item("r1", "红烧肉")]);
    expect(wrapper.find('[data-test="filter-bar"]').exists()).toBe(false);
  });

  it("筛选活跃时信息条写明筛了什么，点它进筛选页", async () => {
    const wrapper = mountList([
      item("r1", "红烧肉", { category: "荤菜", tags: ["家常", "下饭"], ingredients: ["五花肉"] }),
      item("r2", "炒青菜", { category: "素菜" }),
    ]);
    useRecipeFilterStore().filter.categoryIds = ["cat-r1"];
    await flushPromises();

    expect(wrapper.get('[data-test="filter-summary"]').text()).toBe("📂 荤菜");
    expect(names(wrapper)).toEqual(["红烧肉"]);

    await wrapper.get('[data-test="filter-bar"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/recipe/filter");
  });

  it("点清除只清筛选，不进筛选页", async () => {
    const wrapper = mountList([item("r1", "红烧肉", { category: "荤菜" })]);
    useRecipeFilterStore().filter.categoryIds = ["cat-r1"];
    await flushPromises();

    await wrapper.get('[data-test="filter-clear"]').trigger("click");

    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("有菜谱但被筛掉时是「没有符合条件的菜谱」，不是「还没有菜谱」", async () => {
    const wrapper = mountList([item("r1", "红烧肉", { category: "荤菜" })]);
    useRecipeFilterStore().filter.tagIds = ["tag-不存在"];
    await flushPromises();

    expect(wrapper.text()).toContain("没有符合条件的菜谱");
    expect(wrapper.text()).not.toContain("还没有菜谱");
    // 筛选活跃但一条都没命中时，信息条必须还在，否则用户没有任何取消入口
    expect(wrapper.find('[data-test="filter-bar"]').exists()).toBe(true);
  });

  it("点漏斗跳 /recipe/filter", async () => {
    const wrapper = mountList([item("r1", "红烧肉")]);

    await wrapper.get('[data-test="recipe-filter"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/recipe/filter");
  });

  it("默认「全部」：我的菜谱在上，社区段落在下", async () => {
    communityStore().items = [communityRecipe("c1", "社区红烧肉")];
    const wrapper = mountList([item("r1", "我的红烧肉")]);
    await flushPromises();

    const mine = wrapper.get('[data-test="recipe-card"]');
    const community = wrapper.get('[data-test="community-card"]');
    expect(mine.text()).toContain("我的红烧肉");
    expect(community.text()).toContain("社区红烧肉");
    // 两个段落、不合并排序：我的整段排在社区整段之前
    expect(
      mine.element.compareDocumentPosition(community.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("社区接口失败时只社区段落显示失败，我的菜谱照常显示", async () => {
    communityStore().error = "网络不可用";
    const wrapper = mountList([item("r1", "红烧肉")]);
    await flushPromises();

    expect(wrapper.get('[data-test="community-error"]').text()).toContain("加载失败");
    expect(wrapper.get('[data-test="my-recipes"]').text()).not.toContain("加载失败");
    expect(wrapper.get('[data-test="recipe-card"]').text()).toContain("红烧肉");
  });

  it("「收藏」只显示本地收藏的菜谱", async () => {
    mocks.favorites.splice(0, mocks.favorites.length, item("r2", "收藏的红烧肉"));
    const wrapper = mountList([item("r1", "我自己的红烧肉")]);

    await wrapper.get('[data-test="tab-fav"]').trigger("click");
    await flushPromises();

    expect(names(wrapper)).toEqual(["收藏的红烧肉"]);
    expect(mocks.fetchFavorites).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-test="community-section"]').exists()).toBe(false);
  });

  it("「关注」把 followed_only=1 传给社区 store", async () => {
    const wrapper = mountList([item("r1", "我的红烧肉")]);
    await flushPromises();
    communityStore().load.mockClear();

    await wrapper.get('[data-test="tab-follow"]').trigger("click");
    await flushPromises();

    expect(communityStore().followedOnly).toBe(true);
    // followedOnly 变了就得重拉：feed 在「全部」与「关注」之间不会卸载
    expect(communityStore().load).toHaveBeenCalledWith(true);
    // 关注只渲染社区段落
    expect(wrapper.find('[data-test="recipe-card"]').exists()).toBe(false);
  });

  it("未登录时不渲染社区段，关注 tab 给登录提示（C3 回归）", async () => {
    auth().isOnline = false;
    const wrapper = mountList([item("r1", "红烧肉")]);
    await flushPromises();

    expect(wrapper.find('[data-test="community-section"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="community-error"]').exists()).toBe(false);
    expect(communityStore().load).not.toHaveBeenCalled();

    await wrapper.get('[data-test="tab-follow"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="community-section"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="community-error"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="follow-login-hint"]').text()).toContain("登录后");
  });

  it("登录态没有自有菜谱时，「收藏」仍渲染收藏的社区菜谱", async () => {
    // 登录后 store.recipes 只剩自己名下（为空），收藏的社区菜谱 owner_id 是作者、只从 favorites 出来
    mocks.favorites.splice(0, mocks.favorites.length, item("r2", "收藏的社区菜"));
    const wrapper = mountList([]);

    await wrapper.get('[data-test="tab-fav"]').trigger("click");
    await flushPromises();

    expect(names(wrapper)).toEqual(["收藏的社区菜"]);
    expect(wrapper.get('[data-test="my-recipes"]').text()).not.toContain("还没有菜谱");
  });

  it("「收藏」为空时显示「还没有收藏的菜谱」", async () => {
    const wrapper = mountList([]);

    await wrapper.get('[data-test="tab-fav"]').trigger("click");
    await flushPromises();

    const mine = wrapper.get('[data-test="my-recipes"]').text();
    expect(mine).toContain("还没有收藏的菜谱");
    expect(mine).not.toContain("还没有菜谱，点右上角");
  });

  it("「收藏」有收藏但被筛选筛空时说「没有符合条件的菜谱」", async () => {
    mocks.favorites.splice(0, mocks.favorites.length, item("r2", "收藏的红烧肉"));
    const wrapper = mountList([item("r1", "我自己的")]);
    useRecipeFilterStore().filter.keyword = "不存在的菜";

    await wrapper.get('[data-test="tab-fav"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="my-recipes"]').text()).toContain("没有符合条件的菜谱");
  });

  it("「收藏」在途时不闪「还没有收藏的菜谱」，先显示加载态", async () => {
    let resolveFavorites: () => void = () => {};
    mocks.fetchFavorites.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveFavorites = resolve;
      }),
    );
    const wrapper = mountList([]);

    await wrapper.get('[data-test="tab-fav"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="favorites-loading"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="my-recipes"]').text()).not.toContain("还没有收藏的菜谱");

    resolveFavorites();
    await flushPromises();
    expect(wrapper.find('[data-test="favorites-loading"]').exists()).toBe(false);
  });

  it("进「收藏」tab 且在线时触发一次同步，让服务端最新收藏集合下来", async () => {
    const wrapper = mountList([]);
    await flushPromises();
    mocks.enqueueSync.mockClear();

    await wrapper.get('[data-test="tab-fav"]').trigger("click");
    await flushPromises();

    expect(mocks.fetchFavorites).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSync).toHaveBeenCalledWith({});
  });

  it("未登录时进「收藏」tab 不发任何请求，本地收藏照常显示", async () => {
    auth().isOnline = false;
    mocks.favorites.splice(0, mocks.favorites.length, item("r2", "收藏的红烧肉"));
    const wrapper = mountList([]);

    await wrapper.get('[data-test="tab-fav"]').trigger("click");
    await flushPromises();

    expect(mocks.enqueueSync).not.toHaveBeenCalled();
    expect(names(wrapper)).toEqual(["收藏的红烧肉"]);
  });

  it("同步完成后（syncVersion 变化）重拉列表，且不再触发新的同步（防自激循环）", async () => {
    mountList([item("r1", "红烧肉")]);
    await flushPromises();
    mocks.fetchAll.mockClear();
    mocks.enqueueSync.mockClear();

    auth().syncVersion++;
    await flushPromises();

    expect(mocks.fetchAll).toHaveBeenCalledTimes(1);
    // syncVersion 的 watch 里再 enqueueSync 会变成每 3 秒同步一次的死循环
    expect(mocks.enqueueSync).not.toHaveBeenCalled();
  });

  it("同步完成时若在「收藏」tab，重拉收藏但不再触发同步", async () => {
    mocks.favorites.splice(0, mocks.favorites.length, item("r2", "收藏的红烧肉"));
    const wrapper = mountList([]);
    await wrapper.get('[data-test="tab-fav"]').trigger("click");
    await flushPromises();
    mocks.fetchFavorites.mockClear();
    mocks.enqueueSync.mockClear();

    auth().syncVersion++;
    await flushPromises();

    expect(mocks.fetchFavorites).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSync).not.toHaveBeenCalled();
  });

  it("搜索框在顶栏里，信息条紧贴顶栏（不在搜索框和列表之间）", async () => {
    const wrapper = mountList([item("r1", "红烧肉", { category: "荤菜" })]);
    useRecipeFilterStore().filter.categoryIds = ["cat-r1"];
    await flushPromises();

    expect(wrapper.get('[data-test="recipe-search"]').element.closest("header")).not.toBeNull();
    expect(wrapper.get('[data-test="filter-bar"]').element.previousElementSibling?.tagName).toBe(
      "HEADER",
    );
  });
});
