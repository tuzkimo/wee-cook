<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { ChevronRight, RefreshCw } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import UserAvatar from "@/components/UserAvatar.vue";
import { requestSyncNow, syncInFlight } from "@/services/sync";
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

const syncing = computed(() => syncInFlight.value);

// 同步条：一条状态点 + 一行状态文案（照 wee-count 的形状，整条可点 = 手动同步）
const syncText = computed(() =>
  auth.lastSyncedTime ? `已同步 ${new Date(auth.lastSyncedTime).toLocaleString()}` : "还没同步过",
);

const syncDotClass = computed(() => {
  if (syncing.value) return "bg-yellow-400";
  if (auth.lastSyncFailed) return "bg-danger";
  return "bg-green-500";
});

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

      <!-- 未配置服务器：入口 -->
      <button
        v-if="!configured"
        type="button"
        data-test="server-row"
        class="flex w-full items-center justify-between rounded-xl bg-surface px-4 py-3.5 text-sm transition-colors hover:bg-gray-50 active:bg-gray-100"
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
        class="flex w-full items-center justify-between rounded-xl bg-surface px-4 py-3.5 text-sm transition-colors hover:bg-gray-50 active:bg-gray-100"
        @click="router.push('/me/login')"
      >
        <span class="text-text">多设备同步</span>
        <span data-test="server-state" class="text-text-secondary">未登录</span>
      </button>

      <!-- 已登录：一条同步信息条（整条可点 = 立刻跑一次增量同步）+ 退出登录 -->
      <template v-else>
        <button
          type="button"
          data-test="me-sync-card"
          :disabled="syncing"
          class="flex w-full items-center gap-2.5 rounded-xl bg-surface px-4 py-3.5 text-left text-sm transition-colors hover:bg-gray-50 active:bg-gray-100 disabled:cursor-default disabled:hover:bg-transparent"
          @click="requestSyncNow"
        >
          <span class="h-2.5 w-2.5 shrink-0 rounded-full" :class="syncDotClass" aria-hidden="true" />
          <span v-if="syncing" data-test="syncing" class="min-w-0 flex-1 truncate text-text-secondary">
            同步中…
          </span>
          <span
            v-else-if="auth.lastSyncFailed"
            data-test="sync-failed"
            class="min-w-0 flex-1 truncate text-danger"
          >
            上次同步没成功，点一下重试
          </span>
          <span v-else data-test="last-sync" class="min-w-0 flex-1 truncate text-text">
            {{ syncText }}
          </span>
          <!-- 图标是「这一条能点」的可见提示（在途时转起来） -->
          <RefreshCw
            :size="16"
            aria-hidden="true"
            :class="syncing ? 'animate-spin text-primary' : 'text-primary'"
          />
        </button>

        <button
          type="button"
          data-test="logout"
          class="w-full rounded-xl bg-danger py-2.5 text-sm font-medium text-white transition-colors hover:bg-danger/90"
          @click="logout"
        >
          退出登录
        </button>
      </template>
    </div>
  </div>
</template>
