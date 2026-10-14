// src/services/migration.ts
//
// 存量数据认领与「会话从不在线变在线」时的同步接线（spec §9.2 / §9.3 / §9.5）。
// 推送集合与首次全量拉取都在 sync.ts（Task 6 的 `collectPushPayload` / `doSync` 游标分支），
// 这里只负责：认领无主菜谱、以及把「认领 → 一次全扫同步 → 拉团队列表」串起来。
import { getDb, type Db } from "@/db";
import { hasBaseUrl } from "./api";
import { getCurrentServerUserId, performSync } from "./sync";
import { useTeamStore } from "@/stores/team";

/**
 * 把本机未认领的菜谱（`owner_id IS NULL`）划归当前账号（spec §9.2）。
 * 返回认领条数。判据是「还有没有 NULL 行」本身，天然幂等：第二个登录的人认领不到别人的数据。
 */
export async function claimOrphanRecipes(serverUserId: string, db: Db = getDb()): Promise<number> {
  // 不用 execute 的返回值拿行数：plugin-sql 返回 `rowsAffected`，测试注入的 node:sqlite 返回
  // `changes`，两种形状不同；先数一次最省事，也没有并发写者会插进来。
  const rows = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM recipes WHERE owner_id IS NULL",
  );
  const count = rows[0]?.n ?? 0;
  if (count === 0) return 0;
  await db.execute("UPDATE recipes SET owner_id = ?, updated_at = ? WHERE owner_id IS NULL", [
    serverUserId,
    new Date().toISOString(),
  ]);
  return count;
}

/**
 * 会话从「不在线」变「在线」时调用一次（登录成功 / 注册成功 / 冷启动恢复会话成功）：
 * 认领 → 全扫推送与拉取 → 刷新团队列表。
 *
 * `performSync` 内部按游标决定是否首次全量拉取，这里不区分首次与增量。
 * 绝不抛出：调用方的登录/恢复本身已经成功，同步失败只由 `performSync` 置 `lastSyncFailed`。
 */
export async function triggerFullPushAndSync(): Promise<void> {
  const uid = getCurrentServerUserId();
  // 未登录 / 未配地址：一次网络都不发（spec §9.5）
  if (!uid || !hasBaseUrl()) return;
  try {
    await claimOrphanRecipes(uid);
    await performSync();
    await useTeamStore().load();
  } catch (e) {
    // 数据库未就绪 / 团队列表拉取异常等：记一笔日志即可，不能把异常抛回登录流程
    console.warn("[migration] 存量认领或全扫同步失败:", e);
  }
}
