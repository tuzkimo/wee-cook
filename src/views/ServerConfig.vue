<script setup lang="ts">
// 服务器地址配置页。地址存 settings.json 的 server_url；未保存前不碰 api 层的全局 baseUrl。
// 用 fetchWithTimeout 直接探活（不是 apiFetch）：测的是一个**还没保存**的地址，
// 而且 healthz 不需要凭据。
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import { fetchWithTimeout } from "@/services/api";
import { readSetting, writeSetting } from "@/services/settingsFile";

const DEFAULT_URL = "https://";

const router = useRouter();
const url = ref(DEFAULT_URL);
const message = ref("");
const failed = ref(false);
const busy = ref(false);

function parseString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

onMounted(async () => {
  const saved = await readSetting("server_url", parseString);
  if (saved.kind === "found") url.value = saved.value;
});

async function testConnection(): Promise<void> {
  if (busy.value) return;
  const normalized = url.value.trim().replace(/\/+$/, "");
  if (!normalized) {
    failed.value = true;
    message.value = "请填写服务器地址";
    return;
  }

  busy.value = true;
  message.value = "";
  try {
    const response = await fetchWithTimeout(`${normalized}/api/v1/healthz`);
    if (!response.ok) {
      failed.value = true;
      message.value = `服务器返回 ${response.status}`;
      return;
    }
    await writeSetting("server_url", normalized, {
      tag: "server-config",
      label: "服务器地址",
      action: "保存",
    });
    url.value = normalized;
    failed.value = false;
    message.value = "连接成功，地址已保存";
  } catch {
    failed.value = true;
    message.value = "连不上服务器，检查地址和网络";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="服务器地址" show-back @back="router.back()" />
    <div class="flex flex-1 min-h-0 flex-col gap-6 overflow-auto px-4 py-4">
      <label class="block">
        <span class="mb-1 block text-xs text-text-secondary">服务器地址</span>
        <input
          v-model="url"
          data-test="server-url-input"
          type="url"
          inputmode="url"
          autocapitalize="off"
          spellcheck="false"
          placeholder="https://example.com"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
      </label>

      <p v-if="message" data-test="server-message" class="text-sm" :class="failed ? 'text-danger' : 'text-text-secondary'">
        {{ message }}
      </p>

      <button
        type="button"
        data-test="test"
        :disabled="busy"
        class="w-full rounded-xl bg-primary py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
        @click="testConnection"
      >
        测试连接
      </button>
    </div>
  </div>
</template>
