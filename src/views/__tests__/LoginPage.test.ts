import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import LoginPage from "@/views/LoginPage.vue";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  login: vi.fn(async () => {}),
  register: vi.fn(async () => {}),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, back: mocks.back }),
}));

// 页面只测「拿到 store 怎么画、点了往哪跳、错误怎么显示」；错误文案的分类在 auth.test.ts。
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ login: mocks.login, register: mocks.register }),
}));

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.login.mockResolvedValue(undefined);
  mocks.register.mockResolvedValue(undefined);
  localStorage.clear();
  localStorage.setItem("server_url", JSON.stringify("https://srv"));
  localStorage.setItem("server_username", JSON.stringify("alice"));
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

async function page(): Promise<VueWrapper> {
  const wrapper = mount(LoginPage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

function inputValue(wrapper: VueWrapper, selector: string): string {
  return (wrapper.get(selector).element as HTMLInputElement).value;
}

describe("LoginPage", () => {
  it("从设置里带出服务器地址与上次的用户名", async () => {
    const wrapper = await page();

    expect(wrapper.get('[data-test="server-url"]').text()).toBe("https://srv");
    expect(inputValue(wrapper, '[data-test="username"]')).toBe("alice");
  });

  it("登录成功后调 store.login 并回到我的页", async () => {
    const wrapper = await page();
    await wrapper.get('[data-test="password"]').setValue("pw");

    await wrapper.get('[data-test="login"]').trigger("click");
    await flushPromises();

    expect(mocks.login).toHaveBeenCalledWith("https://srv", "alice", "pw");
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith("/me");
  });

  it("注册把用户名当昵称传给 store.register", async () => {
    const wrapper = await page();
    await wrapper.get('[data-test="password"]').setValue("pw");

    await wrapper.get('[data-test="register"]').trigger("click");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalledWith("https://srv", "alice", "pw", "alice");
    expect(mocks.push).toHaveBeenCalledWith("/me");
  });

  it.each([
    ["账号或密码不对"],
    ["连不上服务器，检查地址和网络"],
  ])("登录失败显示中文提示：%s", async (message) => {
    mocks.login.mockRejectedValueOnce(new Error(message));
    const wrapper = await page();
    await wrapper.get('[data-test="password"]').setValue("pw");

    await wrapper.get('[data-test="login"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="form-error"]').text()).toBe(message);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("注册重名时显示「用户名已被占用」", async () => {
    mocks.register.mockRejectedValueOnce(new Error("用户名已被占用"));
    const wrapper = await page();
    await wrapper.get('[data-test="password"]').setValue("pw");

    await wrapper.get('[data-test="register"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="form-error"]').text()).toBe("用户名已被占用");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("用户名或密码为空时不发请求", async () => {
    const wrapper = await page();
    await wrapper.get('[data-test="username"]').setValue("");

    await wrapper.get('[data-test="login"]').trigger("click");
    await flushPromises();

    expect(mocks.login).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="form-error"]').text()).toContain("请输入用户名和密码");
  });

  it("未配置服务器地址时提示先去配置，不发请求", async () => {
    localStorage.clear();
    const wrapper = await page();
    await wrapper.get('[data-test="username"]').setValue("alice");
    await wrapper.get('[data-test="password"]').setValue("pw");

    await wrapper.get('[data-test="login"]').trigger("click");
    await flushPromises();

    expect(mocks.login).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="form-error"]').text()).toContain("请先配置服务器地址");
  });

  it("点服务器那一行去配置页", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="server-row"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/me/server");
  });
});
