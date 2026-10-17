// 长图缩放 / 分段 / 封面几何（spec §5.1）。纯函数，无 DOM，无 canvas。
import { describe, expect, it } from "vitest";
import {
  MAX_SEGMENT_BYTES,
  MAX_SEGMENT_HEIGHT,
  MAX_SEGMENTS,
  MAX_WIDTH,
  SEGMENT_OVERLAP,
  UPSTREAM_NORMALIZE_PIXELS,
  planLongImage,
  type LongImageLayout,
} from "@/services/ai/longImage";

function okLayout(size: { width: number; height: number }): LongImageLayout {
  const r = planLongImage(size);
  if (!r.ok) throw new Error(`预期 ok，实际 ${r.reason}`);
  return r.layout;
}

describe("长图几何", () => {
  it("常量逐字钉死（改了就是换上游，必须连带改看门用例）", () => {
    expect([MAX_WIDTH, MAX_SEGMENT_HEIGHT, SEGMENT_OVERLAP, MAX_SEGMENTS]).toEqual([1080, 1500, 120, 6]);
    expect(MAX_SEGMENT_BYTES).toBe(1048576);
  });

  it("任意一段的输出像素数都不超过上游归一阈值 1300×1300", () => {
    const layout = okLayout({ width: 1080, height: 8400 }); // 恰好 6 段的边界
    for (const p of layout.segments) {
      expect(p.width * p.height).toBeLessThanOrEqual(1_690_000);
    }
    expect(MAX_WIDTH * MAX_SEGMENT_HEIGHT).toBeLessThanOrEqual(UPSTREAM_NORMALIZE_PIXELS);
  });

  it("宽度大于 1080 才缩；已经是 1080 或更窄时不放大", () => {
    expect(planLongImage({ width: 2160, height: 4000 })).toMatchObject({ ok: true, layout: { width: 1080 } });
    expect(planLongImage({ width: 720, height: 1000 })).toMatchObject({ ok: true, layout: { width: 720 } });
  });

  it("短图不分段，封面就是整张（高不超过 4/3 宽）", () => {
    const layout = okLayout({ width: 1080, height: 900 });
    expect(layout.segments).toHaveLength(1);
    expect(layout.segments[0]).toMatchObject({ width: 1080, height: 900 });
    expect(layout.cover).toMatchObject({ width: 1080, height: 900 });
  });

  it("相邻段重叠 120px，最后一段可以更短", () => {
    const layout = okLayout({ width: 1080, height: 3000 });
    expect(layout.segments.map((p) => ({ y: p.source.y, h: p.source.h }))).toEqual([
      { y: 0, h: 1500 },
      { y: 1380, h: 1500 },
      { y: 2760, h: 240 },
    ]);
    for (let i = 1; i < layout.segments.length; i += 1) {
      const prev = layout.segments[i - 1];
      const cur = layout.segments[i];
      expect(prev.source.y + prev.height - cur.source.y).toBe(120);
    }
  });

  it("第 7 段触发拒绝：too_long", () => {
    expect(planLongImage({ width: 1080, height: 8401 })).toEqual({ ok: false, reason: "too_long" });
    expect(planLongImage({ width: 1080, height: 8400 })).toMatchObject({ ok: true });
  });

  it("极端纵横比与 1px 短边不出现 0 边", () => {
    const r = okLayout({ width: 20000, height: 1000 }); // 横图：缩放、单段
    const t = okLayout({ width: 60, height: 1200 }); // 1:20
    for (const p of [...r.segments, t.segments[0]]) {
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
    }
  });

  it("宽或高为 0 / 负数 / 非有限数 ⇒ invalid", () => {
    expect(planLongImage({ width: 0, height: 100 })).toEqual({ ok: false, reason: "invalid" });
    expect(planLongImage({ width: 100, height: 0 })).toEqual({ ok: false, reason: "invalid" });
    expect(planLongImage({ width: -1, height: 100 })).toEqual({ ok: false, reason: "invalid" });
    expect(planLongImage({ width: 100, height: -1 })).toEqual({ ok: false, reason: "invalid" });
    expect(planLongImage({ width: Number.NaN, height: 100 })).toEqual({ ok: false, reason: "invalid" });
    expect(planLongImage({ width: 100, height: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("cover 取顶部第一屏，且在整图范围内", () => {
    const layout = okLayout({ width: 1000, height: 5000 });
    expect(layout.cover).toMatchObject({ source: { x: 0, y: 0 }, width: 1000 });
    if (layout.cover === null) throw new Error("预期有封面");
    expect(layout.cover.height).toBeLessThanOrEqual(1333); // round(1000*4/3)
  });
});
