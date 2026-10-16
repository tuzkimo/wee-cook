<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Star } from "lucide-vue-next";
import { useCommunityStore } from "@/stores/community";
import { imageSrc } from "@/services/imageStore";
import { ensureLocalImages } from "@/services/syncFiles";

const router = useRouter();
const store = useCommunityStore();

// 列表的 cover_path 只是本机文件名，图得走鉴权下载通道补下来；只把已落盘的名字交给模板，
// 文件没到时用字母兜底，不出破图（spec §2 目标：在线浏览要能看到图片）。
const localCovers = ref<Set<string>>(new Set());
watch(
  () => store.items,
  async () => {
    localCovers.value = await ensureLocalImages(store.items.map((item) => item.cover_path));
  },
  { immediate: true },
);

onMounted(() => {
  void store.load(true);
});
// 「关注」切换只改 followedOnly，feed 在「全部」与「关注」之间不卸载，得自己重拉
watch(
  () => store.followedOnly,
  () => void store.load(true),
);

async function open(id: string): Promise<void> {
  // 先把详情落库再跳，详情页才读得到本地副本
  await store.openRecipe(id);
  await router.push(`/recipe/${id}`);
}
</script>

<template>
  <section data-test="community-section">
    <h2 class="mb-2 text-xs font-semibold text-text-secondary">社区</h2>

    <p
      v-if="store.loading && store.items.length === 0"
      data-test="community-loading"
      class="py-6 text-center text-sm text-text-secondary"
    >
      加载中…
    </p>

    <div v-else-if="store.error" data-test="community-error" class="py-6 text-center">
      <button
        type="button"
        data-test="community-retry"
        class="text-sm text-primary"
        @click="store.load(true)"
      >
        加载失败 · 重试
      </button>
    </div>

    <p
      v-else-if="store.items.length === 0"
      data-test="community-empty"
      class="py-6 text-center text-sm text-text-secondary"
    >
      还没有公开的菜谱
    </p>

    <ul v-else class="flex flex-col gap-2.5">
      <li v-for="item in store.items" :key="item.id">
        <button
          type="button"
          data-test="community-card"
          class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors hover:bg-gray-50"
          @click="open(item.id)"
        >
          <img
            v-if="item.cover_path && localCovers.has(item.cover_path)"
            data-test="community-cover"
            :src="imageSrc(item.cover_path)"
            :alt="item.name"
            loading="lazy"
            class="h-11 w-11 shrink-0 rounded-lg object-cover"
          />
          <div
            v-else
            data-test="community-cover-fallback"
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-lg font-semibold text-text-secondary"
          >
            {{ item.name.charAt(0) }}
          </div>
          <div class="min-w-0 flex-1">
            <h3 data-test="community-name" class="line-clamp-2 text-sm font-medium text-text">
              {{ item.name }}
            </h3>
            <p data-test="community-author" class="text-xs text-text-secondary">
              {{ item.author_nickname }}
            </p>
          </div>
          <Star v-if="item.favorited" data-test="community-favorited" :size="16" class="shrink-0 text-primary" />
        </button>
      </li>
    </ul>

    <button
      v-if="store.hasMore"
      type="button"
      data-test="community-load-more"
      class="mt-3 w-full rounded-xl bg-gray-100 py-2 text-sm text-text-secondary"
      @click="store.load()"
    >
      加载更多
    </button>
  </section>
</template>
