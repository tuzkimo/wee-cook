import { beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom 里没有 Tauri IPC，`load` 必失败 ⇒ 走 localStorage 回落分支。
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(),
}));

import { load } from "@tauri-apps/plugin-store";
import { deleteRefreshToken, readRefreshToken, writeRefreshToken } from "@/services/tokenStorage";

const loadMock = load as unknown as ReturnType<typeof vi.fn>;

describe("tokenStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    loadMock.mockRejectedValue(new Error("no tauri"));
  });

  it("非 Tauri 环境回落到 localStorage", async () => {
    await writeRefreshToken("u1", "t1");
    expect(localStorage.getItem("refresh_token:u1")).toBe("t1");
    await expect(readRefreshToken("u1")).resolves.toBe("t1");

    await deleteRefreshToken("u1");
    await expect(readRefreshToken("u1")).resolves.toBeNull();
  });

  it("按服务端 user id 隔离：写 u1 后读 u2 必须是 null", async () => {
    await writeRefreshToken("u1", "t1");

    // 单 key 存储时这里会读回 u1 的 token：用户 2 与会话错绑（串号）
    await expect(readRefreshToken("u2")).resolves.toBeNull();
    await expect(readRefreshToken("u1")).resolves.toBe("t1");
  });
});
