// 长图缩放 / 分段 / 封面几何（spec §5.1）。纯函数：不读 DOM，不碰 canvas，
// 只产出「原图源矩形 + 输出尺寸」，由 Task 6 的编码层去 drawImage。
//
// 两个尺寸常量（1080 / 1500）是从上游「总像素归一到 1300×1300」反推的：
// 1080×1500 = 1_620_000 ≤ 1300×1300，保证每段再过一次上游也不会被二次压缩。
// 换供应商必须重算这两个数，并同步改本文件的像素看门用例（§5.1 / §6.1）。
export const MAX_WIDTH = 1080;
export const MAX_SEGMENT_HEIGHT = 1500;
export const SEGMENT_OVERLAP = 120;
export const MAX_SEGMENTS = 6;
export const MAX_SEGMENT_BYTES = 1 << 20;
/** 上游二次归一的像素阈值；段像素数不得超过它（§5.1 的看门） */
export const UPSTREAM_NORMALIZE_PIXELS = 1300 * 1300;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `source` 是**原图**坐标；`width/height` 是缩放后的输出尺寸 */
export interface Piece {
  source: Rect;
  width: number;
  height: number;
}

export interface LongImageLayout {
  width: number; // 整图缩放后的宽（= min(原宽, 1080)）
  height: number; // 整图缩放后的高
  cover: Piece | null;
  segments: Piece[];
}

export type LayoutResult = { ok: true; layout: LongImageLayout } | { ok: false; reason: "invalid" | "too_long" };

const SEGMENT_STEP = MAX_SEGMENT_HEIGHT - SEGMENT_OVERLAP;

/** 输出坐标 (x,y,w,h) → 原图坐标。除回 scale 让 drawImage 的源矩形与输出尺寸一一对应。 */
function toSource(y: number, w: number, h: number, scale: number): Rect {
  return { x: 0, y: Math.round(y / scale), w: Math.round(w / scale), h: Math.round(h / scale) };
}

export function planLongImage(size: { width: number; height: number }): LayoutResult {
  const { width, height } = size;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: "invalid" };
  }

  const scale = Math.min(1, MAX_WIDTH / width);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const count = 1 + Math.ceil(Math.max(0, outH - MAX_SEGMENT_HEIGHT) / SEGMENT_STEP);
  if (count > MAX_SEGMENTS) return { ok: false, reason: "too_long" };

  const segments: Piece[] = [];
  for (let i = 0; i < count; i += 1) {
    const y = i * SEGMENT_STEP;
    const h = Math.min(MAX_SEGMENT_HEIGHT, outH - y);
    segments.push({ source: toSource(y, outW, h, scale), width: outW, height: h });
  }

  const coverH = Math.min(outH, Math.round((outW * 4) / 3));
  return {
    ok: true,
    layout: {
      width: outW,
      height: outH,
      cover: { source: toSource(0, outW, coverH, scale), width: outW, height: coverH },
      segments,
    },
  };
}
