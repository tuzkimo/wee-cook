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
    <label class="mb-1 block text-sm font-medium text-slate-900">{{ props.label }}</label>

    <button
      v-if="props.modelValue"
      type="button"
      data-test="image-preview"
      class="h-24 w-24 overflow-hidden rounded-xl bg-gray-100 ring-2 ring-gray-200 transition hover:ring-blue-600"
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
      class="flex h-24 w-24 flex-col items-center justify-center rounded-xl bg-gray-100 text-xs text-slate-500 ring-2 ring-gray-200 transition hover:ring-blue-600"
      @click="toggleOptions"
    >
      <span class="text-2xl leading-none">+</span>
      <span class="mt-1">{{ props.label }}</span>
    </button>

    <div v-if="optionsOpen" data-test="image-options" class="mt-2 flex gap-2">
      <button
        type="button"
        data-test="opt-camera"
        class="rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-gray-200"
        @click="cameraInput?.click()"
      >
        拍照
      </button>
      <button
        type="button"
        data-test="opt-gallery"
        class="rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-gray-200"
        @click="chooseFromGallery"
      >
        从相册选
      </button>
      <button
        type="button"
        data-test="opt-remove"
        class="rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-gray-200"
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

    <p v-if="error" data-test="image-error" class="mt-2 text-sm text-red-600">{{ error }}</p>
  </div>
</template>

<!--
Task 7 Step 7 真机结论（2026-10-13，设备 24091RPADC / HyperOS 16）：**未完成，不是已通过**。
APK 本身构建通过（`npm run tauri android build --apk --debug` → app-universal-debug.apk），
但 HyperOS 拒绝安装：`adb install` 报 `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`
（系统通知「应用安装拦截 — 已拦截通过 USB 安装的一起做饭」，即「通过 USB 安装」开关未开）；
改走文件管理器的用户安装流程，点到「继续安装」后弹的是小米账号登录（com.xiaomi.account
QuickLoginActivity），装不下来。所以「<input capture> 能不能唤起相机」（规格 §12 风险 1）与
「asset protocol + CSP 能不能显示图片」（风险 2）**都没有实测证据**。
保留 capture 写法是因为它零依赖、也没有反证据；谁把它在真机上跑通后，把这段改成
「拍照走 webview 的 capture，零依赖」或按计划改走社区插件即可。详细命令与输出见
.superpowers/sdd/2026-10-13-recipe-crud/task-7-report.md 的 Step 7 一节。
-->
