import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CookRecordDetail } from "@/types";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  routeParams: { id: "r1" } as Record<string, string>,
  fetchCookRecords: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, back: mocks.back }),
  useRoute: () => ({ params: mocks.routeParams }),
}));

vi.mock("@/stores/inventory", () => ({
  useInventoryStore: () => ({ fetchCookRecords: mocks.fetchCookRecords }),
}));

import CookRecords from "@/views/CookRecords.vue";

/** 本地时区 YYYY-MM-DD HH:mm，与页面独立实现（不调被测函数） */
function local(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function record(over: Partial<CookRecordDetail> & { id: string }): CookRecordDetail {
  const { id, ...rest } = over;
  return {
    record: {
      id,
      scope_id: "p:local",
      owner_id: null,
      recipe_id: "r1",
      owner_nickname: null,
      owner_avatar_url: null,
      created_at: "2026-11-01T10:00:00.000Z",
      updated_at: "2026-11-01T10:00:00.000Z",
      deleted_at: null,
    },
    author: { name: "我", avatar_url: null },
    recipe_name: "红烧肉",
    lines: [{ ingredient_name: "鸡蛋", unit_name: null, amount: 2 }],
    ...rest,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.routeParams = { id: "r1" };
});

describe("CookRecords", () => {
  it("没有记录时显示空态", async () => {
    mocks.fetchCookRecords.mockResolvedValue([]);

    const wrapper = mount(CookRecords);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wrapper.get('[data-test="cook-records-empty"]').text()).toContain("还没有制作记录");
    expect(mocks.fetchCookRecords).toHaveBeenCalledWith("r1");
  });

  it("按记录渲染时间、作者与扣减项数", async () => {
    mocks.fetchCookRecords.mockResolvedValue([
      record({
        id: "cr2",
        record: { ...record({ id: "cr2" }).record, created_at: "2026-11-01T18:20:00.000Z" },
        author: { name: "老王", avatar_url: null },
        lines: [
          { ingredient_name: "鸡蛋", unit_name: null, amount: 2 },
          { ingredient_name: "面粉", unit_name: "g", amount: 10 },
        ],
      }),
      record({ id: "cr1" }),
    ]);

    const wrapper = mount(CookRecords);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = wrapper.findAll('[data-test="cook-record"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("老王");
    expect(rows[0].text()).toContain(local("2026-11-01T18:20:00.000Z"));
    expect(rows[0].text()).toContain("扣了 2 项食材");
    expect(rows[1].text()).toContain("扣了 1 项食材");
  });

  it("明细为空时显示「没有扣库存」", async () => {
    mocks.fetchCookRecords.mockResolvedValue([record({ id: "cr1", lines: [] })]);

    const wrapper = mount(CookRecords);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wrapper.get('[data-test="cook-record"]').text()).toContain("没有扣库存");
  });

  it("点加号进制作表单", async () => {
    mocks.fetchCookRecords.mockResolvedValue([]);

    const wrapper = mount(CookRecords);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.get('[data-test="cook-record-add"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/recipe/r1/cook/new");
  });

  it("点一行进制作详情", async () => {
    mocks.fetchCookRecords.mockResolvedValue([record({ id: "cr1" }), record({ id: "cr2" })]);

    const wrapper = mount(CookRecords);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.findAll('[data-test="cook-record"]')[0].trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/recipe/r1/cook/cr1");
  });
});
