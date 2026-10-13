<script setup lang="ts">
defineProps<{
  visible: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** 仅显示确认按钮（提示态），隐藏取消按钮 */
  hideCancel?: boolean;
}>();

defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
        @click.self="$emit('cancel')"
      >
        <Transition name="scale">
          <div
            v-if="visible"
            class="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
          >
            <h3 class="text-base font-semibold text-slate-900">{{ title }}</h3>
            <p v-if="description" class="mt-2 text-sm text-slate-500">
              {{ description }}
            </p>
            <div class="mt-6 flex gap-3">
              <button
                v-if="!hideCancel"
                class="flex-1 rounded-xl bg-gray-100 py-2.5 text-sm font-medium text-slate-500 transition-colors hover:bg-gray-200"
                @click="$emit('cancel')"
              >
                {{ cancelText || "取消" }}
              </button>
              <button
                class="flex-1 rounded-xl py-2.5 text-sm font-medium text-white transition-colors"
                :class="danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'"
                @click="$emit('confirm')"
              >
                {{ confirmText || "确认" }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.scale-enter-active,
.scale-leave-active {
  transition: all 0.2s ease;
}
.scale-enter-from,
.scale-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
