import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import MePage from "@/views/MePage.vue";

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

function page(component: typeof MePage): VueWrapper {
  const wrapper = mount(component);
  wrappers.push(wrapper);
  return wrapper;
}

describe("占位页", () => {
  // AI 页已实现为聊天页，其占位断言随实现移除（AiPage.test.ts 接管）
  it("我的页有顶栏与说明文字", () => {
    const wrapper = page(MePage);
    expect(wrapper.get("h1").text()).toBe("我的");
    expect(wrapper.text().length).toBeGreaterThan(2);
  });
});
