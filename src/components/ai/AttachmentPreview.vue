<script setup lang="ts">
// 待发送截图的预览：只负责缩略图与「移除」，显隐由父组件按 attachment 决定。
defineProps<{ image: string }>();

const emit = defineEmits<{
  remove: [];
}>();
</script>

<template>
  <div data-test="ai-attach-preview" class="relative mb-2 inline-block">
    <img :src="image" alt="待发送的截图" class="max-h-28 rounded-xl object-cover" />
    <button
      type="button"
      data-test="ai-attachment-remove"
      aria-label="移除截图"
      class="absolute -right-1.5 -top-1.5 h-6 w-6 rounded-full bg-black/60 text-xs text-white"
      @click="emit('remove')"
    >
      ✕
    </button>
  </div>
</template>
