// 图片：压缩 → 落盘 → 返回裸文件名（规格 §7）。**图片文件通道里唯一接触 canvas 与文件系统的地方**
// （Task 9 的编辑页与 Task 8/10 的列表/详情页只通过 `imageSrc()` 拿地址）。
//
// ⚠️ 与姊妹仓 `wee-count/src/services/ai/imageScale.ts` 的**两处故意不抄**，别当成漏抄：
//   1. **不抄「压缩后超 1 MiB 就拒绝」的闸门**。那是给上传云端 AI 接口设的限制；本项目图只落本地盘，
//      没有理由拒绝用户刚拍的照片（规格 §7、§10.4）。
//   2. **不抄 `ACCEPTED_MIME` 白名单**。新 Android 手机默认用高效存储拍 HEIC，照抄白名单会让
//      用户刚拍的封面被拒。准入交给解码器判决：`createImageBitmap` 解不开（或 canvas 拿不到 2d context）
//      就是唯一的拒绝理由，文案固定「这张图读不出来，换一张试试」，不写盘。
//
// 为什么要有注入缝（`ImageDeps`）：happy-dom 里 `createImageBitmap` 是 `undefined`、
// `canvas.getContext("2d")` 返回 `null`、Tauri 插件没有 IPC —— 转码与 IO 写死在模块内部就**没测了**。
// 所以三个 IO 全部从参数进来、默认用真实现（`realDeps`），写法照 `wee-count/src/services/ai/imageInput.ts`。
//
// ⚠️ 落盘名与库里的名**不是同一个字符串**：写盘路径带 `images/` 前缀，数据库只存裸的 `<uuid>.jpg`
// （规格 §7：Android 的应用目录路径会随安装变化，绝不能存绝对路径）。`imageSrc()` 负责把两者拼回去。
import { convertFileSrc } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-dialog";

/** 图片最长边上限（像素）。规格 §7：本地压缩到最长边 1280px */
export const MAX_EDGE = 1280;

/** 重编码 JPEG 的质量。0.72 是起点值，真机实测小字认不出时可只调这个常量 */
export const JPEG_QUALITY = 0.72;

/** 解码失败的唯一文案（规格 §7、§10.4） */
const MSG_DECODE_FAILED = "这张图读不出来，换一张试试";
/** 写盘失败（磁盘满、目录没权限）—— 与「读不出来」分开，用户能做的是重试而不是换图 */
const MSG_WRITE_FAILED = "图片保存失败，稍后再试";
/** 取图阶段失败（选择器打不开、Android 的 content:// 读不到）—— 与「解码失败」区分：图根本还没拿到 */
const MSG_PICK_FAILED = "打不开这张图，换一张试试";

/** 选择器里列的扩展名：**只是 UX 过滤**，不参与准入判断（准入只看解码器能不能解开） */
const PICK_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "heif"];

export interface ImageSize {
  width: number;
  height: number;
}

export interface ScaledSize extends ImageSize {
  /** true 表示发生了重编码缩放（false 时返回的就是原尺寸） */
  scaled: boolean;
}

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

/**
 * 按长边等比缩到 `maxEdge` 以内；**永不返回 0 边**。
 *
 * 极端长宽比（如 20000×3）下较短边的 `Math.round` 会得到 0，而 0 边画进 canvas 会直接抛
 * `IndexSizeError` ⇒ 用 `Math.max(1, …)` 兜底；1px 的短边在视觉上等价于"一条线"，
 * 比"整张图打不开"好。长边**恰好等于**上限时不缩放（边界用 `<=`，否则白白重编码一次、掉一次画质）。
 */
export function scaleToFit(size: ImageSize, maxEdge: number = MAX_EDGE): ScaledSize {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxEdge) return { width: size.width, height: size.height, scaled: false };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(size.width * ratio)),
    height: Math.max(1, Math.round(size.height * ratio)),
    scaled: true,
  };
}

/**
 * 魔数嗅探：只认 JPEG / PNG / WebP，其余一律 `null`。
 *
 * ⚠️ **本项目没有生产调用方**（裁决 R5）：转码走 `createImageBitmap`，它按内容解码、不看 MIME，
 * 所以魔数**不参与准入**（准入判据只有一条：解码器解不解得开，见文件头）。留着它是为了
 * 「压缩前先知道源类型」这条判据将来要用时不必重写，且单元测试直接断言它。
 * 别把它接成一道否决权 —— ANIM/APNG 与静态图字节头完全同构，魔数判不出"静态"。
 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  // JPEG：SOI 标记 FF D8 + 紧随其后必须是一个标记（0xFF 打头）
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // PNG：\x89PNG\r\n\x1a\n
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // WebP：RIFF 容器头 + `WEBP` 四字符编码
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** `null` = 用户取消（不是错误，页面什么都不做）；`{ok:false}` = 拒绝，附用户可见文案。本模块**不抛**。 */
export type SaveImageResult = { ok: true; name: string } | { ok: false; message: string };

/** 注入缝：三个 IO 全部可换。默认值见 `realDeps`。 */
export interface ImageDeps {
  pickFromGallery: () => Promise<Uint8Array | null>;
  decodeToJpeg: (bytes: Uint8Array) => Promise<{ dataUrl: string; width: number; height: number }>;
  writeImage: (name: string, bytes: Uint8Array) => Promise<void>;
}

/** 图片根目录（`$APPDATA`）。由 `main.ts` 在 mount 前 `setImageBaseDir(await appDataDir())` 定下来 */
let baseDir = "";

export function setImageBaseDir(dir: string): void {
  baseDir = dir;
}

/** 库里存的裸文件名 → 可放进 `<img src>` 的地址（asset protocol，见 tauri.conf.json 的 assetProtocol） */
export function imageSrc(name: string): string {
  return convertFileSrc(`${baseDir}/images/${name}`);
}

/** data URL 的 base64 段 → 真字节。落盘要的是字节，不是那串字符串（base64 比原图大 1/3） */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const binary = atob(comma < 0 ? "" : dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 字节 → 压缩后的 JPEG。真实现用 `createImageBitmap` 解码 + canvas 重编码；
 * ⚠️ 不给 `scaleToFit` 传第二个参数：`maxEdge` 一旦从调用点传进来，1280px 这条常量就被绕过了。
 */
async function decodeToJpeg(bytes: Uint8Array): Promise<{ dataUrl: string; width: number; height: number }> {
  // 复制一份：TS 的 BlobPart 只收 ArrayBuffer 支撑的视图，而注入缝的签名是 Uint8Array<ArrayBufferLike>。
  // 这次复制的开销远小于解码本身（8MP 位图 = 32MB），不值得为它加一个 @ts-expect-error
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  const target = scaleToFit({ width: bitmap.width, height: bitmap.height });
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no-2d-context");
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close();
  return { dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY), width: target.width, height: target.height };
}

/** 生产默认依赖：真插件 + 真 canvas。happy-dom 里三样都没有（没有真 canvas、没有 IPC），测试一律注入假 deps。 */
const realDeps: ImageDeps = {
  async pickFromGallery() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "图片", extensions: PICK_EXTENSIONS }],
    });
    if (selected === null) return null;
    return readFile(selected);
  },
  decodeToJpeg,
  async writeImage(name, bytes) {
    // 目标目录要自己建（spec §2 的应用目录不会预置 images/）
    await mkdir(await join(baseDir, "images"), { recursive: true });
    await writeFile(await join(baseDir, name), bytes);
  },
};

/**
 * 字节 → 落盘（规格 §7）。失败一律转成 `{ok:false}`，**不冒泡异常**：
 * 调用方（编辑页）只需展示文案，且解码失败时不清空表单其余部分。
 */
export async function saveImageBytes(bytes: Uint8Array, deps: ImageDeps = realDeps): Promise<SaveImageResult> {
  let jpeg: Uint8Array;
  try {
    jpeg = dataUrlToBytes((await deps.decodeToJpeg(bytes)).dataUrl);
    // 空结果别落成 0 字节文件：以后只会显示成坏图，不如现在就说读不出来
    if (jpeg.length === 0) throw new Error("empty-jpeg");
  } catch {
    // 解不开 / canvas 拿不到 2d context / 编出来的 data URL 不是 base64 —— 都归"读不出来"
    return { ok: false, message: MSG_DECODE_FAILED };
  }

  // 库里的名（裸文件名）与写盘的名（带 images/ 前缀）从这里分叉
  const name = `${crypto.randomUUID()}.jpg`;
  try {
    await deps.writeImage(`images/${name}`, jpeg);
  } catch {
    return { ok: false, message: MSG_WRITE_FAILED };
  }
  return { ok: true, name };
}

/** 相册选一张并落盘。`null` = 用户在选择器里点了取消。 */
export async function pickAndSaveImage(deps: ImageDeps = realDeps): Promise<SaveImageResult | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.pickFromGallery();
  } catch {
    // open 或 readFile 抛错也归可展示的失败：取消是返回 null，不是抛，所以这里不会误吞取消
    return { ok: false, message: MSG_PICK_FAILED };
  }
  if (bytes === null) return null;
  return saveImageBytes(bytes, deps);
}
