import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import UserAvatar from "@/components/UserAvatar.vue";

describe("UserAvatar", () => {
  it("data URL → <img>", () => {
    const wrapper = mount(UserAvatar, {
      props: { url: "data:image/jpeg;base64,AAA", name: "阿花" },
    });

    expect(wrapper.get("img").attributes("src")).toBe("data:image/jpeg;base64,AAA");
    expect(wrapper.text()).toBe("");
  });

  it("http 地址 → <img>", () => {
    const wrapper = mount(UserAvatar, { props: { url: "https://e.com/a.png", name: "阿花" } });
    expect(wrapper.get("img").attributes("src")).toBe("https://e.com/a.png");
  });

  it("空串与 null 走同一条降级：昵称首字", () => {
    for (const url of [null, ""]) {
      const wrapper = mount(UserAvatar, { props: { url, name: "阿花" } });
      expect(wrapper.find("img").exists(), String(url)).toBe(false);
      expect(wrapper.text()).toBe("阿");
    }
  });

  it("单个 emoji 当文本渲染", () => {
    const wrapper = mount(UserAvatar, { props: { url: "🐱", name: "阿花" } });
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.text()).toBe("🐱");
  });

  it("昵称以 emoji 开头时首字是整个 emoji，不是半个代理对", () => {
    const wrapper = mount(UserAvatar, { props: { url: null, name: "🐱阿花" } });
    expect(wrapper.text()).toBe("🐱");
  });

  it("坏掉的 data URL 交给 <img>，不静默换成首字", () => {
    const wrapper = mount(UserAvatar, { props: { url: "data:image/jpeg;base64,!!!", name: "阿花" } });
    expect(wrapper.find("img").exists()).toBe(true);
    expect(wrapper.text()).toBe("");
  });

  it("url 运行时不存在的键（undefined）→ 不抛错，降级成昵称首字", () => {
    // JSON 缺这个键时就是这个值：props 类型说是 string | null，网络这条信任边界上不是
    const wrapper = mount(UserAvatar, {
      props: { url: undefined as unknown as string | null, name: "阿花" },
    });

    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.text()).toBe("阿");
  });

  it("昵称也为空 → 问号", () => {
    const wrapper = mount(UserAvatar, { props: { url: null, name: "" } });
    expect(wrapper.text()).toBe("?");
  });

  it("尺寸与圆角由调用方 class 决定，文本字号由 textClass 决定", () => {
    const wrapper = mount(UserAvatar, {
      props: { url: "🐱", name: "阿花", textClass: "text-2xl" },
      attrs: { class: "h-12 w-12 rounded-full" },
    });

    expect(wrapper.classes()).toContain("h-12");
    expect(wrapper.classes()).toContain("rounded-full");
    expect(wrapper.get("span").classes()).toContain("text-2xl");
  });
});
