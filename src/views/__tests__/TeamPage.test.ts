import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import * as api from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import TeamPage from "@/views/TeamPage.vue";

const mocks = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push, back: mocks.back }) }));

const NOW = "2026-10-14T10:00:00.000Z";

function res(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => payload,
  } as unknown as Response;
}

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  localStorage.clear();
  api.clearTokens();
  api.setBaseUrl("https://srv");
  useAuthStore().serverUser = {
    id: "u1",
    username: "alice",
    nickname: "阿丽",
    avatar_url: null,
    created_at: NOW,
    updated_at: NOW,
  };
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  vi.unstubAllGlobals();
});

async function page(): Promise<VueWrapper> {
  const wrapper = mount(TeamPage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("TeamPage", () => {
  it("渲染团队名与成员数", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          res(200, [
            { id: "t1", name: "一家人", created_by: "u1", member_count: 3 },
            { id: "t2", name: "亲家", created_by: "u9", member_count: 1 },
          ]),
        ),
      ),
    );

    const wrapper = await page();

    const rows = wrapper.findAll('[data-test="team-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("一家人");
    expect(rows[0].text()).toContain("3 人");
    expect(rows[1].text()).toContain("亲家");
  });

  it("点团队进成员页，创建入口新建后跳成员页", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/v1/teams") && init?.method === "POST") {
        return Promise.resolve(res(201, { team: { id: "t9", name: "新家", created_by: "u1", member_count: 1 } }));
      }
      return Promise.resolve(res(200, [{ id: "t1", name: "一家人", created_by: "u1", member_count: 3 }]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = await page();
    await wrapper.get('[data-test="team-row"]').trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/me/team/t1");

    await wrapper.get('[data-test="team-name"]').setValue("新家");
    await wrapper.get('[data-test="create"]').trigger("click");
    await flushPromises();

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({ name: "新家" });
    expect(mocks.push).toHaveBeenCalledWith("/me/team/t9");
  });
});
