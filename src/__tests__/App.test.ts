import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import App from "@/App.vue";

const mocks = vi.hoisted(() => ({
  route: { path: "/", meta: {} as Record<string, unknown> },
  // App.vue 的 onMounted 会调 aiSettings.load()：这三处不 mock 就会去读 settings.json、发真请求。
  // 默认站在「没配服务器地址」一侧，一个请求都不发；要测「开启后可见」的用例自己 optIn()。
  hasBaseUrl: vi.fn(() => false),
  readAiSendingEnabled: vi.fn(async () => false),
  fetchAiStatus: vi.fn(async () => ({
    enabled: true,
    model: "deepseek-flash",
    host: "ai.example.com",
  })),
}));

vi.mock("@/services/api", () => ({ hasBaseUrl: mocks.hasBaseUrl }));

// 保留真身（AiError 等），只换 fetchAiStatus。
vi.mock("@/services/ai/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/transport")>();
  return { ...actual, fetchAiStatus: mocks.fetchAiStatus };
});

vi.mock("@/services/ai/privacy", () => ({
  readAiSendingEnabled: mocks.readAiSendingEnabled,
  writeAiSendingEnabled: vi.fn(async () => {}),
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
  // aiSettings 是 pinia store，裸 mount 会报「no active pinia」。
  const wrapper = mount(App, {
    global: { plugins: [createPinia()], components: { RouterLink } },
  });
  wrappers.push(wrapper);
  return wrapper;
}

/** 让入口门控走向「开着」：opt-in 已同意 + 地址已配（探活结果各用例自己定）。 */
function optIn(): void {
  mocks.hasBaseUrl.mockReturnValue(true);
  mocks.readAiSendingEnabled.mockResolvedValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.route = { path: "/", meta: {} };
  mocks.hasBaseUrl.mockReturnValue(false);
  mocks.readAiSendingEnabled.mockResolvedValue(false);
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

describe("App 外壳", () => {
  it("渲染状态栏占位与内容区", () => {
    const wrapper = mountApp();
    expect(wrapper.get('[data-test="statusbar"]').classes()).toContain("bg-surface");
    expect(wrapper.find('[data-test="page"]').exists()).toBe(true);
  });

  // 三态之一：opt-in 关着 ⇒ 用户没同意，AI 入口不该出现。
  it("opt-in 未开启时不渲染 AI tab", () => {
    const tabs = mountApp().findAll("nav a");
    expect(tabs.map((t) => t.text())).toEqual(["菜谱", "我的"]);
    expect(tabs.map((t) => t.attributes("href"))).toEqual(["/", "/me"]);
  });

  it("opt-in 开启且后端启用时渲染三个 tab", async () => {
    optIn();
    mocks.fetchAiStatus.mockResolvedValue({
      enabled: true,
      model: "deepseek-flash",
      host: "ai.example.com",
    });
    const wrapper = mountApp();
    await flushPromises();

    const tabs = wrapper.findAll("nav a");
    expect(tabs.map((t) => t.text())).toEqual(["菜谱", "AI", "我的"]);
    expect(tabs.map((t) => t.attributes("href"))).toEqual(["/", "/ai", "/me"]);
  });

  // 三态之三：「探不到」不等于「没启用」—— 一次断网不能把入口永久藏掉。
  it("opt-in 开启但探不到后端状态时仍渲染 AI tab", async () => {
    mocks.readAiSendingEnabled.mockResolvedValue(true);
    const wrapper = mountApp();
    await flushPromises();

    expect(wrapper.findAll("nav a").map((t) => t.text())).toEqual(["菜谱", "AI", "我的"]);
  });

  it("状态栏占位高度有 1.5rem 最小值（桌面 env() 为 0 时顶栏不贴边）", () => {
    expect(mountApp().get('[data-test="statusbar"]').classes()).toContain(
      "h-[max(env(safe-area-inset-top),1.5rem)]",
    );
  });

  it("当前路径的 tab 是主色，其余是次要色", async () => {
    optIn();
    mocks.route.path = "/ai";
    const wrapper = mountApp();
    await flushPromises();
    const tabs = wrapper.findAll("nav a");
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
