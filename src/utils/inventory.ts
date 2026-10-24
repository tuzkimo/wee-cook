import type { BatchStock, IngredientStock } from "@/types";

/** 临期阈值：到期日在 7 天内（含当天）就算临期 */
export const EXPIRING_SOON_DAYS = 7;

const DAY_MS = 86_400_000;

/** YYYY-MM-DD 加减天数。走 UTC 零点，避免本地时区的夏令时/偏移导致差一天。 */
function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 本地日（YYYY-MM-DD）：用户在哪个时区，就以哪天为准。 */
export function localToday(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 生产日期 + 保质期天数 → 过期日；任一为空就是没有过期信息。 */
export function computeExpiresAt(
  producedAt: string | null,
  shelfLifeDays: number | null,
): string | null {
  if (!producedAt || shelfLifeDays === null) return null;
  if (Number.isNaN(Date.parse(`${producedAt}T00:00:00Z`))) return null;
  return addDays(producedAt, shelfLifeDays);
}

/** YYYY-MM-DD 之间可以直接比字符串：字典序就是时间序。 */
export function expiryState(
  expiresAt: string | null,
  today: string,
): "none" | "soon" | "expired" {
  if (!expiresAt) return "none";
  if (expiresAt < today) return "expired";
  if (expiresAt <= addDays(today, EXPIRING_SOON_DAYS)) return "soon";
  return "none";
}

export interface DeductionCandidate {
  batch_id: string;
  remaining: number;
  expires_at: string | null;
  created_at: string;
}

/** 无过期日的批次排最后；同过期日按创建顺序，先买的先扣。 */
function compareCandidates(a: DeductionCandidate, b: DeductionCandidate): number {
  if (a.expires_at !== b.expires_at) {
    if (a.expires_at === null) return 1;
    if (b.expires_at === null) return -1;
    return a.expires_at < b.expires_at ? -1 : 1;
  }
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return 0;
}

/**
 * FIFO 扣减计划：按过期日从早到晚依次扣，扣不满只扣现有的并报差额。
 * 候选必须已经按食材与单位筛好 —— 函数不看库，也不知道批次之间的关系。
 */
export function planDeduction(
  candidates: DeductionCandidate[],
  want: number,
): { plan: { batch_id: string; amount: number }[]; shortfall: number } {
  const plan: { batch_id: string; amount: number }[] = [];
  let left = want > 0 ? want : 0;
  const usable = candidates.filter((item) => item.remaining > 0).sort(compareCandidates);
  for (const item of usable) {
    if (left <= 0) break;
    const take = Math.min(item.remaining, left);
    plan.push({ batch_id: item.batch_id, amount: take });
    left -= take;
  }
  return { plan, shortfall: left };
}

/** 把批次余量按食材聚合，同食材同单位相加；顺序沿用批次顺序（SQL 已按过期日排好）。 */
export function groupStockRows(batches: BatchStock[]): IngredientStock[] {
  const byIngredient = new Map<string, IngredientStock>();
  for (const item of batches) {
    const batch = item.batch;
    let row = byIngredient.get(batch.ingredient_id);
    if (!row) {
      row = {
        ingredient_id: batch.ingredient_id,
        ingredient_name: item.ingredient_name,
        parts: [],
        soonest_expires_at: null,
        usedUp: false,
      };
      byIngredient.set(batch.ingredient_id, row);
    }
    let part = row.parts.find((entry) => entry.unit_id === batch.unit_id);
    if (!part) {
      part = { unit_id: batch.unit_id, unit_name: item.unit_name, remaining: 0 };
      row.parts.push(part);
    }
    part.remaining += item.remaining;
    // 用完的批次不参与临期判定：一袋过期的空袋子不该让整个食材显示「已过期」
    if (item.remaining > 0 && batch.expires_at !== null) {
      if (row.soonest_expires_at === null || batch.expires_at < row.soonest_expires_at) {
        row.soonest_expires_at = batch.expires_at;
      }
    }
  }
  for (const row of byIngredient.values()) {
    row.usedUp = row.parts.every((part) => part.remaining <= 0);
  }
  return [...byIngredient.values()];
}

/** 库存页顺序：还有余量的在前（按最早过期日，无过期日最后），用完的沉底，再按食材名。 */
export function sortStockRows(rows: IngredientStock[]): IngredientStock[] {
  return [...rows].sort((a, b) => {
    if (a.usedUp !== b.usedUp) return a.usedUp ? 1 : -1;
    if (a.soonest_expires_at !== b.soonest_expires_at) {
      if (a.soonest_expires_at === null) return 1;
      if (b.soonest_expires_at === null) return -1;
      return a.soonest_expires_at < b.soonest_expires_at ? -1 : 1;
    }
    if (a.ingredient_name !== b.ingredient_name) {
      return a.ingredient_name < b.ingredient_name ? -1 : 1;
    }
    return 0;
  });
}
