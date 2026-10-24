<script setup lang="ts">
// 团队列表（spec §10.2）：我加入的团队 + 成员数 + 角色；底部创建 / 邀请码加入。
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ChevronRight, Plus, Ticket } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import { useTeamStore } from "@/stores/team";

const router = useRouter();
const team = useTeamStore();

const error = ref("");
const busy = ref(false);
const creating = ref(false);
const name = ref("");
const joining = ref(false);
const code = ref("");

onMounted(async () => {
  try {
    await team.load();
  } catch (e) {
    error.value = message(e, "获取团队失败");
  }
});

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

async function create(): Promise<void> {
  if (busy.value) return;
  const trimmed = name.value.trim();
  if (!trimmed) {
    error.value = "请输入团队名称";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    await team.create(trimmed);
    name.value = "";
    creating.value = false;
    await router.push(`/me/teams/${team.currentTeamId}`);
  } catch (e) {
    error.value = message(e, "创建团队失败");
  } finally {
    busy.value = false;
  }
}

async function join(): Promise<void> {
  if (busy.value) return;
  const trimmed = code.value.trim();
  if (!trimmed) {
    error.value = "请输入邀请码";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    await team.join(trimmed);
    code.value = "";
    joining.value = false;
    await router.push(`/me/teams/${team.currentTeamId}`);
  } catch (e) {
    error.value = message(e, "加入团队失败");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="我的团队" class="border-b border-gray-100" show-back @back="router.back()" />

    <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
      <p
        v-if="error"
        data-test="team-error"
        class="mb-3 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
      >
        {{ error }}
      </p>

      <p
        v-if="team.teams.length === 0"
        data-test="team-empty"
        class="py-12 text-center text-text-secondary"
      >
        还没有团队，创建一个或输入邀请码加入
      </p>
      <ul v-else class="flex flex-col gap-2">
        <li v-for="row in team.teams" :key="row.id">
          <button
            type="button"
            data-test="team-row"
            class="flex w-full items-center justify-between rounded-xl bg-surface px-4 py-3.5 text-left text-sm"
            @click="router.push(`/me/teams/${row.id}`)"
          >
            <span class="flex min-w-0 flex-col">
              <span data-test="team-name" class="truncate text-text">{{ row.name }}</span>
              <span class="text-xs text-text-secondary">
                {{ row.role === "owner" ? "owner" : "成员" }} · {{ row.member_count }} 人
              </span>
            </span>
            <ChevronRight :size="16" class="shrink-0 text-text-secondary" />
          </button>
        </li>
      </ul>

      <div class="mt-6 flex flex-col gap-2">
        <label v-if="creating" class="flex items-center gap-2">
          <input
            v-model="name"
            data-test="team-name-input"
            type="text"
            placeholder="团队名称"
            class="min-w-0 flex-1 rounded-lg bg-gray-100 px-3 py-2 text-sm text-text outline-none"
          />
          <button
            type="button"
            data-test="team-create-submit"
            class="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
            :disabled="busy"
            @click="create"
          >
            创建
          </button>
        </label>
        <button
          v-else
          type="button"
          data-test="team-create"
          class="flex items-center justify-center gap-1 rounded-xl bg-primary px-4 py-3 text-sm text-white"
          @click="creating = true"
        >
          <Plus :size="16" />
          创建团队
        </button>

        <label v-if="joining" class="flex items-center gap-2">
          <input
            v-model="code"
            data-test="team-code-input"
            type="text"
            inputmode="numeric"
            placeholder="6 位邀请码"
            class="min-w-0 flex-1 rounded-lg bg-gray-100 px-3 py-2 text-sm text-text outline-none"
          />
          <button
            type="button"
            data-test="team-join-submit"
            class="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:opacity-50"
            :disabled="busy"
            @click="join"
          >
            加入
          </button>
        </label>
        <button
          v-else
          type="button"
          data-test="team-join"
          class="flex items-center justify-center gap-1 rounded-xl bg-surface px-4 py-3 text-sm text-text"
          @click="joining = true"
        >
          <Ticket :size="16" />
          邀请码加入
        </button>
      </div>
    </div>
  </div>
</template>
