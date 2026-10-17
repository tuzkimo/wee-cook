// 截图 / 分享链的用户可见文案（唯一一份）。这些字符串用户会直接看到，逐字钉死。
import { describe, expect, it } from "vitest";
import {
  MSG_DECODE_FAILED,
  MSG_MULTIPLE_TAKEN,
  MSG_NO_STREAM,
  MSG_READ_FAILED,
  MSG_TOO_LARGE,
  MSG_TOO_LONG,
  MSG_UNSUPPORTED,
  messageForShareCode,
} from "@/services/ai/attachText";

describe("截图 / 分享文案", () => {
  it("常量逐字", () => {
    expect(MSG_UNSUPPORTED).toBe("只支持 JPEG / PNG / WebP / GIF 图片");
    expect(MSG_READ_FAILED).toBe("读不到这张图片，请重试");
    expect(MSG_DECODE_FAILED).toBe("这张图片打不开");
    expect(MSG_TOO_LARGE).toBe("图片太大，换一张或先裁剪");
    expect(MSG_TOO_LONG).toBe("这张图太长了，截短一点再发");
    expect(MSG_NO_STREAM).toBe("这条分享里没有图片");
    expect(MSG_MULTIPLE_TAKEN).toBe("一次只能收一张，已用第一张");
  });

  it("分享失败码映射到文案", () => {
    expect(messageForShareCode("no_stream")).toBe(MSG_NO_STREAM);
    expect(messageForShareCode("read_failed")).toBe(MSG_READ_FAILED);
    expect(messageForShareCode("source_too_large")).toBe(MSG_TOO_LARGE);
  });
});
