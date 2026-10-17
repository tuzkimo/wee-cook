// AI 的客户端 opt-in 开关与入口门控（规格 §7.3 / 入口规格 §5）。
// tabVisible 是「/ai 入口该不该出现」的唯一判据，由 App.vue 的 tab 列表消费。
import { createPinia, defineStore, getActivePinia } from "pinia";
import { computed, ref } from "vue";
import { hasBaseUrl } from "@/services/api";
import { aiAccount } from "@/services/ai/account";
import { fetchAiStatus, type AiStatus } from "@/services/ai/transport";
import { readAiSendingEnabled, writeAiSendingEnabled } from "@/services/ai/privacy";

const useAiSettingsStoreBase = defineStore("aiSettings", () => {
  /** 客户端 opt-in，默认关闭（落盘走 privacy.ts）。 */
  const sendingEnabled = ref(false);
  /** `/ai/status` 的结果；**null 表示未知态**，不是「未启用」。 */
  const status = ref<AiStatus | null>(null);

  // 三态：opt-in 关着 ⇒ 隐藏；开着且服务端**明确**回 enabled:false ⇒ 隐藏；
  // 未知态（null，探活失败 / 还没探）⇒ 不隐藏。
  // 把「探不到」当成「没启用」，一次断网就会永久藏掉入口，用户没有任何办法找回来。
  const tabVisible = computed(() => sendingEnabled.value && status.value?.enabled !== false);

  /** 拿不到 host 就不能让用户同意（说明卡必须讲清数据发给谁）。 */
  const canShowPrivacyCard = computed(() => Boolean(status.value?.host));

  /**
   * 读开关 + 探一次 `/ai/status`。**永不 reject**。
   * 探活失败（断网 / 未登录 401 / 上游出错）一律保持未知态 `null`，绝不置 `false`。
   */
  async function load(): Promise<void> {
    if (aiAccount() === null) {
      // 没账号就没有归属：不读盘、不发探活，入口直接隐藏（spec §12.1）
      sendingEnabled.value = false;
      status.value = null;
      return;
    }
    sendingEnabled.value = await readAiSendingEnabled();
    if (!hasBaseUrl()) {
      // 没配地址：一个请求都不发，status 保持未知态
      status.value = null;
      return;
    }
    try {
      status.value = await fetchAiStatus();
    } catch {
      status.value = null;
    }
  }

  /** 退登 / 换号：只清内存，**绝不写盘** —— 退登不是撤回同意（spec §12.1）。 */
  function reset(): void {
    sendingEnabled.value = false;
    status.value = null;
  }

  async function setSendingEnabled(value: boolean): Promise<void> {
    await writeAiSendingEnabled(value);
    sendingEnabled.value = value;
  }

  return { sendingEnabled, status, tabVisible, canShowPrivacyCard, load, reset, setSendingEnabled };
});

/**
 * 单例 store。没有活跃 pinia 时传一个**显式实例**，不去 `setActivePinia`：理由见 auth.ts
 * 顶部注释（设成全局 active 会让游离 store 抢先成为后续所有 `useStore()` 的落点）。
 */
export function useAiSettingsStore(): ReturnType<typeof useAiSettingsStoreBase> {
  return useAiSettingsStoreBase(getActivePinia() ?? createPinia());
}
