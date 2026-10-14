// src/stores/book.ts
//
// 菜谱本切换：当前正在看哪一本 —— `null` = 我的菜谱（私人），否则是某个 teamId。
// 选择只影响列表的 WHERE 条件，不改任何一行数据（spec §9.1：列表按可见范围 + 当前菜谱本取数）。
// 选中的团队由 `restore()` 校验：退出的团队不该继续选中，否则列表会空得像数据丢了。
import { computed, ref, type ComputedRef, type Ref } from "vue";
import { createPinia, defineStore, getActivePinia } from "pinia";
import { useAuthStore } from "@/stores/auth";
import { useTeamStore } from "@/stores/team";
import type { BookRef } from "@/types";

const STORAGE_KEY = "current_book";

export interface BookStore {
  current: Ref<string | null>;
  options: ComputedRef<BookRef[]>;
  setBook(id: string | null): Promise<void>;
  restore(): Promise<void>;
}

const useBookStoreBase = defineStore("book", (): BookStore => {
  const current = ref<string | null>(null);
  const auth = useAuthStore();
  const team = useTeamStore();

  const options = computed<BookRef[]>(() => [
    { id: null, name: "我的菜谱" },
    ...team.teams.map((item) => ({ id: item.id, name: item.name })),
  ]);

  async function setBook(id: string | null): Promise<void> {
    current.value = id;
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  }

  async function restore(): Promise<void> {
    // 未登录只有「我的菜谱」一本，一次网络都不发
    if (!auth.serverUserId) {
      current.value = null;
      return;
    }
    // 拿不到团队列表（断网）时 load 保留现状，不做「团队没了」的误判清空
    await team.load();
    const saved = localStorage.getItem(STORAGE_KEY);
    current.value = saved !== null && team.teams.some((item) => item.id === saved) ? saved : null;
  }

  return { current, options, setBook, restore };
});

/**
 * 与 `useAuthStore` 同一处兜底（见 stores/auth.ts 的说明）：没有活跃 pinia 时传显式实例，
 * 不去 `setActivePinia` —— 否则游离 store 会抢走后续所有 `useStore()` 的落点。
 * shortcut: 为不改已有测试（RecipeList.test.ts 裸挂载页面）而留；
 *          升级时机：给那些页面测试装上 pinia 后删掉这个兜底。
 */
export function useBookStore(): ReturnType<typeof useBookStoreBase> {
  return useBookStoreBase(getActivePinia() ?? createPinia());
}
