<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { Filter, Plus } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import { useRecipeStore } from "@/stores/recipe";
import { useRecipeFilterStore } from "@/stores/recipeFilter";
import { imageSrc } from "@/services/imageStore";
import { filterRecipes, filterSummary, isFilterActive } from "@/utils/recipeFilter";

const router = useRouter();
const store = useRecipeStore();
const filterStore = useRecipeFilterStore();

const visible = computed(() => filterRecipes(store.recipes, filterStore.filter));
const summary = computed(() => filterSummary(filterStore.filter, store.recipes));
// 按「筛选是否活跃」渲染整条，不按摘要文案：条件指向的菜谱被删光时摘要仍要有东西可点
const active = computed(() => isFilterActive(filterStore.filter));

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
      v-if="active"
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

    <div class="flex-1 min-h-0 overflow-auto px-4 py-3">
      <p v-if="store.recipes.length === 0" class="py-12 text-center text-text-secondary">
        还没有菜谱，点右上角加号记一道
      </p>
      <p v-else-if="visible.length === 0" class="py-12 text-center text-text-secondary">
        没有符合条件的菜谱
      </p>
      <ul v-else class="flex flex-col gap-2.5">
        <li v-for="item in visible" :key="item.recipe.id">
          <button
            type="button"
            data-test="recipe-card"
            class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors hover:bg-gray-50"
            @click="router.push(`/recipe/${item.recipe.id}`)"
          >
            <img
              v-if="item.recipe.cover_path"
              data-test="recipe-cover"
              :src="imageSrc(item.recipe.cover_path)"
              :alt="item.recipe.name"
              loading="lazy"
              class="h-11 w-11 shrink-0 rounded-lg object-cover"
            />
            <div
              v-else
              data-test="recipe-cover-fallback"
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-lg font-semibold text-text-secondary"
            >
              {{ item.recipe.name.charAt(0) }}
            </div>
            <div class="min-w-0 flex-1">
              <h2 data-test="recipe-name" class="line-clamp-2 text-sm font-medium text-text">
                {{ item.recipe.name }}
              </h2>
              <p data-test="recipe-category" class="text-xs text-text-secondary">
                {{ item.category.name }}
              </p>
              <div v-if="item.tags.length > 0" class="mt-1 flex flex-wrap gap-1">
                <span
                  v-for="tag in item.tags"
                  :key="tag.id"
                  data-test="recipe-tag"
                  class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-text-secondary"
                >
                  {{ tag.name }}
                </span>
              </div>
            </div>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
