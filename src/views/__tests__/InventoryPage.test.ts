import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import InventoryPage from "@/views/InventoryPage.vue";
import { useIngredientStore } from "@/stores/ingredient";
import { useInventoryStore } from "@/stores/inventory";
import { useTeamStore } from "@/stores/team";
import { activeScope, setActiveScope } from "@/services/scope";

const mocks = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: mocks.push, back: mocks.back }) }));

let db: Db;
const wrappers: VueWrapper[] = [];

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

/** 本地日加减，与页面用同一套「今天」 */
function day(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

interface SeedBatch {
  ingredientId: string;
  ingredientName: string;
  amount: number;
  unitId?: string;
  unitName?: string;
  producedAt?: string;
  expiresAt?: string;
  used?: number;
}

async function seedBatch(o: SeedBatch): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    "INSERT OR IGNORE INTO ingredients (id, scope_id, name, created_at, updated_at, deleted_at) VALUES (?, 'p:local', ?, ?, ?, NULL)",
    [o.ingredientId, o.ingredientName, now, now],
  );
  if (o.unitId) {
    await db.execute(
      "INSERT OR IGNORE INTO units (id, scope_id, name, created_at, updated_at, deleted_at) VALUES (?, 'p:local', ?, ?, ?, NULL)",
      [o.unitId, o.unitName ?? o.unitId, now, now],
    );
  }
  const batchId = crypto.randomUUID();
  await db.execute(
    `INSERT INTO inventory_batches
       (id, scope_id, ingredient_id, amount, unit_id, produced_at, shelf_life_days, expires_at,
        created_at, updated_at, deleted_at)
     VALUES (?, 'p:local', ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
    [batchId, o.ingredientId, o.amount, o.unitId ?? null, o.producedAt ?? null, o.expiresAt ?? null, now, now],
  );
  if (o.used) {
    await db.execute(
      `INSERT INTO inventory_usages (id, scope_id, recipe_id, batch_id, amount, used_at, updated_at, deleted_at)
       VALUES (?, 'p:local', 'r1', ?, ?, ?, ?, NULL)`,
      [crypto.randomUUID(), batchId, o.used, now, now],
    );
  }
}

async function open(): Promise<VueWrapper> {
  const wrapper = mount(InventoryPage);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

function stockRows(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('[data-test="stock-row"]');
}

function rowOf(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
  const found = stockRows(wrapper).find(
    (row) => row.find('[data-test="stock-name"]').text() === name,
  );
  if (!found) throw new Error(`找不到库存行：${name}`);
  return found;
}

describe("InventoryPage", () => {
  it("没有任何批次时给空状态", async () => {
    const wrapper = await open();

    expect(wrapper.text()).toContain("还没有库存，点右上角加号记一批");
    expect(stockRows(wrapper)).toHaveLength(0);
  });

  it("同一食材的多批按单位合成余量，多个单位用顿号连接", async () => {
    await seedBatch({ ingredientId: "i1", ingredientName: "五花肉", amount: 300, unitId: "g", unitName: "g" });
    await seedBatch({ ingredientId: "i1", ingredientName: "五花肉", amount: 200, unitId: "g", unitName: "g" });
    await seedBatch({ ingredientId: "i1", ingredientName: "五花肉", amount: 2, unitId: "ge", unitName: "个" });

    const wrapper = await open();

    expect(rowOf(wrapper, "五花肉").find('[data-test="stock-amount"]').text()).toBe("500 g、2 个");
  });

  it("余量扣过使用记录，用完的食材标记「已用完」", async () => {
    await seedBatch({ ingredientId: "i1", ingredientName: "鸡蛋", amount: 6, used: 6 });

    const wrapper = await open();

    expect(rowOf(wrapper, "鸡蛋").find('[data-test="stock-used-up"]').text()).toBe("已用完");
  });

  it("7 天内到期标记「快过期」，昨天到期标记「已过期」", async () => {
    await seedBatch({
      ingredientId: "i1",
      ingredientName: "五花肉",
      amount: 500,
      unitId: "g",
      unitName: "g",
      expiresAt: day(3),
    });
    await seedBatch({
      ingredientId: "i2",
      ingredientName: "鸡蛋",
      amount: 2,
      expiresAt: day(-1),
    });

    const wrapper = await open();

    expect(rowOf(wrapper, "五花肉").find('[data-test="stock-expiring"]').text()).toBe("快过期");
    expect(rowOf(wrapper, "鸡蛋").find('[data-test="stock-expired"]').text()).toBe("已过期");
  });

  it("点食材行展开批次，再点收起", async () => {
    await seedBatch({
      ingredientId: "i1",
      ingredientName: "五花肉",
      amount: 500,
      unitId: "g",
      unitName: "g",
      producedAt: "2026-10-01",
      expiresAt: "2026-10-08",
    });
    const wrapper = await open();

    expect(wrapper.findAll('[data-test="stock-batch"]')).toHaveLength(0);
    await rowOf(wrapper, "五花肉").trigger("click");
    expect(wrapper.findAll('[data-test="stock-batch"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="stock-batch"]').text()).toContain("2026-10-08");
    expect(wrapper.find('[data-test="stock-batch"]').text()).toContain("500 g");

    await rowOf(wrapper, "五花肉").trigger("click");
    expect(wrapper.findAll('[data-test="stock-batch"]')).toHaveLength(0);
  });

  it("删批次要过确认框，确认后该批次消失", async () => {
    await seedBatch({ ingredientId: "i1", ingredientName: "五花肉", amount: 500 });
    const wrapper = await open();
    await rowOf(wrapper, "五花肉").trigger("click");

    await wrapper.get('[data-test="stock-batch-delete"]').trigger("click");
    await flushPromises();
    expect(document.body.textContent).toContain("删掉这一批");

    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "删除",
    );
    await new DOMWrapper(confirm!).trigger("click");
    await flushPromises();

    expect(stockRows(wrapper)).toHaveLength(0);
    const left = await db.select<{ deleted_at: string | null }[]>(
      "SELECT deleted_at FROM inventory_batches",
    );
    expect(left[0].deleted_at).not.toBeNull();
  });

  it("点右上角加号打开录入弹层", async () => {
    await useIngredientStore().add("鸡蛋");
    const wrapper = await open();

    await wrapper.get('[data-test="inventory-add"]').trigger("click");
    await flushPromises();

    expect(document.body.querySelector('[data-test="ref-row"]')).not.toBeNull();
  });

  it("进页面只查一次库", async () => {
    const store = useInventoryStore();
    const spy = vi.spyOn(store, "fetchAll");
    await open();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("库存页的范围切换器", () => {
  it("切到团队范围后只显示该团队的批次", async () => {
    await seedBatch({ ingredientId: "i-local", ingredientName: "鸡蛋", amount: 100 });
    await seedBatch({ ingredientId: "i-team", ingredientName: "五花肉", amount: 200 });
    // seedBatch 都写在 p:local；把「五花肉」那批挪到团队范围，模拟团队库存
    await db.execute("UPDATE inventory_batches SET scope_id = 't:t1' WHERE ingredient_id = 'i-team'");

    const wrapper = await open();
    expect(wrapper.text()).toContain("鸡蛋");
    expect(wrapper.text()).not.toContain("五花肉");

    useTeamStore().switchTo("t1");
    await flushPromises();

    expect(activeScope.value).toBe("t:t1");
    expect(wrapper.text()).toContain("五花肉");
    expect(wrapper.text()).not.toContain("鸡蛋");

    setActiveScope("p:local");
  });
});
