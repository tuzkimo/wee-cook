<script setup lang="ts">
// 聊天页：说明卡/连不上服务器的提示 + 可滚动的消息流 + 底部固定输入区。
// 数据全来自 aiChat / aiSettings 两个 store；跳转与 openInFilter 在这里做，store 不认识 router。
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import ChatBubble from "@/components/ai/ChatBubble.vue";
import ChatComposer from "@/components/ai/ChatComposer.vue";
import { useKeyboardInset } from "@/composables/useKeyboardInset";
import { baseUrlReady } from "@/services/api";
import { pickScreenshot } from "@/services/ai/image";
import { useAiChatStore } from "@/stores/aiChat";
import { useAiSettingsStore } from "@/stores/aiSettings";
import { useAuthStore } from "@/stores/auth";
import type { RecipeFilter } from "@/utils/recipeFilter";

const router = useRouter();
const chat = useAiChatStore();
const ai = useAiSettingsStore();
const auth = useAuthStore();
const keyboardInset = useKeyboardInset();
const listEl = ref<HTMLElement | null>(null);
const toggleError = ref<string | null>(null);
// 选图失败自己一条提示：与 AI 失败无关，不能复用 chat.error
const imageError = ref("");
// 选图在途：安卓上手快的人会连点两下，不能开两个选择器
const picking = ref(false);

// 发送要求 opt-in 已同意 + 已登录 + 地址已配 + 后端确实开了 AI；探活失败（401 / 断网）不算「不能发」——
// 拿不到 host 只是不许同意，不该锁死已同意的用户。
// serverReady 留成 ref：地址是异步恢复的，取 .value 存成布尔值会让提示条停在启动那一刻的状态。
const serverReady = baseUrlReady;
const backendDisabled = computed(() => ai.status?.enabled === false);
const canSend = computed(
  () => ai.sendingEnabled && serverReady.value && !backendDisabled.value && auth.isOnline,
);

onMounted(() => {
  // load() 没有 try/catch，别让一次读库失败变成未处理的 rejection
  void chat.load().catch(() => {});
  void ai.load();
});

// 新消息落在可视区外等于没回；每次消息数变化、以及「开始等回答」那一刻都滚到底
// （思考提示是在消息数变化之后才出现的，只盯消息数会把它推到可视区外）
watch(
  () => [chat.messages.length, chat.sending] as const,
  async () => {
    await nextTick();
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
  },
);

// 草稿进槽即跳编辑页：读走即清，跳一次就够
watch(
  () => chat.draftReady,
  (ready) => {
    if (!ready) return;
    chat.clearDraftReady();
    void router.push("/recipe/new");
  },
);

function send(text: string): void {
  imageError.value = "";
  void chat.send(text);
}

async function attach(): Promise<void> {
  if (picking.value) return;
  picking.value = true;
  try {
    // 重新选图先清上一次的失败文案；取消（null）什么都不做
    imageError.value = "";
    const result = await pickScreenshot();
    if (result === null) return;
    if (!result.ok) {
      imageError.value = result.message;
      return;
    }
    chat.setAttachment(result.shot);
  } finally {
    picking.value = false;
  }
}

function openRecipe(id: string): void {
  void router.push(`/recipe/${id}`);
}

function continueInFilter(filter: RecipeFilter): void {
  chat.openInFilter(filter);
  void router.push("/");
}

async function enable(): Promise<void> {
  try {
    toggleError.value = null;
    await ai.setSendingEnabled(true);
  } catch {
    // 落盘失败不能假装已同意：开关仍是关的，明确告诉用户再试
    toggleError.value = "开关没保存成功，再试一次";
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="AI" />

    <!-- 提示条与发送门控同源：说「连不上」就必须真发不出去。探活失败不报文案，交给错误的提示条 -->
    <p
      v-if="!serverReady"
      data-test="ai-server-hint"
      class="mx-4 mt-3 rounded-xl bg-surface px-3 py-2.5 text-xs text-text-secondary"
    >
      先连接服务器，才能用 AI 助手。
    </p>
    <p
      v-else-if="!auth.isOnline"
      data-test="ai-login-hint"
      class="mx-4 mt-3 rounded-xl bg-surface px-3 py-2.5 text-xs text-text-secondary"
    >
      请先登录，才能用 AI 助手。
    </p>
    <p
      v-else-if="backendDisabled"
      data-test="ai-disabled-hint"
      class="mx-4 mt-3 rounded-xl bg-surface px-3 py-2.5 text-xs text-text-secondary"
    >
      服务器的 AI 未启用。
    </p>
    <!-- 拿不到 host（探活失败）一律不给同意入口 -->
    <section
      v-else-if="!ai.sendingEnabled && ai.canShowPrivacyCard"
      data-test="ai-privacy-card"
      class="mx-4 mt-3 rounded-xl bg-surface px-3.5 py-3 text-sm"
    >
      <p class="text-xs text-text-secondary">
        启用后，你的提问、分类与标签名称、命中的菜谱名称与食材会发送到 {{ ai.status?.host }}。聊天记录以明文保存在这台设备的本机数据库里。可随时在「我的 → AI 菜谱助手」关闭。
      </p>
      <button
        type="button"
        data-test="ai-enable"
        class="mt-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-dark"
        @click="enable"
      >
        开启 AI 助手
      </button>
      <p v-if="toggleError" data-test="ai-enable-error" class="mt-1 text-xs text-danger">
        {{ toggleError }}
      </p>
    </section>

    <div v-if="chat.error" data-test="ai-error" class="mx-4 mt-3 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
      <span class="min-w-0 flex-1">{{ chat.error }}</span>
      <button
        type="button"
        data-test="ai-error-close"
        aria-label="关闭"
        class="shrink-0"
        @click="chat.error = null"
      >
        ×
      </button>
    </div>

    <div ref="listEl" class="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3">
      <p v-if="chat.messages.length === 0" class="mt-8 text-center text-sm text-text-secondary">
        问一句，比如「找有五花肉的菜」
      </p>
      <ChatBubble
        v-for="message in chat.messages"
        :key="message.id"
        :message="message"
        @open="openRecipe"
        @continue-in-filter="continueInFilter"
      />
      <!-- 一轮对话在途中的可见反馈：判据是 chat.sending（发送全程为真，finally 收），
           不是首次读历史的状态。少了这一行，实机形态就是「发完毫无反应，过一会结果一次性弹出」。 -->
      <p v-if="chat.sending" data-test="ai-thinking" class="text-sm text-text-secondary">
        正在思考…
      </p>
    </div>

    <!-- 键盘弹出时把输入区顶起来；外壳已补过安全区，这里不再叠 env(safe-area-inset-bottom) -->
    <div
      class="shrink-0 border-t border-gray-100"
      :style="keyboardInset > 0 ? { paddingBottom: `${keyboardInset}px` } : undefined"
    >
      <p v-if="imageError" data-test="ai-image-error" class="mx-4 mb-2 rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
        {{ imageError }}
      </p>
      <ChatComposer
        :disabled="!canSend"
        :sending="chat.sending"
        :attachment="chat.attachment?.cover ?? null"
        @send="send"
        @attach="attach"
        @detach="chat.setAttachment(null)"
      />
    </div>
  </div>
</template>
