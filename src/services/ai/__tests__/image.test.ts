// 选图 → 解码一次 → 按 longImage 的布局逐段编码（spec §5.1）。happy-dom 没有真 canvas，
// 所以测试全部注入假 decode；体积闸门用 base64 字符串的真实长度造出来。
import { describe, expect, it } from "vitest";
import {
  MSG_DECODE_FAILED,
  MSG_READ_FAILED,
  MSG_TOO_LARGE,
  MSG_TOO_LONG,
  MSG_UNSUPPORTED,
} from "@/services/ai/attachText";
import { pickScreenshot, toScreenshot, type Decoded, type ScreenshotResult } from "@/services/ai/image";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const GIF = new TextEncoder().encode("GIF89a");

/** 造一个 base64 长度恰好对应 `bytes` 字节的 JPEG dataUrl（4 字符 = 3 字节） */
function jpegDataUrl(bytes: number): string {
  return `data:image/jpeg;base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`;
}

const fakeDecoded = (w: number, h: number, segBytes = 200_000): Decoded => ({
  width: w,
  height: h,
  async render(plan) {
    return { segments: plan.segments.map(() => jpegDataUrl(segBytes)), cover: jpegDataUrl(100_000) };
  },
});

function expectFailure(r: ScreenshotResult | null, message: string): void {
  expect(r).toEqual({ ok: false, message });
}

describe("toScreenshot", () => {
  it("正常长图 ⇒ 段数与 planLongImage 一致，封面字节非空", async () => {
    const r = await toScreenshot(PNG, { decode: async () => fakeDecoded(1080, 6000) });
    if (!r.ok) throw new Error(`预期 ok，实际 ${r.message}`);
    expect(r.shot.segments).toHaveLength(5);
    expect(r.shot.width).toBe(1080);
    expect(r.shot.height).toBe(6000);
    expect(r.shot.cover.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(r.shot.coverBytes.length).toBeGreaterThan(0);
  });

  it("非图片魔数 ⇒ 拒绝，文案逐字", async () => {
    let decoded = false;
    const deps = {
      decode: async () => {
        decoded = true;
        return fakeDecoded(1080, 1000);
      },
    };
    expectFailure(await toScreenshot(new TextEncoder().encode("%PDF-1.7"), deps), MSG_UNSUPPORTED);
    expectFailure(await toScreenshot(new Uint8Array([1, 2, 3, 4, 5]), deps), MSG_UNSUPPORTED);
    expect(decoded).toBe(false);
  });

  it("GIF 改名成 .jpg 也接受（首帧由解码器决定）", async () => {
    const r = await toScreenshot(GIF, { decode: async () => fakeDecoded(1080, 1000) });
    expect(r).toMatchObject({ ok: true });
  });

  it("任何一段编码后 > 1 MiB ⇒ 整张拒绝", async () => {
    // (1<<20)+3 字节才真的超过上限；恰好上限内（1048575）必须放行
    expectFailure(await toScreenshot(PNG, { decode: async () => fakeDecoded(1080, 2000, (1 << 20) + 3) }), MSG_TOO_LARGE);
    expect(await toScreenshot(PNG, { decode: async () => fakeDecoded(1080, 2000, (1 << 20) - 1) })).toMatchObject({
      ok: true,
    });
  });

  it("段数 > 6 ⇒ 拒绝并提示太长了", async () => {
    expectFailure(await toScreenshot(PNG, { decode: async () => fakeDecoded(1080, 9000) }), MSG_TOO_LONG);
  });

  it("位图每条退出路径都释放：布局被拒、渲染抛错、成功都不漏", async () => {
    const closed = { tooLong: 0, renderErr: 0, ok: 0 };
    await toScreenshot(PNG, {
      decode: async () => ({ ...fakeDecoded(1080, 9000), close: () => void (closed.tooLong += 1) }),
    });
    await toScreenshot(PNG, {
      decode: async () => ({
        width: 1080,
        height: 1000,
        close: () => void (closed.renderErr += 1),
        render: async () => {
          throw new Error("canvas gone");
        },
      }),
    });
    await toScreenshot(PNG, {
      decode: async () => ({ ...fakeDecoded(1080, 1000), close: () => void (closed.ok += 1) }),
    });
    // 未释放 = 32MB 位图泄漏（render 不再自己 close，全靠 toScreenshot 收口）
    expect(closed).toEqual({ tooLong: 1, renderErr: 1, ok: 1 });
  });

  it("解码抛错 ⇒ 「这张图片打不开」，不冒泡", async () => {
    const r = await toScreenshot(PNG, {
      decode: async () => {
        throw new Error("boom");
      },
    });
    expectFailure(r, MSG_DECODE_FAILED);
  });

  it("渲染抛错 / 尺寸非法 ⇒ 「这张图片打不开」", async () => {
    expectFailure(
      await toScreenshot(PNG, {
        decode: async () => ({
          width: 1080,
          height: 1000,
          render: async () => {
            throw new Error("canvas gone");
          },
        }),
      }),
      MSG_DECODE_FAILED,
    );
    expectFailure(await toScreenshot(PNG, { decode: async () => fakeDecoded(0, 1000) }), MSG_DECODE_FAILED);
  });
});

describe("pickScreenshot", () => {
  it("取消返回 null", async () => {
    const r = await pickScreenshot({ pick: async () => null, decode: async () => fakeDecoded(1080, 1000) });
    expect(r).toBeNull();
  });

  it("读文件失败给「读不到这张图片」", async () => {
    const r = await pickScreenshot({
      pick: async () => {
        throw new Error("readFile failed");
      },
      decode: async () => fakeDecoded(1080, 1000),
    });
    expectFailure(r, MSG_READ_FAILED);
  });

  it("选到图 ⇒ 走 toScreenshot", async () => {
    const r = await pickScreenshot({ pick: async () => PNG, decode: async () => fakeDecoded(1080, 1000) });
    expect(r).toMatchObject({ ok: true });
  });
});
