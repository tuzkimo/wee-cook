<script setup lang="ts">
// 底部输入区：只管「有没有可发的内容」与不可用态，选图/移除都由页面接给 store。
import { computed, ref } from "vue";
import { ImagePlus } from "lucide-vue-next";
import AttachmentPreview from "@/components/ai/AttachmentPreview.vue";

const props = defineProps<{
  disabled: boolean;
  sending: boolean;
  /** 待发送截图的封面 dataUrl；null = 没有附件 */
  attachment: string | null;
}>();

const emit = defineEmits<{
  send: [text: string];
  attach: [];
  detach: [];
}>();

const text = ref("");
const blocked = computed(() => props.disabled || props.sending);

function submit(): void {
  const content = text.value.trim();
  // 只有带图时允许空文字：图本身就是问题
  if (blocked.value || (content === "" && props.attachment === null)) return;
  emit("send", content);
  text.value = "";
}
</script>

<template>
  <div class="px-4 pb-3 pt-2">
    <AttachmentPreview v-if="attachment !== null" :image="attachment" @remove="emit('detach')" />
    <form class="flex items-center gap-2" @submit.prevent="submit">
      <button
        type="button"
        data-test="ai-attach"
        aria-label="发送截图"
        :disabled="blocked"
        class="shrink-0 rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-text-secondary transition-colors hover:bg-gray-50 disabled:opacity-50"
        @click="emit('attach')"
      >
        <ImagePlus class="h-4 w-4" aria-hidden="true" />
      </button>
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
  </div>
</template>
