<script setup lang="ts">
// 只读详情页（规格 §6.4）：食材清单在前、字号偏大 —— 这是做菜时真正要看的那一段；
// 步骤在后，带序号与可选插图。「编辑」与「删除」都在顶栏右上角。
// ⚠️ 不做计时器 / 防熄屏 / 逐步高亮，那是下一轮的跟做模式，别在这里加。
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Pencil, Trash2 } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import { imageSrc } from "@/services/imageStore";
import { useAuthStore } from "@/stores/auth";
import { useCommunityStore } from "@/stores/community";
import { canEdit, useRecipeStore } from "@/stores/recipe";
import type { RecipeDetail, RecipeInput } from "@/types";
import { amountText } from "@/utils/amount";

const route = useRoute();
const router = useRouter();
const store = useRecipeStore();
const communityStore = useCommunityStore();
const auth = useAuthStore();

const recipeId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));
const detail = ref<RecipeDetail | null>(null);
const error = ref("");
const showDeleteConfirm = ref(false);
const deleteError = ref("");
const publicError = ref("");
// 收藏只对别人的菜谱可见（spec §9.3）：初值读本地收藏表，离线也读得出
const favorited = ref(false);
const favoriteError = ref("");
const favoriting = ref(false);
const toggling = ref(false);

// store 已经按 sort_order 查出来，这里再排一次是为了「页面自己保证顺序」这件事可被断言
const steps = computed(() =>
  [...(detail.value?.steps ?? [])].sort((a, b) => a.sort_order - b.sort_order),
);

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
    return;
  }
  // 读不到（库未就绪）就当没收藏：一个按钮初值不值得挡住整页详情
  favorited.value = await communityStore.isFavorited(id).catch(() => false);
});

/** 乐观翻转：先让按钮变，服务端拒绝就翻回去并说明原因，不静默。 */
async function toggleFavorite(): Promise<void> {
  if (!detail.value || favoriting.value) return;
  const next = !favorited.value;
  favoriteError.value = "";
  favorited.value = next;
  favoriting.value = true;
  try {
    await (next
      ? communityStore.favorite(recipeId.value)
      : communityStore.unfavorite(recipeId.value));
  } catch (favoriteFailure: unknown) {
    favorited.value = !next;
    favoriteError.value =
      favoriteFailure instanceof Error && favoriteFailure.message
        ? favoriteFailure.message
        : "操作失败，请重试";
  } finally {
    favoriting.value = false;
  }
}

function openAuthor(): void {
  const ownerId = detail.value?.recipe.owner_id;
  if (ownerId) void router.push(`/user/${ownerId}`);
}

function edit(): void {
  void router.push(`/recipe/${recipeId.value}/edit`);
}

// 快捷公开开关：update 是「子行整组替换」，必须带上当前详情里的步骤/食材/标签/分类，
// 否则点一下开关会把这道菜的步骤与食材清空。取消公开是可撤销动作，不弹二次确认（spec §9.2）。
async function togglePublic(): Promise<void> {
  // update 是「先插后删」的非事务子行替换，两次并发会互相删掉新行：跟编辑页一样挡在入口
  if (toggling.value) return;
  const current = detail.value;
  if (!current) return;
  const next = current.recipe.is_public === 1 ? 0 : 1;
  const input: RecipeInput = {
    name: current.recipe.name,
    cover_path: current.recipe.cover_path,
    category_id: current.category.id,
    is_public: next,
    tag_ids: current.tags.map((tag) => tag.id),
    steps: current.steps.map((step) => ({ text: step.text, image_path: step.image_path })),
    ingredients: current.ingredients.map((line) => ({
      ingredient_id: line.ingredient_id,
      amount: line.amount,
      unit_id: line.unit_id,
    })),
  };
  publicError.value = "";
  const before = current.recipe.is_public;
  current.recipe.is_public = next;
  toggling.value = true;
  try {
    await store.update(recipeId.value, input);
  } catch (updateError: unknown) {
    // 失败回滚开关，别让界面显示一个没落库的状态
    current.recipe.is_public = before;
    publicError.value =
      updateError instanceof Error && updateError.message ? updateError.message : "操作失败，请重试";
  } finally {
    toggling.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  showDeleteConfirm.value = false;
  deleteError.value = "";
  try {
    await store.remove(recipeId.value);
  } catch (removeError: unknown) {
    // 删除是唯一会丢数据的操作：失败就留在详情页并说明，别让用户以为删掉了
    deleteError.value =
      removeError instanceof Error && removeError.message ? removeError.message : "删除失败，请重试";
    return;
  }
  await router.push("/");
}
</script>

<template>
  <div class="flex h-full flex-col">
    <template v-if="detail">
      <AppHeader :title="detail.recipe.name" class="border-b border-gray-100" show-back @back="router.back()">
        <template #title>
          <h1 data-test="detail-name" class="min-w-0 flex-1 truncate text-lg font-semibold text-text">
            {{ detail.recipe.name }}
          </h1>
        </template>
        <template #action>
          <button
            v-if="canEdit(detail.recipe)"
            type="button"
            data-test="edit"
            aria-label="编辑"
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="edit"
          >
            <Pencil :size="18" class="text-text-secondary" />
          </button>
          <button
            v-if="canEdit(detail.recipe)"
            type="button"
            data-test="delete"
            aria-label="删除"
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="showDeleteConfirm = true"
          >
            <Trash2 :size="18" class="text-danger" />
          </button>
        </template>
      </AppHeader>

      <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
        <p
          v-if="deleteError"
          data-test="delete-error"
          class="mb-2 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {{ deleteError }}
        </p>

        <p
          v-if="publicError"
          data-test="public-error"
          class="mb-2 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {{ publicError }}
        </p>

        <p
          v-if="favoriteError"
          data-test="favorite-error"
          class="mb-2 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {{ favoriteError }}
        </p>

        <!-- 别人的菜谱：只读，能给的是「知道是谁的」与「收藏」（spec §9.3） -->
        <div
          v-if="!canEdit(detail.recipe)"
          class="mb-4 flex items-center justify-between gap-3"
        >
          <button
            v-if="detail.recipe.owner_id"
            type="button"
            data-test="recipe-author"
            class="min-w-0 truncate text-sm text-primary"
            @click="openAuthor"
          >
            {{ detail.recipe.owner_nickname }}
          </button>
          <span v-else class="min-w-0"></span>
          <button
            type="button"
            data-test="recipe-favorite"
            class="shrink-0 rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
            :class="
              favorited
                ? 'border-gray-300 text-text-secondary hover:bg-gray-50'
                : 'border-primary text-primary hover:bg-primary/10'
            "
            :disabled="!auth.isOnline || favoriting"
            @click="toggleFavorite"
          >
            {{ favorited ? "已收藏" : "收藏" }}
          </button>
        </div>

        <label
          v-if="canEdit(detail.recipe)"
          class="mb-4 flex items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm"
        >
          <span class="text-text-secondary">公开到社区</span>
          <input
            data-test="recipe-public-toggle"
            type="checkbox"
            class="h-5 w-5 accent-primary"
            :checked="detail.recipe.is_public === 1"
            :disabled="toggling"
            @change="togglePublic"
          />
        </label>

        <div class="mb-6 flex flex-wrap items-center gap-2">
          <span data-test="detail-category" class="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary">
            {{ detail.category.name }}
          </span>
          <span
            v-for="tag in detail.tags"
            :key="tag.id"
            data-test="detail-tag"
            class="rounded-full bg-surface px-2.5 py-1 text-xs text-text-secondary"
          >
            {{ tag.name }}
          </span>
        </div>

        <section class="mb-8">
          <h2 class="mb-2 text-xs font-medium text-text-secondary">食材</h2>
          <p
            v-if="detail.ingredients.length === 0"
            class="rounded-xl border border-dashed border-gray-300 py-6 text-center text-sm text-text-secondary"
          >
            还没有食材
          </p>
          <ul v-else class="flex flex-col gap-2">
            <li
              v-for="line in detail.ingredients"
              :key="line.id"
              data-test="ingredient-row"
              class="rounded-xl bg-surface px-3 py-3 text-sm font-medium text-text"
            >
              {{ amountText(line) }} {{ line.ingredient_name }}
            </li>
          </ul>
        </section>

        <section>
          <h2 class="mb-2 text-xs font-medium text-text-secondary">步骤</h2>
          <p
            v-if="steps.length === 0"
            class="rounded-xl border border-dashed border-gray-300 py-6 text-center text-sm text-text-secondary"
          >
            还没有步骤
          </p>
          <ol v-else class="flex flex-col gap-4">
            <li
              v-for="(step, index) in steps"
              :key="step.id"
              data-test="step-row"
              class="flex gap-3 rounded-xl bg-surface p-3"
            >
              <span
                data-test="step-order"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-text-secondary"
              >
                {{ index + 1 }}
              </span>
              <div class="min-w-0 flex-1">
                <p data-test="step-text" class="text-sm leading-relaxed text-text">
                  {{ step.text }}
                </p>
                <img
                  v-if="step.image_path"
                  data-test="step-image"
                  :src="imageSrc(step.image_path)"
                  :alt="`步骤 ${index + 1}`"
                  loading="lazy"
                  class="mt-2 w-full rounded-lg object-cover"
                />
              </div>
            </li>
          </ol>
        </section>
      </div>
    </template>

    <div v-else-if="error" data-test="not-found" class="px-6 py-24 text-center">
      <p class="text-text-secondary">{{ error }}</p>
      <button
        type="button"
        data-test="back-to-list"
        class="mt-6 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white"
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
  </div>
</template>
