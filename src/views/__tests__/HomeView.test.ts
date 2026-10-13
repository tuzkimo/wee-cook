import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import HomeView from "@/views/HomeView.vue";

describe("HomeView", () => {
  it("渲染应用名与占位文案", () => {
    const wrapper = mount(HomeView);

    expect(wrapper.text()).toContain("一起做饭");
    expect(wrapper.text()).toContain("菜谱功能开发中");
  });
});
