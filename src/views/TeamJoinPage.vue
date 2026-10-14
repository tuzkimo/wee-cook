<script setup lang="ts">
// 用 6 位邀请码加入家庭。加入成功后 store 会清同步游标并触发全量重拉（spec §9.4）。
import { ref } from "vue";
import { useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import { useTeamStore } from "@/stores/team";

const router = useRouter();
const store = useTeamStore();

const code = ref("");
const error = ref("");
const busy = ref(false);

/** 只收数字，最多 6 位。 */
function onInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  code.value = input.value.replace(/\D/g, "").slice(0, 6);
  input.value = code.value;
}

async function join(): Promise<void> {
  if (busy.value) return;
  if (code.value.length !== 6) {
    error.value = "请输入 6 位邀请码";
    return;
  }
  error.value = "";
  busy.value = true;
  try {
    const team = await store.joinByCode(code.value);
    await router.replace(`/me/team/${team.id}`);
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "加入失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="加入家庭" show-back @back="router.back()" />
    <div class="flex flex-1 min-h-0 flex-col gap-6 overflow-auto px-4 py-4">
      <label class="block">
        <span class="mb-1 block text-xs text-text-secondary">邀请码</span>
        <input
          :value="code"
          data-test="invite-code"
          type="text"
          inputmode="numeric"
          maxlength="6"
          autocomplete="off"
          placeholder="6 位数字"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-center text-2xl tracking-[0.5em] text-text outline-none focus:border-primary"
          @input="onInput"
        />
      </label>

      <p v-if="error" data-test="form-error" class="text-sm text-danger">{{ error }}</p>

      <button
        type="button"
        data-test="join"
        :disabled="busy"
        class="rounded-xl bg-primary py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
        @click="join"
      >
        加入
      </button>
    </div>
  </div>
</template>
