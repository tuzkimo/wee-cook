<script setup lang="ts">
// 用户页（spec §8 / §9.3）：ta 的公开菜谱 + 关注 / 取消关注。
// 在线页：资料与列表都走 REST（用户页本身要在线，作者昵称的离线显示在菜谱详情页那边）。
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import { imageSrc } from "@/services/imageStore";
import {
  listCommunityRecipes,
  type CommunityRecipe,
  type UserProfile,
} from "@/services/community";
import { useAuthStore } from "@/stores/auth";
import { useCommunityStore } from "@/stores/community";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useCommunityStore();

const userId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));
const profile = ref<UserProfile | null>(null);
const recipes = ref<CommunityRecipe[]>([]);
const error = ref("");
const followError = ref("");
const loading = ref(false);
const following = ref(false);

// 未登录 / 离线一个请求都不发（spec §9.4）：这两个端点对 guest 一律 401，
// 发了只会永远停在失败态。本机仍会显示别人的菜谱副本，所以这条路真的会被走到。
const OFFLINE_MESSAGE = "用户资料需要联网查看";

// 列表直接调服务层：社区 store 的 load 不接受 author_id，而且它带着菜谱页的筛选状态。
// shortcut: 只取第一页，公开菜谱超过 50 条的作者需要「加载更多」时再加。
async function load(): Promise<void> {
  const id = userId.value;
  if (!id) {
    error.value = "用户不存在";
    return;
  }
  if (!auth.isOnline) {
    error.value = OFFLINE_MESSAGE;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const [user, page] = await Promise.all([
      store.profile(id),
      listCommunityRecipes({ limit: 50, offset: 0, authorId: id }),
    ]);
    profile.value = user;
    recipes.value = page.items;
  } catch (loadError: unknown) {
    error.value =
      loadError instanceof Error && loadError.message ? loadError.message : "加载失败，请重试";
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** 乐观翻转：先让按钮变，服务端拒绝就翻回去并说明原因，不静默。 */
async function toggleFollow(): Promise<void> {
  const current = profile.value;
  if (!current || following.value) return;
  const next = !current.followed;
  followError.value = "";
  current.followed = next;
  following.value = true;
  try {
    await (next ? store.follow(current.id) : store.unfollow(current.id));
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

/** 先把详情落库再跳，详情页才读得到本地副本。 */
async function open(id: string): Promise<void> {
  try {
    await store.openRecipe(id);
  } catch (openError: unknown) {
    error.value =
      openError instanceof Error && openError.message ? openError.message : "打开失败，请重试";
    return;
  }
  await router.push(`/recipe/${id}`);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader :title="profile?.nickname ?? '用户'" show-back @back="router.back()" />

    <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
      <p
        v-if="loading"
        data-test="user-loading"
        class="py-12 text-center text-sm text-text-secondary"
      >
        加载中…
      </p>

      <div v-else-if="error" data-test="user-error" class="py-12 text-center">
        <p class="text-sm text-danger">{{ error }}</p>
        <button
          type="button"
          data-test="user-retry"
          class="mt-4 rounded-lg bg-primary px-6 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          :disabled="!auth.isOnline"
          @click="load"
        >
          重试
        </button>
      </div>

      <template v-else-if="profile">
        <div class="mb-3 flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-3 py-3">
          <div class="min-w-0">
            <h1 data-test="user-nickname" class="truncate text-base font-semibold text-text">
              {{ profile.nickname }}
            </h1>
            <p data-test="user-public-count" class="text-xs text-text-secondary">
              公开菜谱 {{ profile.public_count }}
            </p>
          </div>
          <button
            type="button"
            data-test="user-follow"
            class="shrink-0 rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
            :class="
              profile.followed
                ? 'border-gray-300 text-text-secondary hover:bg-gray-50'
                : 'border-primary text-primary hover:bg-primary/10'
            "
            :disabled="!auth.isOnline || following"
            @click="toggleFollow"
          >
            {{ profile.followed ? "取消关注" : "关注" }}
          </button>
        </div>

        <p
          v-if="followError"
          data-test="user-follow-error"
          class="mb-3 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {{ followError }}
        </p>

        <h2 class="mb-2 text-xs font-semibold text-text-secondary">公开菜谱</h2>
        <p
          v-if="recipes.length === 0"
          data-test="user-empty"
          class="rounded-xl border border-dashed border-gray-300 py-6 text-center text-sm text-text-secondary"
        >
          还没有公开的菜谱
        </p>
        <ul v-else class="flex flex-col gap-2.5">
          <li v-for="item in recipes" :key="item.id">
            <button
              type="button"
              data-test="user-recipe"
              class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors hover:bg-gray-50"
              @click="open(item.id)"
            >
              <img
                v-if="item.cover_path"
                :src="imageSrc(item.cover_path)"
                :alt="item.name"
                loading="lazy"
                class="h-11 w-11 shrink-0 rounded-lg object-cover"
              />
              <div
                v-else
                class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-lg font-semibold text-text-secondary"
              >
                {{ item.name.charAt(0) }}
              </div>
              <h3 class="line-clamp-2 text-sm font-medium text-text">{{ item.name }}</h3>
            </button>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>
