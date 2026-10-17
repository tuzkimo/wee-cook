// 截图收图 → 解码一次 → 按 longImage 的布局逐段编码（spec §5.1）。
//
// **canvas 与 Tauri 插件在这条链上只在本文件收口**（选图用 plugin-dialog / plugin-fs，编码用 canvas）。
// ⚠️ `imageStore` 的 1280px / 0.72 是「落盘封面」的规则，与这里的分段参数（1080 / 1500 / 0.8）是两回事，
// 别合并：那边的上限是给本地长期存储的，这边是为了每段都过一遍上游像素归一还能保持可读。
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { MSG_DECODE_FAILED, MSG_READ_FAILED, MSG_TOO_LARGE, MSG_TOO_LONG, MSG_UNSUPPORTED } from "@/services/ai/attachText";
import {
  MAX_SEGMENT_BYTES,
  planLongImage,
  type LongImageLayout,
  type Piece,
} from "@/services/ai/longImage";
import { sniffImageMime } from "@/services/imageStore";

/** 每段 JPEG 重编码质量。真机实测小字认不出时可只调这个常量 */
export const SEGMENT_JPEG_QUALITY = 0.8;

export interface Screenshot {
  segments: string[]; // 每段 JPEG 的 dataUrl，1..6 个
  cover: string; // 封面 JPEG 的 dataUrl
  coverBytes: Uint8Array; // 封面原始字节（跳转前交给 imageStore.saveImageBytes）
  width: number; // 整图缩放后
  height: number;
}

export type ScreenshotResult = { ok: true; shot: Screenshot } | { ok: false; message: string };

/** 解码一次 → 拿着 bitmap 按布局编码；测试注入假实现（happy-dom 没有真 canvas） */
export interface Decoded {
  width: number;
  height: number;
  render(plan: LongImageLayout): Promise<{ segments: string[]; cover: string }>;
  /** 释放底层位图。失败路径（布局被拒 / 编码报错）也要调，所以由 toScreenshot 收口 */
  close?(): void;
}

export interface ScreenshotDeps {
  pick(): Promise<Uint8Array | null>; // 选择器 + 读字节；null = 用户取消
  decode(bytes: Uint8Array): Promise<Decoded>;
}

/** 选择器里列的扩展名：只是 UX 过滤，准入看魔数 */
const PICK_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"];

/** sniffImageMime 不认 GIF（只认 JPEG/PNG/WebP），GIF 头在这里补上 */
function isGif(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const head = String.fromCharCode(...bytes.subarray(0, 6));
  return head === "GIF87a" || head === "GIF89a";
}

/** dataUrl 的 base64 段大小估算（4 字符 = 3 字节），别为它真去 atob 一遍 */
function base64Bytes(dataUrl: string): number {
  return ((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4;
}

/** dataUrl → 真字节。与 imageStore 的私有同名函数同形，但那边是私有的，不为它改公共模块 */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const binary = atob(comma < 0 ? "" : dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 字节 → 分段 + 封面。失败一律转成 `{ok:false, message}`，**不冒泡异常**。
 * `deps` 有默认值：分享链（Task 13）只传字节。
 */
export async function toScreenshot(
  bytes: Uint8Array,
  deps: Pick<ScreenshotDeps, "decode"> = realDeps,
): Promise<ScreenshotResult> {
  if (sniffImageMime(bytes) === null && !isGif(bytes)) return { ok: false, message: MSG_UNSUPPORTED };

  let decoded: Decoded;
  try {
    decoded = await deps.decode(bytes);
  } catch {
    return { ok: false, message: MSG_DECODE_FAILED };
  }

  const planned = planLongImage({ width: decoded.width, height: decoded.height });
  try {
    if (!planned.ok) {
      return { ok: false, message: planned.reason === "too_long" ? MSG_TOO_LONG : MSG_DECODE_FAILED };
    }
    const { segments, cover } = await decoded.render(planned.layout);
    if (segments.some((s) => base64Bytes(s) > MAX_SEGMENT_BYTES)) return { ok: false, message: MSG_TOO_LARGE };
    return {
      ok: true,
      shot: {
        segments,
        cover,
        coverBytes: dataUrlToBytes(cover),
        width: planned.layout.width,
        height: planned.layout.height,
      },
    };
  } catch {
    // 编码失败 / canvas 拿不到 2d context / 封面 dataUrl 不是 base64 —— 都是「打不开」
    return { ok: false, message: MSG_DECODE_FAILED };
  } finally {
    // 8MP 位图 = 32MB：布局被拒、超限、编码报错、成功四条路都得释放
    decoded.close?.();
  }
}

/** 源矩形 → 新 canvas 的 JPEG dataUrl。目标尺寸只取 `piece.width/height`（source.h 可能被夹短 1px） */
function encodePiece(bitmap: ImageBitmap, piece: Piece): string {
  const canvas = document.createElement("canvas");
  canvas.width = piece.width;
  canvas.height = piece.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no-2d-context");
  ctx.drawImage(
    bitmap,
    piece.source.x,
    piece.source.y,
    piece.source.w,
    piece.source.h,
    0,
    0,
    piece.width,
    piece.height,
  );
  return canvas.toDataURL("image/jpeg", SEGMENT_JPEG_QUALITY);
}

/** 生产默认依赖：真插件 + 真 canvas。happy-dom 里两样都没有，测试一律注入。 */
const realDeps: ScreenshotDeps = {
  async pick() {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "图片", extensions: PICK_EXTENSIONS }],
    });
    if (selected === null) return null;
    return readFile(selected);
  },
  async decode(bytes) {
    // 复制一份：TS 的 BlobPart 只收 ArrayBuffer 支撑的视图
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
    return {
      width: bitmap.width,
      height: bitmap.height,
      async render(plan) {
        if (plan.cover === null) throw new Error("no-cover");
        return { segments: plan.segments.map((piece) => encodePiece(bitmap, piece)), cover: encodePiece(bitmap, plan.cover) };
      },
      close() {
        bitmap.close();
      },
    };
  },
};

/** 相册选一张 → 截图。`null` = 用户取消（不是错误，页面什么都不做）。 */
export async function pickScreenshot(deps: ScreenshotDeps = realDeps): Promise<ScreenshotResult | null> {
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.pick();
  } catch {
    // open / readFile 抛错也归可展示的失败：取消是返回 null，不是抛，所以这里不会误吞取消
    return { ok: false, message: MSG_READ_FAILED };
  }
  if (bytes === null) return null;
  return toScreenshot(bytes, deps);
}
