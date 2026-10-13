import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  JPEG_QUALITY,
  imageSrc,
  pickAndSaveImage,
  saveImageBytes,
  scaleToFit,
  setImageBaseDir,
  sniffImageMime,
  type ImageDeps,
} from "@/services/imageStore";

// happy-dom 里没有 Tauri 运行时，convertFileSrc 的真实现会去摸 window.__TAURI_INTERNALS__ ⇒
// 换成一条可断言的纯字符串映射，测的是「拼出来的路径对不对」。
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

const JPEG_DATA_URL = "data:image/jpeg;base64,/9j/4A==";

/** 手写假 deps：本任务测的是规则，真 canvas / 真插件在 happy-dom 里都跑不起来。 */
function fakeDeps(overrides: Partial<ImageDeps> = {}) {
  const writes: { name: string; bytes: Uint8Array }[] = [];
  const deps: ImageDeps = {
    pickFromGallery: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    decodeToJpeg: async () => ({ dataUrl: JPEG_DATA_URL, width: 1280, height: 960 }),
    writeImage: async (name, bytes) => {
      writes.push({ name, bytes });
    },
    ...overrides,
  };
  return { deps, writes };
}

describe("scaleToFit", () => {
  it("最长边是长边时缩到 1280，短边按比例", () => {
    expect(scaleToFit({ width: 4000, height: 3000 })).toEqual({ width: 1280, height: 960, scaled: true });
  });

  it("竖图以高度为准", () => {
    expect(scaleToFit({ width: 1080, height: 4000 })).toEqual({ width: 346, height: 1280, scaled: true });
  });

  it("小图不放大", () => {
    expect(scaleToFit({ width: 800, height: 600 })).toEqual({ width: 800, height: 600, scaled: false });
  });
});

describe("sniffImageMime", () => {
  it("按字节头认类型，认不出的返回 null", () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(
      sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image/webp");
    expect(sniffImageMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("saveImageBytes", () => {
  it("JPEG 质量参数是 0.72", () => {
    expect(JPEG_QUALITY).toBe(0.72);
  });

  it("落盘文件名以 images/ 开头、数据库侧返回的是裸文件名", async () => {
    const { deps, writes } = fakeDeps();
    const result = await saveImageBytes(new Uint8Array([1, 2, 3]), deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("应当成功");
    expect(result.name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
    expect(writes).toHaveLength(1);
    expect(writes[0].name).toBe(`images/${result.name}`);
    // 落的是解码后的真字节，不是 data URL 字符串
    expect(Buffer.from(writes[0].bytes).toString("base64")).toBe("/9j/4A==");
  });

  it("decodeToJpeg 抛错 → 返回「这张图读不出来，换一张试试」且没有写盘", async () => {
    const { deps, writes } = fakeDeps({
      decodeToJpeg: async () => {
        throw new Error("cannot decode");
      },
    });

    expect(await saveImageBytes(new Uint8Array([1, 2, 3]), deps)).toEqual({
      ok: false,
      message: "这张图读不出来，换一张试试",
    });
    expect(writes).toHaveLength(0);
  });

  it("writeImage 抛错 → 返回 ok:false，不冒泡异常", async () => {
    const { deps } = fakeDeps({
      writeImage: async () => {
        throw new Error("disk full");
      },
    });

    // 与解码失败分开：用户能做的是重试，不是换一张图
    expect(await saveImageBytes(new Uint8Array([1, 2, 3]), deps)).toEqual({
      ok: false,
      message: "图片保存失败，稍后再试",
    });
  });

  it("解码结果为空 → 归「读不出来」，不落一个 0 字节文件", async () => {
    const { deps, writes } = fakeDeps({
      decodeToJpeg: async () => ({ dataUrl: "data:image/jpeg;base64,", width: 0, height: 0 }),
    });

    expect(await saveImageBytes(new Uint8Array([1, 2, 3]), deps)).toEqual({
      ok: false,
      message: "这张图读不出来，换一张试试",
    });
    expect(writes).toHaveLength(0);
  });
});

describe("pickAndSaveImage", () => {
  it("pickFromGallery 返回 null 时整条链路返回 null，不写盘", async () => {
    const { deps, writes } = fakeDeps({ pickFromGallery: async () => null });

    expect(await pickAndSaveImage(deps)).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it("pickFromGallery 抛错 → 返回「打不开这张图，换一张试试」且没有写盘", async () => {
    const { deps, writes } = fakeDeps({
      pickFromGallery: async () => {
        throw new Error("content:// read failed");
      },
    });

    // 取图阶段失败（open 或 readFile 抛）也不能静默：本模块**不抛**
    expect(await pickAndSaveImage(deps)).toEqual({
      ok: false,
      message: "打不开这张图，换一张试试",
    });
    expect(writes).toHaveLength(0);
  });
});

describe("imageSrc", () => {
  it("imageSrc(name) 返回 convertFileSrc 出来的地址", () => {
    setImageBaseDir("/data/app");
    expect(imageSrc("a.jpg")).toBe("asset://localhost//data/app/images/a.jpg");
  });
});
