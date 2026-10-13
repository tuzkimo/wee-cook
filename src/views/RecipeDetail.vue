<script setup lang="ts">
// 只读详情页（规格 §6.4）：食材清单在前、字号偏大 —— 这是做菜时真正要看的那一段；
// 步骤在后，带序号与可选插图。「编辑」与「删除」都在右上角。
// ⚠️ 不做计时器 / 防熄屏 / 逐步高亮，那是下一轮的跟做模式，别在这里加。
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import { imageSrc } from "@/services/imageStore";
import { useRecipeStore } from "@/stores/recipe";
import type { RecipeDetail, RecipeIngredientRow } from "@/types";

const route = useRoute();
const router = useRouter();
const store = useRecipeStore();

const recipeId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));
const detail = ref<RecipeDetail | null>(null);
const error = ref("");
const showDeleteConfirm = ref(false);

// store 已经按 sort_order 查出来，这里再排一次是为了「页面自己保证顺序」这件事可被断言
const steps = computed(() =>
  [...(detail.value?.steps ?? [])].sort((a, b) => a.sort_order - b.sort_order),
);

/** 规格 §10.6：数量与单位都为空渲染成「适量」，只填数字不填单位就只显示数字。 */
function amountText(line: RecipeIngredientRow): string {
  const parts = [line.amount === null ? "" : String(line.amount), line.unit_name ?? ""];
  return parts.filter(Boolean).join(" ") || "适量";
}

onMounted(async () => {
  const id = recipeId.value;
  if (!id) {
    error.value = "菜谱不存在";
    return;
  }
  try {
    detail.value = await store.getDetail(id);
  } catch (loadError: unknown) {
    error.value = loadError instanceof Error ? loadError.message : "菜谱不存在";
  }
});

function edit(): void {
  void router.push(`/recipe/${recipeId.value}/edit`);
}

async function confirmDelete(): Promise<void> {
  showDeleteConfirm.value = false;
  await store.remove(recipeId.value);
  await router.push("/");
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 pb-10 dark:bg-slate-900">
    <template v-if="detail">
      <header class="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          data-test="back"
          aria-label="返回"
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xl text-slate-600 transition-colors hover:bg-gray-100 dark:text-slate-300"
          @click="router.back()"
        >
          ←
        </button>
        <h1
          data-test="detail-name"
          class="min-w-0 flex-1 truncate text-xl font-semibold text-slate-900 dark:text-slate-50"
        >
          {{ detail.recipe.name }}
        </h1>
        <button
          type="button"
          data-test="edit"
          class="shrink-0 rounded-full px-3 py-1.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 dark:hover:bg-slate-800"
          @click="edit"
        >
          编辑
        </button>
        <button
          type="button"
          data-test="delete"
          class="shrink-0 rounded-full px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:hover:bg-slate-800"
          @click="showDeleteConfirm = true"
        >
          删除
        </button>
      </header>

      <div class="px-4">
        <div class="mb-6 flex flex-wrap items-center gap-2">
          <span
            data-test="detail-category"
            class="rounded-full bg-slate-200 px-3 py-1 text-sm text-slate-700 dark:bg-slate-700 dark:text-slate-200"
          >
            {{ detail.category.name }}
          </span>
          <span
            v-for="tag in detail.tags"
            :key="tag.id"
            data-test="detail-tag"
            class="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            {{ tag.name }}
          </span>
        </div>

        <section class="mb-8">
          <h2 class="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">食材</h2>
          <p
            v-if="detail.ingredients.length === 0"
            class="rounded-xl border border-dashed border-gray-200 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
          >
            还没有食材
          </p>
          <ul v-else class="flex flex-col gap-2">
            <li
              v-for="line in detail.ingredients"
              :key="line.id"
              data-test="ingredient-row"
              class="rounded-xl bg-white px-4 py-3 text-lg text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-50"
            >
              {{ amountText(line) }} {{ line.ingredient_name }}
            </li>
          </ul>
        </section>

        <section>
          <h2 class="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">步骤</h2>
          <p
            v-if="steps.length === 0"
            class="rounded-xl border border-dashed border-gray-200 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
          >
            还没有步骤
          </p>
          <ol v-else class="flex flex-col gap-4">
            <li
              v-for="(step, index) in steps"
              :key="step.id"
              data-test="step-row"
              class="flex gap-3 rounded-xl bg-white p-4 shadow-sm dark:bg-slate-800"
            >
              <span
                data-test="step-order"
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-200"
              >
                {{ index + 1 }}
              </span>
              <div class="min-w-0 flex-1">
                <p data-test="step-text" class="text-lg leading-relaxed text-slate-900 dark:text-slate-50">
                  {{ step.text }}
                </p>
                <img
                  v-if="step.image_path"
                  data-test="step-image"
                  :src="imageSrc(step.image_path)"
                  :alt="`步骤 ${index + 1}`"
                  loading="lazy"
                  class="mt-3 w-full rounded-lg object-cover"
                />
              </div>
            </li>
          </ol>
        </section>
      </div>
    </template>

    <div v-else-if="error" data-test="not-found" class="px-6 py-24 text-center">
      <p class="text-slate-500 dark:text-slate-400">{{ error }}</p>
      <button
        type="button"
        data-test="back-to-list"
        class="mt-6 rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        @click="router.push('/')"
      >
        返回列表
      </button>
    </div>

    <ConfirmDialog
      :visible="showDeleteConfirm"
      title="删除这道菜？"
      description="删掉后列表里就不再出现，这个操作不能撤销。"
      confirm-text="删除"
      danger
      @confirm="confirmDelete"
      @cancel="showDeleteConfirm = false"
    />
  </main>
</template>
