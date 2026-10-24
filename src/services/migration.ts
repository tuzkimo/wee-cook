// 存量数据认领与「会话从不在线变在线」时的同步接线（spec §10.3 / §11.5）。
// 推送集合与首次全量拉取都在 sync.ts（`collectPushPayload` / 游标分支），
// 这里只负责：把游客范围整批并进账号范围、以及把「认领 → 一次全扫同步」串起来。
import { getDb, type Db } from "@/db";
import { hasBaseUrl } from "./api";
import { LOCAL_SCOPE, personalScope } from "@/services/scope";
import { getCurrentServerUserId, performSync } from "./sync";

/** 字典三表的合同：表名、合并键、合并后要重指哪些引用（与 sync.ts 的 repointSql 同一组）。 */
const DICT_TABLES = [
  {
    table: "ingredients",
    repoint: [
      "UPDATE recipe_ingredients SET ingredient_id = ? WHERE ingredient_id = ?",
      "UPDATE inventory_batches SET ingredient_id = ? WHERE ingredient_id = ?",
    ],
  },
  {
    table: "units",
    repoint: [
      "UPDATE recipe_ingredients SET unit_id = ? WHERE unit_id = ?",
      "UPDATE inventory_batches SET unit_id = ? WHERE unit_id = ?",
    ],
  },
  {
    table: "labels",
    repoint: [
      "UPDATE OR IGNORE recipe_labels SET label_id = ? WHERE label_id = ?",
      "UPDATE recipes SET category_id = ? WHERE category_id = ?",
    ],
    cleanup: ["DELETE FROM recipe_labels WHERE label_id = ?"],
  },
] as const;

/**
 * 把游客范围（`p:local`）整批并进「我」的范围（spec §11.5）。
 *
 * 字典要先处理同名合并：目标范围里已有同名的行 → 引用改指过去、删掉游客那条，
 * 否则改范围时会撞上 `(scope_id, name)` 唯一索引，整次认领失败。
 * 菜谱 / 批次 / 使用记录直接改范围列，并补上 `owner_id`。
 *
 * 判据是「`p:local` 里还有没有行」，天然幂等；登出后未登录界面因此是空态（不删任何数据）。
 */
export async function claimLocalScope(userId: string, db: Db = getDb()): Promise<void> {
  const target = personalScope(userId);

  for (const spec of DICT_TABLES) {
    const guests = await db.select<{ id: string; name: string; kind?: string }[]>(
      `SELECT * FROM ${spec.table} WHERE scope_id = ?`,
      [LOCAL_SCOPE],
    );
    for (const guest of guests) {
      const withKind = guest.kind === undefined ? "" : " AND kind = ?";
      // 只认**活行**：合并到一条软删行上，引用会被指到界面里根本不存在的字典行
      const params: unknown[] = [target, guest.name];
      if (guest.kind !== undefined) params.push(guest.kind);
      const dups = await db.select<{ id: string }[]>(
        `SELECT id FROM ${spec.table} WHERE scope_id = ? AND name = ?${withKind} AND deleted_at IS NULL LIMIT 1`,
        params,
      );
      const keep = dups[0]?.id;
      if (!keep || keep === guest.id) continue;
      for (const sql of spec.repoint) await db.execute(sql, [keep, guest.id]);
      for (const sql of ("cleanup" in spec ? spec.cleanup : []) as readonly string[]) {
        await db.execute(sql, [guest.id]);
      }
      await db.execute(`DELETE FROM ${spec.table} WHERE id = ?`, [guest.id]);
    }
    await db.execute(`UPDATE ${spec.table} SET scope_id = ? WHERE scope_id = ?`, [
      target,
      LOCAL_SCOPE,
    ]);
  }

  // 业务表：改范围 + 补归属（已认领过的行保留原 owner_id）
  await db.execute("UPDATE recipes SET scope_id = ?, owner_id = COALESCE(owner_id, ?) WHERE scope_id = ?", [
    target,
    userId,
    LOCAL_SCOPE,
  ]);
  for (const table of ["inventory_batches", "inventory_usages"]) {
    await db.execute(
      `UPDATE ${table} SET scope_id = ?, owner_id = COALESCE(owner_id, ?) WHERE scope_id = ?`,
      [target, userId, LOCAL_SCOPE],
    );
  }
}

/**
 * 会话从「不在线」变「在线」时调用一次（登录成功 / 注册成功 / 冷启动恢复会话成功）：
 * 认领 → 全扫推送与拉取。
 *
 * `performSync` 内部按游标决定是否首次全量拉取，这里不区分首次与增量。
 * 绝不抛出：调用方的登录/恢复本身已经成功，同步失败只由 `performSync` 置 `lastSyncFailed`。
 */
export async function triggerFullPushAndSync(): Promise<void> {
  const uid = getCurrentServerUserId();
  // 未登录 / 未配地址：一次网络都不发（spec §10.3）
  if (!uid || !hasBaseUrl()) return;
  try {
    await claimLocalScope(uid);
    await performSync();
  } catch (e) {
    // 数据库未就绪 / 同步异常等：记一笔日志即可，不能把异常抛回登录流程
    console.warn("[migration] 存量认领或全扫同步失败:", e);
  }
}
