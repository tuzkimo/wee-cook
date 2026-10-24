import { describe, expect, it } from "vitest";
import type { BatchStock, IngredientStock } from "@/types";
import {
  EXPIRING_SOON_DAYS,
  computeExpiresAt,
  expiryState,
  groupStockRows,
  localToday,
  planDeduction,
  sortStockRows,
} from "@/utils/inventory";

const TODAY = "2026-10-24";

/** planDeduction 的候选：测试只关心余量/过期日/创建顺序 */
function cand(
  batch_id: string,
  remaining: number,
  expires_at: string | null,
  created_at = "2026-10-01T00:00:00.000Z",
) {
  return { batch_id, remaining, expires_at, created_at };
}

/** BatchStock 工厂：默认值够用，各用例只覆盖自己关心的字段 */
function stock(o: {
  id: string;
  ingredient_id: string;
  name?: string;
  unit_id: string | null;
  unit?: string | null;
  remaining: number;
  expires_at?: string | null;
}): BatchStock {
  return {
    batch: {
      id: o.id,
    scope_id: "p:local",
    owner_id: null,
      ingredient_id: o.ingredient_id,
      amount: o.remaining,
      unit_id: o.unit_id,
      produced_at: null,
      shelf_life_days: null,
      expires_at: o.expires_at ?? null,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
      deleted_at: null,
    },
    ingredient_name: o.name ?? "鸡蛋",
    unit_name: o.unit ?? null,
    remaining: o.remaining,
  };
}

describe("localToday", () => {
  it("按本地日输出 YYYY-MM-DD", () => {
    expect(localToday(new Date(2026, 9, 24, 23, 30))).toBe("2026-10-24");
    expect(localToday(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });
});

describe("computeExpiresAt", () => {
  it("生产日期加保质期天数", () => {
    expect(computeExpiresAt("2026-10-01", 7)).toBe("2026-10-08");
  });

  it("跨年也正确", () => {
    expect(computeExpiresAt("2026-12-28", 7)).toBe("2027-01-04");
  });

  it("闰年 2 月也正确", () => {
    expect(computeExpiresAt("2028-02-27", 2)).toBe("2028-02-29");
  });

  it("任一为空就是没有过期日", () => {
    expect(computeExpiresAt(null, 7)).toBeNull();
    expect(computeExpiresAt("2026-10-01", null)).toBeNull();
  });
});

describe("expiryState", () => {
  it("第 7 天仍算临期，第 8 天不算", () => {
    expect(EXPIRING_SOON_DAYS).toBe(7);
    expect(expiryState("2026-10-31", TODAY)).toBe("soon");
    expect(expiryState("2026-11-01", TODAY)).toBe("none");
  });

  it("当天到期算临期，昨天算已过期", () => {
    expect(expiryState("2026-10-24", TODAY)).toBe("soon");
    expect(expiryState("2026-10-23", TODAY)).toBe("expired");
  });

  it("没有过期日不算临期", () => {
    expect(expiryState(null, TODAY)).toBe("none");
  });
});

describe("planDeduction", () => {
  it("单批够用时只扣这一批", () => {
    expect(planDeduction([cand("A", 100, "2026-11-01")], 40)).toEqual({
      plan: [{ batch_id: "A", amount: 40 }],
      shortfall: 0,
    });
  });

  it("跨批次时先扣最早过期的", () => {
    const result = planDeduction(
      [cand("A", 100, "2026-10-05"), cand("B", 100, "2026-10-01")],
      150,
    );
    expect(result.plan).toEqual([
      { batch_id: "B", amount: 100 },
      { batch_id: "A", amount: 50 },
    ]);
    expect(result.shortfall).toBe(0);
  });

  it("没有过期日的批次排在最后", () => {
    const result = planDeduction([cand("A", 100, null), cand("B", 100, "2026-10-01")], 50);
    expect(result.plan).toEqual([{ batch_id: "B", amount: 50 }]);
  });

  it("过期日相同按 created_at 升序", () => {
    const result = planDeduction(
      [
        cand("late", 100, "2026-10-01", "2026-10-02T00:00:00.000Z"),
        cand("early", 100, "2026-10-01", "2026-10-01T00:00:00.000Z"),
      ],
      50,
    );
    expect(result.plan).toEqual([{ batch_id: "early", amount: 50 }]);
  });

  it("库存不足时只扣现有的并报差额", () => {
    expect(planDeduction([cand("A", 60, null)], 100)).toEqual({
      plan: [{ batch_id: "A", amount: 60 }],
      shortfall: 40,
    });
  });

  it("需求为 0 不产生计划", () => {
    expect(planDeduction([cand("A", 60, null)], 0)).toEqual({ plan: [], shortfall: 0 });
  });

  it("余量不大于 0 的批次被跳过", () => {
    const result = planDeduction([cand("A", 0, "2026-10-01"), cand("B", 100, "2026-11-01")], 10);
    expect(result.plan).toEqual([{ batch_id: "B", amount: 10 }]);
  });
});

describe("groupStockRows", () => {
  it("同食材同单位的多批合成一份余量", () => {
    const rows = groupStockRows([
      stock({ id: "b1", ingredient_id: "i1", unit_id: "g", unit: "g", remaining: 300 }),
      stock({ id: "b2", ingredient_id: "i1", unit_id: "g", unit: "g", remaining: 200 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].parts).toEqual([{ unit_id: "g", unit_name: "g", remaining: 500 }]);
  });

  it("同食材不同单位拆成两份，按批次出现顺序", () => {
    const rows = groupStockRows([
      stock({ id: "b1", ingredient_id: "i1", unit_id: "g", unit: "g", remaining: 500 }),
      stock({ id: "b2", ingredient_id: "i1", unit_id: "ge", unit: "个", remaining: 2 }),
    ]);
    expect(rows[0].parts.map((part) => part.unit_name)).toEqual(["g", "个"]);
  });

  it("同食材的份额按单位名排序，与批次入库顺序无关", () => {
    const rows = groupStockRows([
      stock({ id: "b1", ingredient_id: "i1", unit_id: "jin", unit: "斤", remaining: 1 }),
      stock({ id: "b2", ingredient_id: "i1", unit_id: "g", unit: "g", remaining: 500 }),
    ]);
    expect(rows[0].parts.map((part) => part.unit_name)).toEqual(["g", "斤"]);
  });

  it("不同食材各成一行", () => {
    const rows = groupStockRows([
      stock({ id: "b1", ingredient_id: "i1", name: "鸡蛋", unit_id: null, remaining: 2 }),
      stock({ id: "b2", ingredient_id: "i2", name: "五花肉", unit_id: "g", unit: "g", remaining: 500 }),
    ]);
    expect(rows.map((row) => row.ingredient_name)).toEqual(["鸡蛋", "五花肉"]);
  });

  it("所有余量都不大于 0 时 usedUp 为真", () => {
    const rows = groupStockRows([
      stock({ id: "b1", ingredient_id: "i1", unit_id: "g", unit: "g", remaining: 0 }),
    ]);
    expect(rows[0].usedUp).toBe(true);
  });

  it("最早过期日只看还有余量的批次", () => {
    const rows = groupStockRows([
      stock({ id: "b1", ingredient_id: "i1", unit_id: "g", unit: "g", remaining: 0, expires_at: "2026-10-01" }),
      stock({ id: "b2", ingredient_id: "i1", unit_id: "g", unit: "g", remaining: 10, expires_at: "2026-11-01" }),
    ]);
    expect(rows[0].soonest_expires_at).toBe("2026-11-01");
  });

  it("没有任何过期日时 soonest_expires_at 为 null", () => {
    const rows = groupStockRows([
      stock({ id: "b1", ingredient_id: "i1", unit_id: "g", unit: "g", remaining: 10 }),
    ]);
    expect(rows[0].soonest_expires_at).toBeNull();
  });
});

describe("sortStockRows", () => {
  function row(over: Partial<IngredientStock> & { ingredient_id: string; ingredient_name: string }): IngredientStock {
    return { parts: [], soonest_expires_at: null, usedUp: false, ...over };
  }

  it("已用完的沉底", () => {
    const sorted = sortStockRows([
      row({ ingredient_id: "a", ingredient_name: "A", usedUp: true, soonest_expires_at: "2026-10-01" }),
      row({ ingredient_id: "b", ingredient_name: "B", soonest_expires_at: "2026-12-01" }),
    ]);
    expect(sorted.map((item) => item.ingredient_id)).toEqual(["b", "a"]);
  });

  it("按最早过期日升序，没有过期日的排最后", () => {
    const sorted = sortStockRows([
      row({ ingredient_id: "a", ingredient_name: "A", soonest_expires_at: null }),
      row({ ingredient_id: "b", ingredient_name: "B", soonest_expires_at: "2026-11-01" }),
      row({ ingredient_id: "c", ingredient_name: "C", soonest_expires_at: "2026-10-26" }),
    ]);
    expect(sorted.map((item) => item.ingredient_id)).toEqual(["c", "b", "a"]);
  });

  it("同过期日按食材名", () => {
    const sorted = sortStockRows([
      row({ ingredient_id: "a", ingredient_name: "B" }),
      row({ ingredient_id: "b", ingredient_name: "A" }),
    ]);
    expect(sorted.map((item) => item.ingredient_name)).toEqual(["A", "B"]);
  });
});
