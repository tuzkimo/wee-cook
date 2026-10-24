import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import { useIngredientStore, useUnitStore } from "@/stores/ingredient";
import { enqueueSync } from "@/services/sync";
import { setActiveScope } from "@/services/scope";
import { useAuthStore } from "@/stores/auth";
import { useInventoryStore } from "@/stores/inventory";
import type { BatchInput } from "@/types";

// 只 mock 入队这一个动作（真要发同步就碰网络了）。
vi.mock("@/services/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/sync")>();
  return { ...actual, enqueueSync: vi.fn() };
});

let db: Db;

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
  setActiveScope("p:local");
  vi.clearAllMocks();
});

async function newIngredient(name = "鸡蛋"): Promise<string> {
  return (await useIngredientStore().add(name)).id;
}

async function newUnit(name = "g"): Promise<string> {
  return (await useUnitStore().add(name)).id;
}

function batch(over: Partial<BatchInput> & { ingredient_id: string }): BatchInput {
  return {
    amount: 100,
    unit_id: null,
    produced_at: null,
    shelf_life_days: null,
    expires_at: null,
    ...over,
  };
}

/** 直接写使用记录：recipe_id 是逻辑外键，测试里不需要真造一道菜谱 */
async function insertUsage(batchId: string, amount: number, recipeId = "r1"): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO inventory_usages (id, scope_id, recipe_id, batch_id, amount, used_at, updated_at, deleted_at)
     VALUES (?, 'p:local', ?, ?, ?, ?, ?, NULL)`,
    [crypto.randomUUID(), recipeId, batchId, amount, now, now],
  );
}

async function countUsages(): Promise<number> {
  const rows = await db.select<{ count: number }[]>("SELECT COUNT(*) AS count FROM inventory_usages");
  return rows[0].count;
}

describe("addBatch", () => {
  it("落库并出现在 fetchAll 结果里，余量等于数量", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();

    await store.addBatch(batch({ ingredient_id: egg, amount: 300 }));

    expect(store.batches).toHaveLength(1);
    expect(store.batches[0].ingredient_name).toBe("鸡蛋");
    expect(store.batches[0].remaining).toBe(300);
  });

  it("数量为 0 或负数被拒绝", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();

    await expect(store.addBatch(batch({ ingredient_id: egg, amount: 0 }))).rejects.toThrow(
      "数量要大于 0",
    );
    await expect(store.addBatch(batch({ ingredient_id: egg, amount: -5 }))).rejects.toThrow(
      "数量要大于 0",
    );
    expect(await countUsages()).toBe(0);
    expect(store.batches).toHaveLength(0);
  });

  it("过期日早于生产日期被拒绝", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();

    await expect(
      store.addBatch(
        batch({ ingredient_id: egg, produced_at: "2026-10-10", expires_at: "2026-10-01" }),
      ),
    ).rejects.toThrow("过期日不能早于生产日期");
  });

  it("保质期天数给 0 或小数被拒绝", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();

    await expect(
      store.addBatch(batch({ ingredient_id: egg, shelf_life_days: 0 })),
    ).rejects.toThrow("保质期天数要是正整数");
    await expect(
      store.addBatch(batch({ ingredient_id: egg, shelf_life_days: 1.5 })),
    ).rejects.toThrow("保质期天数要是正整数");
  });
});

describe("fetchAll", () => {
  it("余量 = 批次数量 − 未删除使用记录合计", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 300 }));
    const batchId = store.batches[0].batch.id;

    await insertUsage(batchId, 80);
    await insertUsage(batchId, 20);
    await store.fetchAll();

    expect(store.batches[0].remaining).toBe(200);
  });

  it("不返回软删批次", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 300 }));
    const batchId = store.batches[0].batch.id;

    await store.removeBatch(batchId);

    expect(store.batches).toHaveLength(0);
  });
});

describe("removeBatch", () => {
  it("软删批次，使用记录仍在库里", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 300 }));
    const batchId = store.batches[0].batch.id;
    await insertUsage(batchId, 100);

    await store.removeBatch(batchId);

    expect(store.batches).toHaveLength(0);
    expect(await countUsages()).toBe(1);
  });
});

describe("remainingByIngredient", () => {
  it("按单位聚合，余量为 0 的单位不出现", async () => {
    const egg = await newIngredient();
    const gram = await newUnit("g");
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 300, unit_id: gram }));
    await store.addBatch(batch({ ingredient_id: egg, amount: 100, unit_id: null }));
    const usedUp = store.batches.find((item) => item.batch.unit_id === null);
    await insertUsage(usedUp!.batch.id, 100);
    await store.fetchAll();

    const map = store.remainingByIngredient([egg]);

    expect(map.get(egg)).toEqual([{ unit_id: gram, remaining: 300 }]);
  });

  it("没有库存的食材不在 Map 里", async () => {
    const store = useInventoryStore();
    expect(store.remainingByIngredient(["nope"]).has("nope")).toBe(false);
  });
});

describe("commitCook", () => {
  it("按最早过期优先跨批次写记录", async () => {
    const pork = await newIngredient("五花肉");
    const gram = await newUnit("g");
    const store = useInventoryStore();
    await store.addBatch(
      batch({ ingredient_id: pork, amount: 100, unit_id: gram, expires_at: "2026-10-05" }),
    );
    await store.addBatch(
      batch({ ingredient_id: pork, amount: 100, unit_id: gram, expires_at: "2026-10-01" }),
    );

    const result = await store.commitCook("r1", [
      { ingredient_id: pork, ingredient_name: "五花肉", unit_id: gram, unit_name: "g", amount: 150 },
    ]);

    expect(result.deducted).toEqual([{ ingredient_name: "五花肉", unit_name: "g", amount: 150 }]);
    expect(result.shortfall).toEqual([]);
    const rows = await db.select<{ batch_id: string; amount: number }[]>(
      "SELECT batch_id, amount FROM inventory_usages ORDER BY amount DESC",
    );
    // 先过期的是后进库的那一批（10-01），扣它 100，再扣 10-05 那批 50
    const byExpiry = new Map(store.batches.map((item) => [item.batch.id, item.batch.expires_at]));
    expect(rows.map((row) => [byExpiry.get(row.batch_id), row.amount])).toEqual([
      ["2026-10-01", 100],
      ["2026-10-05", 50],
    ]);
    expect(store.batches.map((item) => item.remaining).sort()).toEqual([0, 50]);
  });

  it("只扣同单位的批次：库存记 g、行是「个」时扣不满且不写记录", async () => {
    const egg = await newIngredient();
    const gram = await newUnit("g");
    const piece = await newUnit("个");
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 500, unit_id: gram }));

    const result = await store.commitCook("r1", [
      { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: piece, unit_name: "个", amount: 2 },
    ]);

    expect(result.deducted).toEqual([]);
    expect(result.shortfall).toEqual([{ ingredient_name: "鸡蛋", unit_name: "个", missing: 2 }]);
    expect(await countUsages()).toBe(0);
  });

  it("库存不足时只扣现有量并报差额，余量不为负", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 6 }));

    const result = await store.commitCook("r1", [
      { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, unit_name: null, amount: 10 },
    ]);

    expect(result.deducted).toEqual([{ ingredient_name: "鸡蛋", unit_name: null, amount: 6 }]);
    expect(result.shortfall).toEqual([{ ingredient_name: "鸡蛋", unit_name: null, missing: 4 }]);
    expect(store.batches[0].remaining).toBe(0);
  });

  it("同食材同单位出现两行时第二行只用剩下的量", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 100 }));

    const result = await store.commitCook("r1", [
      { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, unit_name: null, amount: 60 },
      { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, unit_name: null, amount: 60 },
    ]);

    expect(result.deducted).toEqual([
      { ingredient_name: "鸡蛋", unit_name: null, amount: 60 },
      { ingredient_name: "鸡蛋", unit_name: null, amount: 40 },
    ]);
    expect(result.shortfall).toEqual([{ ingredient_name: "鸡蛋", unit_name: null, missing: 20 }]);
    expect(store.batches[0].remaining).toBe(0);
    expect(await countUsages()).toBe(2);
  });

  it("数量为 0 的行不写记录也不出现在结果里", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 100 }));

    const result = await store.commitCook("r1", [
      { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, unit_name: null, amount: 0 },
    ]);

    expect(result).toEqual({ deducted: [], shortfall: [] });
    expect(await countUsages()).toBe(0);
    expect(store.batches[0].remaining).toBe(100);
  });

  it("软删的批次不参与扣减", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 100 }));
    await store.removeBatch(store.batches[0].batch.id);

    const result = await store.commitCook("r1", [
      { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, unit_name: null, amount: 5 },
    ]);

    expect(result.shortfall).toEqual([{ ingredient_name: "鸡蛋", unit_name: null, missing: 5 }]);
  });
});

describe("库存按范围隔离", () => {
  it("两个范围各录一批同食材批次，fetchAll 只返回当前范围", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();

    setActiveScope("p:local");
    await store.addBatch(batch({ ingredient_id: egg, amount: 100 }));
    setActiveScope("t:t1");
    await store.addBatch(batch({ ingredient_id: egg, amount: 200 }));

    expect(store.batches.map((row) => row.batch.amount)).toEqual([200]);

    setActiveScope("p:local");
    await store.fetchAll();
    expect(store.batches.map((row) => row.batch.amount)).toEqual([100]);
  });

  it("remainingByIngredient 不跨范围", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();

    setActiveScope("t:t1");
    await store.addBatch(batch({ ingredient_id: egg, amount: 500 }));
    setActiveScope("p:local");
    await store.fetchAll();

    expect(store.remainingByIngredient([egg]).size).toBe(0);
  });

  it("addBatch 写入当前范围与当前用户", async () => {
    useAuthStore().serverUser = {
      id: "u1",
      username: "u1",
      nickname: "我",
      avatar_url: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const egg = await newIngredient();
    setActiveScope("t:t1");

    await useInventoryStore().addBatch(batch({ ingredient_id: egg }));

    const rows = await db.select<{ scope_id: string; owner_id: string | null }[]>(
      "SELECT scope_id, owner_id FROM inventory_batches",
    );
    expect(rows).toEqual([{ scope_id: "t:t1", owner_id: "u1" }]);
  });

  it("commitCook 只扣当前范围的批次，记录带批次范围与当前用户", async () => {
    useAuthStore().serverUser = {
      id: "u1",
      username: "u1",
      nickname: "我",
      avatar_url: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const egg = await newIngredient();
    const store = useInventoryStore();
    setActiveScope("p:local");
    await store.addBatch(batch({ ingredient_id: egg, amount: 1000 }));
    setActiveScope("t:t1");
    await store.addBatch(batch({ ingredient_id: egg, amount: 300 }));

    const result = await store.commitCook("r1", [
      { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, amount: 200, unit_name: null },
    ]);

    expect(result.deducted[0].amount).toBe(200);
    const usages = await db.select<
      { scope_id: string; owner_id: string | null; amount: number }[]
    >("SELECT scope_id, owner_id, amount FROM inventory_usages");
    expect(usages).toEqual([{ scope_id: "t:t1", owner_id: "u1", amount: 200 }]);
    // p:local 那批一点没动
    setActiveScope("p:local");
    await store.fetchAll();
    expect(store.batches[0].remaining).toBe(1000);
  });

  it("新增 / 软删批次与扣减都入同步队列", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 100 }));
    const id = store.batches[0].batch.id;

    let payload = vi.mocked(enqueueSync).mock.calls[vi.mocked(enqueueSync).mock.calls.length - 1]?.[0];
    expect(payload?.inventory_batches?.[0]).toMatchObject({ id, scope_id: "p:local" });

    await store.commitCook("r1", [
      { ingredient_id: egg, ingredient_name: "鸡蛋", unit_id: null, amount: 1, unit_name: null },
    ]);
    payload = vi.mocked(enqueueSync).mock.calls[vi.mocked(enqueueSync).mock.calls.length - 1]?.[0];
    expect(payload?.inventory_usages?.[0]).toMatchObject({ recipe_id: "r1", amount: 1 });

    await store.removeBatch(id);
    payload = vi.mocked(enqueueSync).mock.calls[vi.mocked(enqueueSync).mock.calls.length - 1]?.[0];
    expect(payload?.inventory_batches?.[0].deleted_at).not.toBeNull();
  });
});

describe("并发扣减的兜底显示", () => {
  it("使用记录超过批次数量时余量按 0 兜底（不显示负数）", async () => {
    const egg = await newIngredient();
    const store = useInventoryStore();
    await store.addBatch(batch({ ingredient_id: egg, amount: 100 }));
    const id = store.batches[0].batch.id;
    // 模拟两人几乎同时扣同一批次（spec §8.7：有意不解决，只兜底）
    await insertUsage(id, 150);

    await store.fetchAll();

    expect(store.batches[0].remaining).toBe(0);
  });
});
