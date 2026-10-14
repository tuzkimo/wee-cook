<script setup lang="ts">
// 家庭成员列表 + 邀请（仅 owner 能生成邀请码，服务端 403 会原样报错）。
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import { useTeamStore, type TeamMember } from "@/stores/team";

const route = useRoute();
const router = useRouter();
const store = useTeamStore();

const teamId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));
const teamName = computed(() => store.teams.find((t) => t.id === teamId.value)?.name ?? "家庭");

const members = ref<TeamMember[]>([]);
const loading = ref(true);
const error = ref("");

const inviteCode = ref("");
const inviteBusy = ref(false);
const inviteError = ref("");

onMounted(async () => {
  try {
    members.value = await store.loadMembers(teamId.value);
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "加载失败";
  } finally {
    loading.value = false;
  }
});

async function invite(): Promise<void> {
  if (inviteBusy.value) return;
  inviteError.value = "";
  inviteBusy.value = true;
  try {
    inviteCode.value = await store.createInvite(teamId.value);
  } catch (err: unknown) {
    inviteError.value = err instanceof Error ? err.message : "生成邀请码失败";
  } finally {
    inviteBusy.value = false;
  }
}

function roleLabel(role: TeamMember["role"]): string {
  return role === "owner" ? "创建者" : "成员";
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader :title="teamName" show-back @back="router.back()" />
    <div class="flex flex-1 min-h-0 flex-col gap-4 overflow-auto px-4 py-4">
      <p v-if="loading" class="py-8 text-center text-sm text-text-secondary">加载中…</p>
      <p v-else-if="error" data-test="load-error" class="text-sm text-danger">{{ error }}</p>

      <template v-else>
        <div
          v-for="m in members"
          :key="m.user_id"
          data-test="member-row"
          class="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm"
        >
          <span class="text-text">{{ m.nickname || m.username }}</span>
          <span
            data-test="member-role"
            class="rounded-full px-2 py-0.5 text-xs"
            :class="m.role === 'owner' ? 'bg-primary/10 text-primary' : 'bg-gray-100 text-text-secondary'"
          >
            {{ roleLabel(m.role) }}
          </span>
        </div>

        <button
          type="button"
          data-test="invite"
          :disabled="inviteBusy"
          class="mt-2 rounded-xl border border-primary py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
          @click="invite"
        >
          邀请家人
        </button>

        <div v-if="inviteCode" data-test="invite-code" class="rounded-xl bg-primary/10 px-4 py-4 text-center">
          <p class="text-3xl font-bold tracking-[0.4em] text-primary">{{ inviteCode }}</p>
          <p class="mt-2 text-xs text-text-secondary">24 小时内有效，让家人在这台手机之外输入它</p>
        </div>
        <p v-if="inviteError" data-test="invite-error" class="text-sm text-danger">{{ inviteError }}</p>
      </template>
    </div>
  </div>
</template>
