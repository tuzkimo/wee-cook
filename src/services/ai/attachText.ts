// 截图 / 分享链的用户可见文案，唯一一份。字符串用户会直接看到，改文案只改这里。
export const MSG_UNSUPPORTED = "只支持 JPEG / PNG / WebP / GIF 图片";
export const MSG_READ_FAILED = "读不到这张图片，请重试";
export const MSG_DECODE_FAILED = "这张图片打不开";
export const MSG_TOO_LARGE = "图片太大，换一张或先裁剪";
export const MSG_TOO_LONG = "这张图太长了，截短一点再发";
export const MSG_NO_STREAM = "这条分享里没有图片";
export const MSG_MULTIPLE_TAKEN = "一次只能收一张，已用第一张";

export type ShareErrorCode = "no_stream" | "read_failed" | "source_too_large";

export function messageForShareCode(code: ShareErrorCode): string {
  switch (code) {
    case "no_stream":
      return MSG_NO_STREAM;
    case "read_failed":
      return MSG_READ_FAILED;
    case "source_too_large":
      return MSG_TOO_LARGE;
  }
}
