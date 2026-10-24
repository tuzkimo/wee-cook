<script setup lang="ts">
// 团队成员页（spec §10.2）：成员列表 + 按角色给操作。
// owner：改名 / 邀请码 / 移除 / 转让 / 解散；member：退出（二次确认）。自己那一行没有「移除」。
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import UserAvatar from "@/components/UserAvatar.vue";
import { useAuthStore } from "@/stores/auth";
import { useTeamStore } from "@/stores/team";
import type { TeamMember } from "@/types";

const route = useRoute();
const router = useRouter();
const team = useTeamStore();
const auth = useAuthStore();

const teamId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));
const members = ref<TeamMember[]>([]);
const error = ref("");
const notice = ref("");
const inviteCode = ref("");
const renaming = ref(false);
const name = ref("");
const confirmAction = ref<"leave" | "dissolve" | null>(null);

const me = computed(() => members.value.find((row) => row.user_id === auth.serverUserId));
const isOwner = computed(() => me.value?.role === "owner");
const teamName = computed(() => team.teams.find((row) => row.id === teamId.value)?.name ?? "团队");

onMounted(async () => {
  try {
    if (team.teams.length === 0) await team.load();
    name.value = teamName.value;
    members.value = await team.members(teamId.value);
  } catch (e) {
    error.value = message(e, "获取成员失败");
  }
});

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

async function reload(): Promise<void> {
  members.value = await team.members(teamId.value);
}

async function saveName(): Promise<void> {
  const trimmed = name.value.trim();
  if (!trimmed) {
    error.value = "请输入团队名称";
    return;
  }
  error.value = "";
  try {
    await team.rename(teamId.value, trimmed);
    renaming.value = false;
    notice.value = "已改名";
  } catch (e) {
    error.value = message(e, "改名失败");
  }
}

async function invite(): Promise<void> {
  error.value = "";
  notice.value = "";
  try {
    inviteCode.value = await team.invite(teamId.value);
  } catch (e) {
    error.value = message(e, "生成邀请码失败");
  }
}

async function removeMember(userId: string): Promise<void> {
  error.value = "";
  try {
    await team.removeMember(teamId.value, userId);
    await reload();
  } catch (e) {
    error.value = message(e, "移除成员失败");
  }
}

async function transfer(userId: string): Promise<void> {
  error.value = "";
  try {
    await team.transfer(teamId.value, userId);
    await reload();
    notice.value = "已转让 owner";
  } catch (e) {
    error.value = message(e, "转让失败");
  }
}

async function confirm(): Promise<void> {
  const action = confirmAction.value;
  confirmAction.value = null;
  if (!action) return;
  error.value = "";
  try {
    if (action === "leave") await team.leave(teamId.value);
    else await team.dissolve(teamId.value);
    await router.replace("/me/teams");
  } catch (e) {
    error.value = message(e, action === "leave" ? "退出团队失败" : "解散团队失败");
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader :title="teamName" class="border-b border-gray-100" show-back @back="router.back()" />

    <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
      <p
        v-if="error"
        data-test="team-error"
        class="mb-3 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
      >
        {{ error }}
      </p>
      <p
        v-if="notice"
        data-test="team-notice"
        class="mb-3 rounded-xl bg-primary/10 px-4 py-3 text-sm text-primary"
      >
        {{ notice }}
      </p>

      <ul class="flex flex-col gap-2">
        <li
          v-for="row in members"
          :key="row.user_id"
          data-test="member-row"
          class="flex items-center gap-3 rounded-xl bg-surface px-4 py-3"
        >
          <UserAvatar
            :url="null"
            :name="row.nickname || row.username"
            class="h-10 w-10 shrink-0 rounded-full"
            text-class="text-sm"
          />
          <div class="flex min-w-0 flex-1 flex-col">
            <span data-test="member-name" class="truncate text-sm text-text">
              {{ row.nickname || row.username }}
            </span>
            <span class="text-xs text-text-secondary">
              {{ row.role === "owner" ? "owner" : "成员" }}
            </span>
          </div>
          <!-- 自己那一行没有移除；owner 也只能移除别的成员 -->
          <button
            v-if="isOwner && row.user_id !== auth.serverUserId"
            type="button"
            data-test="member-remove"
            class="shrink-0 text-xs text-danger"
            @click="removeMember(row.user_id)"
          >
            移除
          </button>
          <button
            v-if="isOwner && row.user_id !== auth.serverUserId"
            type="button"
            data-test="member-transfer"
            class="shrink-0 text-xs text-primary"
            @click="transfer(row.user_id)"
          >
            转让
          </button>
        </li>
      </ul>

      <template v-if="isOwner">
        <div class="mt-6 flex flex-col gap-2">
          <label v-if="renaming" class="flex items-center gap-2">
            <input
              v-model="name"
              data-test="team-rename-input"
              type="text"
              class="min-w-0 flex-1 rounded-lg bg-gray-100 px-3 py-2 text-sm text-text outline-none"
            />
            <button
              type="button"
              data-test="team-rename-submit"
              class="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm text-white"
              @click="saveName"
            >
              保存
            </button>
          </label>
          <button
            v-else
            type="button"
            data-test="team-rename"
            class="rounded-xl bg-surface px-4 py-3 text-sm text-text"
            @click="renaming = true"
          >
            改名
          </button>

          <button
            type="button"
            data-test="team-invite"
            class="rounded-xl bg-surface px-4 py-3 text-sm text-text"
            @click="invite"
          >
            生成邀请码
          </button>
          <p
            v-if="inviteCode"
            data-test="team-invite-code"
            class="rounded-xl bg-primary/10 px-4 py-3 text-center text-lg tracking-[0.3em] text-primary"
          >
            {{ inviteCode }}
          </p>

          <button
            type="button"
            data-test="team-dissolve"
            class="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
            @click="confirmAction = 'dissolve'"
          >
            解散团队
          </button>
        </div>
      </template>

      <button
        v-else-if="me"
        type="button"
        data-test="team-leave"
        class="mt-6 w-full rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
        @click="confirmAction = 'leave'"
      >
        退出团队
      </button>
    </div>

    <ConfirmDialog
      :visible="confirmAction !== null"
      :title="confirmAction === 'leave' ? '退出这个团队？' : '解散这个团队？'"
      :description="
        confirmAction === 'leave'
          ? '退出后就看不到这个团队的菜谱与库存了。'
          : '解散后成员都看不到这个团队；菜谱与库存数据不会删除。'
      "
      :confirm-text="confirmAction === 'leave' ? '退出' : '解散'"
      danger
      @confirm="confirm"
      @cancel="confirmAction = null"
    />
  </div>
</template>
