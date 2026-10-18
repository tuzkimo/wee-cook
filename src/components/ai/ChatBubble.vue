<script setup lang="ts">
// 一条消息：文本气泡 + 检索结果（卡片列表 / 空态）+ 未落定的名字。
// 不碰路由也不碰 store：点击一律 emit 出去，由页面决定跳哪、写哪个 store。
import { computed, ref, watch } from "vue";
import RecipeCard from "@/components/RecipeCard.vue";
import { imageSrc } from "@/services/imageStore";
import { ensureLocalImages } from "@/services/syncFiles";
import type { ChatMessage } from "@/stores/aiChat";
import { renderMarkdown } from "@/utils/markdown";
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
    <!-- 用户说的是什么就打什么；AI 回复是 markdown，走渲染 -->
    <p
      v-if="message.text !== '' && message.role === 'user'"
      data-test="ai-bubble"
      class="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3.5 py-2.5 text-sm text-white"
    >
      {{ message.text }}
    </p>
    <div
      v-else-if="message.text !== ''"
      data-test="ai-bubble"
      v-html="renderMarkdown(message.text)"
      class="md max-w-[85%] rounded-2xl bg-surface px-3.5 py-2.5 text-sm text-text"
    />

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

<!-- 渲染出来的 markdown 没有 class，样式只能从 .md 往下按标签给；整体比正文小一号，免得气泡被撑爆 -->
<style scoped>
.md :deep(> :first-child) {
  margin-top: 0;
}

.md :deep(> :last-child) {
  margin-bottom: 0;
}

.md :deep(p),
.md :deep(ul),
.md :deep(ol),
.md :deep(pre),
.md :deep(blockquote) {
  margin: 0.4em 0;
}

.md :deep(ul),
.md :deep(ol) {
  padding-left: 1.25em;
}

.md :deep(ul) {
  list-style: disc;
}

.md :deep(ol) {
  list-style: decimal;
}

.md :deep(li) {
  margin: 0.15em 0;
}

.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  margin: 0.6em 0 0.3em;
  font-weight: 600;
}

.md :deep(h1) {
  font-size: 1.05em;
}

.md :deep(h2) {
  font-size: 1em;
}

.md :deep(h3),
.md :deep(h4) {
  font-size: 0.95em;
}

.md :deep(code) {
  border-radius: 0.25rem;
  background: var(--color-bg);
  padding: 0.1em 0.3em;
  font-size: 0.85em;
}

.md :deep(pre) {
  overflow-x: auto;
  border-radius: 0.5rem;
  background: var(--color-bg);
  padding: 0.5em 0.65em;
}

.md :deep(pre code) {
  background: none;
  padding: 0;
}

.md :deep(blockquote) {
  border-left: 3px solid var(--color-bg);
  padding-left: 0.6em;
  color: var(--color-text-secondary);
}

.md :deep(a) {
  color: var(--color-primary);
  text-decoration: underline;
}

.md :deep(hr) {
  margin: 0.6em 0;
  border-top: 1px solid var(--color-bg);
}
</style>
