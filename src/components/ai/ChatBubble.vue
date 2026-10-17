<script setup lang="ts">
// 一条消息：文本气泡 + 检索结果（卡片列表 / 空态）+ 未落定的名字。
// 不碰路由也不碰 store：点击一律 emit 出去，由页面决定跳哪、写哪个 store。
import { computed, ref, watch } from "vue";
import RecipeCard from "@/components/RecipeCard.vue";
import { imageSrc } from "@/services/imageStore";
import { ensureLocalImages } from "@/services/syncFiles";
import type { ChatMessage } from "@/stores/aiChat";
import type { RecipeFilter } from "@/utils/recipeFilter";

const props = defineProps<{ message: ChatMessage }>();

const emit = defineEmits<{
  open: [id: string];
  continueInFilter: [filter: RecipeFilter];
}>();

// 封面只有已落盘的才能直接用；否则交给 RecipeCard 的字母兜底，不出破图（与列表页同一套判断）
const localImages = ref<Set<string>>(new Set());
watch(
  () => props.message.items,
  async (items) => {
    localImages.value = await ensureLocalImages(items.map((item) => item.recipe.cover_path));
  },
  { immediate: true },
);

/** 三类没落定的名字合成一行；解析可能留下空串，先滤掉免得显示一个空「、」 */
const unresolvedNames = computed<string[]>(() => {
  const names = props.message.unresolved;
  if (names === null) return [];
  return [...names.categories, ...names.tags, ...names.ingredients].filter(
    (name) => name.trim() !== "",
  );
});

function coverSrc(coverPath: string | null): string | null {
  return coverPath !== null && localImages.value.has(coverPath) ? imageSrc(coverPath) : null;
}

function continueInFilter(): void {
  if (props.message.filter !== null) emit("continueInFilter", props.message.filter);
}
</script>

<template>
  <div class="flex flex-col" :class="message.role === 'user' ? 'items-end' : 'items-start'">
    <!-- 截图轮的封面缩略图：dataUrl 直接能用，不欠文件系统 -->
    <img
      v-if="message.image !== null"
      :src="message.image"
      data-test="ai-bubble-image"
      alt="菜谱截图"
      class="mb-1 max-h-40 rounded-xl object-cover"
    />
    <p
      data-test="ai-bubble"
      class="max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm"
      :class="message.role === 'user' ? 'bg-primary text-white' : 'bg-surface text-text'"
    >
      {{ message.text }}
    </p>

    <template v-if="message.filter !== null">
      <p
        v-if="message.matched === 0"
        data-test="ai-empty"
        class="mt-2 w-full rounded-xl bg-surface px-3 py-3 text-center text-xs text-text-secondary"
      >
        库里没找到，去社区逛逛？
      </p>
      <template v-else>
        <div class="mt-2 w-full space-y-1.5">
          <RecipeCard
            v-for="item in message.items"
            :key="item.recipe.id"
            test-prefix="recipe"
            :name="item.recipe.name"
            :cover-src="coverSrc(item.recipe.cover_path)"
            :category="item.category.name || null"
            :tags="item.tags.map((tag) => tag.name)"
            :author-name="item.recipe.owner_nickname"
            :author-avatar-url="item.recipe.owner_avatar_url"
            @click="emit('open', item.recipe.id)"
          />
        </div>
        <!-- store 里结果封顶 10 条，但 matched 是真总数：不许假装只有 10 道 -->
        <p
          v-if="message.matched > message.items.length"
          data-test="ai-more"
          class="mt-2 text-xs text-text-secondary"
        >
          还有 {{ message.matched - message.items.length }} 道，去筛选页看全部
        </p>
        <button
          type="button"
          data-test="ai-continue-filter"
          class="mt-2 self-start rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-gray-200"
          @click="continueInFilter"
        >
          在筛选页继续改
        </button>
      </template>

      <p
        v-if="unresolvedNames.length > 0"
        data-test="ai-unresolved"
        class="mt-2 text-xs text-text-secondary"
      >
        没找到：{{ unresolvedNames.join("、") }}
      </p>
    </template>
  </div>
</template>
