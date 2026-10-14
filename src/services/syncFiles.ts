// 图片通道（spec §8）：同步开始时把本地新图片推上去，同步回来后把远端引用到的图拉下来。
//
// 与 `imageStore.ts` 的分工：那一个负责「选图 → 压缩 → 落盘」，本文件只搬运已落盘的图。
// 目录约定两边一致：库里只存裸文件名，磁盘上是 `$APPDATA/images/<name>`。
//
// 两条硬约定：
//  1. spec §8.2：一张图传不上去 → `uploadPendingFiles` 返回 false，调用方据此清空本批菜谱、只推字典
//     —— 宁可晚一个周期，也不要服务器上出现没封面的菜谱。
//  2. spec §8.3：下载失败只记账不抛 —— 菜谱先落库、图后补，UI 上就是暂时没封面。
//
// 注入缝（`FileSyncDeps`）照 `imageStore.ts` 的 `ImageDeps` 写法：happy-dom 里没有 Tauri IPC，
// 真 readFile/exists/writeFile/rename 都跑不起来 ⇒ 四个 IO 从参数进来、默认用 `realDeps`。
import { BaseDirectory, exists, mkdir, readFile, rename, writeFile } from "@tauri-apps/plugin-fs";
import { getDb } from "@/db";
import { fetchWithAuth, hasBaseUrl } from "@/services/api";

/** 远端 `files` 列表的一项（spec §7.1）。本轮只用名字，`size` 留给以后做进度/校验 */
export interface FileRef {
  name: string;
  size: number;
}

/**
 * 本文件只读菜谱里引用的图片名，所以只声明用到的那两个字段。
 * Task 6 的 `SyncPayload` 结构上是它的超集，直接传进来即可（不必 import 本类型）——
 * 真身仍由 Task 6 的 `sync.ts` 定义导出，避免两处同名类型互为导向。
 */
export interface SyncPayload {
  recipes: { cover_path: string | null; steps: { image_path: string | null }[] }[];
}

/** 注入缝：四个 IO 全部可换。路径都是相对 `$APPDATA` 的，如 `images/<name>` */
export interface FileSyncDeps {
  readFile: (path: string) => Promise<Uint8Array>;
  exists: (path: string) => Promise<boolean>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
}

/** 生产默认依赖：真插件。测试一律注入假 deps（没有真 IPC） */
const realDeps: FileSyncDeps = {
  readFile: (path) => readFile(path, { baseDir: BaseDirectory.AppData }),
  exists: (path) => exists(path, { baseDir: BaseDirectory.AppData }),
  async writeFile(path, bytes) {
    // images/ 在全新安装的机器上不存在（spec §2 不预置应用目录里的子目录）
    await mkdir("images", { baseDir: BaseDirectory.AppData, recursive: true });
    await writeFile(path, bytes, { baseDir: BaseDirectory.AppData });
  },
  // 临时名与正式名同目录（都在 images/），同盘 rename 才是原子的
  rename: (from, to) =>
    rename(from, to, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData }),
};

/** `changes` 里所有菜谱引用到的图片名（封面 + 步骤图），去重、跳过 null */
export function collectReferencedFileNames(changes: SyncPayload): string[] {
  const names = new Set<string>();
  for (const recipe of changes.recipes) {
    if (recipe.cover_path) names.add(recipe.cover_path);
    for (const step of recipe.steps) if (step.image_path) names.add(step.image_path);
  }
  return [...names];
}

/**
 * 上传 `uploaded_files` 里没有的图。`true` = 全部成功（含没有要传的）。
 *
 * **任一失败即 false**，失败的那张不写 `uploaded_files`，下次同步自然重试（spec §8.2）。
 * 批次里其它成功的照常记录 —— 已经传上去的不必重传。
 */
export async function uploadPendingFiles(
  changes: SyncPayload,
  deps: FileSyncDeps = realDeps,
): Promise<boolean> {
  const names = collectReferencedFileNames(changes);
  if (names.length === 0) return true;
  // 地址没配就不发任何请求（api 层约定）；图没传完不能算成功，否则调用方会推没封面的菜谱
  if (!hasBaseUrl()) return false;

  let uploaded: Set<string>;
  try {
    // 只查一次，不是每个文件查一次
    const rows = await getDb().select<{ name: string }[]>("SELECT name FROM uploaded_files");
    uploaded = new Set(rows.map((r) => r.name));
  } catch {
    return false;
  }

  let allDone = true;
  for (const name of names) {
    if (uploaded.has(name)) continue;
    try {
      const raw = await deps.readFile(`images/${name}`);
      const res = await fetchWithAuth(`/api/v1/files?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        // 复制一份：TS 的 BodyInit 只收 ArrayBuffer 支撑的视图，注入缝给的是 Uint8Array<ArrayBufferLike>。
        // 这次复制的开销远小于上传本身，不值得为它加一个 @ts-expect-error（imageStore 同一手法）
        body: new Uint8Array(raw),
      });
      if (!res.ok) throw new Error(`上传失败：HTTP ${res.status}`);
      await getDb().execute("INSERT OR REPLACE INTO uploaded_files (name, uploaded_at) VALUES (?, ?)", [
        name,
        new Date().toISOString(),
      ]);
    } catch {
      // 断网、超 5MB、服务端拒绝、本地读不到 —— 都只是「这次没传上去」，留待下次
      allDone = false;
    }
  }
  return allDone;
}

/**
 * 串行下载本地没有的图。失败只累加 `failed`，**不抛**（spec §8.3：菜谱先落库、图后补）。
 * 404 本轮记一次失败即止，不重试、不阻塞后面的文件。
 */
export async function downloadMissingFiles(
  refs: FileRef[],
  deps: FileSyncDeps = realDeps,
): Promise<{ downloaded: number; failed: number }> {
  // 地址没配就是「没开始」，不是「每张都失败」：报 N 个失败等于把缺配置伪装成 N 张坏图，
  // 且会白做 N 次 exists。不发任何请求（api 层约定），也不记失败
  if (!hasBaseUrl()) return { downloaded: 0, failed: 0 };

  let downloaded = 0;
  let failed = 0;

  // 串行：家庭场景一次几十张，不值得为并发加一层池子，也避免同时写盘互相抢
  for (const ref of refs) {
    const path = `images/${ref.name}`;
    try {
      if (await deps.exists(path)) continue;

      const res = await fetchWithAuth(`/api/v1/files/${encodeURIComponent(ref.name)}`);
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // 200 也可能是空 body（服务端契约之外的故障）。空文件一旦 rename 成正式名，
      // 下次 exists 就为真、永不重下 ⇒ 当失败处理。在写盘前拦下，连 .tmp 都不会产生
      if (bytes.length === 0) throw new Error("下载内容为空");

      // 临时名再改名：断网/杀进程留下的是 .tmp，正式名要么不存在、要么就是完整文件
      const tmp = `${path}.tmp`;
      await deps.writeFile(tmp, bytes);
      await deps.rename(tmp, path);
      downloaded++;
    } catch {
      failed++;
    }
  }

  return { downloaded, failed };
}
