// AI 聊天页的唯一数据源：历史读回、一轮问答（落库）、错误文案、以及把 AI 的筛选条件交给
// recipeFilter store，让用户能在筛选页自己复验。store 不依赖 router，跳转由视图层做。
import { defineStore } from "pinia";
import { ref, type Ref } from "vue";
import { aiAccount } from "@/services/ai/account";
import { runAgent } from "@/services/ai/agent";
import { loadDict, type UnresolvedNames } from "@/services/ai/filter";
import { PROMPT_VERSION } from "@/services/ai/prompt";
import {
  appendMessage,
  clearMessages,
  historyText,
  loadMessages,
  loadOrCreateSession,
  type MessagePayload,
  type StoredMessage,
} from "@/services/ai/session";
import { AiError, type AiErrorCode, type AiMessage } from "@/services/ai/transport";
import { useRecipeFilterStore } from "@/stores/recipeFilter";
import { useRecipeStore } from "@/stores/recipe";
import type { RecipeListItem } from "@/types";
import type { RecipeFilter } from "@/utils/recipeFilter";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 截图轮的封面缩略图 dataUrl；没有图就是 null */
  image: string | null;
  filter: RecipeFilter | null;
  items: RecipeListItem[];
  matched: number;
  unresolved: UnresolvedNames | null;
}

export interface AiChatStore {
  messages: Ref<ChatMessage[]>;
  sending: Ref<boolean>;
  error: Ref<string | null>;
  load(): Promise<void>;
  send(text: string): Promise<void>;
  clear(): Promise<void>;
  reset(): void;
  openInFilter(filter: RecipeFilter): void;
}

/** 每个码都得有话说：用户看不懂 `ai_upstream_timeout` 这种东西 */
const ERROR_TEXT: Record<AiErrorCode, string> = {
  no_server: "还没配置服务器地址",
  unreachable: "连不上服务器，检查网络后重试",
  ai_disabled: "服务器的 AI 未启用",
  ai_upstream_auth: "AI 服务认证失败，请检查服务器配置",
  ai_rate_limited: "AI 请求太频繁，稍后再试",
  ai_quota_exceeded: "今日 AI 次数已用完",
  ai_upstream_timeout: "AI 响应超时，稍后再试",
  ai_unreachable: "AI 服务连不上，稍后再试",
  ai_upstream_error: "AI 服务出错了，稍后再试",
  bad_request: "请求被服务器拒绝了，稍后再试",
};

const GENERIC_ERROR = "AI 暂时用不了，稍后再试";

export const useAiChatStore = defineStore("aiChat", (): AiChatStore => {
  const messages = ref<ChatMessage[]>([]);
  const sending = ref(false);
  const error = ref<string | null>(null);
  // 当前账号的会话；load / send / clear 共用同一条，避免重复查询
  let sessionId: string | null = null;
  // 退登 / 换号的世代。在飞时用户可能已退登，响应回来时不能把上一个账号的内容写回内存。
  let epoch = 0;

  /** 只有世代未变才肯缓存会话：晚到的旧账号会话 id 不得留在内存里 */
  async function ensureSession(start: number): Promise<string | null> {
    if (sessionId === null) {
      const id = await loadOrCreateSession();
      if (start !== epoch) return null;
      sessionId = id;
    }
    return sessionId;
  }

  async function load(): Promise<void> {
    // 未登录的人打开 /ai 什么也不读，更不能丢一个未处理的 rejection（规格 §12.1）
    if (aiAccount() === null) return;
    const start = epoch;
    const id = await ensureSession(start);
    if (id === null) return;
    const loaded = await loadMessages(id);
    if (start !== epoch) return;
    messages.value = loaded.map(toChatMessage);
  }

  async function send(text: string): Promise<void> {
    const content = text.trim();
    if (sending.value || content === "") return;
    // 未登录不发（也不建会话）：入口本该挡住，这里只是不把未处理的 rejection 丢给上层
    if (aiAccount() === null) return;
    // 世代采样必须在第一个 await 之前，否则 reset() 发生在等待中时这里已经看不到它
    const start = epoch;
    sending.value = true;
    error.value = null;
    try {
      const id = await ensureSession(start);
      if (id === null) return;
      // 历史要在插入本轮提问之前取，runAgent 自己会把本轮提问接在后面。
      // 截图轮在历史里只留占位符；本地 messages 保留原文与缩略图（规格 §12.2）
      const history = messages.value
        .filter((message) => message.text !== "" || message.image !== null)
        .map(
          (message): AiMessage => ({
            role: message.role,
            content: historyText(message.text, message.image !== null),
          }),
        );

      // 用户说的话先落库：AI 挂了也不该丢掉用户的问题
      const userMessage = newMessage("user", content, null);
      messages.value.push(toChatMessage(userMessage));
      await appendMessage(id, userMessage);

      const dict = await loadDict();
      const recipeStore = useRecipeStore();
      await recipeStore.fetchAll();
      const result = await runAgent(content, history, {
        dict,
        today: localDate(),
        loadItems: async () => recipeStore.recipes,
      });

      // 退登后回来的这一发属于上一个账号：不落库、不进内存
      if (start !== epoch) return;
      // assistant 消息只在 agent 成功后才插入，失败路径不留半条
      const assistantMessage = newMessage(
        "assistant",
        result.text,
        result.filter === null
          ? null
          : {
              filter: result.filter,
              matched: result.resolved?.matched ?? 0,
              items: result.resolved?.items ?? [],
              unresolved: result.unresolved ?? { categories: [], tags: [], ingredients: [] },
            },
      );
      messages.value.push(toChatMessage(assistantMessage));
      await appendMessage(id, assistantMessage);
    } catch (err) {
      if (start !== epoch) return;
      error.value = err instanceof AiError ? ERROR_TEXT[err.code] : GENERIC_ERROR;
    } finally {
      // 世代变了说明 reset() 已经复位过 sending（可能已经是新账号的那一发），别再动
      if (start === epoch) sending.value = false;
    }
  }

  async function clear(): Promise<void> {
    const id = await ensureSession(epoch);
    if (id === null) return;
    await clearMessages(id);
    messages.value = [];
    error.value = null;
  }

  function openInFilter(filter: RecipeFilter): void {
    useRecipeFilterStore().apply(filter);
  }

  /** 退登 / 换号：只清内存，库里的行原样留着（spec §12.1）。 */
  function reset(): void {
    // 在飞的 send 作废：响应回来时世代对不上，既不加消息也不写错误
    epoch++;
    messages.value = [];
    error.value = null;
    sending.value = false;
    sessionId = null;
  }

  return { messages, sending, error, load, send, clear, reset, openInFilter };
});

function newMessage(
  role: "user" | "assistant",
  text: string,
  payload: MessagePayload | null,
): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content: text,
    payload,
    promptVersion: PROMPT_VERSION,
    createdAt: new Date().toISOString(),
  };
}

function toChatMessage(message: StoredMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.content,
    image: message.payload?.image ?? null,
    filter: message.payload?.filter ?? null,
    items: message.payload?.items ?? [],
    matched: message.payload?.matched ?? 0,
    unresolved: message.payload?.unresolved ?? null,
  };
}

/** 本地日 `YYYY-MM-DD`；UTC 日会让东八区的晚上错一天 */
function localDate(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
