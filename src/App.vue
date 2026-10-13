<script setup lang="ts">
import { computed } from "vue";
import { RouterView, useRoute } from "vue-router";
import { BookOpen, Sparkles, User } from "lucide-vue-next";

const route = useRoute();

const TABS = [
  { path: "/", label: "菜谱", icon: BookOpen },
  { path: "/ai", label: "AI", icon: Sparkles },
  { path: "/me", label: "我的", icon: User },
];

const showTab = computed(() => !route.meta.hideTab);

function isActive(path: string): boolean {
  return route.path === path;
}
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
