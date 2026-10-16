// src/services/community.ts
//
// 社区浏览接口的薄封装（spec §8）：列表 / 详情 / 收藏 / 关注 / 用户资料。
// 只做 URL 拼装与「ok:false → 抛错」这一层；错误状态由调用方 store 接住。
// 收藏与关注只走 REST，不进同步队列；离线时界面直接禁用按钮，这里不做离线暂存。
import { apiFetch } from "./api";
import type { SyncPayload } from "./sync";

export interface CommunityRecipe {
  id: string;
  name: string;
  cover_path: string | null;
  author_id: string;
  author_nickname: string;
  author_avatar_url: string | null;
  category_name: string | null;
  tags: string[];
  updated_at: string;
  favorited: boolean;
}

export interface CommunityPage {
  items: CommunityRecipe[];
  has_more: boolean;
}

export interface UserProfile {
  id: string;
  nickname: string;
  avatar_url: string | null;
  followed: boolean;
  public_count: number;
}

/** 解开 apiFetch 的 ApiResult：拿不到响应时 apiFetch 自己抛，服务端答了话失败则在这里抛。 */
async function unwrap<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch<T>(path, init);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export function listCommunityRecipes(params: {
  limit: number;
  offset: number;
  followedOnly?: boolean;
  authorId?: string;
}): Promise<CommunityPage> {
  const query = new URLSearchParams({
    limit: String(params.limit),
    offset: String(params.offset),
  });
  if (params.followedOnly) query.set("followed_only", "1");
  if (params.authorId) query.set("author_id", params.authorId);
  return unwrap<CommunityPage>(`/api/v1/community/recipes?${query.toString()}`);
}

/** 详情返回与 /sync 的 remote_changes 同形状的载荷，可直接喂给落库逻辑。 */
export function fetchCommunityRecipe(id: string): Promise<SyncPayload> {
  return unwrap<SyncPayload>(`/api/v1/community/recipes/${id}`);
}

export async function favoriteRecipe(id: string): Promise<void> {
  await unwrap<void>(`/api/v1/favorites/${id}`, { method: "POST" });
}

export async function unfavoriteRecipe(id: string): Promise<void> {
  await unwrap<void>(`/api/v1/favorites/${id}`, { method: "DELETE" });
}

export function fetchUserProfile(id: string): Promise<UserProfile> {
  return unwrap<UserProfile>(`/api/v1/users/${id}`);
}

export async function followUser(id: string): Promise<void> {
  await unwrap<void>(`/api/v1/follows/${id}`, { method: "POST" });
}

export async function unfollowUser(id: string): Promise<void> {
  await unwrap<void>(`/api/v1/follows/${id}`, { method: "DELETE" });
}
