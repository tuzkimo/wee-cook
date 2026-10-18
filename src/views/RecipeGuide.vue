<script setup lang="ts">
// 全屏指导模式（规格 §6）：做菜时手机放一边，随口问「小厨，面粉多少」。
// 全程只读：不写数据库、不落盘、不发业务网络请求。识别与朗读都委托系统能力。
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import { useRecipeStore } from "@/stores/recipe";
import { answerQuestion } from "@/services/voice/answer";
import { keepScreenOn } from "@/services/voice/keepAwake";
import {
  isSpeechAvailable,
  startSpeech,
  type SpeechErrorKind,
  type SpeechHandle,
} from "@/services/voice/speech";
import { speak, stopSpeaking } from "@/services/voice/tts";
import type { RecipeIngredientRow, RecipeStep } from "@/types";

/** 连续 3 次可重试错误就不再自己起麦（规格 §6） */
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 1500;
/** 同一句答案 5 秒内只应答一次（朗读回灌不暂停识别，见规格 §3） */
const DEDUPE_MS = 5000;
const MAX_QA = 5;

const route = useRoute();
const router = useRouter();
const store = useRecipeStore();

const recipeId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));
const recipeName = ref("");
const steps = ref<RecipeStep[]>([]);
const ingredients = ref<RecipeIngredientRow[]>([]);
const currentStep = ref(0);
const qa = ref<{ question: string; answer: string }[]>([]);
/** 上一句听到的原文：识别得到的但不带唤醒词时也得让用户知道它听到了 */
const lastHeard = ref("");
const loadError = ref("");
const micError = ref("");
const micErrorRetryable = ref(false);
const listening = ref(false);

let handle: SpeechHandle | null = null;
let restartCount = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let lastAnswer: { text: string; at: number } | null = null;
// 卸载后所有在飞的异步（getDetail / 权限 / startSpeech）都靠它刹车，否则会把麦留在后台
let disposed = false;

const hasSteps = computed(() => steps.value.length > 0);
const currentText = computed(() => steps.value[currentStep.value]?.text ?? "");
const statusText = computed(() => {
  if (micError.value) return "语音不可用，步骤照常可看可翻";
  return listening.value ? "正在聆听 · 说「小厨」开头" : "重新连接中…";
});

onMounted(async () => {
  const id = recipeId.value;
  if (!id) {
    loadError.value = "菜谱不存在";
    return;
  }
  try {
    const detail = await store.getDetail(id);
    recipeName.value = detail.recipe.name;
    // store 已按 sort_order 查，这里再排一次是页面自己保证顺序（同详情页）
    steps.value = [...detail.steps].sort((a, b) => a.sort_order - b.sort_order);
    ingredients.value = detail.ingredients;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : "菜谱不存在";
    return;
  }

  await keepScreenOn(true);
  if (disposed) return;
  await listen();
  if (disposed) return;
  // 播报与识别互不依赖：识别不可用也照报当前步
  if (currentText.value) await speak(currentText.value);
});

onUnmounted(() => {
  disposed = true;
  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  // 顺序不能反：先停朗读再关麦，否则半句话被切断后又自己恢复（规格 §6）
  void stopSpeaking();
  void handle?.stop();
  handle = null;
  void keepScreenOn(false);
});

async function listen(): Promise<void> {
  if (!(await isSpeechAvailable())) {
    unavailable("这台设备没有可用的语音识别，可以手动翻步", false);
    return;
  }
  if (disposed) return;

  // 旧会话先停：重试时直接覆盖 handle 会永久多出一对监听器，回调被重复触发
  const previous = handle;
  handle = null;
  await previous?.stop();

  handle = await startSpeech(handleResult, handleError);
  if (disposed) {
    await handle.stop();
    handle = null;
    return;
  }
  listening.value = true;
}

function handleResult(transcript: string): void {
  // 只要能拿到一句识别结果，就说明麦和识别服务都活着：重启计数归零
  restartCount = 0;
  lastHeard.value = transcript;

  const answer = answerQuestion(transcript, {
    ingredients: ingredients.value,
    steps: steps.value,
    currentStep: currentStep.value,
  });
  // null = 不是在叫它，安静丢弃
  if (!answer) return;

  const now = Date.now();
  if (lastAnswer && lastAnswer.text === answer.text && now - lastAnswer.at < DEDUPE_MS) return;
  lastAnswer = { text: answer.text, at: now };

  if (answer.step !== undefined) currentStep.value = answer.step;
  qa.value = [{ question: transcript, answer: answer.text }, ...qa.value].slice(0, MAX_QA);
  void speak(answer.text);
}

function handleError(kind: SpeechErrorKind, message: string): void {
  if (kind === "permission") {
    // 永久拒绝：不重试，否则用户看到的是一个永远在失败的红条
    unavailable("需要麦克风权限，请在系统设置里允许", false);
    return;
  }
  if (kind === "unavailable") {
    unavailable("这台设备没有可用的语音识别，可以手动翻步", false);
    return;
  }
  if (kind === "silence") {
    // 插件内部已连着重启 3 次，这次是它放弃了（做菜时安静太正常）。
    // 不计入重试额度，直接接上：把安静当成故障，一分钟就会自己变红条。
    listening.value = false;
    scheduleRestart();
    return;
  }
  restartCount += 1;
  if (restartCount < MAX_RESTARTS) {
    listening.value = false;
    scheduleRestart();
    return;
  }
  // 把插件给的原因带上：只有「暂时不可用」一句话，等于没法排查也看不出是哪一步坏的
  unavailable(`语音识别暂时不可用（${message}），点这里重试`, true);
}

function unavailable(text: string, retryable: boolean): void {
  listening.value = false;
  micError.value = text;
  micErrorRetryable.value = retryable;
}

function scheduleRestart(): void {
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void listen();
  }, RESTART_DELAY_MS);
}

/** 点提示条重试：手动路径不看重试次数，直接清零重来 */
async function retry(): Promise<void> {
  if (!micErrorRetryable.value) return;
  micError.value = "";
  restartCount = 0;
  await listen();
}

/** 手动翻步与语音跳步共用一个入口，越界一律夹回合法范围 */
function goStep(target: number): void {
  if (!hasSteps.value) return;
  currentStep.value = Math.min(Math.max(target, 0), steps.value.length - 1);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader :title="recipeName" show-back @back="router.back()">
      <template #action>
        <button
          type="button"
          data-test="guide-end"
          class="min-h-10 shrink-0 rounded-full px-4 py-2 text-sm font-medium text-primary hover:bg-gray-100"
          @click="router.back()"
        >
          结束指导
        </button>
      </template>
    </AppHeader>

    <p v-if="loadError" class="px-4 py-6 text-center text-sm text-text-secondary">{{ loadError }}</p>

    <template v-else>
      <p
        data-test="guide-status"
        class="flex items-center gap-2 border-b border-gray-100 px-4 py-2 text-xs"
        :class="micError ? 'text-danger' : 'text-text-secondary'"
      >
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          :class="listening && !micError ? 'bg-green-500' : 'bg-gray-300'"
          aria-hidden="true"
        />
        {{ statusText }}
      </p>

      <p v-if="lastHeard" data-test="guide-heard" class="px-4 pb-1 text-xs text-text-secondary">
        听到：{{ lastHeard }}
      </p>

      <button
        v-if="micError"
        type="button"
        data-test="guide-mic-error"
        class="mx-4 mt-2 rounded-lg bg-danger/10 px-3 py-2 text-left text-xs text-danger disabled:opacity-100"
        :disabled="!micErrorRetryable"
        @click="retry"
      >
        {{ micError }}
      </button>

      <div class="flex flex-1 flex-col items-center justify-center gap-4 overflow-auto px-6 py-4">
        <p data-test="guide-step-order" class="text-sm text-text-secondary">
          {{ hasSteps ? `${currentStep + 1} / ${steps.length}` : "" }}
        </p>
        <p data-test="guide-step-text" class="text-2xl leading-relaxed text-text">
          {{ hasSteps ? currentText : "这道菜没有步骤" }}
        </p>
      </div>

      <div class="flex items-center justify-between gap-3 px-4 pb-4">
        <button
          type="button"
          data-test="guide-prev"
          :disabled="!hasSteps || currentStep === 0"
          class="min-h-12 rounded-full border border-gray-200 px-4 py-3 text-sm text-text disabled:opacity-40"
          @click="goStep(currentStep - 1)"
        >
          ‹ 上一步
        </button>
        <button
          type="button"
          data-test="guide-next"
          :disabled="!hasSteps || currentStep >= steps.length - 1"
          class="min-h-12 rounded-full border border-gray-200 px-4 py-3 text-sm text-text disabled:opacity-40"
          @click="goStep(currentStep + 1)"
        >
          下一步 ›
        </button>
      </div>

      <ul v-if="qa.length" class="max-h-40 overflow-auto border-t border-gray-100 px-4 py-2">
        <li v-for="(item, index) in qa" :key="index" data-test="guide-qa" class="py-1 text-xs">
          <p class="text-text-secondary">你：{{ item.question }}</p>
          <p class="text-text">答：{{ item.answer }}</p>
        </li>
      </ul>

      <!-- 规格 §3 / §8.5 要求把音频去向写在页面上：不落盘不上传本服务，厂商服务联网与否不由我们定 -->
      <p data-test="guide-privacy" class="border-t border-gray-100 px-4 py-2 text-[11px] leading-snug text-text-secondary">
        音频不落盘、不上传本服务；系统识别服务是否联网由手机厂商决定。
      </p>
    </template>
  </div>
</template>
