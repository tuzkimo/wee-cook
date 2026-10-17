<script setup lang="ts">
// 底部输入区：只管「有没有非空文本」与不可用态，发送由页面接给 store。
import { computed, ref } from "vue";

const props = defineProps<{
  disabled: boolean;
  sending: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
}>();

const text = ref("");
const blocked = computed(() => props.disabled || props.sending);

function submit(): void {
  const content = text.value.trim();
  if (content === "" || blocked.value) return;
  emit("send", content);
  text.value = "";
}
</script>

<template>
  <form class="flex items-center gap-2 px-4 pb-3 pt-2" @submit.prevent="submit">
    <input
      v-model="text"
      data-test="ai-input"
      type="text"
      enterkeyhint="send"
      aria-label="想问点什么"
      :disabled="blocked"
      placeholder="比如：找有五花肉的菜"
      class="min-w-0 flex-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary disabled:bg-gray-50 disabled:text-text-secondary"
    />
    <button
      type="submit"
      data-test="ai-send"
      :disabled="blocked"
      class="shrink-0 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
    >
      发送
    </button>
  </form>
</template>
