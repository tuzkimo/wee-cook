<script setup lang="ts">
// 列表卡片的唯一实现处：三行 = 标题 / 分类与标签 / 作者。
// 全是已解析好的展示值，组件不认识 imageSrc / syncFiles 与任何数据来源。
// 点击不在这里处理：外层就是 <button>，父组件通过默认属性继承的 @click 接走。
import UserAvatar from "@/components/UserAvatar.vue";

defineProps<{
  name: string;
  coverSrc: string | null;
  category: string | null;
  tags: string[];
  authorName: string | null;
  authorAvatarUrl: string | null;
  testPrefix: "recipe" | "community";
}>();

/** 按码点取首字：charAt(0) 会把 emoji 切成半个代理对（与 UserAvatar 同一套判断） */
function firstChar(name: string): string {
  return Array.from(name.trim())[0] ?? "?";
}
</script>

<template>
  <button
    type="button"
    :data-test="`${testPrefix}-card`"
    class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors hover:bg-gray-50"
  >
    <img
      v-if="coverSrc"
      :data-test="`${testPrefix}-cover`"
      :src="coverSrc"
      :alt="name"
      loading="lazy"
      class="h-11 w-11 shrink-0 rounded-lg object-cover"
    />
    <div
      v-else
      :data-test="`${testPrefix}-cover-fallback`"
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-lg font-semibold text-text-secondary"
    >
      {{ firstChar(name) }}
    </div>
    <div class="min-w-0 flex-1">
      <h3 :data-test="`${testPrefix}-name`" class="line-clamp-2 text-sm font-medium text-text">
        {{ name }}
      </h3>
      <div v-if="category || tags.length > 0" class="mt-1 flex flex-wrap items-center gap-1">
        <span
          v-if="category"
          :data-test="`${testPrefix}-category`"
          class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-text-secondary"
        >
          {{ category }}
        </span>
        <span
          v-for="tag in tags"
          :key="tag"
          :data-test="`${testPrefix}-tag`"
          class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-text-secondary"
        >
          {{ tag }}
        </span>
      </div>
      <div v-if="authorName" class="mt-1 flex items-center gap-1.5">
        <UserAvatar
          :data-test="`${testPrefix}-author-avatar`"
          :url="authorAvatarUrl"
          :name="authorName"
          class="h-5 w-5 shrink-0 rounded-full"
          text-class="text-[10px]"
        />
        <span :data-test="`${testPrefix}-author`" class="truncate text-xs text-text-secondary">
          {{ authorName }}
        </span>
      </div>
    </div>
  </button>
</template>
