// AI 聊天页的唯一数据源：历史读回、一轮问答（落库）、错误文案、以及把 AI 的筛选条件交给
// recipeFilter store，让用户能在筛选页自己复验。store 不依赖 router，跳转由视图层做。
import { defineStore } from "pinia";
import { ref, type Ref } from "vue";
import { aiAccount } from "@/services/ai/account";
import { runAgent } from "@/services/ai/agent";
import { setDraft } from "@/services/ai/draft";
import { loadDict, type UnresolvedNames } from "@/services/ai/filter";
import type { Screenshot } from "@/services/ai/image";
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
import { saveImageBytes } from "@/services/imageStore";
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
  /** 待发送的截图；send 取走即清，reset 也清 */
  attachment: Ref<Screenshot | null>;
  /** 草稿槽刚写好：视图层据此跳编辑页。读走即清（clearDraftReady） */
  draftReady: Ref<boolean>;
  setAttachment(shot: Screenshot | null): void;
  clearDraftReady(): void;
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
  const attachment = ref<Screenshot | null>(null);
  const draftReady = ref(false);
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
    if (sending.value || (content === "" && attachment.value === null)) return;
    // 未登录不发（也不建会话）：入口本该挡住，这里只是不把未处理的 rejection 丢给上层
    if (aiAccount() === null) return;
    // 世代采样必须在第一个 await 之前，否则 reset() 发生在等待中时这里已经看不到它
    const start = epoch;
    sending.value = true;
    // 取走即清：图只跟着这一轮，失败也不留在输入区。本轮把 shot.segments 发给模型
    const shot = attachment.value;
    attachment.value = null;
    error.value = null;
    // 上一轮遗留的跳转标志不能跟着这一发走
    draftReady.value = false;
    try {
      const id = await ensureSession(start);
      if (id === null) return;
      // 退登 / 换号发生在等会话的那一下：这一发不属于任何人，直接作废
      if (start !== epoch) return;
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

      // 用户说的话先落库：AI 挂了也不该丢掉用户的问题。有图才带 payload（封面缩略图）；
      // 纯文字轮的 payload 仍是 null（别的字段本来就是默认值）
      const payload: MessagePayload | null =
        shot === null
          ? null
          : {
              filter: null,
              matched: 0,
              items: [],
              unresolved: { categories: [], tags: [], ingredients: [] },
              image: shot.cover,
            };
      const userMessage = newMessage("user", content, payload);
      messages.value.push(toChatMessage(userMessage));
      await appendMessage(id, userMessage);

      const dict = await loadDict();
      const recipeStore = useRecipeStore();
      await recipeStore.fetchAll();
      const result = await runAgent(
        content,
        history,
        {
          dict,
          today: localDate(),
          loadItems: async () => recipeStore.recipes,
        },
        shot === null ? undefined : { images: shot.segments },
      );

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

      // 有草稿才算这一轮跑通：封面在跳转前落盘（模型说「不是菜谱」时不留孤儿图）；
      // 写盘失败只丢封面，不阻断进编辑页
      if (result.draft !== null) {
        let coverPath: string | null = null;
        if (shot !== null) {
          const saved = await saveImageBytes(shot.coverBytes);
          if (saved.ok) coverPath = saved.name;
          else console.warn(`封面没存下来：${saved.message}`);
        }
        // 落盘期间退登 / 换号：这份草稿属于上一个账号
        if (start !== epoch) return;
        setDraft({ ...result.draft, cover_path: coverPath });
        draftReady.value = true;
      }
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

  function setAttachment(shot: Screenshot | null): void {
    attachment.value = shot;
  }

  /** 视图层跳转前调一次：读完再读是 false，同一份草稿不会跳两次 */
  function clearDraftReady(): void {
    draftReady.value = false;
  }

  /** 退登 / 换号：只清内存，库里的行原样留着（spec §12.1）。 */
  function reset(): void {
    // 在飞的 send 作废：响应回来时世代对不上，既不加消息也不写错误
    epoch++;
    messages.value = [];
    error.value = null;
    attachment.value = null;
    draftReady.value = false;
    sending.value = false;
    sessionId = null;
  }

  return {
    messages,
    sending,
    error,
    attachment,
    draftReady,
    setAttachment,
    clearDraftReady,
    load,
    send,
    clear,
    reset,
    openInFilter,
  };
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
