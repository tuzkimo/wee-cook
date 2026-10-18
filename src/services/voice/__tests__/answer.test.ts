// 指导模式的全部业务逻辑都在这一个纯函数里：22 条用例逐条对应规格 §5 的规则表。
import { describe, expect, it } from "vitest";
import type { RecipeIngredientRow, RecipeStep } from "@/types";
import { answerQuestion } from "@/services/voice/answer";
import type { AnswerContext } from "@/services/voice/answer";

const NOW = "2026-10-18T00:00:00.000Z";

function line(
  id: string,
  ingredientName: string,
  amount: number | null,
  unitName: string | null,
): RecipeIngredientRow {
  return {
    id,
    recipe_id: "r1",
    ingredient_id: `i-${id}`,
    amount,
    unit_id: unitName ? `u-${id}` : null,
    sort_order: 0,
    updated_at: NOW,
    deleted_at: null,
    ingredient_name: ingredientName,
    unit_name: unitName,
  };
}

function step(id: string, sortOrder: number, text: string): RecipeStep {
  return {
    id,
    recipe_id: "r1",
    sort_order: sortOrder,
    text,
    image_path: null,
    updated_at: NOW,
    deleted_at: null,
  };
}

const ingredients: RecipeIngredientRow[] = [
  line("1", "低筋面粉", 200, "克"),
  line("2", "盐", 3, "克"),
  line("3", "鸡胸肉", 300, "克"),
  line("4", "鸡蛋", 2, "个"),
  line("5", "淀粉", 20, "克"),
  line("6", "食用油", null, null),
];

const steps: RecipeStep[] = [
  step("s1", 0, "鸡胸肉切丁，加盐和淀粉抓匀，腌 10 分钟"),
  step("s2", 1, "热锅下油，油温六成热下鸡丁滑散，约 2 分钟"),
  step("s3", 2, "倒掉多余的油，留底油下配料"),
  step("s4", 3, "大火翻炒均匀出锅"),
];

function ctx(overrides: Partial<AnswerContext> = {}): AnswerContext {
  return { ingredients, steps, currentStep: 0, ...overrides };
}

describe("answerQuestion", () => {
  it("没有唤醒词时返回 null（不是在叫它，绝不能出声）", () => {
    expect(answerQuestion("面粉多少", ctx())).toBeNull();
  });

  it("空文本返回 null", () => {
    expect(answerQuestion("", ctx())).toBeNull();
  });

  it("「扫除」当成唤醒词（实机头号的听错法：小厨 → 扫除）", () => {
    expect(answerQuestion("扫除，面粉多少", ctx())?.text).toBe("低筋面粉，200 克");
    expect(answerQuestion("扫除下一步", ctx())?.step).toBe(1);
  });

  it("同音字也能当唤醒词（小橱 / 小初 / 小除）", () => {
    expect(answerQuestion("小橱，面粉多少", ctx())?.text).toBe("低筋面粉，200 克");
    expect(answerQuestion("小初，面粉多少", ctx())?.text).toBe("低筋面粉，200 克");
    expect(answerQuestion("小除，面粉多少", ctx())?.text).toBe("低筋面粉，200 克");
  });

  it("简体「雏」也认（spec 写的是简体）", () => {
    expect(answerQuestion("小雏，面粉多少", ctx())?.text).toBe("低筋面粉，200 克");
  });

  it("「消除」也当唤醒词（实机还会这么听错）", () => {
    expect(answerQuestion("消除，面粉多少", ctx())?.text).toBe("低筋面粉，200 克");
  });

  it("只喊唤醒词（哪怕是听错的）也回一句「在」", () => {
    expect(answerQuestion("扫除", ctx())?.text).toContain("在");
  });

  it("只喊唤醒词时回一句「在」", () => {
    const answer = answerQuestion("小厨", ctx());

    expect(answer?.text).toContain("在");
    expect(answer?.step).toBeUndefined();
  });

  it("问部分食材名（ASR 少字）也能命中完整食材名", () => {
    const answer = answerQuestion("小厨，面粉多少", ctx());

    expect(answer?.text).toBe("低筋面粉，200 克");
    expect(answer?.step).toBeUndefined();
  });

  it("问完整食材名命中同一行", () => {
    expect(answerQuestion("小厨，低筋面粉多少", ctx())?.text).toBe("低筋面粉，200 克");
  });

  it("单字食材名按原名命中", () => {
    expect(answerQuestion("小厨，盐放多少", ctx())?.text).toBe("盐，3 克");
  });

  it("一句话问两个食材，按顺序都念", () => {
    const text = answerQuestion("小厨，面粉和盐各多少", ctx())?.text ?? "";

    expect(text).toContain("低筋面粉，200 克");
    expect(text).toContain("盐，3 克");
  });

  it("命中 4 个以上只念前 3 个，其余报数量", () => {
    const text = answerQuestion("小厨，面粉盐鸡肉鸡蛋淀粉各多少", ctx())?.text ?? "";

    // 长度降序：低筋面粉(4) → 鸡蛋/淀粉(2，按原顺序) → 盐(1)
    expect(text).toContain("低筋面粉，200 克");
    expect(text).toContain("鸡蛋，2 个");
    expect(text).toContain("淀粉，20 克");
    expect(text).toContain("还有 1 样");
    // 「鸡肉」不是「鸡胸肉」，宽松匹配只兜最后两字，这条不在前 3 里
    expect(text).not.toContain("鸡胸肉");
  });

  it("数量为空时念「适量」", () => {
    expect(answerQuestion("小厨，食用油呢", ctx())?.text).toBe("食用油，适量");
  });

  it("中文数字步号跳到那一步并念原文", () => {
    const answer = answerQuestion("小厨，第三步是什么", ctx());

    expect(answer?.step).toBe(2);
    expect(answer?.text).toBe(steps[2].text);
  });

  it("阿拉伯数字步号同样识别", () => {
    expect(answerQuestion("小厨，第3步", ctx())?.step).toBe(2);
  });

  it("「第二部」这种同音错字也能识别步号（ASR 把步听成部）", () => {
    const answer = answerQuestion("小厨，第二部是什么", ctx());

    expect(answer?.step).toBe(1);
    expect(answer?.text).toBe(steps[1].text);
  });

  it("步号越界时说清只有几步，不改高亮", () => {
    const answer = answerQuestion("小厨，第十步", ctx());

    expect(answer?.text).toBe("现在只有 4 步");
    expect(answer?.step).toBeUndefined();
  });

  it("「下一步」跳转到下一步", () => {
    const answer = answerQuestion("小厨，下一步", ctx({ currentStep: 0 }));

    expect(answer?.step).toBe(1);
    expect(answer?.text).toBe(steps[1].text);
  });

  it("「继续」与「下一步」同义", () => {
    expect(answerQuestion("小厨，继续", ctx({ currentStep: 0 }))?.step).toBe(1);
  });

  it("在第一步说「上一步」时给固定文案，不改高亮", () => {
    const answer = answerQuestion("小厨，上一步", ctx({ currentStep: 0 }));

    expect(answer?.text).toContain("已经是第一步");
    expect(answer?.step).toBeUndefined();
  });

  it("在第三步说「上一步」回到第二步", () => {
    expect(answerQuestion("小厨，上一步", ctx({ currentStep: 2 }))?.step).toBe(1);
  });

  it("问「多久」时从当前步原文抽出时间", () => {
    const answer = answerQuestion("小厨，要炒多久", ctx({ currentStep: 1 }));

    expect(answer?.text).toBe("大约 2 分钟");
    expect(answer?.step).toBeUndefined();
  });

  it("当前步里没有时间词时念整段原文（不编造时长）", () => {
    expect(answerQuestion("小厨，这个要多久", ctx({ currentStep: 2 }))?.text).toBe(steps[2].text);
  });

  it("菜谱外的问题走兜底话术", () => {
    expect(answerQuestion("小厨，今天天气怎么样", ctx())?.text).toContain("菜谱里没写");
  });

  it("没有步骤的菜谱问步骤时说「没有步骤」", () => {
    const answer = answerQuestion("小厨，第三步是什么", ctx({ steps: [] }));

    expect(answer?.text).toBe("这道菜没有步骤");
    expect(answer?.step).toBeUndefined();
  });

  it("没有步骤的菜谱仍然能答食材用量", () => {
    expect(answerQuestion("小厨，面粉多少", ctx({ steps: [] }))?.text).toBe("低筋面粉，200 克");
  });

  it("一句话里同时有步号和食材时先跳步（步骤优先于食材）", () => {
    const answer = answerQuestion("小厨第三步面粉放多少", ctx());

    expect(answer?.step).toBe(2);
  });
});
