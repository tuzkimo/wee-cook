<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Filter, Plus } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import CommunityFeed from "@/components/CommunityFeed.vue";
import RecipeCard from "@/components/RecipeCard.vue";
import { useRecipeStore } from "@/stores/recipe";
import { useCommunityStore } from "@/stores/community";
import { useAuthStore } from "@/stores/auth";
import { useRecipeFilterStore } from "@/stores/recipeFilter";
import { imageSrc } from "@/services/imageStore";
import { ensureLocalImages } from "@/services/syncFiles";
import { enqueueSync } from "@/services/sync";
import { filterRecipes, filterSummary, isFilterActive } from "@/utils/recipeFilter";
import type { RecipeListItem } from "@/types";

const TABS = [
  { value: "all", label: "全部" },
  { value: "mine", label: "我的" },
  { value: "fav", label: "收藏" },
  { value: "follow", label: "关注" },
] as const;

type Tab = (typeof TABS)[number]["value"];

const router = useRouter();
const store = useRecipeStore();
const communityStore = useCommunityStore();
const auth = useAuthStore();
const filterStore = useRecipeFilterStore();

const tab = ref<Tab>("all");
const favoritesLoading = ref(false);
// 封面得走鉴权下载通道补下来（收藏里的社区菜谱、别的设备同步来的自己菜谱都在内）；
// 只把**已落盘**的名字交给模板，没到就出字母兜底，不出破图
const localImages = ref<Set<string>>(new Set());

const visible = computed(() => filterRecipes(store.recipes, filterStore.filter));
const summary = computed(() => filterSummary(filterStore.filter, store.recipes));
// 按「筛选是否活跃」渲染整条，不按摘要文案：条件指向的菜谱被删光时摘要仍要有东西可点
const active = computed(() => isFilterActive(filterStore.filter));

// 两个段落不合并排序：社区接口挂了，我的段落照样在用（spec §9.1）
const showMine = computed(() => tab.value !== "follow");
const showCommunity = computed(() => tab.value === "all" || tab.value === "follow");
// 收藏与我的形状相同（RecipeListItem[]），沿用同一套搜索与筛选
const mineList = computed(() =>
  tab.value === "fav" ? filterRecipes(store.favorites, filterStore.filter) : visible.value,
);

/** 第三行的作者：自己的菜谱（或未认领）用内存里的我；别人的用本地落库的两列。 */
function authorOf(item: RecipeListItem): { name: string | null; avatarUrl: string | null } {
  const mine = item.recipe.owner_id === null || item.recipe.owner_id === auth.serverUserId;
  if (mine) return { name: auth.nickname, avatarUrl: auth.avatarUrl };
  return { name: item.recipe.owner_nickname, avatarUrl: item.recipe.owner_avatar_url };
}

// 收藏与其他 tab 的空态口径不同：收藏 tab 要区分「一条都没收藏」与「收藏被现有筛选筛空」
const emptyMessage = computed(() => {
  if (tab.value === "fav") {
    return store.favorites.length === 0 ? "还没有收藏的菜谱" : "没有符合条件的菜谱";
  }
  return store.recipes.length === 0 ? "还没有菜谱，点右上角加号记一道" : "没有符合条件的菜谱";
});

// 源数组只在 fetch 时换引用（不像 mineList 会跟着搜索每敲一个字重算），不会白跑 IO
watch(
  [() => store.recipes, () => store.favorites],
  async () => {
    localImages.value = await ensureLocalImages(
      [...store.recipes, ...store.favorites].map((item) => item.recipe.cover_path),
    );
  },
  { immediate: true },
);

async function loadFavorites(opts: { sync?: boolean } = {}): Promise<void> {
  favoritesLoading.value = true;
  try {
    await store.fetchFavorites();
  } finally {
    favoritesLoading.value = false;
  }
  // 服务端最新收藏只能靠同步下来（作者取消公开后由对账整表替换），进收藏 tab 时催一次；
  // 离线时本地收藏照常显示，一个请求都不发
  if (opts.sync && auth.isOnline) enqueueSync({});
}

function select(next: Tab): void {
  if (next === "fav") void loadFavorites({ sync: true });
  // 离开「关注」要复位，否则回到「全部」时社区段还是关注口径
  communityStore.followedOnly = next === "follow";
  tab.value = next;
}

// 同步完成后重拉，让「A 取消公开」这类服务端变化反映到界面。
// 这里**只许** fetchFavorites，不许再 enqueueSync —— 否则每次同步完成又催一次同步，变成死循环。
watch(
  () => auth.syncVersion,
  async () => {
    await store.fetchAll();
    if (tab.value === "fav") await loadFavorites();
  },
);

onMounted(async () => {
  await store.fetchAll();
});
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="菜谱">
      <!-- 标题槽让给搜索框：整条顶栏就是「搜索框 + 漏斗 + 加号」，不再多占一行 -->
      <template #title>
        <input
          v-model="filterStore.filter.keyword"
          data-test="recipe-search"
          type="text"
          placeholder="搜索菜名"
          aria-label="搜索菜名"
          class="mr-2 min-w-0 flex-1 rounded-lg bg-gray-100 px-3 py-2 text-sm text-text outline-none focus:bg-gray-50"
        />
      </template>
      <template #action>
        <button
          type="button"
          data-test="recipe-filter"
          aria-label="筛选"
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="router.push('/recipe/filter')"
        >
          <Filter :size="20" class="text-text" />
        </button>
        <button
          type="button"
          data-test="recipe-add"
          aria-label="新建菜谱"
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="router.push('/recipe/new')"
        >
          <Plus :size="20" class="text-text" />
        </button>
      </template>
    </AppHeader>

    <div
      v-if="active && showMine"
      data-test="filter-bar"
      class="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-gray-100 bg-surface px-4 py-2"
      @click="router.push('/recipe/filter')"
    >
      <span
        data-test="filter-summary"
        class="flex-1 whitespace-nowrap text-xs text-text-secondary"
      >
        {{ summary }}
      </span>
      <button
        type="button"
        data-test="filter-clear"
        aria-label="清除筛选"
        class="shrink-0 text-xs text-primary"
        @click.stop="filterStore.clear()"
      >
        清除
      </button>
    </div>

    <!-- 四个 chip 排在信息条之后：信息条必须紧贴顶栏（既有约束） -->
    <div class="flex shrink-0 gap-2 overflow-x-auto border-b border-gray-100 bg-surface px-4 py-2">
      <button
        v-for="item in TABS"
        :key="item.value"
        type="button"
        :data-test="`tab-${item.value}`"
        :aria-pressed="tab === item.value"
        class="shrink-0 rounded-full px-3 py-1 text-xs transition-colors"
        :class="tab === item.value ? 'bg-primary text-white' : 'bg-gray-100 text-text-secondary'"
        @click="select(item.value)"
      >
        {{ item.label }}
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-auto px-4 py-3">
      <section v-if="showMine" data-test="my-recipes">
        <h2 class="mb-2 text-xs font-semibold text-text-secondary">
          {{ tab === "fav" ? "收藏" : "我的菜谱" }}
        </h2>
        <p
          v-if="favoritesLoading && tab === 'fav'"
          data-test="favorites-loading"
          class="py-12 text-center text-text-secondary"
        >
          加载中…
        </p>
        <p
          v-else-if="mineList.length === 0"
          class="py-12 text-center text-text-secondary"
        >
          {{ emptyMessage }}
        </p>
        <ul v-else class="flex flex-col gap-2.5">
          <li v-for="item in mineList" :key="item.recipe.id">
            <RecipeCard
              :name="item.recipe.name"
              :cover-src="
                item.recipe.cover_path && localImages.has(item.recipe.cover_path)
                  ? imageSrc(item.recipe.cover_path)
                  : null
              "
              :category="item.category.name || null"
              :tags="item.tags.map((tag) => tag.name)"
              :author-name="authorOf(item).name"
              :author-avatar-url="authorOf(item).avatarUrl"
              test-prefix="recipe"
              @click="router.push(`/recipe/${item.recipe.id}`)"
            />
          </li>
        </ul>
      </section>

      <CommunityFeed v-if="showCommunity && auth.isOnline" class="mt-4" />
      <!-- 未登录：关注一定为空，给一句提示而不是让社区段去发请求后显示失败态 -->
      <p
        v-else-if="tab === 'follow'"
        data-test="follow-login-hint"
        class="mt-4 py-6 text-center text-sm text-text-secondary"
      >
        登录后可以关注别人
      </p>
    </div>
  </div>
</template>
