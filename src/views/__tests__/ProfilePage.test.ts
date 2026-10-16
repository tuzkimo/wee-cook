import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent } from "vue";
import { clearTokens, type User } from "@/services/api";
import { writeRefreshToken } from "@/services/tokenStorage";
import ProfilePage from "@/views/ProfilePage.vue";

// 用真 store + fetch 替身：本条覆盖的是「本地暂存态 → 保存 body」这条链，
// 把 store mock 掉就测不到 avatarUrl 与 selectedAvatar 的「无改动」判定。
const mocks = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), push: vi.fn() }));

vi.mock("vue-router", () => ({ useRouter: () => ({ replace: mocks.replace, back: mocks.back, push: mocks.push }) }));

// happy-dom 解不了真图片（new Image() 拿不到 naturalWidth），裁剪器必须换成假按钮
vi.mock("@/components/AvatarCropper.vue", () => ({
  default: defineComponent({
    props: { file: { type: Object, required: true } },
    emits: ["confirm", "cancel", "error"],
    template: `<button data-test="fake-cropper" @click="$emit('confirm', 'data:image/jpeg;base64,NEW')">裁剪</button>`,
  }),
}));

const NOW = "2026-10-14T10:00:00.000Z";

const wrappers: VueWrapper[] = [];

function seedSetting(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => payload,
  } as unknown as Response;
}

/** 服务端替身：/auth/profile 回完整 User 并记下请求 body，其余（/auth/refresh）回 AuthResponse。 */
function stubProfileFetch(returns: Partial<User> = {}): { body: () => unknown } {
  let profileBody: unknown = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/auth/profile")) {
        profileBody = JSON.parse(String(init?.body));
        return Promise.resolve(
          response(200, {
            id: "u1",
            username: "alice",
            nickname: "阿丽",
            avatar_url: "🐱",
            created_at: NOW,
            updated_at: NOW,
            ...returns,
          }),
        );
      }
      return Promise.resolve(
        response(200, {
          user: { id: "u1", username: "alice", nickname: "阿丽", avatar_url: "🐱", created_at: NOW, updated_at: NOW },
          access_token: "a",
          refresh_token: "r",
        }),
      );
    }),
  );
  return { body: () => profileBody };
}

async function onlinePage(): Promise<VueWrapper> {
  seedSetting("server_url", "https://srv");
  seedSetting("server_user_id", "u1");
  await writeRefreshToken("u1", "refresh-1");
  const wrapper = mount(ProfilePage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** 给隐藏的 file input 塞一个文件（happy-dom 里只能用 defineProperty）。 */
async function pickFile(wrapper: VueWrapper): Promise<void> {
  const input = wrapper.get('[data-test="me-avatar-input"]');
  Object.defineProperty(input.element, "files", {
    value: [new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })],
  });
  await input.trigger("change");
}

beforeEach(async () => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  clearTokens();
  // clearTokens 的「删落盘 refresh token」是 fire-and-forget，等它落定再清 localStorage
  await new Promise((resolve) => setTimeout(resolve, 0));
  localStorage.clear();
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  vi.unstubAllGlobals();
});

describe("ProfilePage 资料编辑", () => {
  it("未登录进入 → 弹回登录页", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await onlinePage();

    expect(mocks.replace).toHaveBeenCalledWith("/me/login");
  });

  it("保存：昵称与裁剪结果一起提交，data URL 进 JSON body", async () => {
    const stub = stubProfileFetch();
    const wrapper = await onlinePage();

    await pickFile(wrapper);
    await wrapper.get('[data-test="fake-cropper"]').trigger("click");
    await wrapper.get('[data-test="me-nickname"]').setValue("阿丽");
    await wrapper.get('[data-test="me-save"]').trigger("click");
    await flushPromises();

    expect(stub.body()).toEqual({ nickname: "阿丽", avatar_url: "data:image/jpeg;base64,NEW" });
    expect(mocks.back).toHaveBeenCalled();
  });

  it("昵称纯空格 → 不提交并显示错误", async () => {
    const stub = stubProfileFetch();
    const wrapper = await onlinePage();

    await wrapper.get('[data-test="me-nickname"]').setValue("   ");
    await wrapper.get('[data-test="me-save"]').trigger("click");
    await flushPromises();

    expect(stub.body()).toBeNull();
    expect(wrapper.get('[data-test="me-error"]').text()).toBe("昵称不能为空");
  });

  it("粘贴超长昵称被截到 50 个码点", async () => {
    const stub = stubProfileFetch();
    const wrapper = await onlinePage();

    await wrapper.get('[data-test="me-nickname"]').setValue("汉".repeat(60));
    await wrapper.get('[data-test="me-save"]').trigger("click");
    await flushPromises();

    expect(Array.from((stub.body() as { nickname: string }).nickname).length).toBe(50);
  });

  it("点已选中的 emoji → 取消选择，保存发空串（不是 null）", async () => {
    const stub = stubProfileFetch(); // 存档头像就是 "🐱"，所以它开屏就是选中态
    const wrapper = await onlinePage();

    await wrapper.get('[data-test="me-emoji-🐱"]').trigger("click"); // 只点一次：取消选中
    await wrapper.get('[data-test="me-save"]').trigger("click");
    await flushPromises();

    expect(stub.body()).toEqual({ nickname: "阿丽", avatar_url: "" });
  });

  it("没有改动时保存按钮 disabled", async () => {
    stubProfileFetch();
    const wrapper = await onlinePage();

    expect(wrapper.get('[data-test="me-save"]').attributes("disabled")).toBeDefined();
  });
});
