// 指导模式的唯一业务逻辑：纯函数，不碰 IO，可单测。规则顺序见规格 §5，先命中先返回。
import type { RecipeIngredientRow, RecipeStep } from "@/types";
import { amountText } from "@/utils/amount";

export interface AnswerContext {
  ingredients: RecipeIngredientRow[];
  steps: RecipeStep[];
  /** 0-based */
  currentStep: number;
}

export interface Answer {
  /** 要念出来的话 */
  text: string;
  /** 命中步骤跳转时给出，0-based */
  step?: number;
}

const NO_STEPS = "这道菜没有步骤";
const FALLBACK = "这个我菜谱里没写。可以问，面粉多少，或者，第三步是什么。";
const MAX_INGREDIENTS = 3;

const CN_NUMERALS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const RELATIVE_STEPS: { words: string[]; delta: number }[] = [
  { words: ["下一步", "下步", "继续"], delta: 1 },
  { words: ["上一步", "上步", "前一步"], delta: -1 },
];

const TIME_WORDS = ["多久", "几分钟", "多长时间", "几秒", "多少分钟"];
const DURATION = /\d+\s*(分钟|分|秒|小时|钟头)/;

/** null = 不是在叫它（无唤醒词 / 空文本） */
export function answerQuestion(transcript: string, ctx: AnswerContext): Answer | null {
  if (!transcript.includes("小厨")) return null;

  const text = stripWakeWord(transcript);
  if (text === "") return { text: "在，问吧。" };

  const steps = ctx.steps;
  const current = clamp(ctx.currentStep, steps.length);

  // 步骤判断排在食材前面：「第三步面粉放多少」先跳步更符合人的预期。
  const relative = answerRelativeStep(text, current, steps);
  if (relative) return relative;

  const absolute = answerAbsoluteStep(text, steps);
  if (absolute) return absolute;

  const ingredients = matchIngredients(text, ctx.ingredients);
  if (ingredients.total > 0) return { text: ingredientsText(ingredients) };

  if (TIME_WORDS.some((word) => text.includes(word))) return answerDuration(steps, current);

  return { text: FALLBACK };
}

function stripWakeWord(raw: string): string {
  return raw.replace(/小厨/g, "").replace(/^[\s，。！？、,.!?;；:：…—-]+|[\s，。！？、,.!?;；:：…—-]+$/g, "");
}

function clamp(currentStep: number, stepCount: number): number {
  if (stepCount === 0) return 0;
  return Math.min(Math.max(currentStep, 0), stepCount - 1);
}

function answerRelativeStep(text: string, current: number, steps: RecipeStep[]): Answer | null {
  const rule = RELATIVE_STEPS.find((item) => item.words.some((word) => text.includes(word)));
  if (!rule) return null;
  if (steps.length === 0) return { text: NO_STEPS };

  const target = current + rule.delta;
  if (target < 0) return { text: "已经是第一步了" };
  if (target >= steps.length) return { text: "已经是最后一步了" };
  return { text: steps[target].text, step: target };
}

function answerAbsoluteStep(text: string, steps: RecipeStep[]): Answer | null {
  const match = text.match(/第\s*([一二三四五六七八九十]|\d{1,2})\s*[步部]/) ?? text.match(/步骤\s*([一二三四五六七八九十]|\d{1,2})/);
  if (!match) return null;
  if (steps.length === 0) return { text: NO_STEPS };

  const raw = match[1];
  const order = CN_NUMERALS[raw] ?? Number(raw);
  const target = order - 1;
  if (!Number.isInteger(target) || target < 0 || target >= steps.length) {
    return { text: `现在只有 ${steps.length} 步` };
  }
  return { text: steps[target].text, step: target };
}

/**
 * 长名优先：ASR 把「低筋面粉」听成「面粉」时靠最后两字兜住，
 * 长度降序保证「低筋面粉」不会被更短的「面粉」类名字抢走。
 */
function matchIngredients(
  text: string,
  lines: RecipeIngredientRow[],
): { hits: RecipeIngredientRow[]; total: number } {
  const sorted = [...lines].sort((a, b) => b.ingredient_name.length - a.ingredient_name.length);
  const hits = sorted.filter((line) => {
    const name = line.ingredient_name;
    if (text.includes(name)) return true;
    return name.length >= 2 && text.includes(name.slice(-2));
  });
  return { hits: hits.slice(0, MAX_INGREDIENTS), total: hits.length };
}

function ingredientsText({ hits, total }: { hits: RecipeIngredientRow[]; total: number }): string {
  const spoken = hits.map((line) => `${line.ingredient_name}，${amountText(line)}`).join("；");
  return total > MAX_INGREDIENTS ? `${spoken}；还有 ${total - MAX_INGREDIENTS} 样` : spoken;
}

function answerDuration(steps: RecipeStep[], current: number): Answer {
  if (steps.length === 0) return { text: FALLBACK };

  const source = steps[current].text;
  const match = source.match(DURATION);
  // 步骤里没写时间就不编：念原文，用户自己判断
  return match ? { text: `大约 ${match[0]}` } : { text: source };
}
