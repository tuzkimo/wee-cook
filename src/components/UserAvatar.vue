<script setup lang="ts">
// 头像渲染规则的唯一实现处：能当 URL 的走 <img>，否则退到文本（emoji），再退到昵称首字。
// 宽高 / 圆角由调用方的 class 通过默认属性继承落到外层 div，本组件不认识尺寸。
import { computed } from "vue";

const props = withDefaults(defineProps<{ url: string | null; name: string; textClass?: string }>(), {
  textClass: "text-sm",
});

/** data: / http / / 开头才算图；坏掉的 data URL 也交给 <img>（浏览器出破图），不静默换成首字 */
function isImageUrl(url: string | null): boolean {
  return url !== null && (url.startsWith("data:") || url.startsWith("http") || url.startsWith("/"));
}

/** 用 Array.from 按码点切，charAt(0) 会把 emoji 切成半个代理对 */
function firstChar(name: string): string {
  return Array.from(name.trim())[0] ?? "?";
}

const isImage = computed(() => isImageUrl(props.url));
// 真值判断而非 `??`：空串不是 null，`??` 会让空串原样渲染成一片空白
const text = computed(() => (props.url ? props.url : firstChar(props.name)));
</script>

<template>
  <div class="flex items-center justify-center overflow-hidden bg-gray-100 text-text-secondary">
    <img v-if="isImage" class="h-full w-full object-cover" :src="url!" />
    <span v-else :class="['flex h-full w-full items-center justify-center', textClass]">{{ text }}</span>
  </div>
</template>
