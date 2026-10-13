import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import AiPage from "@/views/AiPage.vue";
import MePage from "@/views/MePage.vue";

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

function page(component: typeof AiPage): VueWrapper {
  const wrapper = mount(component);
  wrappers.push(wrapper);
  return wrapper;
}

describe("占位页", () => {
  it("AI 页有顶栏与说明文字", () => {
    const wrapper = page(AiPage);
    expect(wrapper.get("h1").text()).toBe("AI");
    expect(wrapper.text()).toContain("还在做");
  });

  it("我的页有顶栏与说明文字", () => {
    const wrapper = page(MePage);
    expect(wrapper.get("h1").text()).toBe("我的");
    expect(wrapper.text().length).toBeGreaterThan(2);
  });
});
