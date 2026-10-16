import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import RecipeCard from "@/components/RecipeCard.vue";

function mountCard(props: Record<string, unknown> = {}, prefix: "recipe" | "community" = "recipe") {
  return mount(RecipeCard, {
    props: {
      name: "红烧肉",
      coverSrc: null,
      category: null,
      tags: [],
      authorName: null,
      authorAvatarUrl: null,
      testPrefix: prefix,
      ...props,
    },
  });
}

describe("RecipeCard", () => {
  it("三行都在：标题 / 分类与标签 / 作者", () => {
    const wrapper = mountCard({ category: "家常菜", tags: ["下饭", "快手"], authorName: "老王", authorAvatarUrl: "🐱" });

    expect(wrapper.get('[data-test="recipe-name"]').text()).toBe("红烧肉");
    expect(wrapper.get('[data-test="recipe-category"]').text()).toBe("家常菜");
    expect(wrapper.findAll('[data-test="recipe-tag"]').map((t) => t.text())).toEqual(["下饭", "快手"]);
    expect(wrapper.get('[data-test="recipe-author"]').text()).toBe("老王");
    expect(wrapper.get('[data-test="recipe-author-avatar"]').text()).toBe("🐱");
  });

  it("没有分类时只画标签", () => {
    const wrapper = mountCard({ category: null, tags: ["下饭"] });

    expect(wrapper.find('[data-test="recipe-category"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-test="recipe-tag"]').map((t) => t.text())).toEqual(["下饭"]);
  });

  it("分类与标签都为空时整个第二行不渲染", () => {
    const wrapper = mountCard({ category: null, tags: [] });

    expect(wrapper.find('[data-test="recipe-category"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="recipe-tag"]').exists()).toBe(false);
  });

  it("分类用主色 chip，标签仍是灰的（看得出一类二类）", () => {
    const wrapper = mountCard({ category: "家常菜", tags: ["下饭"] });

    expect(wrapper.get('[data-test="recipe-category"]').classes()).toContain("text-primary");
    expect(wrapper.get('[data-test="recipe-tag"]').classes()).toContain("text-text-secondary");
  });

  it("作者为空时第三行整行不渲染", () => {
    const wrapper = mountCard({ authorName: null, authorAvatarUrl: null });

    expect(wrapper.find('[data-test="recipe-author"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="recipe-author-avatar"]').exists()).toBe(false);
  });

  it("封面没落盘时用菜名首字兜底", () => {
    const wrapper = mountCard({ name: "红烧肉", coverSrc: null });

    expect(wrapper.find('[data-test="recipe-cover"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="recipe-cover-fallback"]').text()).toBe("红");
  });

  it("菜名以 emoji 开头时兜底取整个 emoji，不是半个代理对", () => {
    const wrapper = mountCard({ name: "🍜牛肉面", coverSrc: null });

    expect(wrapper.get('[data-test="recipe-cover-fallback"]').text()).toBe("🍜");
  });

  it("有图源时画 <img> 且不做兜底", () => {
    const wrapper = mountCard({ coverSrc: "/x.jpg" });

    expect(wrapper.get('[data-test="recipe-cover"]').attributes("src")).toBe("/x.jpg");
    expect(wrapper.find('[data-test="recipe-cover-fallback"]').exists()).toBe(false);
  });

  it("testPrefix 决定钩子前缀，社区那套逐字保留", () => {
    const wrapper = mountCard(
      { category: "家常菜", tags: ["下饭"], authorName: "老王", authorAvatarUrl: "🐱" },
      "community",
    );

    expect(wrapper.find('[data-test="community-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="community-name"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="community-cover-fallback"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="community-category"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="community-tag"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="community-author"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="community-author-avatar"]').exists()).toBe(true);
    expect(wrapper.find('[data-test^="recipe-"]').exists()).toBe(false);
  });

  it("整张卡是一个按钮，点击 emit 到父组件的 handler", async () => {
    const onClick = vi.fn();
    const wrapper = mount(RecipeCard, {
      props: {
        name: "红烧肉",
        coverSrc: null,
        category: null,
        tags: [],
        authorName: null,
        authorAvatarUrl: null,
        testPrefix: "recipe",
      },
      attrs: { onClick },
    });

    const card = wrapper.get('[data-test="recipe-card"]');
    expect(card.element.tagName).toBe("BUTTON");
    expect(card.attributes("type")).toBe("button");
    await card.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
