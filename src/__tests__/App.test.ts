import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import App from "@/App.vue";

const mocks = vi.hoisted(() => ({
  route: { path: "/", meta: {} as Record<string, unknown> },
}));

vi.mock("vue-router", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    useRoute: () => mocks.route,
    RouterView: defineComponent({
      name: "RouterView",
      render: () => h("div", { "data-test": "page" }),
    }),
  };
});

const RouterLink = defineComponent({
  name: "RouterLink",
  props: { to: { type: String, required: true } },
  setup: (props, { slots }) => () => h("a", { href: props.to }, slots.default?.()),
});

const wrappers: VueWrapper[] = [];

function mountApp(): VueWrapper {
  const wrapper = mount(App, { global: { components: { RouterLink } } });
  wrappers.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  mocks.route = { path: "/", meta: {} };
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

describe("App 外壳", () => {
  it("渲染状态栏占位、内容区与三个 tab", () => {
    const wrapper = mountApp();
    expect(wrapper.get('[data-test="statusbar"]').classes()).toContain("bg-surface");
    expect(wrapper.find('[data-test="page"]').exists()).toBe(true);

    const tabs = wrapper.findAll("nav a");
    expect(tabs.map((t) => t.text())).toEqual(["菜谱", "AI", "我的"]);
    expect(tabs.map((t) => t.attributes("href"))).toEqual(["/", "/ai", "/me"]);
  });

  it("状态栏占位高度有 1.5rem 最小值（桌面 env() 为 0 时顶栏不贴边）", () => {
    expect(mountApp().get('[data-test="statusbar"]').classes()).toContain(
      "h-[max(env(safe-area-inset-top),1.5rem)]",
    );
  });

  it("当前路径的 tab 是主色，其余是次要色", () => {
    mocks.route.path = "/ai";
    const tabs = mountApp().findAll("nav a");
    expect(tabs[1].classes()).toContain("text-primary");
    expect(tabs[0].classes()).toContain("text-text-secondary");
    expect(tabs[2].classes()).toContain("text-text-secondary");
  });

  it("meta.hideTab 时没有 tab 栏，且内容区补上底部安全区", () => {
    mocks.route.meta = { hideTab: true };
    const wrapper = mountApp();
    expect(wrapper.find("nav").exists()).toBe(false);
    expect(wrapper.get('[data-test="content"]').classes()).toContain(
      "pb-[env(safe-area-inset-bottom)]",
    );
  });

  it("tab 栏可见时内容区不加底部安全区（tab 栏自己已经补了）", () => {
    expect(mountApp().get('[data-test="content"]').classes()).not.toContain(
      "pb-[env(safe-area-inset-bottom)]",
    );
  });
});
