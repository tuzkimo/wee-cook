// system prompt 组装：只给分类名与标签名，不给 id、不给食材全量。
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, PROMPT_VERSION } from "@/services/ai/prompt";
import type { Dict, DictEntry } from "@/services/ai/filter";

function entry(id: string, name: string): DictEntry {
  return { id, name };
}

// 食材桶特意放一个 few-shot 里没出现过的名字（土豆）：用来证明「食材表整表不进 prompt」。
const dict: Dict = {
  categories: [entry("cat-1", "家常菜")],
  tags: [entry("tag-1", "下饭")],
  ingredients: [entry("ing-1", "土豆")],
  units: [entry("unit-1", "克")],
};

describe("buildSystemPrompt", () => {
  it("prompt 里只有分类名与标签名，没有 id、没有食材全量", () => {
    const p = buildSystemPrompt(dict, "2026-10-16");

    expect(p).toContain("家常菜");
    expect(p).toContain("下饭");
    expect(p).not.toContain("cat-1"); // 不给 id
    expect(p).not.toContain("tag-1");
    expect(p).not.toContain("ing-1");
    expect(p).not.toContain("土豆"); // 不给食材全量（库可能上千条）
  });

  it("prompt 里带上今天日期", () => {
    expect(buildSystemPrompt(dict, "2026-10-16")).toContain("2026-10-16");
    // 日期原样用入参，函数里不许读时钟
    expect(buildSystemPrompt(dict, "1999-01-02")).toContain("1999-01-02");
  });

  it("prompt 里有禁止清单的硬约束", () => {
    const p = buildSystemPrompt(dict, "2026-10-16");

    expect(p).toContain("编造"); // 不得编造菜谱
    expect(p).toContain("已收录"); // 不得声称已收录
    expect(p).toContain("不存在"); // 不得调用不存在的工具
    expect(p).toContain("不输出任何 id"); // 不得输出 id
  });

  it("prompt 明说四维之外的条件筛不了，做不到就直说别丢条件", () => {
    const p = buildSystemPrompt(dict, "2026-10-16");

    // 能筛的只有四维
    expect(p).toContain("关键词");
    expect(p).toContain("分类");
    expect(p).toContain("标签");
    expect(p).toContain("食材");
    // 时长 / 难度 / 几人份 筛不了
    expect(p).toContain("半小时");
    expect(p).toContain("难度");
    expect(p).toContain("三人份");
    expect(p).toContain("做不到");
    // 否定条件（「不要香菜」）也要直说不支持，不能塞进 keyword 换一个假阴性
    expect(p).toContain("否定条件");
  });

  it("prompt 里有 search_recipes 的 few-shot", () => {
    const p = buildSystemPrompt(dict, "2026-10-16");

    expect(p).toContain("search_recipes");
    expect(p).toContain("五花肉"); // 「找有五花肉的菜」
    expect(p).toContain("番茄"); // 纯检索那条（正向词）
    // 否定条件不能当关键词：教成 keyword:"不放辣椒" 必得 0 条，模型会说「库里没有」
    expect(p).not.toContain("不放辣椒");
    expect(p).not.toContain("create_recipe_draft"); // 本计划不实现截图收录，prompt 不能提到它
    expect(p).not.toContain("截图");
    expect(p).toContain("不调用工具"); // 「我库里有哪些分类」直接答
  });

  it("五段齐全：角色 / 日期 / 字典 / 工具 / 输出约定", () => {
    const p = buildSystemPrompt(dict, "2026-10-16");

    expect(p).toContain("菜谱助手"); // 角色
    expect(p).toContain("2026-10-16"); // 日期
    expect(p).toContain("分类："); // 字典
    expect(p).toContain("search_recipes"); // 工具
    expect(p).toContain("中文"); // 输出约定
  });

  it("版本号留着，改 prompt 时一起改", () => {
    expect(PROMPT_VERSION).toBe("ai-recipe-v1");
    expect(buildSystemPrompt(dict, "2026-10-16").length).toBeGreaterThan(0);
  });
});
