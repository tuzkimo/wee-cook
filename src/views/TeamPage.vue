<script setup lang="ts">
// 我的家庭列表 + 创建 + 进入成员页/加入页。接口形状见 stores/team.ts 顶部注释。
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import { useTeamStore } from "@/stores/team";

const router = useRouter();
const store = useTeamStore();

const name = ref("");
const busy = ref(false);
const error = ref("");

onMounted(() => {
  void store.load();
});

async function create(): Promise<void> {
  const trimmed = name.value.trim();
  if (!trimmed || busy.value) return;
  error.value = "";
  busy.value = true;
  try {
    const team = await store.create(trimmed);
    name.value = "";
    await router.push(`/me/team/${team.id}`);
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "创建失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="我的家庭" show-back @back="router.back()" />
    <div class="flex flex-1 min-h-0 flex-col gap-4 overflow-auto px-4 py-4">
      <p
        v-if="store.teams.length === 0"
        data-test="empty"
        class="py-8 text-center text-sm text-text-secondary"
      >
        还没有家庭，创建一个或用邀请码加入
      </p>

      <button
        v-for="team in store.teams"
        :key="team.id"
        type="button"
        data-test="team-row"
        class="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm transition-colors hover:bg-gray-50"
        @click="router.push(`/me/team/${team.id}`)"
      >
        <span class="text-text">{{ team.name }}</span>
        <span data-test="member-count" class="text-text-secondary">{{ team.member_count }} 人</span>
      </button>

      <div class="mt-2 flex flex-col gap-3">
        <div class="flex gap-3">
          <input
            v-model="name"
            data-test="team-name"
            type="text"
            placeholder="新家庭名称"
            class="min-w-0 flex-1 rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />
          <button
            type="button"
            data-test="create"
            :disabled="busy"
            class="shrink-0 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
            @click="create"
          >
            创建家庭
          </button>
        </div>
        <button
          type="button"
          data-test="join-entry"
          class="rounded-lg border border-primary py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
          @click="router.push('/me/team/join')"
        >
          用邀请码加入
        </button>
        <p v-if="error" data-test="form-error" class="text-sm text-danger">{{ error }}</p>
      </div>
    </div>
  </div>
</template>
