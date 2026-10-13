<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useRecipeStore } from "@/stores/recipe";
import { imageSrc } from "@/services/imageStore";

const router = useRouter();
const store = useRecipeStore();

onMounted(() => {
  void store.fetchAll();
});
</script>

<template>
  <main class="min-h-screen bg-slate-50 pt-[env(safe-area-inset-top)] pb-24 dark:bg-slate-900">
    <p
      v-if="store.recipes.length === 0"
      class="px-6 py-24 text-center text-slate-500 dark:text-slate-400"
    >
      还没有菜谱，点下面的加号记一道
    </p>
    <ul v-else class="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
      <li v-for="item in store.recipes" :key="item.recipe.id">
        <button
          type="button"
          data-test="recipe-card"
          class="flex w-full flex-col overflow-hidden rounded-xl bg-white text-left shadow-sm dark:bg-slate-800"
          @click="router.push(`/recipe/${item.recipe.id}`)"
        >
          <img
            v-if="item.recipe.cover_path"
            data-test="recipe-cover"
            :src="imageSrc(item.recipe.cover_path)"
            :alt="item.recipe.name"
            loading="lazy"
            class="aspect-[4/3] w-full object-cover"
          />
          <div
            v-else
            data-test="recipe-cover-fallback"
            class="flex aspect-[4/3] w-full items-center justify-center bg-slate-200 text-4xl font-semibold text-slate-400 dark:bg-slate-700 dark:text-slate-500"
          >
            {{ item.recipe.name.charAt(0) }}
          </div>
          <div class="flex w-full flex-col gap-1 p-2">
            <h2
              data-test="recipe-name"
              class="line-clamp-2 text-sm font-medium text-slate-900 dark:text-slate-50"
            >
              {{ item.recipe.name }}
            </h2>
            <p data-test="recipe-category" class="text-xs text-slate-500 dark:text-slate-400">
              {{ item.category.name }}
            </p>
            <div v-if="item.tags.length > 0" class="flex flex-wrap gap-1">
              <span
                v-for="tag in item.tags"
                :key="tag.id"
                data-test="recipe-tag"
                class="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-300"
              >
                {{ tag.name }}
              </span>
            </div>
          </div>
        </button>
      </li>
    </ul>

    <button
      type="button"
      data-test="recipe-add"
      aria-label="新建菜谱"
      class="fixed right-6 bottom-[calc(env(safe-area-inset-bottom)+1.5rem)] flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-3xl leading-none text-white shadow-lg"
      @click="router.push('/recipe/new')"
    >
      +
    </button>
  </main>
</template>
