import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import AttachmentPreview from "@/components/ai/AttachmentPreview.vue";

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

function preview(image = "data:image/jpeg;base64,x"): VueWrapper {
  const wrapper = mount(AttachmentPreview, { props: { image } });
  wrappers.push(wrapper);
  return wrapper;
}

describe("AttachmentPreview", () => {
  it("渲染缩略图，点 ✕ emit remove", async () => {
    const wrapper = preview();

    expect(wrapper.get("img").attributes("src")).toBe("data:image/jpeg;base64,x");
    await wrapper.get('[data-test="ai-attachment-remove"]').trigger("click");

    expect(wrapper.emitted("remove")).toHaveLength(1);
  });
});
