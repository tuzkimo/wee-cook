import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { Label, LabelKind, Recipe, RecipeListItem } from "@/types";
import FilterPage from "@/views/FilterPage.vue";
import { useRecipeFilterStore } from "@/stores/recipeFilter";

const NOW = "2026-10-14T00:00:00.000Z";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  apply: vi.fn(),
  clear: vi.fn(),
  fetchAll: vi.fn(async () => {}),
  recipes: [] as RecipeListItem[],
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push, back: mocks.back }) }));
vi.mock("@/stores/recipe", () => ({
  useRecipeStore: () => ({ recipes: mocks.recipes, fetchAll: mocks.fetchAll }),
}));
vi.mock("@/stores/recipeFilter", async () => {
  const { reactive } = await import("vue");
  const filter = reactive({
    keyword: "",
    categoryIds: [] as string[],
    tagIds: [] as string[],
    ingredientIds: [] as string[],
  });
  return { useRecipeFilterStore: () => ({ filter, apply: mocks.apply, clear: mocks.clear }) };
});

function label(id: string, name: string, kind: LabelKind): Label {
  return { id, name, kind, created_at: NOW, updated_at: NOW, deleted_at: null };
}

function item(
  id: string,
  opts: { category?: string; tags?: string[]; ingredients?: string[] } = {},
): RecipeListItem {
  const category = opts.category ?? "家常菜";
  const recipe: Recipe = {
    id,
    name: `菜谱${id}`,
    cover_path: null,
    category_id: `cat-${category}`,
    is_public: 0,
    owner_nickname: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    owner_id: null,
  };
  return {
    recipe,
    category: label(recipe.category_id, category, "category"),
    tags: (opts.tags ?? []).map((tag) => label(`tag-${tag}`, tag, "tag")),
    ingredients: (opts.ingredients ?? []).map((ingredient) => ({
      id: `ing-${ingredient}`,
      name: ingredient,
    })),
  };
}

const wrappers: VueWrapper[] = [];

function mountPage(items: RecipeListItem[]): VueWrapper {
  mocks.recipes.splice(0, mocks.recipes.length, ...items);
  const wrapper = mount(FilterPage);
  wrappers.push(wrapper);
  return wrapper;
}

function chipNames(wrapper: VueWrapper, hook: string): string[] {
  return wrapper.findAll(`[data-test="${hook}"]`).map((node) => node.text());
}

/** 食材行的文字里带勾号，所以断言名字要看行内那个单独的 span */
function ingredientNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-test="filter-ingredient-name"]').map((node) => node.text());
}

beforeEach(() => {
  vi.clearAllMocks();
  const { filter } = useRecipeFilterStore();
  filter.keyword = "";
  filter.categoryIds = [];
  filter.tagIds = [];
  filter.ingredientIds = [];
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

describe("FilterPage", () => {
  it("分类、标签、食材候选只列真的有菜谱在用的条目，各去重一次", () => {
    const wrapper = mountPage([
      item("r1", { category: "荤菜", tags: ["家常"], ingredients: ["五花肉", "土豆"] }),
      item("r2", { category: "荤菜", tags: ["家常", "下饭"], ingredients: ["五花肉"] }),
    ]);

    expect(chipNames(wrapper, "filter-category-chip")).toEqual(["荤菜"]);
    expect(chipNames(wrapper, "filter-tag-chip")).toEqual(["下饭", "家常"]);
    expect(ingredientNames(wrapper)).toEqual(["五花肉", "土豆"]);
  });

  it("食材按出现过的菜谱数降序，同数按名称升序", () => {
    const wrapper = mountPage([
      item("r1", { ingredients: ["土豆", "五花肉", "A 料"] }),
      item("r2", { ingredients: ["五花肉", "A 料"] }),
    ]);

    expect(ingredientNames(wrapper)).toEqual(["A 料", "五花肉", "土豆"]);
  });

  it("进入时草稿复制已生效的筛选，勾选显示为选中", async () => {
    useRecipeFilterStore().filter.categoryIds = ["cat-荤菜"];
    const wrapper = mountPage([item("r1", { category: "荤菜" })]);

    expect(wrapper.get('[data-test="filter-category-chip"]').classes()).toContain("bg-primary");
  });

  it("勾选分类后点确定：写回筛选状态并回列表页", async () => {
    const wrapper = mountPage([item("r1", { category: "荤菜" })]);

    await wrapper.get('[data-test="filter-category-chip"]').trigger("click");
    await wrapper.get('[data-test="filter-confirm"]').trigger("click");

    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(mocks.apply.mock.calls[0][0].categoryIds).toEqual(["cat-荤菜"]);
    expect(mocks.push).toHaveBeenCalledWith("/");
  });

  it("食材多选能同时勾上两个不同的食材", async () => {
    const wrapper = mountPage([item("r1", { ingredients: ["五花肉", "土豆"] })]);

    const rows = wrapper.findAll('[data-test="filter-ingredient-row"]');
    await rows[0].trigger("click");
    await rows[1].trigger("click");
    await wrapper.get('[data-test="filter-confirm"]').trigger("click");

    expect(mocks.apply.mock.calls[0][0].ingredientIds).toEqual(["ing-五花肉", "ing-土豆"]);
  });

  it("返回不改已生效的筛选（草稿丢弃）", async () => {
    const wrapper = mountPage([item("r1", { category: "荤菜" })]);

    await wrapper.get('[data-test="filter-category-chip"]').trigger("click");
    // 草稿要是穿透到 store，这里的勾选会直接改到已生效的筛选
    expect(useRecipeFilterStore().filter.categoryIds).toEqual([]);

    await wrapper.get('[data-test="back"]').trigger("click");

    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.back).toHaveBeenCalledTimes(1);
    expect(useRecipeFilterStore().filter.categoryIds).toEqual([]);
  });

  it("重置清空本页勾选，但不写回、不跳页", async () => {
    const wrapper = mountPage([item("r1", { category: "荤菜" })]);

    const chip = wrapper.get('[data-test="filter-category-chip"]');
    await chip.trigger("click");
    expect(chip.classes()).toContain("bg-primary");

    await wrapper.get('[data-test="filter-reset"]').trigger("click");

    expect(wrapper.get('[data-test="filter-category-chip"]').classes()).not.toContain("bg-primary");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("标签搜索：命中项留下，已选中的标签即使不命中搜索词也保留（否则取消不掉）", async () => {
    const wrapper = mountPage([item("r1", { tags: ["快手", "下饭"] })]);
    const tags = () => chipNames(wrapper, "filter-tag-chip");

    await wrapper.get('[data-test="filter-tag-chip"]').trigger("click"); // 选中「下饭」（名称排序在前）
    expect(tags()).toEqual(["下饭", "快手"]);

    await wrapper.get('[data-test="filter-tag-search"]').setValue("根本没有这个词");

    // 未选中的被搜索词筛掉，已选中的留下来
    expect(tags()).toEqual(["下饭"]);
  });

  it("食材搜索：只留命中的行", async () => {
    const wrapper = mountPage([item("r1", { ingredients: ["五花肉", "土豆"] })]);

    await wrapper.get('[data-test="filter-ingredient-search"]').setValue("土豆");

    expect(ingredientNames(wrapper)).toEqual(["土豆"]);
  });

  it("挂载时拉一次菜谱（直接打开筛选页也有候选）", async () => {
    mountPage([item("r1")]);
    await flushPromises();

    expect(mocks.fetchAll).toHaveBeenCalledTimes(1);
  });
});
