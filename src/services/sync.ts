// src/services/sync.ts
//
// 同步核心：协议形状、LWW 合并、待推送队列、游标与调度。
// 服务器只做「收增量 / 发增量」，本地 SQLite 始终是唯一真相源（spec §4）。
// 结构照抄姊妹项目 wee-count/src/services/sync.ts，按本项目规格去掉账本 / 交易 / 别名分支，
// 保留：字典同名合并、子行整组替换、队列与游标按 uid 隔离。
import { getDb, type Db } from "@/db";
import { apiFetch, hasBaseUrl } from "./api";
import { downloadPendingFiles, uploadPendingFiles, type FileRef } from "./syncFiles";
import { useAuthStore } from "@/stores/auth";
import type { Ingredient, Label, Recipe, Unit } from "@/types";

/** 菜谱子表在协议里的形状：跟父菜谱整条走，不带各自的 updated_at / deleted_at（spec §7.3）。 */
export interface RecipeStepPayload {
  id: string;
  sort_order: number;
  text: string;
  image_path: string | null;
}

export interface RecipeIngredientPayload {
  id: string;
  ingredient_id: string;
  amount: number | null;
  unit_id: string | null;
  sort_order: number;
}

/**
 * 菜谱的完整同步形状 = `Recipe` + 它的三份子行快照（spec §7.3）。
 * 父行字段唯一来源是 `src/types` 的 `Recipe`，这里不再平行声明一份（两份字段不一致 = 静默丢字段）。
 */
export interface RecipePayload extends Recipe {
  steps: RecipeStepPayload[];
  ingredients: RecipeIngredientPayload[];
  label_ids: string[];
}

/** 双向同步载荷。`files` 只在响应里有值（推送时为空）。 */
export interface SyncPayload {
  ingredients: Ingredient[];
  units: Unit[];
  labels: Label[];
  recipes: RecipePayload[];
  files: FileRef[];
}

interface SyncRequest {
  last_server_seq: number;
  local_changes: SyncPayload;
}

interface SyncResponse {
  server_seq: number;
  remote_changes: SyncPayload;
  /** 我当前有效的收藏（只读下发，整表替换用）。对账接线见 Task 4。 */
  favorite_recipe_ids: string[];
}

export function emptyPayload(): SyncPayload {
  return { ingredients: [], units: [], labels: [], recipes: [], files: [] };
}

// SQLite 的 datetime('now') 产出 "YYYY-MM-DD HH:MM:SS"（UTC），非 RFC3339，
// Go time.Time 无法解析会让整个 /sync 请求体被拒（400 invalid request body）。
// 统一归一化为 ISO（带 Z）；已经是 ISO 的原样返回。
export function toIsoTimestamp(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(v);
  if (m) return `${m[1]}T${m[2]}${m[3] ?? ""}Z`;
  return v;
}

// 归一化后按 epoch 毫秒比较，消除 " " vs "T" 字典序误判与毫秒位差异。
export function compareTimestamp(a: string, b: string): number {
  return new Date(toIsoTimestamp(a)).getTime() - new Date(toIsoTimestamp(b)).getTime();
}

function normDeleted(v: string | null): string | null {
  return v === null ? null : toIsoTimestamp(v);
}

/**
 * 写一条字典行，并守住「同一 (name[, kind]) 最多一条活行」这条不变量。
 *
 * 顺序被外键约束钉死（node:sqlite 与 sqlx 都默认开 `foreign_keys`）：引用不能在目标行存在之前
 * 指向它，而新行又与老行同键、撞 `name` 上的局部唯一索引，所以先软删老行释放唯一键 →
 * 写新行 → 改指引用 → 硬删老行。
 *
 * 两条入口共用：
 *  - 插入路径（本地没有该 id）：`writeSql` 是 INSERT。
 *  - 更新路径（本地已有该 id，远端把它复活）：`writeSql` 是 UPDATE，且 `findDupSql` 只找
 *    **另一条活行**（软删行不占唯一键，不该被误删）。
 *
 * 返回被合并掉的老 id（无同键老行为 null），调用方据此记 remap。
 */
async function upsertDictRow(
  db: Db,
  opts: {
    table: "ingredients" | "units" | "labels";
    id: string;
    updatedAt: string;
    findDupSql: string;
    findDupParams: unknown[];
    writeSql: string;
    writeParams: unknown[];
    repointSql: string[];
    cleanupSql?: string[];
  },
): Promise<string | null> {
  const dup = await db.select<{ id: string }[]>(opts.findDupSql, opts.findDupParams);
  const oldId = dup.length > 0 ? dup[0].id : null;
  if (oldId !== null) {
    await db.execute(`UPDATE ${opts.table} SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?`, [
      opts.updatedAt,
      oldId,
    ]);
  }
  await db.execute(opts.writeSql, opts.writeParams);
  if (oldId === null) return null;
  for (const sql of opts.repointSql) await db.execute(sql, [opts.id, oldId]);
  for (const sql of opts.cleanupSql ?? []) await db.execute(sql, [oldId]);
  await db.execute(`DELETE FROM ${opts.table} WHERE id = ?`, [oldId]);
  return oldId;
}

/**
 * Apply remote changes to local SQLite (LWW merge).
 *
 * 顺序：先合并字典（并记下 旧 id → 新 id 的 remap），把引用改指到合并后的 id，
 * 再把**同一批 remote.recipes 里子数组的引用**按 remap 重写，最后才落地菜谱。
 * 不这样排，同批次里引用了被合并掉的旧 id 的菜谱会指向一条已被删掉的行（spec §7.4）。
 */
export async function applyRemoteChanges(remote: SyncPayload, db: Db = getDb()): Promise<void> {
  // 旧字典 id → 服务端返回的有效 id（同键合并时产生）
  const remap = new Map<string, string>();

  // --- 字典：ingredients ---
  for (const item of remote.ingredients ?? []) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM ingredients WHERE id = ?",
      [item.id],
    );
    const updatedAt = toIsoTimestamp(item.updated_at);
    if (local.length === 0) {
      // 本地已有同名行（不同 UUID，典型是清库重绑）→ 引用改指、删旧行、插新行。
      // **不过滤软删行**：软删行仍占着「同名」这个坑，漏掉会写出两条同名数据。
      const oldId = await upsertDictRow(db, {
        table: "ingredients",
        id: item.id,
        updatedAt,
        // 优先取活行：(deleted_at IS NULL) DESC 把活行排在前。若先取到软删行，只软删它
        // 不会释放 name 的局部唯一索引，INSERT 会撞活行 → 同步永远卡死。
        findDupSql: "SELECT id FROM ingredients WHERE name = ? ORDER BY (deleted_at IS NULL) DESC LIMIT 1",
        findDupParams: [item.name],
        writeSql: "INSERT INTO ingredients (id,name,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?)",
        writeParams: [item.id, item.name, toIsoTimestamp(item.created_at), updatedAt, normDeleted(item.deleted_at)],
        repointSql: ["UPDATE recipe_ingredients SET ingredient_id = ? WHERE ingredient_id = ?"],
      });
      if (oldId !== null) remap.set(oldId, item.id);
    } else if (compareTimestamp(item.updated_at, local[0].updated_at) > 0) {
      if (item.deleted_at === null) {
        // 远端把一条本地已软删的行复活。若本地另有同名的活行，直接 UPDATE 会写出第二条
        // 活行、撞 idx_ingredients_name（同步永久卡死），所以先把它并掉（C1）。
        const oldId = await upsertDictRow(db, {
          table: "ingredients",
          id: item.id,
          updatedAt,
          // 只找另一条**活行**：软删行不占唯一键，误删它没有意义。
          findDupSql: "SELECT id FROM ingredients WHERE name = ? AND deleted_at IS NULL AND id != ? LIMIT 1",
          findDupParams: [item.name, item.id],
          writeSql: "UPDATE ingredients SET name=?, updated_at=?, deleted_at=? WHERE id=?",
          writeParams: [item.name, updatedAt, null, item.id],
          repointSql: ["UPDATE recipe_ingredients SET ingredient_id = ? WHERE ingredient_id = ?"],
        });
        if (oldId !== null) remap.set(oldId, item.id);
      } else {
        await db.execute("UPDATE ingredients SET name=?, updated_at=?, deleted_at=? WHERE id=?", [
          item.name,
          updatedAt,
          normDeleted(item.deleted_at),
          item.id,
        ]);
      }
    }
  }

  // --- 字典：units ---
  for (const item of remote.units ?? []) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM units WHERE id = ?",
      [item.id],
    );
    const updatedAt = toIsoTimestamp(item.updated_at);
    if (local.length === 0) {
      const oldId = await upsertDictRow(db, {
        table: "units",
        id: item.id,
        updatedAt,
        findDupSql: "SELECT id FROM units WHERE name = ? ORDER BY (deleted_at IS NULL) DESC LIMIT 1",
        findDupParams: [item.name],
        writeSql: "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?)",
        writeParams: [item.id, item.name, toIsoTimestamp(item.created_at), updatedAt, normDeleted(item.deleted_at)],
        repointSql: ["UPDATE recipe_ingredients SET unit_id = ? WHERE unit_id = ?"],
      });
      if (oldId !== null) remap.set(oldId, item.id);
    } else if (compareTimestamp(item.updated_at, local[0].updated_at) > 0) {
      if (item.deleted_at === null) {
        const oldId = await upsertDictRow(db, {
          table: "units",
          id: item.id,
          updatedAt,
          findDupSql: "SELECT id FROM units WHERE name = ? AND deleted_at IS NULL AND id != ? LIMIT 1",
          findDupParams: [item.name, item.id],
          writeSql: "UPDATE units SET name=?, updated_at=?, deleted_at=? WHERE id=?",
          writeParams: [item.name, updatedAt, null, item.id],
          repointSql: ["UPDATE recipe_ingredients SET unit_id = ? WHERE unit_id = ?"],
        });
        if (oldId !== null) remap.set(oldId, item.id);
      } else {
        await db.execute("UPDATE units SET name=?, updated_at=?, deleted_at=? WHERE id=?", [
          item.name,
          updatedAt,
          normDeleted(item.deleted_at),
          item.id,
        ]);
      }
    }
  }

  // --- 字典：labels（合并键是 (name, kind)，不能跨 kind 合并）---
  for (const item of remote.labels ?? []) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM labels WHERE id = ?",
      [item.id],
    );
    const updatedAt = toIsoTimestamp(item.updated_at);
    if (local.length === 0) {
      const oldId = await upsertDictRow(db, {
        table: "labels",
        id: item.id,
        updatedAt,
        // 合并键是 (name, kind)：分类与标签不能并成一行（spec §7.4）。
        findDupSql: "SELECT id FROM labels WHERE name = ? AND kind = ? ORDER BY (deleted_at IS NULL) DESC LIMIT 1",
        findDupParams: [item.name, item.kind],
        writeSql: "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?)",
        writeParams: [item.id, item.name, item.kind, toIsoTimestamp(item.created_at), updatedAt, normDeleted(item.deleted_at)],
        // recipe_labels 的主键是 (recipe_id, label_id)：一条菜谱同时引用新旧两行时，
        // OR IGNORE 跳过冲突行，随后整行删掉旧 id，不留指向已删行的关联。
        repointSql: [
          "UPDATE OR IGNORE recipe_labels SET label_id = ? WHERE label_id = ?",
          "UPDATE recipes SET category_id = ? WHERE category_id = ?",
        ],
        cleanupSql: ["DELETE FROM recipe_labels WHERE label_id = ?"],
      });
      if (oldId !== null) remap.set(oldId, item.id);
    } else if (compareTimestamp(item.updated_at, local[0].updated_at) > 0) {
      if (item.deleted_at === null) {
        const oldId = await upsertDictRow(db, {
          table: "labels",
          id: item.id,
          updatedAt,
          findDupSql: "SELECT id FROM labels WHERE name = ? AND kind = ? AND deleted_at IS NULL AND id != ? LIMIT 1",
          findDupParams: [item.name, item.kind, item.id],
          writeSql: "UPDATE labels SET name=?, kind=?, updated_at=?, deleted_at=? WHERE id=?",
          writeParams: [item.name, item.kind, updatedAt, null, item.id],
          repointSql: [
            "UPDATE OR IGNORE recipe_labels SET label_id = ? WHERE label_id = ?",
            "UPDATE recipes SET category_id = ? WHERE category_id = ?",
          ],
          cleanupSql: ["DELETE FROM recipe_labels WHERE label_id = ?"],
        });
        if (oldId !== null) remap.set(oldId, item.id);
      } else {
        await db.execute("UPDATE labels SET name=?, kind=?, updated_at=?, deleted_at=? WHERE id=?", [
          item.name,
          item.kind,
          updatedAt,
          normDeleted(item.deleted_at),
          item.id,
        ]);
      }
    }
  }

  // 同一批下发的菜谱，其引用可能指向刚被合并掉的本地 id：先按 remap 重写成有效 id 再落地。
  for (const r of remote.recipes ?? []) {
    r.category_id = remap.get(r.category_id) ?? r.category_id;
    r.label_ids = (r.label_ids ?? []).map((id) => remap.get(id) ?? id);
    for (const line of r.ingredients ?? []) {
      line.ingredient_id = remap.get(line.ingredient_id) ?? line.ingredient_id;
      if (line.unit_id !== null) line.unit_id = remap.get(line.unit_id) ?? line.unit_id;
    }
  }

  // --- 菜谱：LWW + 子行整组替换 ---
  for (const r of remote.recipes ?? []) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM recipes WHERE id = ?",
      [r.id],
    );
    const isNew = local.length === 0;
    if (!isNew && compareTimestamp(r.updated_at, local[0].updated_at) <= 0) {
      // 作者两列是服务端从 users 表派生的展示数据，本地从不改写：菜谱本体不过 LWW，
      // 这两列也要刷新（否则新加的 owner_avatar_url 对存量行永远是 NULL）。
      // 载荷里没有这个键说明是旧版服务端，保持本地值不动（别把好头像抹成 NULL）。
      if ("owner_avatar_url" in r) {
        await db.execute(
          "UPDATE recipes SET owner_nickname = ?, owner_avatar_url = ? WHERE id = ?",
          [r.owner_nickname ?? null, r.owner_avatar_url ?? null, r.id],
        );
      }
      continue;
    }

    const updatedAt = toIsoTimestamp(r.updated_at);
    const deletedAt = normDeleted(r.deleted_at);
    // 旧版本服务端的载荷可能没有这两列：缺失时按「私有、无昵称」兜底。
    const isPublic = r.is_public ?? 0;
    const ownerNickname = r.owner_nickname ?? null;
    const ownerAvatar = r.owner_avatar_url ?? null;
    if (isNew) {
      await db.execute(
        `INSERT INTO recipes (id,name,cover_path,category_id,is_public,owner_nickname,owner_avatar_url,created_at,updated_at,deleted_at,owner_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          r.id,
          r.name,
          r.cover_path,
          r.category_id,
          isPublic,
          ownerNickname,
          ownerAvatar,
          toIsoTimestamp(r.created_at),
          updatedAt,
          deletedAt,
          r.owner_id ?? null,
        ],
      );
    } else {
      await db.execute(
        `UPDATE recipes SET name=?, cover_path=?, category_id=?, is_public=?, owner_nickname=?, owner_avatar_url=?, updated_at=?, deleted_at=?, owner_id=?
         WHERE id=?`,
        [
          r.name,
          r.cover_path,
          r.category_id,
          isPublic,
          ownerNickname,
          ownerAvatar,
          updatedAt,
          deletedAt,
          r.owner_id ?? null,
          r.id,
        ],
      );
    }

    // 子行整组硬替换：远端快照就是当前有效子行，DELETE 掉本地的（含软删的旧行）再插，
    // 既不复活旧行也不留孤儿（spec §7.3 / §11.13）。子行协议里没有 updated_at，沿用父行时间。
    await db.execute("DELETE FROM recipe_steps WHERE recipe_id = ?", [r.id]);
    for (const step of r.steps ?? []) {
      await db.execute(
        `INSERT INTO recipe_steps (id,recipe_id,sort_order,text,image_path,updated_at,deleted_at)
         VALUES (?,?,?,?,?,?,NULL)`,
        [step.id, r.id, step.sort_order, step.text, step.image_path, updatedAt],
      );
    }

    await db.execute("DELETE FROM recipe_ingredients WHERE recipe_id = ?", [r.id]);
    for (const line of r.ingredients ?? []) {
      await db.execute(
        `INSERT INTO recipe_ingredients
           (id,recipe_id,ingredient_id,amount,unit_id,sort_order,updated_at,deleted_at)
         VALUES (?,?,?,?,?,?,?,NULL)`,
        [line.id, r.id, line.ingredient_id, line.amount, line.unit_id, line.sort_order, updatedAt],
      );
    }

    await db.execute("DELETE FROM recipe_labels WHERE recipe_id = ?", [r.id]);
    for (const labelId of r.label_ids ?? []) {
      await db.execute("INSERT OR IGNORE INTO recipe_labels (recipe_id,label_id) VALUES (?,?)", [
        r.id,
        labelId,
      ]);
    }
  }
}

// --- 收藏对账与本机账号登记（spec §7.2）---

/** 记录本机用过的账号：清理别人的菜谱副本时要拿它当白名单（spec §7.2）。 */
export async function registerLocalAccount(uid: string, db: Db = getDb()): Promise<void> {
  await db.execute("INSERT OR IGNORE INTO local_accounts (user_id) VALUES (?)", [uid]);
}

// 收藏 / 取消收藏的操作版本，只在内存里（不持久化）。在途同步的响应快照可能早于一次收藏 POST，
// 靠它判断这份快照是否已过期。
let favoriteOps = 0;
// 本轮 /sync 请求发出时的版本，由 doSync 记录。
let favoriteOpsAtRequest = 0;

export function bumpFavoriteOps(): void {
  favoriteOps += 1;
}

export function favoriteOpsEpoch(): number {
  return favoriteOps;
}

/** 删掉「本机谁都不要、只因为浏览或收藏才存在」的别人的菜谱副本（含子行）。 */
async function deleteCachedOtherRecipes(uid: string, db: Db): Promise<void> {
  const rows = await db.select<{ id: string }[]>(
    `SELECT id FROM recipes
     WHERE owner_id IS NOT NULL AND owner_id <> ?
       AND owner_id NOT IN (SELECT user_id FROM local_accounts)
       AND id NOT IN (SELECT recipe_id FROM favorite_recipes)`,
    [uid],
  );
  for (const { id } of rows) {
    // 本地子表没有 ON DELETE CASCADE，删父行前自己删子行，否则留下孤儿。
    await db.execute("DELETE FROM recipe_steps WHERE recipe_id = ?", [id]);
    await db.execute("DELETE FROM recipe_ingredients WHERE recipe_id = ?", [id]);
    await db.execute("DELETE FROM recipe_labels WHERE recipe_id = ?", [id]);
    await db.execute("DELETE FROM recipes WHERE id = ?", [id]);
  }
}

/**
 * 同步成功后的收藏对账（spec §7.2）：整表替换收藏集合 → 清掉别人的缓存副本。
 * 响应快照发出后用户又动过收藏（版本已变）时整段跳过，不推进任何本地状态，交给补跑的那轮。
 */
export async function reconcileFavorites(
  uid: string,
  favoriteIds: string[],
  db: Db = getDb(),
): Promise<void> {
  const epoch = favoriteOps;
  if (epoch !== favoriteOpsAtRequest) return;

  await db.execute("DELETE FROM favorite_recipes");
  for (const id of favoriteIds) {
    await db.execute("INSERT OR IGNORE INTO favorite_recipes (recipe_id) VALUES (?)", [id]);
  }

  // 替换期间又收藏了：这份过期列表不能拿去清缓存，交给下一轮
  if (epoch !== favoriteOps) return;
  await deleteCachedOtherRecipes(uid, db);
}

// --- 调度：待推送队列 / 游标 / 定时器 ---

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let isSyncing = false;
let syncQueued = false;

// 待推送队列按 uid 隔离（Map key = 服务端 user id），并持久化到 localStorage。
// 单例会让 A 的变更串到 B 账号；不持久化则 3s 防抖定时器没烧完就退出 App 会丢变更。
const pendingByUid = new Map<string, SyncPayload>();

// 同步只推队列里这四类（files 只在响应里有值，不参与入队）。
const PENDING_KEYS = ["ingredients", "units", "labels", "recipes"] as const;

/** 当前登录用户的 id；未登录 / 未初始化时 null。内部调 auth store。 */
export function getCurrentServerUserId(): string | null {
  try {
    return useAuthStore().serverUserId;
  } catch {
    return null;
  }
}

function pendingQueueKey(uid: string): string {
  return `pending_sync:${uid}`;
}

function cursorKeyFor(uid: string | null): string {
  return uid ? `last_server_seq:${uid}` : "last_server_seq";
}

export function getLastSyncedAtFor(uid: string | null): string | null {
  return localStorage.getItem(cursorKeyFor(uid));
}

export function setLastSyncedAtFor(uid: string | null, seq: string): void {
  localStorage.setItem(cursorKeyFor(uid), seq);
}

/** 取当前 uid 的队列；未登录（uid=null）返回一次性空队列，不入 Map、不持久化。 */
function pendingFor(uid: string | null): SyncPayload {
  if (!uid) return emptyPayload();
  let p = pendingByUid.get(uid);
  if (!p) {
    try {
      const raw = localStorage.getItem(pendingQueueKey(uid));
      p = raw ? (JSON.parse(raw) as SyncPayload) : emptyPayload();
    } catch {
      p = emptyPayload();
    }
    pendingByUid.set(uid, p);
  }
  return p;
}

function isEmptyPayload(p: SyncPayload): boolean {
  return PENDING_KEYS.every((k) => p[k].length === 0);
}

function persistPending(uid: string | null): void {
  if (!uid) return;
  const p = pendingByUid.get(uid);
  // 队列只是触发/备忘（全扫推送是兜底）：localStorage 写失败（配额/被禁）不能把异常抛给调用方
  // ——enqueueSync 会沿 recipe.create/update 抛回用户，失败回队路径会让 performSync reject。
  try {
    if (!p || isEmptyPayload(p)) localStorage.removeItem(pendingQueueKey(uid));
    else localStorage.setItem(pendingQueueKey(uid), JSON.stringify(p));
  } catch {
    // 只是这次没落盘，下轮全扫同步照常推
  }
}

/** 合并一批改动进队列：同 id 只保留 updated_at 更新的一份。 */
export function mergeChanges(target: SyncPayload, source: Partial<SyncPayload>): void {
  for (const key of PENDING_KEYS) {
    const targetArr = target[key] as unknown as { id: string; updated_at: string }[];
    const sourceArr = source[key] as unknown as { id: string; updated_at: string }[] | undefined;
    if (!sourceArr) continue;
    for (const item of sourceArr) {
      const idx = targetArr.findIndex((t) => t.id === item.id);
      if (idx < 0) targetArr.push(item);
      else if (compareTimestamp(item.updated_at, targetArr[idx].updated_at) > 0) targetArr[idx] = item;
    }
  }
}

/** 把本地改动入队，3 秒防抖后触发一次同步。未配地址 / 未登录直接返回（不发请求）。 */
export function enqueueSync(changes: Partial<SyncPayload>): void {
  if (!hasBaseUrl()) return;
  const uid = getCurrentServerUserId();
  if (!uid) return;

  mergeChanges(pendingFor(uid), changes);
  persistPending(uid);

  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void performSync().catch(() => {});
  }, 3000);
}

/** 停止同步调度（定时器 + 重试计数），但保留各 uid 的待推送队列。登出用。 */
export function resetSyncTimers(): void {
  retryAttempt = 0;
  syncQueued = false;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}

/** 清空待推送队列与定时器。仅用于「解绑在线同步」，登出不需要。 */
export function clearPendingSync(): void {
  resetSyncTimers();
  pendingByUid.clear();
  const prefix = "pending_sync:";
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
}

// 待下载图集合，按 uid 隔离并持久化。服务端只在下发菜谱时带上它引用的图，游标推进后就不再重发，
// 首同步里一张图断网失败若不记账，就固化成「永久缺封面」（spec §8.3 的「下一轮」靠它实现）。
const pendingFilesByUid = new Map<string, Set<string>>();

function pendingFilesKey(uid: string): string {
  return `pending_files:${uid}`;
}

function pendingFilesFor(uid: string | null): Set<string> {
  if (!uid) return new Set();
  let files = pendingFilesByUid.get(uid);
  if (!files) {
    try {
      const raw = localStorage.getItem(pendingFilesKey(uid));
      files = new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      files = new Set();
    }
    pendingFilesByUid.set(uid, files);
  }
  return files;
}

function persistPendingFiles(uid: string | null): void {
  if (!uid) return;
  const files = pendingFilesByUid.get(uid);
  try {
    if (!files || files.size === 0) localStorage.removeItem(pendingFilesKey(uid));
    else localStorage.setItem(pendingFilesKey(uid), JSON.stringify([...files]));
  } catch {
    // 集合丢了只是少补一次图，不能因此打断同步
  }
}

/**
 * 把远端下发的文件名并入待下载集合，再补一轮下载（不 await，失败只影响封面）。
 * 下载成功 / 本地已有 / 404 的名字从集合移除，瞬时失败（超时/断网/5xx）留着下次同步再试。
 */
function rememberAndDownloadFiles(uid: string, refs: FileRef[]): void {
  const files = pendingFilesFor(uid);
  for (const ref of refs) files.add(ref.name);
  persistPendingFiles(uid);
  const names = [...files];
  if (names.length === 0) return;
  void downloadPendingFiles(names)
    .then(({ retry }) => {
      // 只删掉本轮确实拿到归宿的名字；期间新并入的（不在 names 里）原样保留
      const keep = new Set(retry);
      const live = pendingFilesFor(uid);
      for (const name of names) if (!keep.has(name)) live.delete(name);
      persistPendingFiles(uid);
    })
    .catch(() => {
      // downloadPendingFiles 自身不抛；保险起见吞掉，别冒未处理 rejection
    });
}

/**
 * 把 `GET /community/recipes/{id}` 的详情载荷落进本地库（spec §11.1：浏览过的公开菜谱走本地缓存，
 * 详情页 / 图片 / 字典解析都复用现有落库与下载通道）。
 *
 * 走 applyRemoteChanges 的 LWW 合并而不是自己写 INSERT：远端的字典行与子行快照可能和本地
 * 已有数据同键，合并规则必须与 /sync 完全一致。图片下载不 await，失败只影响封面。
 */
export async function cacheCommunityChanges(changes: SyncPayload, db: Db = getDb()): Promise<void> {
  await applyRemoteChanges(changes, db);
  const uid = getCurrentServerUserId();
  if (uid) rememberAndDownloadFiles(uid, changes.files ?? []);
}

// 同步失败后按指数退避重新武装定时器：5s → 10s → 20s → 60s（上限）。
function scheduleRetry(): void {
  if (syncTimer) clearTimeout(syncTimer);
  const delay = Math.min(5000 * Math.pow(2, retryAttempt), 60000);
  retryAttempt++;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void performSync().catch(() => {});
  }, delay);
}

/** 把同步结果同步到 auth store，供 UI 显示「同步失败」而非误报「已同步」。 */
function markSyncResult(ok: boolean): void {
  try {
    useAuthStore().lastSyncFailed = !ok;
  } catch {
    // auth store 尚未初始化，忽略
  }
}

/**
 * 同步入口（带互斥）：并发调用时在途的同步不会被重复执行；若在途期间又有请求，
 * 标记 syncQueued，待本次结束后补跑一次，避免变更卡在队列里。
 */
export async function performSync(): Promise<boolean> {
  if (isSyncing) {
    syncQueued = true;
    return false;
  }
  isSyncing = true;
  try {
    return await doSync();
  } finally {
    isSyncing = false;
    if (syncQueued) {
      syncQueued = false;
      void performSync().catch(() => {});
    }
  }
}

async function doSync(): Promise<boolean> {
  const uid = getCurrentServerUserId();
  // 未登录 / 未配地址：一次网络都不发（spec §9.5）
  if (!uid || !hasBaseUrl()) return false;
  const db = getDb();

  // 全扫推送（spec §9.3）：不论首次还是增量，都推「我名下的全部菜谱（含墓碑）+ 全部字典行」，
  // 而不是只推队列——登出期间录的菜、被清掉的 localStorage 队列、上次崩在一半的推送都靠它补上。
  // LWW 幂等，重复推没有副作用；队列仍照常入队（防重复入队），日常写操作走 3s 防抖。
  const changes = await collectPushPayload();

  // 推送前先把图传上去。一张失败就整批不推菜谱、只推字典（spec §8.2）：
  // 宁可晚一个周期，也不要服务器上出现没封面的菜谱。
  let filesPending = false;
  if (!(await uploadPendingFiles(changes))) {
    changes.recipes = [];
    filesPending = true;
  }

  const lastSyncedAt = getLastSyncedAtFor(uid);
  const lastServerSeq = lastSyncedAt === null ? 0 : parseInt(lastSyncedAt, 10);

  // 记下请求发出时的收藏版本：响应回来时若已变，说明快照早于一次收藏操作（spec §7.2）
  favoriteOpsAtRequest = favoriteOps;

  let res: Awaited<ReturnType<typeof apiFetch<SyncResponse>>>;
  try {
    res = await apiFetch<SyncResponse>("/api/v1/sync", {
      method: "POST",
      body: JSON.stringify({
        last_server_seq: lastServerSeq,
        local_changes: changes,
      } as SyncRequest),
    });
  } catch (e) {
    // 拿不到 HTTP 响应（超时 / 断网）：apiFetch 抛异常。改动回队并退避重试，游标不推进。
    console.warn("[sync] 网络异常:", e);
    mergeChanges(pendingFor(uid), changes);
    persistPending(uid);
    markSyncResult(false);
    scheduleRetry();
    return false;
  }

  if (!res.ok || !res.data) {
    console.warn("[sync] 同步失败:", res.status);
    mergeChanges(pendingFor(uid), changes);
    persistPending(uid);
    markSyncResult(false);
    scheduleRetry();
    return false;
  }

  try {
    await applyRemoteChanges(res.data.remote_changes, db);
  } catch (e) {
    // 落地失败同样退回队列、退避重试，游标不推进（否则丢掉这批远端变更）
    console.warn("[sync] 应用远端变更失败:", e);
    mergeChanges(pendingFor(uid), changes);
    persistPending(uid);
    markSyncResult(false);
    scheduleRetry();
    return false;
  }

  // 图片下载不 await：失败只影响封面，不影响菜谱落地（spec §8.3）。
  // 远端只在下发菜谱时带上引用的图，游标推进后就不再重发 ⇒ 把没下来的名字记进按 uid
  // 持久化的待下载集合，每轮同步末尾再补一轮（瞬时失败下轮再试，404 放弃）。
  rememberAndDownloadFiles(uid, res.data.remote_changes.files ?? []);

  // 收藏对账（spec §7.2）：整表替换收藏集合 → 清别人的缓存副本。
  // 请求发出后若用户又动过收藏，这份响应快照已过期：对账会自己跳过，这里补跑一轮把它带上。
  await reconcileFavorites(uid, res.data.favorite_recipe_ids ?? [], db);
  if (favoriteOps !== favoriteOpsAtRequest) enqueueSync({});

  setLastSyncedAtFor(uid, String(res.data.server_seq));
  pendingByUid.set(uid, emptyPayload());
  persistPending(uid);
  try {
    useAuthStore().notifySyncComplete();
  } catch {
    // auth store 尚未初始化，忽略
  }
  if (filesPending) {
    // 图没传完 → 这批菜谱只是「晚一个周期」推，不是同步成功：界面要能区分，且必须安排退避
    // 重试（否则用户不编辑就永远推不上去）。不重置 retryAttempt，让退避计数继续涨。
    markSyncResult(false);
    scheduleRetry();
  } else {
    retryAttempt = 0;
  }
  return true;
}

async function buildRecipePayload(db: Db, row: Recipe): Promise<RecipePayload> {
  const steps = await db.select<{
    id: string;
    sort_order: number;
    text: string;
    image_path: string | null;
  }[]>(
    `SELECT id, sort_order, text, image_path FROM recipe_steps
     WHERE recipe_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC`,
    [row.id],
  );
  const ingredients = await db.select<{
    id: string;
    ingredient_id: string;
    amount: number | null;
    unit_id: string | null;
    sort_order: number;
  }[]>(
    `SELECT id, ingredient_id, amount, unit_id, sort_order FROM recipe_ingredients
     WHERE recipe_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC`,
    [row.id],
  );
  const labelRows = await db.select<{ label_id: string }[]>(
    "SELECT label_id FROM recipe_labels WHERE recipe_id = ?",
    [row.id],
  );

  return {
    id: row.id,
    owner_id: row.owner_id,
    name: row.name,
    cover_path: row.cover_path,
    category_id: row.category_id,
    is_public: row.is_public,
    owner_nickname: row.owner_nickname,
    owner_avatar_url: row.owner_avatar_url,
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    deleted_at: normDeleted(row.deleted_at),
    steps,
    ingredients,
    label_ids: labelRows.map((l) => l.label_id),
  };
}

/**
 * 组装全扫推送载荷（spec §9.3）：`owner_id = 我` 的全部菜谱（**含墓碑**，否则删不掉）
 * 加全部字典行（含软删行，否则服务端删不掉），子行随父菜谱整条带上。
 * 未登录时只带字典（不会走到这里——doSync 已早退）。
 */
export async function collectPushPayload(): Promise<SyncPayload> {
  const uid = getCurrentServerUserId();
  const db = getDb();

  const ingredients = await db.select<Ingredient[]>("SELECT * FROM ingredients");
  const units = await db.select<Unit[]>("SELECT * FROM units");
  const labels = await db.select<Label[]>("SELECT * FROM labels");
  const recipeRows = uid
    ? await db.select<Recipe[]>("SELECT * FROM recipes WHERE owner_id = ?", [uid])
    : [];

  return {
    ingredients: ingredients.map((r) => ({
      ...r,
      created_at: toIsoTimestamp(r.created_at),
      updated_at: toIsoTimestamp(r.updated_at),
      deleted_at: normDeleted(r.deleted_at),
    })),
    units: units.map((r) => ({
      ...r,
      created_at: toIsoTimestamp(r.created_at),
      updated_at: toIsoTimestamp(r.updated_at),
      deleted_at: normDeleted(r.deleted_at),
    })),
    labels: labels.map((r) => ({
      ...r,
      created_at: toIsoTimestamp(r.created_at),
      updated_at: toIsoTimestamp(r.updated_at),
      deleted_at: normDeleted(r.deleted_at),
    })),
    recipes: await Promise.all(recipeRows.map((row) => buildRecipePayload(db, row))),
    files: [],
  };
}

/** 按 id 组装一条菜谱的同步形状（写完立刻入队用）；行不存在返回 null。 */
export async function recipePayloadFor(
  id: string,
  db: Db = getDb(),
): Promise<RecipePayload | null> {
  const rows = await db.select<Recipe[]>("SELECT * FROM recipes WHERE id = ?", [id]);
  return rows.length === 0 ? null : buildRecipePayload(db, rows[0]);
}
