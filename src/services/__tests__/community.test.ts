// 社区接口封装：只断言 URL / 方法 / 查询参数拼装与错误冒泡，不发真网络。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/services/api";
import {
  favoriteRecipe,
  fetchCommunityRecipe,
  fetchUserProfile,
  followUser,
  listCommunityRecipes,
  unfavoriteRecipe,
  unfollowUser,
} from "@/services/community";
import type { SyncPayload } from "@/services/sync";

const apiFetchMock = vi.mocked(apiFetch);

function ok<T>(data: T): { ok: true; status: number; data: T } {
  return { ok: true, status: 200, data };
}

function fail(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

/** 用 URL 解析查询参数，断言不依赖参数拼接顺序。 */
function callUrl(index = 0): URL {
  return new URL(apiFetchMock.mock.calls[index][0], "http://x");
}

function callMethod(index = 0): string {
  return (apiFetchMock.mock.calls[index][1]?.method as string | undefined) ?? "GET";
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("社区接口封装", () => {
  it("列表走 GET /api/v1/community/recipes 并拼上 limit / offset", async () => {
    apiFetchMock.mockResolvedValue(ok({ items: [], has_more: false }));

    await listCommunityRecipes({ limit: 20, offset: 40 });

    expect(callUrl().pathname).toBe("/api/v1/community/recipes");
    expect(callUrl().searchParams.get("limit")).toBe("20");
    expect(callUrl().searchParams.get("offset")).toBe("40");
    expect(callMethod()).toBe("GET");
  });

  it("followedOnly 映射成 followed_only=1、authorId 映射成 author_id", async () => {
    apiFetchMock.mockResolvedValue(ok({ items: [], has_more: false }));

    await listCommunityRecipes({ limit: 10, offset: 0, followedOnly: true, authorId: "u1" });

    expect(callUrl().searchParams.get("followed_only")).toBe("1");
    expect(callUrl().searchParams.get("author_id")).toBe("u1");
  });

  it("不传 followedOnly / authorId 时不拼这两个参数", async () => {
    apiFetchMock.mockResolvedValue(ok({ items: [], has_more: false }));

    await listCommunityRecipes({ limit: 10, offset: 0 });

    expect(callUrl().searchParams.has("followed_only")).toBe(false);
    expect(callUrl().searchParams.has("author_id")).toBe(false);
  });

  it("列表失败时把服务端错误抛给调用方", async () => {
    apiFetchMock.mockResolvedValue(fail(500, "服务器错误"));

    await expect(listCommunityRecipes({ limit: 10, offset: 0 })).rejects.toThrow("服务器错误");
  });

  it("详情走 GET /api/v1/community/recipes/{id}，返回 /sync 同形状载荷", async () => {
    const payload: SyncPayload = {
      ingredients: [],
      units: [],
      labels: [],
      recipes: [],
      files: [],
    };
    apiFetchMock.mockResolvedValue(ok(payload));

    await expect(fetchCommunityRecipe("r1")).resolves.toEqual(payload);
    expect(callUrl().pathname).toBe("/api/v1/community/recipes/r1");
    expect(callMethod()).toBe("GET");
  });

  it("收藏走 POST /api/v1/favorites/{id}，204 即成功", async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 204, data: undefined });

    await expect(favoriteRecipe("r1")).resolves.toBeUndefined();
    expect(callUrl().pathname).toBe("/api/v1/favorites/r1");
    expect(callMethod()).toBe("POST");
  });

  it("取消收藏走 DELETE /api/v1/favorites/{id}", async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 204, data: undefined });

    await unfavoriteRecipe("r1");

    expect(callUrl().pathname).toBe("/api/v1/favorites/r1");
    expect(callMethod()).toBe("DELETE");
  });

  it("收藏 404（菜谱不存在 / 不公开）时抛错", async () => {
    apiFetchMock.mockResolvedValue(fail(404, "菜谱不存在"));

    await expect(favoriteRecipe("gone")).rejects.toThrow("菜谱不存在");
  });

  it("用户资料走 GET /api/v1/users/{id}", async () => {
    const profile = { id: "u1", nickname: "老王", avatar_url: null, followed: false, public_count: 3 };
    apiFetchMock.mockResolvedValue(ok(profile));

    await expect(fetchUserProfile("u1")).resolves.toEqual(profile);
    expect(callUrl().pathname).toBe("/api/v1/users/u1");
    expect(callMethod()).toBe("GET");
  });

  it("关注走 POST、取关走 DELETE /api/v1/follows/{id}", async () => {
    apiFetchMock.mockResolvedValue({ ok: true, status: 204, data: undefined });

    await followUser("u1");
    expect(callUrl(0).pathname).toBe("/api/v1/follows/u1");
    expect(callMethod(0)).toBe("POST");

    await unfollowUser("u1");
    expect(callUrl(1).pathname).toBe("/api/v1/follows/u1");
    expect(callMethod(1)).toBe("DELETE");
  });

  it("关注自己（400）时抛错", async () => {
    apiFetchMock.mockResolvedValue(fail(400, "不能关注自己"));

    await expect(followUser("me")).rejects.toThrow("不能关注自己");
  });
});
