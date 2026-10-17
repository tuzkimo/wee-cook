// 气泡只看 props：截图轮的缩略图从 message.image 回显，没有图就不渲染 <img>。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";

// 封面补下载要碰文件系统，缩略图是 dataUrl 直接能用，这里不需要真文件
vi.mock("@/services/syncFiles", () => ({ ensureLocalImages: vi.fn(async () => new Set<string>()) }));
vi.mock("@/services/imageStore", () => ({ imageSrc: (name: string) => `/img/${name}` }));

import ChatBubble from "@/components/ai/ChatBubble.vue";
import type { ChatMessage } from "@/stores/aiChat";

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

function bubble(image: string | null): VueWrapper {
  const message: ChatMessage = {
    id: "m1",
    role: "user",
    text: "这个怎么做",
    image,
    filter: null,
    items: [],
    matched: 0,
    unresolved: null,
  };
  const wrapper = mount(ChatBubble, { props: { message } });
  wrappers.push(wrapper);
  return wrapper;
}

describe("ChatBubble", () => {
  it("有 image 时渲染缩略图，没有时不渲染", () => {
    const withImage = bubble("data:image/jpeg;base64,x");
    const thumb = withImage.get('[data-test="ai-bubble-image"]');
    expect(thumb.attributes("src")).toBe("data:image/jpeg;base64,x");
    // 缩略图在文字上方
    expect(thumb.element.nextElementSibling?.getAttribute("data-test")).toBe("ai-bubble");

    expect(bubble(null).find('[data-test="ai-bubble-image"]').exists()).toBe(false);
  });
});
