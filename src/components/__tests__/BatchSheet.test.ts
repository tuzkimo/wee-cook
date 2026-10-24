import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import BatchSheet from "@/components/BatchSheet.vue";
import { useIngredientStore, useUnitStore } from "@/stores/ingredient";
import { useInventoryStore } from "@/stores/inventory";

let db: Db;
const wrappers: VueWrapper[] = [];

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
  await useIngredientStore().add("鸡蛋");
  await useIngredientStore().add("面粉");
  await useUnitStore().add("克");
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  document.body.innerHTML = "";
});

/** 组件 Teleport 到 body，所以一律查 document.body。 */
function el(selector: string): DOMWrapper<Element> {
  const found = document.body.querySelector(selector);
  if (!found) throw new Error(`找不到元素：${selector}`);
  return new DOMWrapper(found);
}

function has(selector: string): boolean {
  return document.body.querySelector(selector) !== null;
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

function mountSheet(): VueWrapper {
  const wrapper = mount(BatchSheet, { props: { visible: true } });
  wrappers.push(wrapper);
  return wrapper;
}

/** 打开弹层并选好食材，停在表单这一步。 */
async function openForm(ingredient = "鸡蛋"): Promise<VueWrapper> {
  const wrapper = mountSheet();
  await flushPromises();
  const row = [...document.body.querySelectorAll<HTMLElement>('[data-test="ref-row"]')].find(
    (rowEl) => rowEl.textContent?.trim() === ingredient,
  );
  if (!row) throw new Error(`找不到食材：${ingredient}`);
  await new DOMWrapper(row).trigger("click");
  await flushPromises();
  return wrapper;
}

async function save(): Promise<void> {
  await el('[data-test="batch-save"]').trigger("click");
  await flushPromises();
}

async function rows(): Promise<{ amount: number; produced_at: string | null; expires_at: string | null }[]> {
  return db.select(
    "SELECT amount, produced_at, expires_at FROM inventory_batches ORDER BY created_at ASC",
  );
}

describe("BatchSheet", () => {
  it("第一步列食材，选中后进表单", async () => {
    const wrapper = await openForm();

    expect(has('[data-test="ref-row"]')).toBe(false);
    expect(has('[data-test="batch-amount"]')).toBe(true);
    expect(has('[data-test="batch-produced"]')).toBe(true);
    expect(has('[data-test="batch-shelf-life"]')).toBe(true);
    expect(has('[data-test="batch-expires"]')).toBe(true);
    expect(wrapper.emitted("saved")).toBeUndefined();
  });

  it("数量留空时报错且不写库", async () => {
    const wrapper = await openForm();

    await save();

    expect(bodyText()).toContain("数量要大于 0");
    expect(await rows()).toEqual([]);
    expect(wrapper.emitted("saved")).toBeUndefined();
  });

  it("数量为 0 或负数时报错且不写库", async () => {
    await openForm();

    await el('[data-test="batch-amount"]').setValue("-2");
    await save();

    expect(bodyText()).toContain("数量要大于 0");
    expect(await rows()).toEqual([]);
  });

  it("生产日期加保质期天数自动算出过期日", async () => {
    await openForm();

    await el('[data-test="batch-produced"]').setValue("2026-10-01");
    await el('[data-test="batch-shelf-life"]').setValue("7");
    await flushPromises();

    expect((el('[data-test="batch-expires"]').element as HTMLInputElement).value).toBe(
      "2026-10-08",
    );
  });

  it("手改过期日后，再改保质期天数不会覆盖手填值", async () => {
    await openForm();
    await el('[data-test="batch-produced"]').setValue("2026-10-01");
    await el('[data-test="batch-shelf-life"]').setValue("7");
    await flushPromises();

    await el('[data-test="batch-expires"]').setValue("2026-10-05");
    await el('[data-test="batch-shelf-life"]').setValue("30");
    await flushPromises();

    expect((el('[data-test="batch-expires"]').element as HTMLInputElement).value).toBe(
      "2026-10-05",
    );
  });

  it("清空过期日后恢复自动计算", async () => {
    await openForm();
    await el('[data-test="batch-produced"]').setValue("2026-10-01");
    await el('[data-test="batch-shelf-life"]').setValue("7");
    await el('[data-test="batch-expires"]').setValue("2026-10-05");
    await flushPromises();

    await el('[data-test="batch-expires"]').setValue("");
    await flushPromises();

    expect((el('[data-test="batch-expires"]').element as HTMLInputElement).value).toBe(
      "2026-10-08",
    );
  });

  it("保质期天数为 0 时报错且不写库", async () => {
    await openForm();

    await el('[data-test="batch-amount"]').setValue("100");
    await el('[data-test="batch-shelf-life"]').setValue("0");
    await save();

    expect(bodyText()).toContain("保质期天数要是正整数");
    expect(await rows()).toEqual([]);
  });

  it("过期日早于生产日期时报错且不写库", async () => {
    await openForm();

    await el('[data-test="batch-amount"]').setValue("100");
    await el('[data-test="batch-produced"]').setValue("2026-10-10");
    await el('[data-test="batch-expires"]').setValue("2026-10-01");
    await save();

    expect(bodyText()).toContain("过期日不能早于生产日期");
    expect(await rows()).toEqual([]);
  });

  it("保存成功写库、emit saved 与 close", async () => {
    const wrapper = await openForm();
    await el('[data-test="batch-amount"]').setValue("300");
    await el('[data-test="batch-produced"]').setValue("2026-10-01");
    await el('[data-test="batch-shelf-life"]').setValue("7");

    await save();

    expect(await rows()).toEqual([
      { amount: 300, produced_at: "2026-10-01", expires_at: "2026-10-08" },
    ]);
    expect(wrapper.emitted("saved")).toHaveLength(1);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("选了单位就一起存下来", async () => {
    await openForm();
    await el('[data-test="batch-amount"]').setValue("300");

    await el('[data-test="batch-unit"]').trigger("click");
    await flushPromises();
    const gram = [...document.body.querySelectorAll<HTMLElement>('[data-test="ref-row"]')].find(
      (rowEl) => rowEl.textContent?.trim() === "克",
    );
    await new DOMWrapper(gram!).trigger("click");
    await flushPromises();
    await save();

    const stored = await db.select<{ unit_id: string | null }[]>(
      "SELECT unit_id FROM inventory_batches",
    );
    const unit = useUnitStore().items.find((item) => item.name === "克");
    expect(stored).toEqual([{ unit_id: unit!.id }]);
  });

  it("写库失败时错误显示在面板内且不关窗", async () => {
    const wrapper = await openForm();
    const store = useInventoryStore();
    const spy = vi.spyOn(store, "addBatch").mockRejectedValue(new Error("数据库忙，再试一次"));
    await el('[data-test="batch-amount"]').setValue("100");

    await save();

    expect(bodyText()).toContain("数据库忙，再试一次");
    expect(wrapper.emitted("close")).toBeUndefined();
    expect(has('[data-test="batch-amount"]')).toBe(true);
    spy.mockRestore();
  });

  it("保存中再点一次不会重复写库", async () => {
    await openForm();
    const store = useInventoryStore();
    let release!: () => void;
    const spy = vi
      .spyOn(store, "addBatch")
      .mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    await el('[data-test="batch-amount"]').setValue("100");

    await el('[data-test="batch-save"]').trigger("click");
    await el('[data-test="batch-save"]').trigger("click");

    expect(spy).toHaveBeenCalledTimes(1);
    release();
    await flushPromises();
    spy.mockRestore();
  });

  it("重新打开时从选食材开始，不残留上一轮输入", async () => {
    const wrapper = await openForm();
    await el('[data-test="batch-amount"]').setValue("999");

    await wrapper.setProps({ visible: false });
    await wrapper.setProps({ visible: true });
    await flushPromises();

    expect(has('[data-test="ref-row"]')).toBe(true);
    expect(has('[data-test="batch-amount"]')).toBe(false);
  });
});
