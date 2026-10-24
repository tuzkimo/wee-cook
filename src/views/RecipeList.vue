<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Filter, Plus } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import RecipeCard from "@/components/RecipeCard.vue";
import TeamSwitcher from "@/components/TeamSwitcher.vue";
import { useRecipeStore } from "@/stores/recipe";
import { useAuthStore } from "@/stores/auth";
import { useRecipeFilterStore } from "@/stores/recipeFilter";
import { useTeamStore } from "@/stores/team";
import { activeScope } from "@/services/scope";
import { imageSrc } from "@/services/imageStore";
import { ensureLocalImages } from "@/services/syncFiles";
import { filterRecipes, filterSummary, isFilterActive } from "@/utils/recipeFilter";
import type { RecipeListItem } from "@/types";

const router = useRouter();
const store = useRecipeStore();
const auth = useAuthStore();
const team = useTeamStore();
const filterStore = useRecipeFilterStore();

// 封面得走鉴权下载通道补下来（别的设备同步来的菜谱就在内）；
// 只把**已落盘**的名字交给模板，没到就出字母兜底，不出破图
const localImages = ref<Set<string>>(new Set());

const visible = computed(() => filterRecipes(store.recipes, filterStore.filter));
const summary = computed(() => filterSummary(filterStore.filter, store.recipes));
// 按「筛选是否活跃」渲染整条，不按摘要文案：条件指向的菜谱被删光时摘要仍要有东西可点
const active = computed(() => isFilterActive(filterStore.filter));

// 空态随范围变：团队里没有菜谱和「我的菜谱」是两件事（spec §10.2）
const emptyMessage = computed(() => {
  if (store.recipes.length > 0) return "没有符合条件的菜谱";
  return activeScope.value.startsWith("t:")
    ? "这个团队还没有菜谱，点右上角加号记一道"
    : "还没有菜谱，点右上角加号记一道";
});

/** 第三行的作者：自己建的菜谱用内存里的我；队友建的用本地落库的两列。 */
function authorOf(item: RecipeListItem): { name: string | null; avatarUrl: string | null } {
  const mine = item.recipe.owner_id === null || item.recipe.owner_id === auth.serverUserId;
  if (mine) return { name: auth.nickname, avatarUrl: auth.avatarUrl };
  return { name: item.recipe.owner_nickname, avatarUrl: item.recipe.owner_avatar_url };
}

// 源数组只在 fetch 时换引用（不像 visible 会跟着搜索每敲一个字重算），不会白跑 IO
watch(
  () => store.recipes,
  async () => {
    localImages.value = await ensureLocalImages(
      store.recipes.map((item) => item.recipe.cover_path),
    );
  },
  { immediate: true },
);

// 同步完成后重拉：别的设备建的菜谱要出现在列表里。这里**不许** enqueueSync，否则变成同步死循环。
watch(
  () => auth.syncVersion,
  async () => {
    await store.fetchAll();
  },
);

onMounted(async () => {
  // 冷启动：先恢复团队缓存与上次选中的范围，再按范围查列表
  if (team.teams.length === 0) await team.load().catch(() => {});
  await team.restoreCurrentTeam();
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

    <!-- 范围切换器：与库存页共用同一个全局状态（spec §10.1） -->
    <div class="flex shrink-0 items-center border-b border-gray-100 bg-surface px-4 py-2">
      <TeamSwitcher />
    </div>

    <div
      v-if="active"
      data-test="filter-bar"
      class="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-gray-100 bg-surface px-4 py-2"
      @click="router.push('/recipe/filter')"
    >
      <span data-test="filter-summary" class="flex-1 whitespace-nowrap text-xs text-text-secondary">
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

    <div class="flex-1 min-h-0 overflow-auto px-4 py-3">
      <section data-test="my-recipes">
        <p v-if="visible.length === 0" data-test="empty-state" class="py-12 text-center text-text-secondary">
          {{ emptyMessage }}
        </p>
        <ul v-else class="flex flex-col gap-2.5">
          <li v-for="item in visible" :key="item.recipe.id">
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
    </div>
  </div>
</template>
