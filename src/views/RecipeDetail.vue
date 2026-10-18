<script setup lang="ts">
// 只读详情页（规格 §6.4）：食材清单在前、字号偏大 —— 这是做菜时真正要看的那一段；
// 步骤在后，带序号与可选插图。「编辑」与「删除」都在顶栏右上角。
// ⚠️ 计时器 / 防熄屏 / 逐步高亮 属于指导模式，已在 `RecipeGuide.vue` 里做，别在这里加。
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Pencil, PhoneCall, Star, Trash2, UserCheck, UserPlus } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import UserAvatar from "@/components/UserAvatar.vue";
import { imageSrc } from "@/services/imageStore";
import type { UserProfile } from "@/services/community";
import { ensureLocalImages } from "@/services/syncFiles";
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
// 步骤图得走鉴权下载通道补下来；只把**已落盘**的名字交给模板，文件没到就不出 <img>，
// 宁可不显示也不出破图（首次打开社区菜谱时图还在后台下载，spec §8.3）
const localImages = ref<Set<string>>(new Set());
const error = ref("");
const showDeleteConfirm = ref(false);
const deleteError = ref("");
const publicError = ref("");
// 收藏只对别人的菜谱可见（spec §9.3）：初值读本地收藏表，离线也读得出
const favorited = ref(false);
const favoriteError = ref("");
const favoriting = ref(false);
const toggling = ref(false);
// 作者卡片（spec §7）：昵称与头像用本地那份立刻画，联网再补「公开 N 道」与关注按钮
const authorProfile = ref<UserProfile | null>(null);
const following = ref(false);
const followError = ref("");

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
  // 读不到（库未就绪）就当没收藏：一个按钮初值不值得挡住整页详情。
  // 先读本地收藏再等图：读本地 SQL 是毫秒级，图片下载要串行跑完，反过来的话慢网下
  // 按钮会在图下完之前一直显示错的「收藏」态
  favorited.value = await communityStore.isFavorited(id).catch(() => false);
  // 不 await：作者资料是补料，慢网下不该拖住步骤图下载
  void loadAuthorProfile();
  localImages.value = await ensureLocalImages(steps.value.map((step) => step.image_path));
});

/** 拉作者资料补「公开 N 道」与关注态。失败静默 —— 卡片其余部分照常，不阻塞只读页。 */
async function loadAuthorProfile(): Promise<void> {
  const current = detail.value;
  // 自己的菜谱不画作者卡片（canEdit 为真），也就不必请自己的资料
  if (!current || !current.recipe.owner_id || canEdit(current.recipe) || !auth.isOnline) return;
  try {
    authorProfile.value = await communityStore.profile(current.recipe.owner_id);
  } catch {
    // 拿不到就少画数字与关注按钮，不写错误提示（spec §4.6）
  }
}

/** 关注按钮：乐观翻转，服务端拒绝就翻回去并提示（与用户页同一套）。 */
async function toggleFollow(): Promise<void> {
  const ownerId = detail.value?.recipe.owner_id;
  const current = authorProfile.value;
  if (!ownerId || !current || following.value) return;
  const next = !current.followed;
  followError.value = "";
  current.followed = next;
  following.value = true;
  try {
    await (next ? communityStore.follow(ownerId) : communityStore.unfollow(ownerId));
  } catch (followFailure: unknown) {
    current.followed = !next;
    followError.value =
      followFailure instanceof Error && followFailure.message
        ? followFailure.message
        : "操作失败，请重试";
  } finally {
    following.value = false;
  }
}

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
  // 带上来源标记：编辑页保存后才知道该 back()（弹掉自己）还是 replace()
  void router.push({ path: `/recipe/${recipeId.value}/edit`, query: { from: "detail" } });
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
  // replace：删除后历史里不能留下这张已删除菜谱的详情，否则返回键会回到「菜谱不存在」
  await router.replace("/");
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
            type="button"
            data-test="guide"
            aria-label="指导模式"
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="router.push(`/recipe/${recipeId}/guide`)"
          >
            <PhoneCall :size="18" class="text-text-secondary" />
          </button>
          <!-- 收藏只对别人的菜谱可见（spec §9.3）：图标按钮放顶栏，正文不再占一行 -->
          <button
            v-if="!canEdit(detail.recipe)"
            type="button"
            data-test="recipe-favorite"
            :aria-label="favorited ? '已收藏' : '收藏'"
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100 disabled:opacity-50"
            :disabled="!auth.isOnline || favoriting"
            @click="toggleFavorite"
          >
            <Star
              :size="18"
              :fill="favorited ? 'currentColor' : 'none'"
              :class="favorited ? 'text-primary' : 'text-text-secondary'"
            />
          </button>
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

        <p
          v-if="followError"
          data-test="author-follow-error"
          class="mb-2 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {{ followError }}
        </p>

        <!-- 别人的菜谱：只读，能给的是「知道是谁的」「关注 ta」与「收藏」（spec §7 / §9.3） -->
        <div
          v-if="!canEdit(detail.recipe) && detail.recipe.owner_id"
          class="mb-4 flex items-center gap-3 rounded-xl bg-surface px-3 py-3"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-3 text-left"
            @click="openAuthor"
          >
            <UserAvatar
              data-test="recipe-author-avatar"
              :url="detail.recipe.owner_avatar_url"
              :name="detail.recipe.owner_nickname ?? ''"
              class="h-16 w-16 shrink-0 rounded-full"
              text-class="text-2xl"
            />
            <div class="min-w-0 flex-1">
              <p data-test="recipe-author" class="truncate text-base font-medium text-text">
                {{ detail.recipe.owner_nickname }}
              </p>
              <p
                v-if="authorProfile"
                data-test="recipe-author-count"
                class="text-xs text-text-secondary"
              >
                公开 {{ authorProfile.public_count }} 道
              </p>
            </div>
          </button>
          <button
            v-if="authorProfile"
            type="button"
            data-test="recipe-author-follow"
            :aria-label="authorProfile.followed ? '取消关注' : '关注'"
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50"
            :class="
              authorProfile.followed
                ? 'text-primary hover:bg-primary/10'
                : 'bg-primary text-white hover:bg-primary-dark'
            "
            :disabled="!auth.isOnline || following"
            @click="toggleFollow"
          >
            <UserCheck v-if="authorProfile.followed" :size="18" />
            <UserPlus v-else :size="18" />
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
                  v-if="step.image_path && localImages.has(step.image_path)"
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
