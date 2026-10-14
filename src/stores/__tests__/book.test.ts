import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/stores/auth";
import { useBookStore } from "@/stores/book";
import { useTeamStore, type Team } from "@/stores/team";

const NOW = "2026-10-14T10:00:00.000Z";

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});

/** 直接种当前会话：serverUserId 由 serverUser 派生，不用真跑一遍登录。 */
function loginAs(id: string): void {
  useAuthStore().serverUser = {
    id,
    username: id,
    nickname: id,
    avatar_url: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function team(id: string, name = "一家人"): Team {
  return { id, name, created_by: "me", member_count: 2 };
}

describe("bookStore", () => {
  it("setBook 持久化，切回「我的菜谱」时清掉记录", async () => {
    const book = useBookStore();

    await book.setBook("t1");
    expect(book.current).toBe("t1");
    expect(localStorage.getItem("current_book")).toBe("t1");

    await book.setBook(null);
    expect(book.current).toBeNull();
    expect(localStorage.getItem("current_book")).toBeNull();
  });

  it("重启后 restore() 读回上次选中的团队", async () => {
    loginAs("me");
    useTeamStore().teams = [team("t1")];
    localStorage.setItem("current_book", "t1");

    const book = useBookStore();
    expect(book.current).toBeNull();

    await book.restore();

    expect(book.current).toBe("t1");
  });

  it("选中的团队已不存在（退出 / 被解散）时回落「我的菜谱」", async () => {
    loginAs("me");
    useTeamStore().teams = [team("t1")];
    localStorage.setItem("current_book", "t-gone");

    const book = useBookStore();
    await book.restore();

    expect(book.current).toBeNull();
  });

  it("未登录时 restore() 回落「我的菜谱」，且不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("current_book", "t1");

    const book = useBookStore();
    await book.restore();

    expect(book.current).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("options 第一项永远是「我的菜谱」，后面跟着我的团队", async () => {
    loginAs("me");
    useTeamStore().teams = [team("t1"), team("t2", "老王家")];

    expect(useBookStore().options).toEqual([
      { id: null, name: "我的菜谱" },
      { id: "t1", name: "一家人" },
      { id: "t2", name: "老王家" },
    ]);
  });
});
