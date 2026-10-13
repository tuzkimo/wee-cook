<script setup lang="ts">
// 拍照 / 从相册选 / 移除 三选一（规格 §7）。三个选项**内联在一行**，不套底部 sheet ——
// 它只服务一张图，弹一层面板反而多一次点击。
//
// 拍照走 webview 自带的 `<input type="file" accept="image/*" capture="environment">`，零依赖
// （真机结论见本文件末尾的注释）。压缩与落盘全在 `services/imageStore.ts`，本组件只负责
// 「拿到结果 → emit 文件名 / 显示文案」。
import { ref } from "vue";
import { imageSrc, pickAndSaveImage, saveImageBytes, type SaveImageResult } from "@/services/imageStore";

const props = withDefaults(defineProps<{ modelValue: string | null; label?: string }>(), {
  label: "封面图",
});

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
}>();

const optionsOpen = ref(false);
const error = ref("");
const cameraInput = ref<HTMLInputElement | null>(null);

function toggleOptions(): void {
  error.value = "";
  optionsOpen.value = !optionsOpen.value;
}

/** 成功才 emit 并收起选项；取消什么都不做；失败只显示文案、不清空已有的图 */
function apply(result: SaveImageResult | null): void {
  if (result === null) return;
  if (!result.ok) {
    error.value = result.message;
    return;
  }
  error.value = "";
  optionsOpen.value = false;
  emit("update:modelValue", result.name);
}

async function chooseFromGallery(): Promise<void> {
  apply(await pickAndSaveImage());
}

async function onCameraFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 清掉才能再拍同一张（否则 change 不触发）
  if (!file) return;
  apply(await saveImageBytes(new Uint8Array(await file.arrayBuffer())));
}

function remove(): void {
  error.value = "";
  optionsOpen.value = false;
  emit("update:modelValue", null);
}
</script>

<template>
  <div>
    <label class="mb-1 block text-sm font-medium text-text">{{ props.label }}</label>

    <button
      v-if="props.modelValue"
      type="button"
      data-test="image-preview"
      class="h-24 w-24 overflow-hidden rounded-xl bg-gray-100 ring-2 ring-gray-200 transition hover:ring-primary"
      @click="toggleOptions"
    >
      <img
        :src="imageSrc(props.modelValue)"
        class="h-full w-full object-cover"
        :alt="props.label"
      />
    </button>
    <button
      v-else
      type="button"
      data-test="image-placeholder"
      class="flex h-24 w-24 flex-col items-center justify-center rounded-xl bg-gray-100 text-xs text-text-secondary ring-2 ring-gray-200 transition hover:ring-primary"
      @click="toggleOptions"
    >
      <span class="text-2xl leading-none">+</span>
      <span class="mt-1">{{ props.label }}</span>
    </button>

    <div v-if="optionsOpen" data-test="image-options" class="mt-2 flex gap-2">
      <button
        type="button"
        data-test="opt-camera"
        class="rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-200"
        @click="cameraInput?.click()"
      >
        拍照
      </button>
      <button
        type="button"
        data-test="opt-gallery"
        class="rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-200"
        @click="chooseFromGallery"
      >
        从相册选
      </button>
      <button
        type="button"
        data-test="opt-remove"
        class="rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-200"
        @click="remove"
      >
        移除
      </button>
    </div>

    <input
      ref="cameraInput"
      data-test="image-camera-input"
      type="file"
      accept="image/*"
      capture="environment"
      class="hidden"
      @change="onCameraFile"
    />

    <p v-if="error" data-test="image-error" class="mt-2 text-sm text-danger">{{ error }}</p>
  </div>
</template>

<!--
拍照走 webview 的 `<input capture>`，零依赖（规格 §12 风险 1 已关闭）。
2026-10-13 真机（小米 HyperOS / Android 16）实测：相机能被唤起、拍完能回显、重开 App 图还在；
相册选图与 asset protocol 显示图片同样正常（风险 2 一并关闭）。
若哪天真机上唤不起相机，按设计 §12 的预案改走社区相机插件：`pickFromGallery` /
`saveImageBytes` 的签名不变，插件调用关在 `src/services/imageStore.ts` 的 `realDeps` 里。
-->
