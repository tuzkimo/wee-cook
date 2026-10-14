import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import { enqueueSync } from "@/services/sync";
import { useAuthStore } from "@/stores/auth";
import { useBookStore } from "@/stores/book";
import { useLabelStore } from "@/stores/label";
import { canEdit, useRecipeStore } from "@/stores/recipe";
import { useTeamStore, type Team } from "@/stores/team";
import type { RecipeInput } from "@/types";

// 只 mock 入队这一个动作（真要发同步就碰网络了）；sync 其余部分保持真身。
vi.mock("@/services/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/sync")>();
  return { ...actual, enqueueSync: vi.fn() };
});

const NOW = "2026-10-14T10:00:00.000Z";

let db: Db;
let category: string | null = null;

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
  localStorage.clear();
  category = null;
  vi.clearAllMocks();
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

/** 分类只建一次：labels(name, kind) 上有活行唯一索引，重复插会撞。 */
async function categoryId(): Promise<string> {
  category ??= (await useLabelStore().add("category", "炒菜")).id;
  return category;
}

/** 直接落一行菜谱，归属由参数钉死：过滤用例不该依赖 create 的归属逻辑。 */
async function insertRecipe(opts: {
  name: string;
  owner_id: string | null;
  team_id: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO recipes (id, name, cover_path, category_id, created_at, updated_at, deleted_at, owner_id, team_id)
     VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
    [id, opts.name, await categoryId(), NOW, NOW, opts.owner_id, opts.team_id],
  );
  return id;
}

async function listNames(): Promise<string[]> {
  const store = useRecipeStore();
  await store.fetchAll();
  // updated_at 相同，库里按 id 兜底排序，用例只关心「谁在列表里」
  return store.recipes.map((item) => item.recipe.name).sort();
}

function input(name: string, overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    name,
    cover_path: null,
    category_id: "",
    tag_ids: [],
    steps: [],
    ingredients: [],
    ...overrides,
  };
}

async function ownershipOf(id: string): Promise<{ owner_id: string | null; team_id: string | null }> {
  const rows = await db.select<{ owner_id: string | null; team_id: string | null }[]>(
    "SELECT owner_id, team_id FROM recipes WHERE id = ?",
    [id],
  );
  return rows[0];
}

async function updatedAtOf(id: string): Promise<string> {
  const rows = await db.select<{ updated_at: string }[]>(
    "SELECT updated_at FROM recipes WHERE id = ?",
    [id],
  );
  return rows[0].updated_at;
}

describe("菜谱可见范围与归属", () => {
  it("未登录时列表不过滤，但别人的菜谱不可编辑", async () => {
    const mine = await insertRecipe({ name: "本机菜", owner_id: null, team_id: null });
    const others = await insertRecipe({ name: "别人的菜", owner_id: "other", team_id: null });

    expect(await listNames()).toEqual(["别人的菜", "本机菜"]);

    const store = useRecipeStore();
    const recipeOf = (id: string) => store.recipes.find((item) => item.recipe.id === id)!.recipe;
    // 认领过的菜谱照样显示（过滤掉会让用户以为数据丢了），但不给改
    expect(canEdit(recipeOf(others))).toBe(false);
    expect(canEdit(recipeOf(mine))).toBe(true);
  });

  it("登录后只显示我的私人菜谱与我所在的团队菜谱", async () => {
    loginAs("me");
    useTeamStore().teams = [team("t1")];
    await insertRecipe({ name: "我的私人", owner_id: "me", team_id: null });
    await insertRecipe({ name: "团队菜", owner_id: "other", team_id: "t1" });
    await insertRecipe({ name: "别人团队的", owner_id: "other", team_id: "t2" });
    await insertRecipe({ name: "本机未认领", owner_id: null, team_id: null });

    expect(await listNames()).toEqual(["团队菜", "我的私人"]);
  });

  it("切换菜谱本只影响列表，不改数据", async () => {
    loginAs("me");
    useTeamStore().teams = [team("t1")];
    await insertRecipe({ name: "我的私人", owner_id: "me", team_id: null });
    await insertRecipe({ name: "团队菜", owner_id: "other", team_id: "t1" });

    const book = useBookStore();
    await book.setBook("t1");
    expect(await listNames()).toEqual(["团队菜"]);

    await book.setBook(null);
    expect(await listNames()).toEqual(["团队菜", "我的私人"]);

    // 切来切去只换了 WHERE，行还是那两行，归属一个字节都没动
    const rows = await db.select<{ owner_id: string | null; team_id: string | null }[]>(
      "SELECT owner_id, team_id FROM recipes",
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.team_id).sort()).toEqual([null, "t1"].sort());
  });

  it("新增菜谱写入当前用户与当前菜谱本", async () => {
    loginAs("me");
    useTeamStore().teams = [team("t1")];
    const store = useRecipeStore();
    const book = useBookStore();
    const category_id = await categoryId();

    const personal = await store.create(input("私人菜", { category_id }));
    await book.setBook("t1");
    const inTeam = await store.create(input("团队菜", { category_id }));

    expect(await ownershipOf(personal)).toEqual({ owner_id: "me", team_id: null });
    expect(await ownershipOf(inTeam)).toEqual({ owner_id: "me", team_id: "t1" });
  });

  it("未登录新增的菜谱 owner_id 与 team_id 都是 null", async () => {
    const store = useRecipeStore();

    const id = await store.create(input("本机菜", { category_id: await categoryId() }));

    expect(await ownershipOf(id)).toEqual({ owner_id: null, team_id: null });
  });

  it("登录后改不动别人的菜谱：update / remove 被拒，本地 updated_at 不被推新", async () => {
    loginAs("me");
    useTeamStore().teams = [team("t1")];
    const otherId = await insertRecipe({ name: "别人的团队菜", owner_id: "other", team_id: "t1" });
    const before = await updatedAtOf(otherId);
    const store = useRecipeStore();

    await expect(
      store.update(otherId, input("改名", { category_id: await categoryId() })),
    ).rejects.toThrow("没有修改权限");
    await expect(store.remove(otherId)).rejects.toThrow("没有修改权限");

    expect(await updatedAtOf(otherId)).toBe(before);
    expect(await listNames()).toEqual(["别人的团队菜"]);
  });

  it("断网冷启动：有 uid 的团队缓存时，家人菜谱仍在可见范围里", async () => {
    localStorage.setItem("team_cache:me", JSON.stringify([team("t1")]));
    loginAs("me");
    await insertRecipe({ name: "家人菜", owner_id: "other", team_id: "t1" });
    await insertRecipe({ name: "私人菜", owner_id: "me", team_id: null });

    // book.restore() 内部会 team.load()：没配地址 → 请求失败，只能回落到缓存
    await useBookStore().restore();

    expect(await listNames()).toEqual(["家人菜", "私人菜"]);
  });

  it("换号后不会用上一个账号的团队缓存算可见范围", async () => {
    localStorage.setItem("team_cache:u1", JSON.stringify([team("t1")]));
    const teamStore = useTeamStore();
    loginAs("u1");
    await teamStore.load();
    expect(teamStore.teams.map((item) => item.id)).toEqual(["t1"]);

    loginAs("u2");
    await teamStore.load();
    expect(teamStore.teams).toEqual([]);

    await insertRecipe({ name: "u1 的团队菜", owner_id: "u1", team_id: "t1" });
    expect(await listNames()).toEqual([]);
  });

  it("新增、修改、删除后都把该条完整形状入同步队列，删除带墓碑", async () => {
    loginAs("me");
    useTeamStore().teams = [team("t1")];
    const store = useRecipeStore();
    const category_id = await categoryId();
    const id = await store.create(
      input("红烧肉", {
        category_id,
        steps: [{ text: "切块", image_path: null }],
      }),
    );

    const created = vi.mocked(enqueueSync).mock.calls;
    expect(created[created.length - 1][0].recipes?.[0]).toMatchObject({
      id,
      name: "红烧肉",
      owner_id: "me",
      team_id: null,
      deleted_at: null,
      steps: [{ text: "切块", sort_order: 0 }],
    });

    await store.update(id, input("回锅肉", { category_id }));
    const afterUpdate = vi.mocked(enqueueSync).mock.calls;
    expect(afterUpdate[afterUpdate.length - 1][0].recipes?.[0]).toMatchObject({
      id,
      name: "回锅肉",
      deleted_at: null,
      steps: [],
    });

    await store.remove(id);
    const afterRemove = vi.mocked(enqueueSync).mock.calls;
    const removed = afterRemove[afterRemove.length - 1][0].recipes?.[0];
    expect(removed?.id).toBe(id);
    expect(removed?.deleted_at).not.toBeNull();
  });
});
