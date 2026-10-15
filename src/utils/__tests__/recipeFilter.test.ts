import { describe, expect, it } from "vitest";
import type { Label, LabelKind, Recipe, RecipeListItem } from "@/types";
import {
  cloneFilter,
  emptyFilter,
  filterRecipes,
  filterSummary,
  isFilterActive,
} from "@/utils/recipeFilter";

const NOW = "2026-10-14T00:00:00.000Z";

function label(id: string, name: string, kind: LabelKind): Label {
  return { id, name, kind, created_at: NOW, updated_at: NOW, deleted_at: null };
}

/** 一行菜谱；分类/标签/食材的 id 由名字派生，测试里好读 */
function row(
  name: string,
  opts: { category?: string; tags?: string[]; ingredients?: string[] } = {},
): RecipeListItem {
  const category = opts.category ?? "家常菜";
  const recipe: Recipe = {
    id: `r-${name}`,
    name,
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

/** 全部条件都只填需要的字段 */
function filter(overrides: Partial<ReturnType<typeof emptyFilter>> = {}) {
  return { ...emptyFilter(), ...overrides };
}

describe("emptyFilter / cloneFilter", () => {
  it("emptyFilter 四项为空且是独立对象", () => {
    const a = emptyFilter();
    const b = emptyFilter();
    expect(a).toEqual({ keyword: "", categoryIds: [], tagIds: [], ingredientIds: [] });
    expect(a.categoryIds).not.toBe(b.categoryIds);
  });

  it("cloneFilter 复制数组，改副本不影响原对象", () => {
    const source = filter({ categoryIds: ["cat-家常菜"], tagIds: ["tag-快手"] });

    const copy = cloneFilter(source);
    copy.categoryIds.push("cat-汤");
    copy.tagIds.length = 0;

    expect(source.categoryIds).toEqual(["cat-家常菜"]);
    expect(source.tagIds).toEqual(["tag-快手"]);
  });
});

describe("isFilterActive", () => {
  it("只有关键词不算活跃（关键词有自己的输入框）", () => {
    expect(isFilterActive(filter({ keyword: "红烧" }))).toBe(false);
  });

  it("三个多选任一非空就算活跃", () => {
    expect(isFilterActive(filter({ categoryIds: ["cat-家常菜"] }))).toBe(true);
    expect(isFilterActive(filter({ tagIds: ["tag-快手"] }))).toBe(true);
    expect(isFilterActive(filter({ ingredientIds: ["ing-五花肉"] }))).toBe(true);
  });
});

describe("filterRecipes", () => {
  it("空筛选原样返回，顺序不变", () => {
    const items = [row("红烧肉"), row("番茄炒蛋")];
    expect(filterRecipes(items, emptyFilter())).toEqual(items);
  });

  it("关键词按中文子串匹配", () => {
    const items = [row("红烧肉"), row("番茄炒蛋")];

    expect(filterRecipes(items, filter({ keyword: "红烧" })).map((i) => i.recipe.name)).toEqual([
      "红烧肉",
    ]);
    expect(filterRecipes(items, filter({ keyword: "鱼" }))).toEqual([]);
  });

  it("关键词去掉前后空格，且不分大小写", () => {
    const items = [row("ABC 汤")];

    expect(filterRecipes(items, filter({ keyword: "  abc  " }))).toHaveLength(1);
  });

  it("分类多选是「或」——一道菜只有一个分类", () => {
    const items = [
      row("红烧肉", { category: "荤菜" }),
      row("冬瓜汤", { category: "汤" }),
      row("炒青菜", { category: "素菜" }),
    ];

    const names = filterRecipes(items, filter({ categoryIds: ["cat-荤菜", "cat-汤"] })).map(
      (i) => i.recipe.name,
    );

    expect(names).toEqual(["红烧肉", "冬瓜汤"]);
  });

  it("标签多选是「且」——两个标签都贴了的才算", () => {
    const items = [
      row("红烧肉", { tags: ["家常", "下饭"] }),
      row("番茄炒蛋", { tags: ["家常"] }),
      row("炒青菜", { tags: ["下饭"] }),
    ];

    const names = filterRecipes(items, filter({ tagIds: ["tag-家常", "tag-下饭"] })).map(
      (i) => i.recipe.name,
    );

    expect(names).toEqual(["红烧肉"]);
  });

  it("食材多选是「且」——两样都用了的才算", () => {
    const items = [
      row("土豆炖肉", { ingredients: ["五花肉", "土豆"] }),
      row("回锅肉", { ingredients: ["五花肉"] }),
      row("炒土豆丝", { ingredients: ["土豆"] }),
    ];

    const names = filterRecipes(items, filter({ ingredientIds: ["ing-五花肉", "ing-土豆"] })).map(
      (i) => i.recipe.name,
    );

    expect(names).toEqual(["土豆炖肉"]);
  });

  it("跨维度是「且」", () => {
    const items = [
      row("土豆炖肉", { category: "荤菜", ingredients: ["五花肉", "土豆"] }),
      row("土豆丝", { category: "素菜", ingredients: ["土豆"] }),
    ];

    const names = filterRecipes(
      items,
      filter({ categoryIds: ["cat-荤菜"], ingredientIds: ["ing-土豆"] }),
    ).map((i) => i.recipe.name);

    expect(names).toEqual(["土豆炖肉"]);
  });

  it("关键词与多选叠加生效：两条线索同时收敛", () => {
    const items = [
      row("土豆炖肉", { category: "荤菜", ingredients: ["五花肉", "土豆"] }),
      row("炒土豆丝", { category: "素菜", ingredients: ["土豆"] }),
    ];

    const names = filterRecipes(
      items,
      filter({ keyword: "土豆", ingredientIds: ["ing-五花肉"] }),
    ).map((i) => i.recipe.name);

    expect(names).toEqual(["土豆炖肉"]);
  });

  it("选中的条件在数据里根本不存在时结果是空", () => {
    expect(filterRecipes([row("红烧肉")], filter({ tagIds: ["tag-已删除"] }))).toEqual([]);
  });
});

describe("filterSummary", () => {
  const items = [
    row("土豆炖肉", {
      category: "家常菜",
      tags: ["快手", "下饭", "汤"],
      ingredients: ["五花肉", "土豆"],
    }),
  ];

  it("不活跃时返回空串（调用方据此不渲染整条）", () => {
    expect(filterSummary(emptyFilter(), items)).toBe("");
    expect(filterSummary(filter({ keyword: "土豆" }), items)).toBe("");
  });

  it("按 分类 → 标签 → 食材 拼，中间用 · 连，超过两个折叠", () => {
    const summary = filterSummary(
      filter({
        categoryIds: ["cat-家常菜"],
        tagIds: ["tag-快手", "tag-下饭", "tag-汤"],
        ingredientIds: ["ing-五花肉", "ing-土豆"],
      }),
      items,
    );

    expect(summary).toBe("📂 家常菜 · 🏷️ 快手、下饭 等3个标签 · 🥕 五花肉、土豆");
  });

  it("只选了一个维度时只写那一段", () => {
    expect(filterSummary(filter({ categoryIds: ["cat-家常菜"] }), items)).toBe("📂 家常菜");
    expect(filterSummary(filter({ ingredientIds: ["ing-五花肉"] }), items)).toBe("🥕 五花肉");
  });

  it("查不到名字的 id 兜底显示 id 本身（菜谱被删后的残留）", () => {
    expect(filterSummary(filter({ tagIds: ["tag-已删除"] }), items)).toBe("🏷️ tag-已删除");
  });
});
