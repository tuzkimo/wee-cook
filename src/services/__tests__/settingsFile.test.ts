// I5：settingsFile 是 auth 与 ServerConfig 共用的唯一读写入口，承载两条关键不变量：
//  1）`invalid`（读得懂 JSON 但形状不认识）不能当作「不存在」去覆盖；
//  2）Tauri 内 settings.json 加载失败（error 态）绝不回落到 localStorage（否则两份真相源漂移）。
// 本文件把三态（load 成功 / load 抛错 / 非 Tauri）都钉住。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadMock = vi.hoisted(() => vi.fn());
const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({ load: loadMock }));

const LOG = { tag: "test", label: "同步设置", action: "保存" };

/** 显式切换「在不在 Tauri 内」；settingsFile 靠 `__TAURI_INTERNALS__` 判环境。 */
function setTauri(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** 每个用例拿一份全新的 settingsFile（storePromise 是模块级缓存，必须重置）。 */
async function freshSettings(): Promise<typeof import("@/services/settingsFile")> {
  vi.resetModules();
  return await import("@/services/settingsFile");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  storeMock.get.mockResolvedValue(null);
  storeMock.set.mockResolvedValue(undefined);
  storeMock.save.mockResolvedValue(undefined);
  storeMock.delete.mockResolvedValue(undefined);
});

afterEach(() => {
  setTauri(false);
});

describe("settingsFile", () => {
  it("非 Tauri：读写删走 localStorage，不碰 settings.json", async () => {
    setTauri(false);
    const s = await freshSettings();

    await s.writeSetting("k", { a: 1 }, LOG);
    expect(JSON.parse(localStorage.getItem("k") as string)).toEqual({ a: 1 });
    expect(loadMock).not.toHaveBeenCalled();

    await expect(
      s.readSetting("k", (raw) => (typeof raw === "object" && raw !== null ? (raw as { a: number }) : null)),
    ).resolves.toEqual({ kind: "found", value: { a: 1 } });
    await expect(s.readSetting("missing", () => null)).resolves.toEqual({ kind: "absent" });

    await s.deleteSetting("k", LOG);
    expect(localStorage.getItem("k")).toBeNull();
  });

  it("Tauri 且加载成功：读命中 found、缺席 absent，写删走 store", async () => {
    setTauri(true);
    loadMock.mockResolvedValue(storeMock);
    storeMock.get.mockResolvedValue("v");
    const s = await freshSettings();

    await expect(s.readSetting("k", (raw) => (typeof raw === "string" ? raw : null))).resolves.toEqual({
      kind: "found",
      value: "v",
    });

    await s.writeSetting("k", "v2", LOG);
    expect(storeMock.set).toHaveBeenCalledWith("k", "v2");
    expect(storeMock.save).toHaveBeenCalledTimes(1);

    await s.deleteSetting("k", LOG);
    expect(storeMock.delete).toHaveBeenCalledWith("k");
  });

  it("Tauri 加载失败（error 态）：写/删 reject 且不回落 localStorage，读返回 unavailable", async () => {
    setTauri(true);
    loadMock.mockRejectedValue(new Error("settings.json 崩了"));
    localStorage.setItem("k", JSON.stringify("旧值"));
    const s = await freshSettings();

    await expect(s.writeSetting("k", "新值", LOG)).rejects.toThrow(/settings\.json 加载失败/);
    await expect(s.deleteSetting("k", LOG)).rejects.toThrow(/settings\.json 加载失败/);
    // 绝不碰 localStorage：预置值一个字节都没变（否则清掉的值下次启动会复活）
    expect(JSON.parse(localStorage.getItem("k") as string)).toBe("旧值");

    await expect(s.readSetting("k", (raw) => (typeof raw === "string" ? raw : null))).resolves.toMatchObject({
      kind: "unavailable",
      stage: "load",
    });
  });

  it("Tauri：形状不认识的取值是 invalid（不是 absent），读不会写回覆盖", async () => {
    setTauri(true);
    loadMock.mockResolvedValue(storeMock);
    storeMock.get.mockResolvedValue({ unexpected: true });
    const s = await freshSettings();

    await expect(s.readSetting("k", (_raw: unknown): string | null => null)).resolves.toEqual({
      kind: "invalid",
    });
    // 读路径绝不写：把 invalid 当 absent 去写初值就是覆盖别人的数据
    expect(storeMock.set).not.toHaveBeenCalled();
    expect(storeMock.save).not.toHaveBeenCalled();
  });

  it("非 Tauri：JSON 解析失败是 invalid，且不写回 localStorage", async () => {
    setTauri(false);
    const s = await freshSettings();
    localStorage.setItem("bad", "{不是合法 JSON");

    await expect(s.readSetting("bad", (raw) => (raw === null ? null : String(raw)))).resolves.toEqual({
      kind: "invalid",
    });
    expect(localStorage.getItem("bad")).toBe("{不是合法 JSON");
  });
});
