import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { clearTokens } from "@/services/api";
import { writeRefreshToken } from "@/services/tokenStorage";
import { useAuthStore } from "@/stores/auth";
import MePage from "@/views/MePage.vue";

// 用**真** store（而不是 mock）：本条覆盖的是 restoreSession 与 MePage 的三态联动，
// 把 store mock 掉就测不到「只配了地址 → baseUrl 就绪」这条关键回归。
const mocks = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
const syncMock = vi.hoisted(() => ({ requestSyncNow: vi.fn() }));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push, back: mocks.back }) }));

// 只把手动同步入口换成 spy，其余用真身；syncInFlight 换成测试自有的 ref，
// 这样「在途置灰」不依赖真同步逻辑的时序。
vi.mock("@/services/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/sync")>();
  const { ref } = await import("vue");
  return { ...actual, requestSyncNow: syncMock.requestSyncNow, syncInFlight: ref(false) };
});

import { syncInFlight } from "@/services/sync";

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
  syncInFlight.value = false;
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

    expect(wrapper.find('[data-test="me-sync-card"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="server-state"]').text()).toBe("已开启");
    expect(wrapper.get('[data-test="nickname"]').text()).toBe("阿丽");
    expect(wrapper.get('[data-test="last-sync"]').text()).toBe("还没同步过");
  });
});

describe("MePage 同步卡", () => {
  async function loggedInPage(): Promise<VueWrapper> {
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
    return page();
  }

  it("点同步卡触发一次手动同步", async () => {
    const wrapper = await loggedInPage();

    await wrapper.get('[data-test="me-sync-card"]').trigger("click");

    expect(syncMock.requestSyncNow).toHaveBeenCalledTimes(1);
  });

  it("同步在途时显示「同步中…」且整块 disabled", async () => {
    const wrapper = await loggedInPage();
    expect(wrapper.find('[data-test="syncing"]').exists()).toBe(false);

    syncInFlight.value = true;
    await flushPromises();

    expect(wrapper.get('[data-test="syncing"]').text()).toContain("同步中");
    expect(wrapper.get('[data-test="me-sync-card"]').attributes("disabled")).toBeDefined();
  });

  it("同步失败且不在途时显示「上次同步没成功」，不显示「同步中」（F5）", async () => {
    const wrapper = await loggedInPage();
    useAuthStore().lastSyncFailed = true;
    await flushPromises();

    expect(wrapper.get('[data-test="sync-failed"]').text()).toContain("上次同步没成功");
    expect(wrapper.find('[data-test="syncing"]').exists()).toBe(false);
  });

  it("空闲时显示「点一下立刻同步」的可点提示", async () => {
    const wrapper = await loggedInPage();

    expect(wrapper.get('[data-test="sync-hint"]').text()).toContain("点一下立刻同步");
    expect(wrapper.get('[data-test="me-sync-card"]').attributes("disabled")).toBeUndefined();
  });
});

describe("MePage 用户卡", () => {
  it("未配置服务器：显示「未登录」，点击进登录页", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const wrapper = await page();

    expect(wrapper.get('[data-test="me-user-name"]').text()).toBe("未登录");
    await wrapper.get('[data-test="me-user-card"]').trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/me/login");
  });

  it("离线但有存档昵称：显示存档昵称与头像，副标题写明离线", async () => {
    seedSetting("server_url", "https://srv");
    seedSetting("server_user_id", "u1");
    seedSetting("server_nickname", "阿丽");
    seedSetting("server_avatar_url", "🐱");
    await writeRefreshToken("u1", "refresh-1");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));

    const wrapper = await page();

    expect(wrapper.get('[data-test="me-user-name"]').text()).toBe("阿丽");
    expect(wrapper.get('[data-test="me-user-card"]').text()).toContain("🐱");
    expect(wrapper.get('[data-test="me-user-status"]').text()).toBe("离线使用中，连上网络后自动恢复");
  });

  it("已登录：显示昵称，点击进资料页", async () => {
    // 已登录的 seed 照本文件第三条用例
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

    expect(wrapper.get('[data-test="me-user-name"]').text()).toBe("阿丽");
    await wrapper.get('[data-test="me-user-card"]').trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/me/profile");
  });

  it("退登后用户卡回到「未登录」，不再显示存档昵称", async () => {
    // 已登录 + 点 me-user-card 之外的方式触发退登：seed 之后手动 await useAuthStore().logout() 再挂载
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
    await useAuthStore().logout();

    const wrapper = await page();

    expect(wrapper.get('[data-test="me-user-name"]').text()).toBe("未登录");
  });
});
