import { createPinia, defineStore, getActivePinia } from "pinia";
import { ref } from "vue";
import { getDb } from "@/db";
import * as community from "@/services/community";
import { bumpFavoriteOps, cacheCommunityChanges, enqueueSync } from "@/services/sync";
import type { CommunityRecipe, UserProfile } from "@/services/community";

/** 社区列表一页的条数；未知总量，到位靠 has_more。 */
const PAGE_SIZE = 20;

/**
 * 社区列表的取数与收藏动作（spec §8 / §9.1 / §9.3）。界面只读这里的 items / hasMore / loading / error。
 * 收藏 / 关注只走 REST：先在服务端成功，再改本地 —— 失败不留脏状态，离线时界面按钮灰着。
 */
const useCommunityStoreBase = defineStore("community", () => {
  const items = ref<CommunityRecipe[]>([]);
  const hasMore = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** 只看我关注的（详情页外的社区段落 / 关注筛选共用）。 */
  const followedOnly = ref(false);

  /** 拉一页。`reset` 为 true 时从第一页重来，否则接着已有条数往后翻。 */
  async function load(reset = false): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const page = await community.listCommunityRecipes({
        limit: PAGE_SIZE,
        offset: reset ? 0 : items.value.length,
        followedOnly: followedOnly.value,
      });
      items.value = reset ? page.items : [...items.value, ...page.items];
      hasMore.value = page.has_more;
    } catch (e) {
      // 社区接口挂掉不影响「我的」段落，这里只记下错误让社区段落显示重试
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  /** 拉详情落本地并返回 id 供路由跳转；失败向上抛（不进 error，跳转本身要失败）。 */
  async function openRecipe(id: string): Promise<string> {
    await cacheCommunityChanges(await community.fetchCommunityRecipe(id));
    return id;
  }

  async function favorite(id: string): Promise<void> {
    // 先服务端后本地：POST 失败（离线 / 404）时本地一个字都不动
    await community.favoriteRecipe(id);
    await setLocalFavorite(id, true);
  }

  async function unfavorite(id: string): Promise<void> {
    await community.unfavoriteRecipe(id);
    await setLocalFavorite(id, false);
  }

  /** 本地收藏集合与列表里的标记；写完后触发一次同步把关系拉回来（spec §9.3）。 */
  async function setLocalFavorite(id: string, favorited: boolean): Promise<void> {
    const db = getDb();
    if (favorited) {
      await db.execute("INSERT OR IGNORE INTO favorite_recipes (recipe_id) VALUES (?)", [id]);
    } else {
      await db.execute("DELETE FROM favorite_recipes WHERE recipe_id = ?", [id]);
    }
    const item = items.value.find((r) => r.id === id);
    if (item) item.favorited = favorited;
    bumpFavoriteOps();
    enqueueSync({});
  }

  function profile(id: string): Promise<UserProfile> {
    return community.fetchUserProfile(id);
  }

  function follow(id: string): Promise<void> {
    return community.followUser(id);
  }

  function unfollow(id: string): Promise<void> {
    return community.unfollowUser(id);
  }

  return {
    items,
    hasMore,
    loading,
    error,
    followedOnly,
    load,
    openRecipe,
    favorite,
    unfavorite,
    profile,
    follow,
    unfollow,
  };
});

/**
 * 单例 store。没有活跃 pinia 时传一个**显式实例**，不去 `setActivePinia`：理由见 auth.ts
 * 顶部注释（设成全局 active 会让游离 store 抢先成为后续所有 `useStore()` 的落点）。
 */
export function useCommunityStore(): ReturnType<typeof useCommunityStoreBase> {
  return useCommunityStoreBase(getActivePinia() ?? createPinia());
}
