import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { emptyFilter } from "@/utils/recipeFilter";
import { useRecipeFilterStore } from "@/stores/recipeFilter";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("recipeFilterStore", () => {
  it("初值是空筛选", () => {
    expect(useRecipeFilterStore().filter).toEqual(emptyFilter());
  });

  it("apply 存的是副本，之后改原对象不影响 store", () => {
    const store = useRecipeFilterStore();
    const next = { ...emptyFilter(), categoryIds: ["cat-家常菜"] };

    store.apply(next);
    next.categoryIds.push("cat-汤");

    expect(store.filter.categoryIds).toEqual(["cat-家常菜"]);
  });

  it("clear 四项全清，包括关键词", () => {
    const store = useRecipeFilterStore();
    store.apply({
      keyword: "红烧",
      categoryIds: ["cat-家常菜"],
      tagIds: ["tag-快手"],
      ingredientIds: ["ing-五花肉"],
    });

    store.clear();

    expect(store.filter).toEqual(emptyFilter());
  });
});
