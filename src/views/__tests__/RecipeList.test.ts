import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { Label, LabelKind, Recipe, RecipeListItem } from "@/types";
import RecipeList from "@/views/RecipeList.vue";
import { useRecipeFilterStore } from "@/stores/recipeFilter";

const NOW = "2026-10-13T00:00:00.000Z";

// 页面只测「拿到 store 的数据怎么画、点了往哪跳」；真 store 的查询已由 Task 4 覆盖，
// 跳转用 mock 的 router 断言（真路由是 Task 9 的事）。
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  fetchAll: vi.fn(async () => {}),
  imageSrc: vi.fn((name: string) => `asset://localhost/images/${name}`),
  recipes: [] as RecipeListItem[],
  apply: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/stores/recipe", () => ({
  useRecipeStore: () => ({ recipes: mocks.recipes, fetchAll: mocks.fetchAll }),
}));
vi.mock("@/services/imageStore", () => ({ imageSrc: mocks.imageSrc }));
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
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
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
  resetFilter();
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
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

  it("有封面时用 imageSrc 出来的地址，无封面时显示菜名首字", () => {
    const wrapper = mountList([
      item("r1", "红烧肉", { cover: "a.jpg" }),
      item("r2", "番茄炒蛋"),
    ]);

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
