import { describe, expect, it } from "vitest";
import { formatLocalDateTime } from "@/utils/time";

/** 本地时区 YYYY-MM-DD HH:mm，测试里独立拼（不调被测函数） */
function local(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

describe("formatLocalDateTime", () => {
  it("整点也补成两位", () => {
    expect(formatLocalDateTime("2026-11-01T10:00:00.000Z")).toBe(local("2026-11-01T10:00:00.000Z"));
  });

  it("分钟补零", () => {
    expect(formatLocalDateTime("2026-11-01T01:05:00Z")).toBe(local("2026-11-01T01:05:00Z"));
  });

  it("解析失败返回空串（页面不渲染）", () => {
    expect(formatLocalDateTime("not a date")).toBe("");
  });
});
