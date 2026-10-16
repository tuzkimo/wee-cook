import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import IngredientSheet from "@/components/IngredientSheet.vue";
import { useIngredientStore, useUnitStore } from "@/stores/ingredient";
import type { RefRow } from "@/stores/refStore";
import type { WithUsage } from "@/types";

type Row = WithUsage<RefRow>;

const NOW = "2026-10-13T00:00:00.000Z";

function row(id: string, name: string, usageCount = 0): Row {
  return {
    id,
    name,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    usage_count: usageCount,
  };
}

const wrappers: VueWrapper[] = [];

/**
 * 组件内部直接调 useIngredientStore / useUnitStore，所以测试给它们一个真的
 * Pinia 实例并把 items 塞好（真 store 已被 Task 2 覆盖，这里只关心组件行为）。
 * DB 在 import 时不碰，只有真的调 add/remove 才会 getDb，所以用 spy 顶上。
 */
let ingredients: ReturnType<typeof useIngredientStore>;
let units: ReturnType<typeof useUnitStore>;

beforeEach(() => {
  setActivePinia(createPinia());
  ingredients = useIngredientStore();
  units = useUnitStore();
  vi.spyOn(ingredients, "fetchAll").mockResolvedValue();
  vi.spyOn(units, "fetchAll").mockResolvedValue();
  ingredients.items = [row("i1", "鸡蛋", 5), row("i2", "盐", 0)];
  units.items = [row("u1", "克", 3), row("u2", "个", 1)];
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function openSheet(): VueWrapper {
  const wrapper = mount(IngredientSheet, { props: { visible: true } });
  wrappers.push(wrapper);
  return wrapper;
}

/** 组件 Teleport 到 body，所以一律查 document.body。 */
function el(selector: string): DOMWrapper<Element> {
  const found = document.body.querySelector(selector);
  if (!found) throw new Error(`找不到元素：${selector}`);
  return new DOMWrapper(found);
}

function has(selector: string): boolean {
  return document.body.querySelector(selector) !== null;
}

function rowElements(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[data-test="ref-row"]')];
}

function rowName(rowEl: HTMLElement): string {
  return rowEl.querySelector('[data-test="ref-name"]')?.textContent?.trim() ?? "";
}

function names(): string[] {
  return rowElements().map(rowName);
}

function rowByName(name: string): DOMWrapper<Element> {
  const found = rowElements().find((rowEl) => rowName(rowEl) === name);
  if (!found) throw new Error(`找不到行：${name}`);
  return new DOMWrapper(found);
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

/** 第一步选食材，等它切到第二步。 */
async function pickIngredient(name: string): Promise<void> {
  await rowByName(name).trigger("click");
  await flushPromises();
}

/** 第二步点开单位 sheet 并选一个单位。 */
async function pickUnit(name: string): Promise<void> {
  await el('[data-test="ingredient-unit"]').trigger("click");
  await flushPromises();
  await rowByName(name).trigger("click");
  await flushPromises();
}

describe("IngredientSheet", () => {
  it("第一步列出食材（按使用次数倒序）并带筛选框", async () => {
    openSheet();
    await flushPromises();

    // 顺序只由 store 的 ORDER BY usage_count DESC 决定，组件不重排
    expect(names()).toEqual(["鸡蛋", "盐"]);
    expect(ingredients.fetchAll).toHaveBeenCalledTimes(1);
    // 单位 sheet 还没打开，不该去查单位
    expect(units.fetchAll).not.toHaveBeenCalled();

    await el('[data-test="ref-filter"]').setValue("鸡");
    expect(names()).toEqual(["鸡蛋"]);
  });

  it("选中食材后进第二步，显示食材名、数量输入框、单位选择行", async () => {
    const wrapper = openSheet();
    await flushPromises();

    await pickIngredient("鸡蛋");

    // 第一步的列表收起来，第二步才出现
    expect(has('[data-test="ref-row"]')).toBe(false);
    expect(bodyText()).toContain("鸡蛋");
    expect(has('[data-test="ingredient-amount"]')).toBe(true);
    expect(has('[data-test="ingredient-unit"]')).toBe(true);
    // 还没点确定，什么都不发
    expect(wrapper.emitted("add")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("第二步选单位打开单位 sheet，选中后回填单位名", async () => {
    openSheet();
    await flushPromises();
    await pickIngredient("鸡蛋");

    await el('[data-test="ingredient-unit"]').trigger("click");
    await flushPromises();

    expect(names()).toEqual(["克", "个"]);
    expect(units.fetchAll).toHaveBeenCalledTimes(1);

    await rowByName("个").trigger("click");
    await flushPromises();

    // 单位 sheet 关掉，回到第二步，单位名填在行上
    expect(has('[data-test="ref-row"]')).toBe(false);
    expect(el('[data-test="ingredient-unit"]').text()).toContain("个");
    expect(has('[data-test="ingredient-amount"]')).toBe(true);
  });

  it("数量留空 + 单位留空 → emit payload { amount: null, unit_id: null }", async () => {
    const wrapper = openSheet();
    await flushPromises();
    await pickIngredient("鸡蛋");

    await el('[data-test="ingredient-confirm"]').trigger("click");
    await flushPromises();

    expect(wrapper.emitted("add")).toEqual([
      [{ ingredient_id: "i1", amount: null, unit_id: null }],
    ]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("数量填 0 或负数 → 显示错误且不 emit", async () => {
    const wrapper = openSheet();
    await flushPromises();
    await pickIngredient("鸡蛋");

    await el('[data-test="ingredient-amount"]').setValue("0");
    await el('[data-test="ingredient-confirm"]').trigger("click");
    await flushPromises();

    expect(has('[data-test="ingredient-amount-error"]')).toBe(true);
    expect(el('[data-test="ingredient-amount-error"]').text()).not.toBe("");
    expect(wrapper.emitted("add")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();
    // 还在第二步，用户可以改
    expect(has('[data-test="ingredient-amount"]')).toBe(true);

    await el('[data-test="ingredient-amount"]').setValue("-3");
    await el('[data-test="ingredient-confirm"]').trigger("click");
    await flushPromises();

    expect(wrapper.emitted("add")).toBeUndefined();
  });

  it("数量填非数字（输入框被粘进 'abc'）→ 视为空", async () => {
    const wrapper = openSheet();
    await flushPromises();
    await pickIngredient("鸡蛋");

    await el('[data-test="ingredient-amount"]').setValue("abc");
    // number 输入框会把非数字清成空串（happy-dom 与真浏览器一致）；
    // 真有多余字符漏进来时 parseAmount 的 NaN 分支兜底，同样当空
    expect((el('[data-test="ingredient-amount"]').element as HTMLInputElement).value).toBe("");
    await el('[data-test="ingredient-confirm"]').trigger("click");
    await flushPromises();

    expect(wrapper.emitted("add")).toEqual([
      [{ ingredient_id: "i1", amount: null, unit_id: null }],
    ]);
  });

  it("数量填 2、单位选「个」→ payload { amount: 2, unit_id: <个的id> }", async () => {
    const wrapper = openSheet();
    await flushPromises();
    await pickIngredient("鸡蛋");
    await pickUnit("个");

    await el('[data-test="ingredient-amount"]').setValue("2");
    await el('[data-test="ingredient-confirm"]').trigger("click");
    await flushPromises();

    expect(wrapper.emitted("add")).toEqual([
      [{ ingredient_id: "i1", amount: 2, unit_id: "u2" }],
    ]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("在这一层新建食材后自动选中它并进入第二步", async () => {
    vi.spyOn(ingredients, "add").mockImplementation(async (name: string) => {
      const created = row("i-new", name, 0);
      ingredients.items = [...ingredients.items, created];
      return created;
    });
    openSheet();
    await flushPromises();

    await el('[data-test="ref-filter"]').setValue("酱油");
    await el('[data-test="ref-create"]').trigger("click");
    await flushPromises();

    // RefSheet 单选模式建完即发 select，这一层据此直接进第二步
    expect(has('[data-test="ingredient-amount"]')).toBe(true);
    expect(has('[data-test="ref-form-name"]')).toBe(false);
    expect(bodyText()).toContain("酱油");

    await el('[data-test="ingredient-confirm"]').trigger("click");
    await flushPromises();
    expect(ingredients.items.map((item) => item.name)).toContain("酱油");
  });

  it("关闭时重置到第一步", async () => {
    const wrapper = openSheet();
    await flushPromises();
    await pickIngredient("鸡蛋");
    await pickUnit("个");
    await el('[data-test="ingredient-amount"]').setValue("2");

    await el('[data-test="ingredient-close"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);

    await wrapper.setProps({ visible: false });
    await wrapper.setProps({ visible: true });
    await flushPromises();

    // 回到第一步，列表重新可见
    expect(has('[data-test="ref-row"]')).toBe(true);
    expect(has('[data-test="ingredient-amount"]')).toBe(false);

    // 第二步的临时输入也被清掉
    await pickIngredient("鸡蛋");
    expect((el('[data-test="ingredient-amount"]').element as HTMLInputElement).value).toBe("");
    expect(el('[data-test="ingredient-unit"]').text()).toContain("未选");
  });
});
