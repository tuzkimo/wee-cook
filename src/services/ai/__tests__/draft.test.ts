// 草稿槽与 create_recipe_draft 的参数校验/名字解析：模型给的一律当不可信输入。
import { beforeEach, describe, expect, it } from "vitest";
import type { Dict, DictEntry } from "@/services/ai/filter";
import {
  clearDraft,
  resolveDraft,
  setDraft,
  takeDraft,
  validateDraftArgs,
  type DraftArgs,
  type RecipeDraft,
} from "@/services/ai/draft";

function entry(id: string, name: string): DictEntry {
  return { id, name };
}

/** 「肉」同时是「五花肉」「肉末」的子串 ⇒ 多命中，不许猜 */
const dict: Dict = {
  categories: [entry("c1", "家常菜")],
  tags: [entry("t1", "快手")],
  ingredients: [entry("i1", "五花肉"), entry("i2", "肉末")],
  units: [entry("u1", "克"), entry("u2", "个")],
};

/** 通过校验的 args；不合格时直接抛，免得每个用例都写窄化 */
function validated(raw: string): DraftArgs {
  const result = validateDraftArgs(raw);
  if (!result.ok) throw new Error(result.error);
  return result.args;
}

beforeEach(() => {
  clearDraft();
});

describe("validateDraftArgs", () => {
  it("菜名空 / 不是 JSON / 不是对象 ⇒ ok:false（调用方据此回 tool 错误）", () => {
    expect(validateDraftArgs('{"name":"   "}').ok).toBe(false);
    expect(validateDraftArgs('{"name":""}').ok).toBe(false);
    expect(validateDraftArgs('{"category":"家常菜"}').ok).toBe(false);
    expect(validateDraftArgs('{"name":123}').ok).toBe(false);
    expect(validateDraftArgs("不是 JSON").ok).toBe(false);
    expect(validateDraftArgs("[]").ok).toBe(false);
    expect(validateDraftArgs("null").ok).toBe(false);
  });

  it("amount：0、负数、NaN、字符串 ⇒ 一律 null（不是 0）", () => {
    const args = validated(
      '{"name":"盐焗鸡","ingredients":[' +
        '{"name":"盐","amount":0},' +
        '{"name":"糖","amount":-3},' +
        '{"name":"水","amount":"NaN"},' +
        '{"name":"油","amount":"200"},' +
        '{"name":"鸡","amount":1.5}]}',
    );

    const amounts = (args.ingredients ?? []).map((line) => line.amount);
    expect(amounts).toEqual([null, null, null, null, 1.5]);
    for (const amount of amounts.slice(0, 4)) expect(amount).not.toBe(0);
  });

  it("食材名字 trim 后为空的行被丢弃", () => {
    const args = validated(
      '{"name":"炒饭","ingredients":[{"name":"   "},{"name":"\\u3000"},{"name":" 米饭 ","amount":1}]}',
    );

    expect(args.ingredients).toEqual([{ name: "米饭", amount: 1, unit: null }]);
  });

  it("多余字段忽略，标签/步骤里的非字符串被丢掉", () => {
    expect(validated('{"name":" 红烧肉 ","extra":1,"tags":[1," 快手 "]}')).toEqual({
      name: "红烧肉",
      tags: [" 快手 "],
    });
    expect(validated('{"name":"红烧肉","tags":"快手"}').tags).toBeUndefined();
    expect(validated('{"name":"红烧肉","steps":"切块"}').steps).toBeUndefined();
  });
});

describe("resolveDraft", () => {
  it("食材多命中 / 零命中 ⇒ ingredient_id 为 \"\"，name 保留 AI 原文", () => {
    const draft = resolveDraft(
      validated('{"name":"乱炖","ingredients":[{"name":"肉"},{"name":"洋蓟"}]}'),
      dict,
    );

    expect(draft.ingredients.map((line) => line.ingredient_id)).toEqual(["", ""]);
    expect(draft.ingredients.map((line) => line.name)).toEqual(["肉", "洋蓟"]);
    // 未落定不是静默新建：草稿里只有名字，没有凭空冒出的 id
    expect(draft.ingredients.every((line) => line.ingredient_id === "")).toBe(true);
  });

  it("单位未命中 ⇒ unit_id = null，amount 保留", () => {
    const draft = resolveDraft(
      validated('{"name":"爆炒","ingredients":[{"name":"五花肉","amount":200,"unit":"把"}]}'),
      dict,
    );

    expect(draft.ingredients[0]).toEqual({
      ingredient_id: "i1",
      name: "五花肉",
      amount: 200,
      unit_id: null,
      unit_name: null,
    });

    // 命中时收 id 和字典里的名字
    const hit = resolveDraft(
      validated('{"name":"爆炒","ingredients":[{"name":"五花肉","amount":2,"unit":"个"}]}'),
      dict,
    );
    expect(hit.ingredients[0].unit_id).toBe("u2");
    expect(hit.ingredients[0].unit_name).toBe("个");
  });

  it("分类未命中 ⇒ category_id 为 \"\"；标签未命中直接丢弃（不进草稿）", () => {
    const draft = resolveDraft(
      validated('{"name":"宵夜","category":"宵夜","tags":["快手","库里没有的标签"]}'),
      dict,
    );

    expect(draft.category_id).toBe("");
    expect(draft.category_name).toBe("宵夜");
    expect(draft.tag_ids).toEqual(["t1"]);
    expect(draft.tag_names).toEqual(["快手"]);

    const hit = resolveDraft(validated('{"name":"家常小炒","category":"家常菜"}'), dict);
    expect(hit.category_id).toBe("c1");
    expect(hit.tag_ids).toEqual([]);
    expect(hit.tag_names).toEqual([]);
  });

  it("模型重复同一个标签名 ⇒ 同一个 id 只进一次（否则编辑页挂上重复标签）", () => {
    const draft = resolveDraft(validated('{"name":"葱油面","tags":["快手","快手"]}'), dict);

    expect(draft.tag_ids).toEqual(["t1"]);
    expect(draft.tag_names).toEqual(["快手"]);
  });

  it("步骤逐条 trim，空串丢弃；cover_path 留空等 store 填", () => {
    const draft = resolveDraft(
      validated('{"name":"炒饭","steps":[" 打蛋 ","", "\u3000","下锅"]}'),
      dict,
    );

    expect(draft.steps).toEqual(["打蛋", "下锅"]);
    expect(draft.cover_path).toBeNull();
    expect(draft.ingredients).toEqual([]);
  });
});

describe("草稿槽", () => {
  it("setDraft → takeDraft 读到 → 第二次是 null；clearDraft 后读不到", () => {
    const draft: RecipeDraft = resolveDraft(validated('{"name":"红烧肉"}'), dict);

    setDraft(draft);
    expect(takeDraft()).toEqual(draft);
    // 读走即清：编辑页重新挂载不会二次预填
    expect(takeDraft()).toBeNull();

    setDraft(draft);
    clearDraft();
    expect(takeDraft()).toBeNull();
  });
});
