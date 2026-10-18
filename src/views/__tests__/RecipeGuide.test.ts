// 指导模式页：只验证状态机与接线（识别 → 答案解析 → 朗读 / 生命周期），识别与朗读本身是桩。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { RecipeDetail, RecipeIngredientRow, RecipeStep } from "@/types";
import type { SpeechErrorKind, SpeechHandle } from "@/services/voice/speech";
import RecipeGuide from "@/views/RecipeGuide.vue";

const NOW = "2026-10-18T00:00:00.000Z";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  routeParams: {} as Record<string, string>,
  getDetail: vi.fn(),
  isSpeechAvailable: vi.fn(),
  startSpeech: vi.fn(),
  stop: vi.fn(),
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
  keepScreenOn: vi.fn(),
  onResult: undefined as ((text: string) => void) | undefined,
  onError: undefined as ((kind: SpeechErrorKind, message: string) => void) | undefined,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, back: mocks.back, replace: vi.fn() }),
  useRoute: () => ({ params: mocks.routeParams }),
}));

vi.mock("@/stores/recipe", () => ({
  useRecipeStore: () => ({ getDetail: mocks.getDetail }),
}));

vi.mock("@/services/voice/speech", () => ({
  isSpeechAvailable: mocks.isSpeechAvailable,
  startSpeech: mocks.startSpeech,
}));

vi.mock("@/services/voice/tts", () => ({
  speak: mocks.speak,
  stopSpeaking: mocks.stopSpeaking,
}));

vi.mock("@/services/voice/keepAwake", () => ({
  keepScreenOn: mocks.keepScreenOn,
}));

function step(id: string, sortOrder: number, text: string): RecipeStep {
  return { id, recipe_id: "r1", sort_order: sortOrder, text, image_path: null, updated_at: NOW, deleted_at: null };
}

function line(id: string, name: string, amount: number | null, unit: string | null): RecipeIngredientRow {
  return {
    id,
    recipe_id: "r1",
    ingredient_id: `i-${id}`,
    amount,
    unit_id: unit ? `u-${id}` : null,
    sort_order: 0,
    updated_at: NOW,
    deleted_at: null,
    ingredient_name: name,
    unit_name: unit,
  };
}

function detail(steps: RecipeStep[] = fourSteps()): RecipeDetail {
  return {
    recipe: {
      id: "r1",
      name: "宫保鸡丁",
      cover_path: null,
      category_id: "c1",
      is_public: 0,
      owner_nickname: null,
      owner_avatar_url: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      owner_id: null,
    },
    category: { id: "c1", name: "荤菜", kind: "category", created_at: NOW, updated_at: NOW, deleted_at: null },
    tags: [],
    steps,
    ingredients: [line("1", "低筋面粉", 200, "克")],
  };
}

function fourSteps(): RecipeStep[] {
  return [
    step("s1", 0, "鸡胸肉切丁，加盐和淀粉抓匀，腌 10 分钟"),
    step("s2", 1, "热锅下油，油温六成热下鸡丁滑散，约 2 分钟"),
    step("s3", 2, "倒掉多余的油，留底油下配料"),
    step("s4", 3, "大火翻炒均匀出锅"),
  ];
}

const wrappers: VueWrapper[] = [];

function speechHandle(): SpeechHandle {
  return { stop: mocks.stop };
}

async function page(): Promise<VueWrapper> {
  const wrapper = mount(RecipeGuide);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.routeParams = { id: "r1" };
  mocks.getDetail.mockResolvedValue(detail());
  mocks.isSpeechAvailable.mockResolvedValue(true);
  mocks.speak.mockResolvedValue(undefined);
  mocks.stopSpeaking.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.keepScreenOn.mockResolvedValue(undefined);
  mocks.startSpeech.mockImplementation(
    async (
      onResult: (text: string) => void,
      onError: (kind: SpeechErrorKind, message: string) => void,
    ) => {
      mocks.onResult = onResult;
      mocks.onError = onError;
      return speechHandle();
    },
  );
  mocks.onResult = undefined;
  mocks.onError = undefined;
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  vi.useRealTimers();
});

describe("RecipeGuide", () => {
  it("进入时启动识别并播报第一步", async () => {
    const wrapper = await page();

    expect(mocks.startSpeech).toHaveBeenCalledTimes(1);
    expect(mocks.speak).toHaveBeenCalledWith("鸡胸肉切丁，加盐和淀粉抓匀，腌 10 分钟");
    expect(wrapper.get('[data-test="guide-step-order"]').text()).toBe("1 / 4");
    expect(wrapper.get('[data-test="guide-status"]').text()).toContain("正在聆听");
  });

  it("识别结果命中时追加一行问答并朗读答案", async () => {
    const wrapper = await page();

    mocks.onResult?.("小厨，面粉多少");
    await flushPromises();

    expect(mocks.speak).toHaveBeenLastCalledWith("低筋面粉，200 克");
    expect(wrapper.get('[data-test="guide-qa"]').text()).toContain("低筋面粉，200 克");
  });

  it("识别结果没有唤醒词时不朗读、不加问答行", async () => {
    const wrapper = await page();
    mocks.speak.mockClear();

    mocks.onResult?.("面粉多少");
    await flushPromises();

    expect(mocks.speak).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="guide-qa"]').exists()).toBe(false);
  });

  it("transient 错误后 1.5 秒自动重启一次（fake timers）", async () => {
    vi.useFakeTimers();
    const wrapper = mount(RecipeGuide);
    wrappers.push(wrapper);
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.startSpeech).toHaveBeenCalledTimes(1);

    mocks.onError?.("transient", "no speech");
    await vi.advanceTimersByTimeAsync(1500);

    expect(mocks.startSpeech).toHaveBeenCalledTimes(2);
  });

  it("连续 3 次 transient 错误后显示异常提示条，不再重启", async () => {
    vi.useFakeTimers();
    const wrapper = mount(RecipeGuide);
    wrappers.push(wrapper);
    await vi.advanceTimersByTimeAsync(10);

    mocks.onError?.("transient", "no speech");
    await vi.advanceTimersByTimeAsync(1500);
    mocks.onError?.("transient", "no speech");
    await vi.advanceTimersByTimeAsync(1500);
    mocks.onError?.("transient", "no speech");
    await vi.advanceTimersByTimeAsync(5000);

    expect(mocks.startSpeech).toHaveBeenCalledTimes(3);
    expect(wrapper.get('[data-test="guide-mic-error"]').text()).toContain("暂时不可用");
  });

  it("permission 错误不重试，提示去系统设置开麦克风", async () => {
    vi.useFakeTimers();
    const wrapper = mount(RecipeGuide);
    wrappers.push(wrapper);
    await vi.advanceTimersByTimeAsync(10);

    mocks.onError?.("permission", "没有麦克风权限");
    await vi.advanceTimersByTimeAsync(10000);

    expect(mocks.startSpeech).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-test="guide-mic-error"]').text()).toContain("系统设置");
  });

  it("语音不可用时页面仍渲染步骤，下一步按钮仍可用", async () => {
    mocks.isSpeechAvailable.mockResolvedValue(false);

    const wrapper = await page();

    expect(mocks.startSpeech).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="guide-step-text"]').text()).toContain("鸡胸肉切丁");
    expect(wrapper.find('[data-test="guide-mic-error"]').exists()).toBe(true);

    await wrapper.get('[data-test="guide-next"]').trigger("click");

    expect(wrapper.get('[data-test="guide-step-order"]').text()).toBe("2 / 4");
  });

  it("没有步骤的菜谱：显示没有步骤、翻步按钮禁用、语音仍答食材", async () => {
    mocks.getDetail.mockResolvedValue(detail([]));

    const wrapper = await page();

    expect(wrapper.get('[data-test="guide-step-text"]').text()).toBe("这道菜没有步骤");
    expect(wrapper.get('[data-test="guide-prev"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="guide-next"]').attributes("disabled")).toBeDefined();
    // 播报与识别互不依赖：没有步骤时也照常起麦
    expect(mocks.startSpeech).toHaveBeenCalledTimes(1);

    mocks.onResult?.("小厨，面粉多少");
    await flushPromises();

    expect(wrapper.get('[data-test="guide-qa"]').text()).toContain("低筋面粉，200 克");
  });

  it("识别服务不存在时提示不可重试，点提示条也不会再起麦", async () => {
    const wrapper = await page();

    mocks.onError?.("unavailable", "not available");
    await flushPromises();

    const bar = wrapper.get('[data-test="guide-mic-error"]');
    expect(bar.text()).toContain("没有可用的语音识别");
    await bar.trigger("click");
    await flushPromises();
    expect(mocks.startSpeech).toHaveBeenCalledTimes(1);
  });

  it("点重试前先停掉旧会话，不留重复监听", async () => {
    vi.useFakeTimers();
    const wrapper = mount(RecipeGuide);
    wrappers.push(wrapper);
    await vi.advanceTimersByTimeAsync(10);

    mocks.onError?.("transient", "no speech");
    await vi.advanceTimersByTimeAsync(1500);
    mocks.onError?.("transient", "no speech");
    await vi.advanceTimersByTimeAsync(1500);
    mocks.onError?.("transient", "no speech");
    await vi.advanceTimersByTimeAsync(10);
    mocks.stop.mockClear();

    await wrapper.get('[data-test="guide-mic-error"]').trigger("click");
    await vi.advanceTimersByTimeAsync(10);

    expect(mocks.stop).toHaveBeenCalled();
    expect(mocks.startSpeech).toHaveBeenCalledTimes(4);
  });

  it("成功识别一次后重启计数清零（不是整场只给 3 次）", async () => {
    vi.useFakeTimers();
    const wrapper = mount(RecipeGuide);
    wrappers.push(wrapper);
    await vi.advanceTimersByTimeAsync(10);

    mocks.onError?.("transient", "no speech");
    await vi.advanceTimersByTimeAsync(1500);
    mocks.onError?.("transient", "no speech");
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.startSpeech).toHaveBeenCalledTimes(3);

    // 中途听到一句：计数器必须归零，否则一堂菜下来总共只给 3 次重试
    mocks.onResult?.("小厨");
    await vi.advanceTimersByTimeAsync(10);
    mocks.onError?.("transient", "no speech");
    await vi.advanceTimersByTimeAsync(1500);

    expect(mocks.startSpeech).toHaveBeenCalledTimes(4);
  });

  it("卸载后才返回的详情不会再开麦（异步竞态不留后台监听）", async () => {
    let resolveDetail: (value: RecipeDetail) => void = () => {};
    mocks.getDetail.mockReturnValue(
      new Promise<RecipeDetail>((resolve) => {
        resolveDetail = resolve;
      }),
    );

    const wrapper = mount(RecipeGuide);
    wrapper.unmount();
    resolveDetail(detail());
    await flushPromises();

    expect(mocks.startSpeech).not.toHaveBeenCalled();
  });

  it("页面上说明音频去向（不落盘、不上传本服务，厂商识别服务是否联网由其决定）", async () => {
    const wrapper = await page();

    expect(wrapper.get('[data-test="guide-privacy"]').text()).toContain("不落盘");
  });

  it("卸载时调用 stop()、stopSpeaking()、keepScreenOn(false)", async () => {
    const wrapper = await page();

    wrapper.unmount();
    wrappers.length = 0;
    await flushPromises();

    expect(mocks.stopSpeaking).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.keepScreenOn).toHaveBeenCalledWith(false);
  });
});
