import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import AppHeader from "@/components/AppHeader.vue";

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

function header(props: { title: string; showBack?: boolean }): VueWrapper {
  const wrapper = mount(AppHeader, { props });
  wrappers.push(wrapper);
  return wrapper;
}

describe("AppHeader", () => {
  it("渲染标题", () => {
    const wrapper = header({ title: "菜谱" });
    expect(wrapper.get("h1").text()).toBe("菜谱");
  });

  it("不传 showBack 时没有返回按钮", () => {
    expect(header({ title: "菜谱" }).find('[data-test="back"]').exists()).toBe(false);
  });

  it("传 showBack 时有返回按钮，点了发 back 事件", async () => {
    const wrapper = header({ title: "红烧肉", showBack: true });
    await wrapper.get('[data-test="back"]').trigger("click");
    expect(wrapper.emitted("back")).toHaveLength(1);
  });

  it("title 插槽覆盖默认标题（详情页要靠它挂 data-test）", () => {
    const wrapper = mount(AppHeader, {
      props: { title: "会被覆盖" },
      slots: { title: '<h1 data-test="detail-name">红烧肉</h1>' },
    });
    wrappers.push(wrapper);
    expect(wrapper.get('[data-test="detail-name"]').text()).toBe("红烧肉");
    expect(wrapper.find("h1:not([data-test])").exists()).toBe(false);
  });

  it("action 插槽渲染在标题右侧", () => {
    const wrapper = mount(AppHeader, {
      props: { title: "菜谱" },
      slots: { action: '<button data-test="act">x</button>' },
    });
    wrappers.push(wrapper);
    expect(wrapper.get('[data-test="act"]').exists()).toBe(true);
  });
});
