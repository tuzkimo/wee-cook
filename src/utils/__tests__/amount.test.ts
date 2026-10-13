import { describe, expect, it } from "vitest";
import { amountText } from "@/utils/amount";

describe("amountText", () => {
  it("没填数量有单位：读「适量 克」，不能只剩一个裸单位", () => {
    expect(amountText({ amount: null, unit_name: "克" })).toBe("适量 克");
  });

  it("没填数量也没单位：读「适量」", () => {
    expect(amountText({ amount: null, unit_name: null })).toBe("适量");
  });

  it("有数量有单位：数字加空格加单位", () => {
    expect(amountText({ amount: 2, unit_name: "个" })).toBe("2 个");
  });

  it("只有数量没单位：只读数字", () => {
    expect(amountText({ amount: 3, unit_name: null })).toBe("3");
  });
});
