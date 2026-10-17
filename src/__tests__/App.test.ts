import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import App from "@/App.vue";
import { setAiAccount } from "@/services/ai/account";
import type { Screenshot } from "@/services/ai/image";
import type { ShareIntakeDeps } from "@/services/ai/shareIntake";

const mocks = vi.hoisted(() => ({
  route: { path: "/", meta: {} as Record<string, unknown> },
  push: vi.fn(),
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

// 分享链的拉取点：生产实现由 Task 13 的 shareIntake 用例覆盖，这里只测 App 的接线。
const intake = vi.hoisted(() => ({
  start: vi.fn<(deps: ShareIntakeDeps & { retryDelayMs?: number }) => () => void>(),
  stop: vi.fn(),
  realDeps: {
    readPending: vi.fn(),
    readBytes: vi.fn(),
    consume: vi.fn(),
    toScreenshot: vi.fn(),
  },
  setAttachment: vi.fn<(shot: Screenshot) => void>(),
  setNotice: vi.fn<(text: string) => void>(),
}));

vi.mock("@/services/ai/shareIntake", () => ({
  startShareIntake: intake.start,
  realDeps: intake.realDeps,
}));

// 真 store 已由 store 层用例覆盖；App 只负责把附件/提示交给它。
vi.mock("@/stores/aiChat", () => ({
  useAiChatStore: () => ({ setAttachment: intake.setAttachment, setNotice: intake.setNotice }),
}));

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
    useRouter: () => ({ push: mocks.push }),
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
  intake.start.mockReturnValue(intake.stop);
  // 入口门控按账号读 opt-in（spec §12.1）：没账号时 load() 什么都不读，入口也会隐藏
  setAiAccount("u-A");
  mocks.route = { path: "/", meta: {} };
  mocks.hasBaseUrl.mockReturnValue(false);
  mocks.readAiSendingEnabled.mockResolvedValue(false);
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

describe("App 分享入口", () => {
  it("挂载时注册拉取点，卸载时兜底注销", () => {
    const wrapper = mountApp();
    expect(intake.start).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    // afterEach 里还会再 unmount 一次（同一个 wrapper）：这里已经从列表里摘掉
    wrappers.length = 0;
    expect(intake.stop).toHaveBeenCalledTimes(1);
  });

  it("拉到的东西直接进 aiChat store", () => {
    mountApp();
    const deps = intake.start.mock.calls[0][0];
    const shot: Screenshot = {
      segments: ["data:image/jpeg;base64,seg1"],
      cover: "data:image/jpeg;base64,cover",
      coverBytes: new Uint8Array([1]),
      width: 1080,
      height: 1500,
    };

    deps.setAttachment(shot);
    deps.setNotice("一次只能收一张，已用第一张");

    expect(intake.setAttachment).toHaveBeenCalledWith(shot);
    expect(intake.setNotice).toHaveBeenCalledWith("一次只能收一张，已用第一张");
  });

  it("pushAi 只在不在 /ai 时跳转（已在页面上就不堆历史栈）", () => {
    mountApp();
    const deps = intake.start.mock.calls[0][0];

    deps.pushAi();
    expect(mocks.push).toHaveBeenCalledWith("/ai");

    mocks.route.path = "/ai";
    deps.pushAi();
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });
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
