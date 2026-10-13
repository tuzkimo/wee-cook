import type { RecipeIngredientRow } from "@/types";

/** 规格 §10.6：数量为空就是「适量」，单位跟着数量一起显示；两页共用，别再各写一份。 */
export function amountText(line: Pick<RecipeIngredientRow, "amount" | "unit_name">): string {
  const amount = line.amount === null ? "适量" : String(line.amount);
  return line.unit_name ? `${amount} ${line.unit_name}` : amount;
}
