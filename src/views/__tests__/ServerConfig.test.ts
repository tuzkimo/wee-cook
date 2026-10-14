import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({ back: vi.fn(), fetchWithTimeout: vi.fn() }));

vi.mock("vue-router", () => ({ useRouter: () => ({ back: mocks.back }) }));
vi.mock("@/services/api", () => ({ fetchWithTimeout: mocks.fetchWithTimeout }));

import ServerConfig from "@/views/ServerConfig.vue";

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
});

async function page(): Promise<VueWrapper> {
  const wrapper = mount(ServerConfig);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

function storedUrl(): unknown {
  const raw = localStorage.getItem("server_url");
  return raw === null ? undefined : JSON.parse(raw);
}

describe("ServerConfig", () => {
  it("默认填 https://，有已保存地址时填已保存的", async () => {
    expect(
      (await page()).get('[data-test="server-url-input"]').element as HTMLInputElement,
    ).toHaveProperty("value", "https://");

    localStorage.setItem("server_url", JSON.stringify("http://localhost:8080"));
    expect(
      ((await page()).get('[data-test="server-url-input"]').element as HTMLInputElement).value,
    ).toBe("http://localhost:8080");
  });

  it("测试连接成功：打 healthz、去掉末尾斜杠、地址存 settings", async () => {
    mocks.fetchWithTimeout.mockResolvedValue({ ok: true, status: 200 });
    const wrapper = await page();
    await wrapper.get('[data-test="server-url-input"]').setValue("http://localhost:8080//");

    await wrapper.get('[data-test="test"]').trigger("click");
    await flushPromises();

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith("http://localhost:8080/api/v1/healthz");
    expect(storedUrl()).toBe("http://localhost:8080");
    expect(wrapper.get('[data-test="server-message"]').text()).toContain("连接成功");
  });

  it("连不上时不保存地址", async () => {
    mocks.fetchWithTimeout.mockRejectedValue(new Error("NetworkError"));
    const wrapper = await page();
    await wrapper.get('[data-test="server-url-input"]').setValue("http://localhost:9999");

    await wrapper.get('[data-test="test"]').trigger("click");
    await flushPromises();

    expect(storedUrl()).toBeUndefined();
    expect(wrapper.get('[data-test="server-message"]').text()).toContain(
      "连不上服务器，检查地址和网络",
    );
  });
});
