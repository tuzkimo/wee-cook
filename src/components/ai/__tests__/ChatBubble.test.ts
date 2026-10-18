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

function bubble(image: string | null, text = "这个怎么做"): VueWrapper {
  const message: ChatMessage = {
    ...reply(),
    role: "user",
    text,
    image,
  };
  const wrapper = mount(ChatBubble, { props: { message } });
  wrappers.push(wrapper);
  return wrapper;
}

/** AI 回复轮：无图、无检索结果 */
function reply(): ChatMessage {
  return {
    id: "m2",
    role: "assistant",
    text: "库里没找到",
    image: null,
    filter: null,
    items: [],
    matched: 0,
    unresolved: null,
  };
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

  it("纯图轮（没打字）：只渲染缩略图，不出一个空的彩色气泡", () => {
    const wrapper = bubble("data:image/jpeg;base64,x", "");

    expect(wrapper.find('[data-test="ai-bubble-image"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="ai-bubble"]').exists()).toBe(false);
  });

  it("AI 回复按 markdown 渲染，不把 ** 原样显示出来", () => {
    const wrapper = mount(ChatBubble, {
      props: { message: { ...reply(), text: "库里**没有**这道菜" } },
    });
    wrappers.push(wrapper);

    const el = wrapper.get('[data-test="ai-bubble"]');
    expect(el.find("strong").text()).toBe("没有");
    expect(el.text()).not.toContain("**");
  });

  it("用户自己打的星号不被当成标记", () => {
    const wrapper = bubble(null, "**这个是重点吗**");

    expect(wrapper.get('[data-test="ai-bubble"]').find("strong").exists()).toBe(false);
    expect(wrapper.get('[data-test="ai-bubble"]').text()).toBe("**这个是重点吗**");
  });
});
