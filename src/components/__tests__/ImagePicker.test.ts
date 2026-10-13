import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import ImagePicker from "@/components/ImagePicker.vue";

// 组件只管「拿到结果怎么办」；压缩与落盘由 imageStore 自己的测试覆盖 ⇒ 这里整条替换掉。
const mocks = vi.hoisted(() => ({
  pickAndSaveImage: vi.fn(),
  saveImageBytes: vi.fn(),
}));

vi.mock("@/services/imageStore", () => ({
  imageSrc: (name: string) => `asset://localhost/images/${name}`,
  pickAndSaveImage: mocks.pickAndSaveImage,
  saveImageBytes: mocks.saveImageBytes,
}));

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  mocks.pickAndSaveImage.mockReset();
  mocks.saveImageBytes.mockReset();
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

function mountPicker(modelValue: string | null): VueWrapper {
  const wrapper = mount(ImagePicker, { props: { modelValue } });
  wrappers.push(wrapper);
  return wrapper;
}

/** 点开内联的三个选项（拍照 / 从相册选 / 移除） */
async function openOptions(wrapper: VueWrapper): Promise<void> {
  const trigger = wrapper.find('[data-test="image-placeholder"]').exists()
    ? wrapper.get('[data-test="image-placeholder"]')
    : wrapper.get('[data-test="image-preview"]');
  await trigger.trigger("click");
}

describe("ImagePicker", () => {
  it("modelValue 为 null 时显示占位，有值时显示图", () => {
    const empty = mountPicker(null);
    expect(empty.find('[data-test="image-placeholder"]').exists()).toBe(true);
    expect(empty.find('[data-test="image-preview"]').exists()).toBe(false);

    const filled = mountPicker("a.jpg");
    expect(filled.find('[data-test="image-placeholder"]').exists()).toBe(false);
    const img = filled.get('[data-test="image-preview"] img');
    expect(img.attributes("src")).toBe("asset://localhost/images/a.jpg");
  });

  it("点占位打开「拍照 / 从相册选 / 移除」三个选项", async () => {
    const wrapper = mountPicker(null);
    expect(wrapper.find('[data-test="image-options"]').exists()).toBe(false);

    await openOptions(wrapper);

    const options = wrapper.get('[data-test="image-options"]');
    expect(options.find('[data-test="opt-camera"]').exists()).toBe(true);
    expect(options.find('[data-test="opt-gallery"]').exists()).toBe(true);
    expect(options.find('[data-test="opt-remove"]').exists()).toBe(true);
    expect(options.text()).toContain("拍照");
    expect(options.text()).toContain("从相册选");
    expect(options.text()).toContain("移除");
  });

  it("选相册成功 → emit update:modelValue 带上文件名", async () => {
    mocks.pickAndSaveImage.mockResolvedValue({ ok: true, name: "a.jpg" });
    const wrapper = mountPicker(null);

    await openOptions(wrapper);
    await wrapper.get('[data-test="opt-gallery"]').trigger("click");
    await flushPromises();

    expect(mocks.pickAndSaveImage).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted("update:modelValue")).toEqual([["a.jpg"]]);
  });

  it("用户取消 → 不发 emit", async () => {
    mocks.pickAndSaveImage.mockResolvedValue(null);
    const wrapper = mountPicker(null);

    await openOptions(wrapper);
    await wrapper.get('[data-test="opt-gallery"]').trigger("click");
    await flushPromises();

    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("失败 → 显示 message，不发 emit", async () => {
    mocks.pickAndSaveImage.mockResolvedValue({ ok: false, message: "这张图读不出来，换一张试试" });
    const wrapper = mountPicker(null);

    await openOptions(wrapper);
    await wrapper.get('[data-test="opt-gallery"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="image-error"]').text()).toBe("这张图读不出来，换一张试试");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("已有图时点「移除」→ emit update:modelValue 传 null", async () => {
    const wrapper = mountPicker("a.jpg");

    await openOptions(wrapper);
    await wrapper.get('[data-test="opt-remove"]').trigger("click");

    expect(wrapper.emitted("update:modelValue")).toEqual([[null]]);
  });

  it("拍照走隐藏 input 的 capture，change 后把字节交给 saveImageBytes", async () => {
    mocks.saveImageBytes.mockResolvedValue({ ok: true, name: "shot.jpg" });
    const wrapper = mountPicker(null);

    const input = wrapper.get<HTMLInputElement>('[data-test="image-camera-input"]');
    expect(input.attributes("accept")).toBe("image/*");
    expect(input.attributes("capture")).toBe("environment");

    await openOptions(wrapper);
    await wrapper.get('[data-test="opt-camera"]').trigger("click");

    const file = new File([new Uint8Array([1, 2, 3])], "shot.jpg", { type: "image/jpeg" });
    Object.defineProperty(input.element, "files", { value: [file] });
    await input.trigger("change");
    await flushPromises();

    expect(mocks.saveImageBytes).toHaveBeenCalledTimes(1);
    const sent = mocks.saveImageBytes.mock.calls[0][0] as Uint8Array;
    expect([...sent]).toEqual([1, 2, 3]);
    expect(wrapper.emitted("update:modelValue")).toEqual([["shot.jpg"]]);
  });
});
