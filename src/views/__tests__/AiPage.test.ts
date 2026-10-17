import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { ComputedRef, Ref } from "vue";
import type { AiStatus } from "@/services/ai/transport";
import type { ChatMessage } from "@/stores/aiChat";
import type { Label, LabelKind, Recipe, RecipeListItem } from "@/types";
import type { RecipeFilter } from "@/utils/recipeFilter";
import { emptyFilter } from "@/utils/recipeFilter";
import AiPage from "@/views/AiPage.vue";

const NOW = "2026-10-16T00:00:00.000Z";

// store 用同形状假身：真 store 已由 Task 14 / 9 的用例覆盖，这里测的是页面的渲染与跳转。
const h = vi.hoisted(() => ({
  mocks: {
    push: vi.fn(),
    apply: vi.fn(),
    loadChat: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    loadSettings: vi.fn(async () => {}),
    setSendingEnabled: vi.fn(async () => {}),
  },
  chat: {} as {
    messages: Ref<ChatMessage[]>;
    sending: Ref<boolean>;
    error: Ref<string | null>;
  },
  settings: {} as {
    sendingEnabled: Ref<boolean>;
    status: Ref<AiStatus | null>;
    canShowPrivacyCard: ComputedRef<boolean>;
  },
  api: {} as { baseUrlReady: Ref<boolean> },
  auth: {} as { isOnline: Ref<boolean> },
}));

vi.mock("@/stores/aiChat", async () => {
  const { reactive, ref } = await import("vue");
  h.chat.messages = ref<ChatMessage[]>([]);
  h.chat.sending = ref(false);
  h.chat.error = ref<string | null>(null);
  const store = reactive({
    ...h.chat,
    load: h.mocks.loadChat,
    send: h.mocks.send,
    clear: h.mocks.clear,
    // 页面只调 openInFilter，真正的 apply 由 Task 14 的 store 做；这里把两者接起来好断言
    openInFilter: (filter: RecipeFilter) => h.mocks.apply(filter),
  });
  return { useAiChatStore: () => store };
});

vi.mock("@/stores/aiSettings", async () => {
  const { computed, reactive, ref } = await import("vue");
  h.settings.sendingEnabled = ref(false);
  h.settings.status = ref<AiStatus | null>(null);
  const store = reactive({
    sendingEnabled: h.settings.sendingEnabled,
    status: h.settings.status,
    canShowPrivacyCard: computed(() => Boolean(h.settings.status.value?.host)),
    tabVisible: computed(() => true),
    load: h.mocks.loadSettings,
    setSendingEnabled: h.mocks.setSendingEnabled,
  });
  return { useAiSettingsStore: () => store };
});

vi.mock("vue-router", () => ({ useRouter: () => ({ push: h.mocks.push }) }));
// 登录态：默认已登录，只有专测「未登录」的用例在 beforeEach 之后改成 false
vi.mock("@/stores/auth", async () => {
  const { computed, reactive, ref } = await import("vue");
  h.auth.isOnline = ref(true);
  return { useAuthStore: () => reactive({ isOnline: computed(() => h.auth.isOnline.value) }) };
});
// 地址是否已配：页面用它当发送门控的第二条腿（真实现见 services/__tests__/api.test.ts）
vi.mock("@/services/api", async () => {
  const { computed, ref } = await import("vue");
  h.api.baseUrlReady = ref(false);
  return {
    baseUrlReady: computed(() => h.api.baseUrlReady.value),
    hasBaseUrl: () => h.api.baseUrlReady.value,
  };
});
vi.mock("@/services/imageStore", () => ({ imageSrc: (name: string) => `/img/${name}` }));
vi.mock("@/services/syncFiles", () => ({ ensureLocalImages: async () => new Set<string>() }));

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  h.chat.messages.value = [];
  h.chat.sending.value = false;
  h.chat.error.value = null;
  h.settings.sendingEnabled.value = false;
  h.settings.status.value = null;
  h.api.baseUrlReady.value = false;
  h.auth.isOnline.value = true;
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

async function page(): Promise<VueWrapper> {
  const wrapper = mount(AiPage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

function label(id: string, name: string, kind: LabelKind): Label {
  return { id, name, kind, created_at: NOW, updated_at: NOW, deleted_at: null };
}

function item(id: string, name: string): RecipeListItem {
  const recipe: Recipe = {
    id,
    name,
    cover_path: null,
    category_id: "cat-home",
    is_public: 0,
    owner_nickname: null,
    owner_avatar_url: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    owner_id: null,
  };
  return { recipe, category: label("cat-home", "家常菜", "category"), tags: [], ingredients: [] };
}

let seq = 0;

function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return {
    id: `m-${seq}`,
    role: "assistant",
    text: "找到 1 道",
    filter: emptyFilter(),
    items: [],
    matched: 0,
    unresolved: null,
    ...overrides,
  };
}

const HOST = "ai.example.com";

function enabledStatus(): AiStatus {
  return { enabled: true, model: "deepseek-flash", host: HOST };
}

describe("AiPage 隐私门控", () => {
  it("opt-in 未开启时显示说明与入口，输入区禁用", async () => {
    h.settings.status.value = enabledStatus();
    h.api.baseUrlReady.value = true;
    const wrapper = await page();

    expect(wrapper.find('[data-test="ai-privacy-card"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="ai-privacy-card"]').text()).toContain(HOST);
    expect((wrapper.get('[data-test="ai-input"]').element as HTMLInputElement).disabled).toBe(true);

    await wrapper.get('[data-test="ai-enable"]').trigger("click");
    expect(h.mocks.setSendingEnabled).toHaveBeenCalledWith(true);
  });

  it("说明卡里写明聊天记录是明文存在本机的", async () => {
    h.settings.status.value = enabledStatus();
    h.api.baseUrlReady.value = true;
    const wrapper = await page();

    const text = wrapper.get('[data-test="ai-privacy-card"]').text();
    expect(text).toContain("明文");
    expect(text).toContain("本机");
    expect(text).toContain("菜谱名称与食材");
  });

  it("未配服务器地址时说的是「先连接服务器」，不是「加载失败」", async () => {
    // 未配地址 / 探活失败 ⇒ status 为未知态 null，拿不到 host
    h.settings.status.value = null;
    const wrapper = await page();

    expect(wrapper.text()).toContain("先连接服务器");
    expect(wrapper.text()).not.toContain("加载失败");
    expect(wrapper.find('[data-test="ai-privacy-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="ai-enable"]').exists()).toBe(false);
    expect((wrapper.get('[data-test="ai-input"]').element as HTMLInputElement).disabled).toBe(true);
  });

  it("后端 AI_API_KEY 为空时不展示说明卡、也没有开启入口，输入区禁用并说明原因", async () => {
    h.settings.sendingEnabled.value = true;
    h.settings.status.value = { enabled: false, model: "", host: "" };
    h.api.baseUrlReady.value = true;
    const wrapper = await page();

    expect(wrapper.get('[data-test="ai-disabled-hint"]').text()).toBe("服务器的 AI 未启用。");
    expect(wrapper.find('[data-test="ai-server-hint"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="ai-privacy-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="ai-enable"]').exists()).toBe(false);
    expect((wrapper.get('[data-test="ai-input"]').element as HTMLInputElement).disabled).toBe(true);
  });

  it("opt-in 开启且拿到 host 后输入区可用，且不再展示说明卡", async () => {
    h.settings.sendingEnabled.value = true;
    h.settings.status.value = enabledStatus();
    h.api.baseUrlReady.value = true;
    const wrapper = await page();

    expect(wrapper.find('[data-test="ai-privacy-card"]').exists()).toBe(false);
    expect((wrapper.get('[data-test="ai-input"]').element as HTMLInputElement).disabled).toBe(false);
  });

  it("opt-in 开着、地址已配但探活失败时仍能发送，且不误报「先连接服务器」", async () => {
    // status 停在未知态（401 / 断网），但地址是配了的：能发给谁已经确定，不该锁死输入区
    h.settings.sendingEnabled.value = true;
    h.settings.status.value = null;
    h.api.baseUrlReady.value = true;
    const wrapper = await page();

    expect((wrapper.get('[data-test="ai-input"]').element as HTMLInputElement).disabled).toBe(false);
    expect(wrapper.find('[data-test="ai-server-hint"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="ai-disabled-hint"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("先连接服务器");
  });

  it("opt-in 开着但地址没配时输入区禁用并提示先连接服务器", async () => {
    h.settings.sendingEnabled.value = true;
    h.settings.status.value = null;
    h.api.baseUrlReady.value = false;
    const wrapper = await page();

    expect((wrapper.get('[data-test="ai-input"]').element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.get('[data-test="ai-server-hint"]').text()).toBe("先连接服务器，才能用 AI 助手。");
  });

  it("未登录时输入区禁用并提示先登录，不报服务器或 AI 未启用", async () => {
    // 退登后 opt-in 与地址都可能还在，但没凭据就发不出去，不能装作能用
    h.auth.isOnline.value = false;
    h.settings.sendingEnabled.value = true;
    h.settings.status.value = enabledStatus();
    h.api.baseUrlReady.value = true;
    const wrapper = await page();

    expect((wrapper.get('[data-test="ai-input"]').element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.get('[data-test="ai-login-hint"]').text()).toBe("请先登录，才能用 AI 助手。");
    expect(wrapper.find('[data-test="ai-server-hint"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="ai-disabled-hint"]').exists()).toBe(false);
  });

  it("opt-in 开着但地址没配时提示先连接服务器，历史仍在", async () => {
    // 401 与断网都让 status 停在未知态 null；页面不据此判「没启用」
    // 入口显隐由 tabVisible 决定，见 src/stores/__tests__/aiSettings.test.ts
    h.settings.sendingEnabled.value = true;
    h.settings.status.value = null;
    h.chat.messages.value = [chatMessage({ role: "user", text: "找有五花肉的菜", filter: null })];
    const wrapper = await page();

    expect(wrapper.get("h1").text()).toBe("AI");
    expect(wrapper.findAll('[data-test="ai-bubble"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("先连接服务器");
  });

  it("输入框回车只把文本交给 store.send，不清历史", async () => {
    h.settings.sendingEnabled.value = true;
    h.settings.status.value = enabledStatus();
    h.api.baseUrlReady.value = true;
    const wrapper = await page();

    await wrapper.get('[data-test="ai-input"]').setValue("找有五花肉的菜");
    await wrapper.get("form").trigger("submit");

    expect(h.mocks.send).toHaveBeenCalledWith("找有五花肉的菜");
    expect(h.mocks.clear).not.toHaveBeenCalled();
  });
});

describe("AiPage 消息流", () => {
  beforeEach(() => {
    h.settings.sendingEnabled.value = true;
    h.settings.status.value = enabledStatus();
    h.api.baseUrlReady.value = true;
  });

  it("发送后消息渲染成气泡，卡片用 RecipeCard", async () => {
    h.chat.messages.value = [
      chatMessage({ role: "user", text: "找有五花肉的菜", filter: null }),
      chatMessage({
        text: "找到 1 道",
        filter: { keyword: "", categoryIds: [], tagIds: [], ingredientIds: [] },
        items: [item("r1", "回锅肉")],
        matched: 1,
      }),
    ];
    const wrapper = await page();

    const bubbles = wrapper.findAll('[data-test="ai-bubble"]');
    expect(bubbles.map((bubble) => bubble.text())).toEqual(["找有五花肉的菜", "找到 1 道"]);
    expect(wrapper.findAll('[data-test="recipe-card"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="recipe-name"]').text()).toBe("回锅肉");

    await wrapper.get('[data-test="recipe-card"]').trigger("click");
    expect(h.mocks.push).toHaveBeenCalledWith("/recipe/r1");
  });

  it("点「在筛选页继续改」会 apply 进 recipeFilter 并跳到 /", async () => {
    const filter: RecipeFilter = {
      keyword: "",
      categoryIds: [],
      tagIds: [],
      ingredientIds: ["ing-pork"],
    };
    h.chat.messages.value = [
      chatMessage({ filter, items: [item("r1", "回锅肉")], matched: 1 }),
    ];
    const wrapper = await page();

    await wrapper.get('[data-test="ai-continue-filter"]').trigger("click");

    expect(h.mocks.apply).toHaveBeenCalledWith(filter);
    expect(h.mocks.push).toHaveBeenCalledWith("/");
  });

  it("有未落定名字时渲染一行提示，且不把它们放进 filter", async () => {
    const filter: RecipeFilter = { keyword: "", categoryIds: [], tagIds: [], ingredientIds: [] };
    h.chat.messages.value = [
      chatMessage({
        filter,
        items: [item("r1", "回锅肉")],
        matched: 1,
        unresolved: { categories: [], tags: [], ingredients: ["五花肉片"] },
      }),
    ];
    const wrapper = await page();

    expect(wrapper.get('[data-test="ai-unresolved"]').text()).toBe("没找到：五花肉片");

    await wrapper.get('[data-test="ai-continue-filter"]').trigger("click");
    const applied = h.mocks.apply.mock.calls[0][0] as RecipeFilter;
    expect(applied.ingredientIds).toEqual([]);
    expect(applied).toStrictEqual(filter);
  });

  it("搜索无结果时给空态文案，不渲染卡片、也不给去筛选页的入口", async () => {
    h.chat.messages.value = [
      chatMessage({
        filter: { keyword: "佛跳墙", categoryIds: [], tagIds: [], ingredientIds: [] },
        items: [],
        matched: 0,
      }),
    ];
    const wrapper = await page();

    expect(wrapper.get('[data-test="ai-empty"]').text()).toContain("库里没找到");
    expect(wrapper.findAll('[data-test="recipe-card"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="ai-continue-filter"]').exists()).toBe(false);
    expect(h.mocks.push).not.toHaveBeenCalled();
  });

  it("命中数多于卡片数时说明还有几道，不假装只有第一页", async () => {
    const items = Array.from({ length: 10 }, (_, index) => item(`r${index}`, `菜${index}`));
    h.chat.messages.value = [chatMessage({ items, matched: 12 })];
    const wrapper = await page();

    expect(wrapper.get('[data-test="ai-more"]').text()).toContain("还有 2 道");
  });

  it("读历史失败不把页面搞崩", async () => {
    h.mocks.loadChat.mockRejectedValueOnce(new Error("boom"));
    const wrapper = await page();

    expect(wrapper.get("h1").text()).toBe("AI");
  });

  it("失败文案渲染成可关闭的提示条", async () => {
    h.chat.error.value = "连不上服务器，检查网络后重试";
    const wrapper = await page();

    expect(wrapper.get('[data-test="ai-error"]').text()).toContain("连不上服务器");
    await wrapper.get('[data-test="ai-error-close"]').trigger("click");
    expect(wrapper.find('[data-test="ai-error"]').exists()).toBe(false);
  });
});

describe("AiPage 等待反馈", () => {
  it("发送中在消息流末尾显示「正在思考…」，回答到达后消失", async () => {
    const wrapper = await page();
    expect(wrapper.find('[data-test="ai-thinking"]').exists()).toBe(false);

    h.chat.sending.value = true;
    await flushPromises();
    const thinking = wrapper.get('[data-test="ai-thinking"]');
    expect(thinking.text()).toContain("正在思考");

    h.chat.sending.value = false;
    await flushPromises();
    expect(wrapper.find('[data-test="ai-thinking"]').exists()).toBe(false);
  });

  it("等待中也能看到最后一条消息（提示条不会把消息挤出可视区）", async () => {
    h.chat.messages.value = [chatMessage({ text: "早到的回复" })];
    h.chat.sending.value = true;
    const wrapper = await page();

    expect(wrapper.text()).toContain("早到的回复");
    expect(wrapper.find('[data-test="ai-thinking"]').exists()).toBe(true);
  });
});
