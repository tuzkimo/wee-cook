<script setup lang="ts">
// 范围切换器（spec §10.2）：一行下拉 sheet，「我的菜谱」+ 每个团队。
// 未登录时只有一个范围，没有可切的 → 整块不渲染。
import { computed, ref } from "vue";
import { ChevronDown, Check } from "lucide-vue-next";
import { useAuthStore } from "@/stores/auth";
import { useTeamStore } from "@/stores/team";

const team = useTeamStore();
const auth = useAuthStore();
const open = ref(false);

const visible = computed(() => auth.serverUserId !== null);
const currentName = computed(
  () => team.teams.find((row) => row.id === team.currentTeamId)?.name ?? "我的菜谱",
);

function choose(id: string | null): void {
  open.value = false;
  team.switchTo(id);
}
</script>

<template>
  <div v-if="visible" class="relative shrink-0">
    <button
      type="button"
      data-test="team-switcher"
      class="flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1.5 text-sm text-text"
      @click="open = !open"
    >
      <span class="max-w-[10rem] truncate">{{ currentName }}</span>
      <ChevronDown :size="14" class="text-text-secondary" />
    </button>

    <div
      v-if="open"
      data-test="team-options"
      class="absolute left-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-xl border border-gray-100 bg-surface shadow-lg"
    >
      <button
        type="button"
        data-test="team-option"
        class="flex w-full items-center justify-between px-4 py-3 text-left text-sm"
        @click="choose(null)"
      >
        <span>我的菜谱</span>
        <Check v-if="team.currentTeamId === null" :size="16" class="text-primary" />
      </button>
      <button
        v-for="row in team.teams"
        :key="row.id"
        type="button"
        data-test="team-option"
        class="flex w-full items-center justify-between px-4 py-3 text-left text-sm"
        @click="choose(row.id)"
      >
        <span class="truncate">{{ row.name }}</span>
        <Check v-if="team.currentTeamId === row.id" :size="16" class="text-primary" />
      </button>
    </div>
  </div>
</template>
