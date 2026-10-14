import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { clearTokens } from "@/services/api";
import { writeRefreshToken } from "@/services/tokenStorage";
import MePage from "@/views/MePage.vue";

// 用**真** store（而不是 mock）：本条覆盖的是 restoreSession 与 MePage 的三态联动，
// 把 store mock 掉就测不到「只配了地址 → baseUrl 就绪」这条关键回归。
const mocks = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push, back: mocks.back }) }));

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

async function page(): Promise<VueWrapper> {
  const wrapper = mount(MePage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("MePage 多设备同步入口", () => {
  it("未配地址：显示「未开启」，点进配置页，且不发任何请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = await page();

    expect(wrapper.get('[data-test="server-state"]').text()).toBe("未开启");
    await wrapper.get('[data-test="server-row"]').trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/me/server");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("只配了地址还没登录：显示「未登录」，点进登录页，且不发任何请求", async () => {
    seedSetting("server_url", "https://srv");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = await page();

    expect(wrapper.get('[data-test="server-state"]').text()).toBe("未登录");
    await wrapper.get('[data-test="server-row"]').trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/me/login");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("已登录：显示昵称与上次同步时间", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    await writeRefreshToken("u1", "refresh-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response(200, {
            user: {
              id: "u1",
              username: "alice",
              nickname: "阿丽",
              avatar_url: null,
              created_at: NOW,
              updated_at: NOW,
            },
            access_token: "access-new",
            refresh_token: "refresh-new",
          }),
        ),
      ),
    );

    const wrapper = await page();

    expect(wrapper.get('[data-test="server-state"]').text()).toBe("已开启");
    expect(wrapper.get('[data-test="nickname"]').text()).toBe("阿丽");
    expect(wrapper.get('[data-test="last-sync"]').text()).toBe("还没同步过");
  });
});

describe("MePage 我的家庭入口", () => {
  it("未配地址：只显示「先开启多设备同步」，没有可点的家庭入口，也不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = await page();

    expect(wrapper.get('[data-test="team-state"]').text()).toBe("先开启多设备同步");
    expect(wrapper.find('button[data-test="team-row"]').exists()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("已登录：渲染「我的家庭」入口，点击跳 /me/team", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    await writeRefreshToken("u1", "refresh-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response(200, {
            user: {
              id: "u1",
              username: "alice",
              nickname: "阿丽",
              avatar_url: null,
              created_at: NOW,
              updated_at: NOW,
            },
            access_token: "access-new",
            refresh_token: "refresh-new",
          }),
        ),
      ),
    );

    const wrapper = await page();

    const row = wrapper.get('button[data-test="team-row"]');
    expect(row.text()).toContain("我的家庭");
    await row.trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/me/team");
  });
});
