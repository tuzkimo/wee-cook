<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { ChevronRight } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import UserAvatar from "@/components/UserAvatar.vue";
import { triggerFullPushAndSync } from "@/services/migration";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

// 冷启动后恢复会话；未配置地址时 store 内部直接返回，不发任何请求
onMounted(() => {
  void auth.restoreSession();
});

const configured = computed(() => auth.baseUrl !== null);
const displayName = computed(() => auth.nickname ?? auth.serverUser?.username ?? "");
// 离线但存档里有账号档案：会话是真的，只是连不上（退登过的账号不会走到这里，见 spec §7.5）
const offlineWithProfile = computed(() => !auth.isOnline && auth.nickname !== null);
const cardName = computed(() =>
  auth.isOnline || offlineWithProfile.value ? displayName.value : "未登录",
);
const cardStatus = computed(() => {
  if (auth.isOnline) return "已开启多设备同步";
  if (offlineWithProfile.value) return "离线使用中，连上网络后自动恢复";
  return "点这里登录或注册";
});

function openCard(): void {
  void router.push(auth.isOnline ? "/me/profile" : "/me/login");
}

const lastSyncText = computed(() =>
  auth.lastSyncedTime ? new Date(auth.lastSyncedTime).toLocaleString() : "还没同步过",
);

function retry(): void {
  // 手动重试一次全扫同步；函数内部全捕获，不会 reject
  void triggerFullPushAndSync();
}

async function logout(): Promise<void> {
  await auth.logout();
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="我的" />
    <div class="flex flex-1 flex-col gap-4 overflow-auto px-4 py-4">
      <button
        type="button"
        data-test="me-user-card"
        class="flex w-full items-center gap-3 rounded-xl bg-surface px-4 py-4 text-left transition-colors hover:bg-gray-50"
        @click="openCard"
      >
        <UserAvatar
          :url="auth.avatarUrl"
          :name="displayName"
          class="h-12 w-12 shrink-0 rounded-full"
          text-class="text-lg"
        />
        <div class="flex min-w-0 flex-1 flex-col">
          <p data-test="me-user-name" class="truncate text-base font-medium text-text">
            {{ cardName }}
          </p>
          <p data-test="me-user-status" class="text-xs text-text-secondary">{{ cardStatus }}</p>
        </div>
        <ChevronRight :size="16" class="text-text-secondary" />
      </button>

      <section class="rounded-xl border border-gray-200">
        <!-- 未配置服务器：入口 -->
        <button
          v-if="!configured"
          type="button"
          data-test="server-row"
          class="flex w-full items-center justify-between px-3 py-3 text-sm transition-colors hover:bg-gray-50"
          @click="router.push('/me/server')"
        >
          <span class="text-text">多设备同步</span>
          <span data-test="server-state" class="text-text-secondary">未开启</span>
        </button>

        <!-- 配了地址但还没登录 -->
        <button
          v-else-if="!auth.isOnline"
          type="button"
          data-test="server-row"
          class="flex w-full items-center justify-between px-3 py-3 text-sm transition-colors hover:bg-gray-50"
          @click="router.push('/me/login')"
        >
          <span class="text-text">多设备同步</span>
          <span data-test="server-state" class="text-text-secondary">未登录</span>
        </button>

        <!-- 已登录 -->
        <div v-else class="flex flex-col gap-3 px-3 py-3 text-sm">
          <div class="flex items-center justify-between">
            <span class="text-text-secondary">多设备同步</span>
            <span data-test="server-state" class="text-text">已开启</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-text-secondary">账号</span>
            <span data-test="nickname" class="text-text">{{ displayName }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-text-secondary">上次同步</span>
            <span data-test="last-sync" class="text-text">{{ lastSyncText }}</span>
          </div>
          <p
            v-if="auth.lastSyncFailed"
            data-test="sync-failed"
            class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            上次同步没成功
          </p>
          <div class="flex gap-3">
            <button
              v-if="auth.lastSyncFailed"
              type="button"
              data-test="retry"
              class="flex-1 rounded-lg border border-primary py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
              @click="retry"
            >
              重试
            </button>
            <button
              type="button"
              data-test="logout"
              class="flex-1 rounded-lg bg-danger py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90"
              @click="logout"
            >
              退出登录
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
