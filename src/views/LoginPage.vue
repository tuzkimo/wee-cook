<script setup lang="ts">
// 登录 / 注册共用一页。服务器地址来自 settings.json（由「服务器地址」页保存），
// 这里只收用户名与密码：地址已配置好就不该让用户在这个页面再填一遍。
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import { readSetting } from "@/services/settingsFile";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

const serverUrl = ref<string | null>(null);
const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

function parseString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

onMounted(async () => {
  const url = await readSetting("server_url", parseString);
  serverUrl.value = url.kind === "found" ? url.value : null;
  // 上次登录过的用户名带出来，换设备后少打一次字
  const saved = await readSetting("server_username", parseString);
  if (saved.kind === "found" && username.value === "") username.value = saved.value;
});

async function submit(kind: "login" | "register"): Promise<void> {
  if (busy.value) return;
  const name = username.value.trim();
  if (!name || !password.value) {
    error.value = "请输入用户名和密码";
    return;
  }
  if (!serverUrl.value) {
    error.value = "请先配置服务器地址";
    return;
  }

  error.value = "";
  busy.value = true;
  try {
    if (kind === "login") await auth.login(serverUrl.value, name, password.value);
    // 单账号体系里没有单独的昵称字段，默认用用户名当昵称
    else await auth.register(serverUrl.value, name, password.value, name);
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : "操作失败";
    return;
  } finally {
    busy.value = false;
  }
  await router.push("/me");
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="多设备同步" show-back @back="router.back()" />
    <div class="flex flex-1 min-h-0 flex-col gap-6 overflow-auto px-4 py-4">
      <button
        type="button"
        data-test="server-row"
        class="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm transition-colors hover:bg-gray-50"
        @click="router.push('/me/server')"
      >
        <span class="text-text-secondary">服务器</span>
        <span data-test="server-url" class="text-text">{{ serverUrl || "未设置" }}</span>
      </button>

      <label class="block">
        <span class="mb-1 block text-xs text-text-secondary">用户名</span>
        <input
          v-model="username"
          data-test="username"
          type="text"
          autocomplete="username"
          autocapitalize="off"
          spellcheck="false"
          placeholder="用户名"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
      </label>

      <label class="block">
        <span class="mb-1 block text-xs text-text-secondary">密码</span>
        <input
          v-model="password"
          data-test="password"
          type="password"
          autocomplete="current-password"
          placeholder="密码"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
      </label>

      <p v-if="error" data-test="form-error" class="text-sm text-danger">{{ error }}</p>

      <div class="flex gap-3">
        <button
          type="button"
          data-test="login"
          :disabled="busy"
          class="flex-1 rounded-xl bg-primary py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
          @click="submit('login')"
        >
          登录
        </button>
        <button
          type="button"
          data-test="register"
          :disabled="busy"
          class="flex-1 rounded-xl border border-primary py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
          @click="submit('register')"
        >
          注册
        </button>
      </div>
    </div>
  </div>
</template>
