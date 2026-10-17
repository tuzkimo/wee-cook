import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import ChatComposer from "@/components/ai/ChatComposer.vue";

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

function composer(
  props: { disabled?: boolean; sending?: boolean; attachment?: string | null } = {},
): VueWrapper {
  const wrapper = mount(ChatComposer, {
    props: { disabled: false, sending: false, attachment: null, ...props },
  });
  wrappers.push(wrapper);
  return wrapper;
}

describe("ChatComposer", () => {
  it("空字符串或纯空白不发", async () => {
    const wrapper = composer();

    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("send")).toBeUndefined();

    await wrapper.get('[data-test="ai-input"]').setValue("   ");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("send")).toBeUndefined();
  });

  it("disabled 或 sending 时输入框与发送按钮都不可用", () => {
    for (const props of [{ disabled: true }, { sending: true }]) {
      const wrapper = composer(props);
      expect((wrapper.get('[data-test="ai-input"]').element as HTMLInputElement).disabled).toBe(
        true,
      );
      expect((wrapper.get('[data-test="ai-send"]').element as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
  });

  it("有附件时允许空文字发送", async () => {
    const wrapper = composer({ attachment: "data:image/jpeg;base64,x" });

    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("send")).toEqual([[""]]);
  });

  it("点选图按钮 emit attach；点预览的 ✕ emit detach", async () => {
    const wrapper = composer({ attachment: "data:image/jpeg;base64,x" });

    await wrapper.get('[data-test="ai-attach"]').trigger("click");
    expect(wrapper.emitted("attach")).toHaveLength(1);

    await wrapper.get('[data-test="ai-attachment-remove"]').trigger("click");
    expect(wrapper.emitted("detach")).toHaveLength(1);
  });

  it("没有附件时不渲染预览", () => {
    const wrapper = composer();

    expect(wrapper.find("img").exists()).toBe(false);
  });

  it("disabled 或 sending 时选图按钮也不可用", () => {
    for (const props of [{ disabled: true }, { sending: true }]) {
      const wrapper = composer(props);
      expect((wrapper.get('[data-test="ai-attach"]').element as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
  });

  it("发送后清空输入框", async () => {
    const wrapper = composer();
    const input = wrapper.get('[data-test="ai-input"]');

    await input.setValue("  找有五花肉的菜 ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("send")).toEqual([["找有五花肉的菜"]]);
    expect((input.element as HTMLInputElement).value).toBe("");
  });
});
