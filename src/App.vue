<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { BookOpen, Sparkles, User } from "lucide-vue-next";
import { realDeps, startShareIntake } from "@/services/ai/shareIntake";
import { useAiChatStore } from "@/stores/aiChat";
import { useAiSettingsStore } from "@/stores/aiSettings";

const route = useRoute();
const router = useRouter();
const aiSettings = useAiSettingsStore();
const aiChat = useAiChatStore();

// AI 项按 aiSettings.tabVisible 过滤（opt-in + 后端状态的三态），菜谱 / 我的两项不动。
const TABS = computed(() => [
  { path: "/", label: "菜谱", icon: BookOpen },
  ...(aiSettings.tabVisible ? [{ path: "/ai", label: "AI", icon: Sparkles }] : []),
  { path: "/me", label: "我的", icon: User },
]);

const showTab = computed(() => !route.meta.hideTab);

function isActive(path: string): boolean {
  return route.path === path;
}

// 读本地 opt-in 开关 + 探一次 /ai/status（永不 reject；探不到保持未知态、不隐藏入口）。
// 系统分享进来的截图也在这里接：外壳只挂载一次，拉取点全交给 startShareIntake。
let stopIntake: (() => void) | null = null;

onMounted(() => {
  void aiSettings.load();
  stopIntake = startShareIntake({
    ...realDeps,
    setAttachment: (shot) => aiChat.setAttachment(shot),
    setNotice: (text) => aiChat.setNotice(text),
    // 已在 AI 页就不推：免得历史栈里堆一串重复条目
    pushAi: () => {
      if (route.path !== "/ai") void router.push("/ai");
    },
  });
});

onUnmounted(() => {
  stopIntake?.();
  stopIntake = null;
});
</script>

<template>
  <div class="flex h-dvh flex-col bg-bg">
    <div
      data-test="statusbar"
      class="h-[max(env(safe-area-inset-top),1.5rem)] shrink-0 bg-surface"
    />
    <div
      data-test="content"
      class="flex-1 min-h-0"
      :class="showTab ? '' : 'pb-[env(safe-area-inset-bottom)]'"
    >
      <RouterView />
    </div>
    <nav
      v-if="showTab"
      class="flex shrink-0 border-t border-gray-100 bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <RouterLink
        v-for="tab in TABS"
        :key="tab.path"
        :to="tab.path"
        class="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors"
        :class="isActive(tab.path) ? 'text-primary' : 'text-text-secondary'"
      >
        <component :is="tab.icon" :size="20" />
        <span>{{ tab.label }}</span>
      </RouterLink>
    </nav>
  </div>
</template>
