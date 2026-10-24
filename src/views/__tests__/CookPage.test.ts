import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { useUnitStore } from "@/stores/ingredient";
import type { RefRow } from "@/stores/refStore";
import type { CookResult, RecipeDetail } from "@/types";
import type { WithUsage } from "@/types";
import CookPage from "@/views/CookPage.vue";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  keyboardInset: { value: 0 },
  routeParams: { id: "r1" } as Record<string, string>,
  getDetail: vi.fn(),
  fetchAll: vi.fn(async () => {}),
  commitCook: vi.fn(),
}));

vi.mock("@/composables/useKeyboardInset", () => ({
  useKeyboardInset: () => mocks.keyboardInset,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, back: mocks.back }),
  useRoute: () => ({ params: mocks.routeParams }),
}));

vi.mock("@/stores/recipe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/recipe")>();
  return { ...actual, useRecipeStore: () => ({ getDetail: mocks.getDetail }) };
});

/** 库存在本页是只读的：预填要的余量与扣减都从 store 拿，这里给可编程的桩 */
const availability = new Map<string, { unit_id: string | null; remaining: number }[]>();

vi.mock("@/stores/inventory", () => ({
  useInventoryStore: () => ({
    batches: [],
    fetchAll: mocks.fetchAll,
    addBatch: vi.fn(),
    removeBatch: vi.fn(),
    remainingByIngredient: () => availability,
    commitCook: mocks.commitCook,
  }),
}));

const NOW = "2026-10-24T00:00:00.000Z";

function unitRow(id: string, name: string): WithUsage<RefRow> {
  return { id, name, created_at: NOW, updated_at: NOW, deleted_at: null, usage_count: 0 };
}

function detail(): RecipeDetail {
  return {
    recipe: {
      id: "r1",
      name: "红烧肉",
      cover_path: null,
      category_id: "c1",
      is_public: 0,
      owner_nickname: null,
      owner_avatar_url: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      owner_id: null,
    },
    category: { id: "c1", name: "家常菜", kind: "category", created_at: NOW, updated_at: NOW, deleted_at: null },
    tags: [],
    steps: [],
    ingredients: [
      {
        id: "ri1",
        recipe_id: "r1",
        ingredient_id: "i1",
        amount: 2,
        unit_id: "ge",
        sort_order: 0,
        updated_at: NOW,
        deleted_at: null,
        ingredient_name: "五花肉",
        unit_name: "个",
      },
      {
        id: "ri2",
        recipe_id: "r1",
        ingredient_id: "i2",
        amount: null,
        unit_id: null,
        sort_order: 1,
        updated_at: NOW,
        deleted_at: null,
        ingredient_name: "盐",
        unit_name: null,
      },
    ],
  };
}

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  availability.clear();
  const units = useUnitStore();
  // 真路径：页面必须自己 fetchAll 才有单位名（不靠测试预先塞 items）
  vi.spyOn(units, "fetchAll").mockImplementation(async () => {
    units.items = [unitRow("g", "g"), unitRow("ge", "个"), unitRow("jin", "斤")];
  });
  mocks.getDetail.mockResolvedValue(detail());
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  document.body.innerHTML = "";
});

async function open(): Promise<VueWrapper> {
  const wrapper = mount(CookPage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

function rows(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('[data-test="cook-row"]');
}

function rowOf(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
  const found = rows(wrapper).find(
    (row) => row.find('[data-test="cook-name"]').text() === name,
  );
  if (!found) throw new Error(`找不到行：${name}`);
  return found;
}

function amountOf(wrapper: VueWrapper, name: string): string {
  return (rowOf(wrapper, name).get('[data-test="cook-amount"]').element as HTMLInputElement).value;
}

function unitTextOf(wrapper: VueWrapper, name: string): string {
  return rowOf(wrapper, name).get('[data-test="cook-unit"]').text();
}

function availableOf(wrapper: VueWrapper, name: string): string {
  return rowOf(wrapper, name).get('[data-test="cook-available"]').text();
}

describe("CookPage 预填", () => {
  it("按菜谱用量与单位预填；适量（无数量）的行留空", async () => {
    availability.set("i1", [{ unit_id: "ge", remaining: 5 }]);
    const wrapper = await open();

    expect(rows(wrapper)).toHaveLength(2);
    expect(amountOf(wrapper, "五花肉")).toBe("2");
    expect(unitTextOf(wrapper, "五花肉")).toContain("个");
    expect(amountOf(wrapper, "盐")).toBe("");
  });

  it("菜谱单位没库存而别的单位有货时，预填切到有库存的单位", async () => {
    availability.set("i1", [{ unit_id: "g", remaining: 500 }]);
    const wrapper = await open();

    expect(unitTextOf(wrapper, "五花肉")).toContain("g");
    expect(availableOf(wrapper, "五花肉")).toBe("库存 500 g");
  });

  it("菜谱单位有货就用它，哪怕别的单位余量更多", async () => {
    availability.set("i1", [
      { unit_id: "ge", remaining: 3 },
      { unit_id: "jin", remaining: 600 },
    ]);

    const wrapper = await open();

    expect(unitTextOf(wrapper, "五花肉")).toContain("个");
  });

  it("菜谱单位没货、多个单位有货时选余量最大的", async () => {
    availability.set("i1", [
      { unit_id: "g", remaining: 100 },
      { unit_id: "jin", remaining: 600 },
    ]);

    const wrapper = await open();

    expect(unitTextOf(wrapper, "五花肉")).toContain("斤");
    expect(availableOf(wrapper, "五花肉")).toBe("库存 600 斤");
  });

  it("没有库存的行显示「库存 0」", async () => {
    const wrapper = await open();

    expect(availableOf(wrapper, "五花肉")).toBe("库存 0 个");
  });
});

describe("CookPage 确认", () => {
  it("全部行留空或填 0 时确认按钮不可点", async () => {
    availability.set("i1", [{ unit_id: "ge", remaining: 5 }]);
    const wrapper = await open();

    await rowOf(wrapper, "五花肉").get('[data-test="cook-amount"]').setValue("0");

    expect(wrapper.get('[data-test="cook-confirm"]').attributes("disabled")).toBeDefined();
    expect(mocks.commitCook).not.toHaveBeenCalled();
  });

  it("数量填 0 的行不进入提交的行", async () => {
    availability.set("i1", [{ unit_id: "ge", remaining: 5 }]);
    mocks.commitCook.mockResolvedValue({ deducted: [], shortfall: [] });
    const wrapper = await open();
    await rowOf(wrapper, "五花肉").get('[data-test="cook-amount"]').setValue("0");
    await rowOf(wrapper, "盐").get('[data-test="cook-amount"]').setValue("3");

    await wrapper.get('[data-test="cook-confirm"]').trigger("click");
    await flushPromises();

    expect(mocks.commitCook).toHaveBeenCalledWith("r1", [
      { ingredient_id: "i2", ingredient_name: "盐", unit_id: null, unit_name: null, amount: 3 },
    ]);
  });

  it("确认后原地进结果态：显示扣减与差额，输入与确认按钮消失", async () => {
    availability.set("i1", [{ unit_id: "ge", remaining: 5 }]);
    const result: CookResult = {
      deducted: [{ ingredient_name: "五花肉", unit_name: "个", amount: 2 }],
      shortfall: [{ ingredient_name: "盐", unit_name: null, missing: 3 }],
    };
    mocks.commitCook.mockResolvedValue(result);
    const wrapper = await open();
    await rowOf(wrapper, "盐").get('[data-test="cook-amount"]').setValue("3");

    await wrapper.get('[data-test="cook-confirm"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("已记录");
    expect(wrapper.get('[data-test="cook-deducted"]').text()).toContain("五花肉");
    expect(wrapper.get('[data-test="cook-deducted"]').text()).toContain("2 个");
    expect(wrapper.get('[data-test="cook-shortfall"]').text()).toContain("还差 3");
    expect(wrapper.find('[data-test="cook-amount"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="cook-confirm"]').exists()).toBe(false);
  });

  it("库存不足的行在确认前就有提示", async () => {
    availability.set("i1", [{ unit_id: "ge", remaining: 1 }]);
    const wrapper = await open();

    expect(wrapper.find('[data-test="cook-shortfall-hint"]').exists()).toBe(true);
  });

  it("结果态点「完成」返回上一页", async () => {
    availability.set("i1", [{ unit_id: "ge", remaining: 5 }]);
    mocks.commitCook.mockResolvedValue({ deducted: [], shortfall: [] });
    const wrapper = await open();

    await wrapper.get('[data-test="cook-confirm"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-test="cook-done"]').trigger("click");

    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it("提交失败时留在表单并显示错误", async () => {
    availability.set("i1", [{ unit_id: "ge", remaining: 5 }]);
    mocks.commitCook.mockRejectedValue(new Error("数据库忙"));
    const wrapper = await open();

    await wrapper.get('[data-test="cook-confirm"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("数据库忙");
    expect(wrapper.find('[data-test="cook-confirm"]').exists()).toBe(true);
  });
});

describe("CookPage 改单位", () => {
  it("点行内单位打开选择器，选中后该行单位与库存跟着变", async () => {
    availability.set("i1", [
      { unit_id: "ge", remaining: 2 },
      { unit_id: "g", remaining: 500 },
    ]);
    const wrapper = await open();
    expect(availableOf(wrapper, "五花肉")).toBe("库存 2 个");

    await rowOf(wrapper, "五花肉").get('[data-test="cook-unit"]').trigger("click");
    await flushPromises();
    const gram = [...document.body.querySelectorAll<HTMLElement>('[data-test="ref-row"]')].find(
      (rowEl) => rowEl.textContent?.trim() === "g",
    );
    await new DOMWrapper(gram!).trigger("click");
    await flushPromises();

    expect(unitTextOf(wrapper, "五花肉")).toContain("g");
    expect(availableOf(wrapper, "五花肉")).toBe("库存 500 g");
  });
});

describe("CookPage 健壮性", () => {
  it("进页面自己把单位字典查回来", async () => {
    availability.set("i1", [{ unit_id: "g", remaining: 500 }]);

    await open();

    expect(useUnitStore().fetchAll).toHaveBeenCalledTimes(1);
  });

  it("同一食材在菜谱里出现两行时，两行各自独立可改", async () => {
    const duplicated = detail();
    duplicated.ingredients = [duplicated.ingredients[0], { ...duplicated.ingredients[0], id: "ri3" }];
    mocks.getDetail.mockResolvedValue(duplicated);
    availability.set("i1", [{ unit_id: "ge", remaining: 5 }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = await open();

    const inputs = wrapper.findAll('[data-test="cook-amount"]');
    await inputs[0].setValue("5");

    expect((inputs[0].element as HTMLInputElement).value).toBe("5");
    expect((inputs[1].element as HTMLInputElement).value).toBe("2");
    // 重复的 key 会让 Vue 警告并在重排时把值放错行
    expect(warn.mock.calls.flat().join(" ")).not.toContain("Duplicate keys");
    warn.mockRestore();
  });

  it("菜谱取不到时给错误提示，不是空白页", async () => {
    mocks.getDetail.mockRejectedValue(new Error("菜谱不存在"));

    const wrapper = await open();

    expect(wrapper.get('[data-test="cook-load-error"]').text()).toContain("菜谱不存在");
  });

  it("软键盘弹起时确认按钮栏被顶起来", async () => {
    availability.set("i1", [{ unit_id: "ge", remaining: 5 }]);
    mocks.keyboardInset.value = 300;
    const wrapper = await open();

    const bar = wrapper.get('[data-test="cook-actions"]').element as HTMLElement;
    expect(bar.style.paddingBottom).toContain("300px");
    mocks.keyboardInset.value = 0;
  });
});
