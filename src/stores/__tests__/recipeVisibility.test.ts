import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import { enqueueSync } from "@/services/sync";
import { useAuthStore } from "@/stores/auth";
import { useLabelStore } from "@/stores/label";
import { canEdit, useRecipeStore, visibleRecipeFilter } from "@/stores/recipe";
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

/** 分类只建一次：labels(name, kind) 上有活行唯一索引，重复插会撞。 */
async function categoryId(): Promise<string> {
  category ??= (await useLabelStore().add("category", "炒菜")).id;
  return category;
}

/** 直接落一行菜谱，归属由参数钉死：过滤用例不该依赖 create 的归属逻辑。 */
async function insertRecipe(opts: { name: string; owner_id: string | null }): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO recipes (id, name, cover_path, category_id, created_at, updated_at, deleted_at, owner_id)
     VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)`,
    [id, opts.name, await categoryId(), NOW, NOW, opts.owner_id],
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
    is_public: 0,
    tag_ids: [],
    steps: [],
    ingredients: [],
    ...overrides,
  };
}

async function ownerIdOf(id: string): Promise<string | null> {
  const rows = await db.select<{ owner_id: string | null }[]>(
    "SELECT owner_id FROM recipes WHERE id = ?",
    [id],
  );
  return rows[0].owner_id;
}

async function updatedAtOf(id: string): Promise<string> {
  const rows = await db.select<{ updated_at: string }[]>(
    "SELECT updated_at FROM recipes WHERE id = ?",
    [id],
  );
  return rows[0].updated_at;
}

describe("菜谱可见范围与归属", () => {
  it("未登录时收藏的别人的菜谱不进「我的」列表，收藏 tab 里能打开但不可编辑", async () => {
    const mine = await insertRecipe({ name: "本机菜", owner_id: null });
    const others = await insertRecipe({ name: "别人的菜", owner_id: "other" });
    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES (?)", [others]);

    // I2：收藏的别人的菜谱只在「收藏」tab，不混进「我的」列表（spec §9.1、反目标 3）
    expect(await listNames()).toEqual(["本机菜"]);

    const store = useRecipeStore();
    await store.fetchFavorites();
    expect(store.favorites.map((item) => item.recipe.name)).toEqual(["别人的菜"]);
    const recipeOf = (id: string) => store.recipes.find((item) => item.recipe.id === id)!.recipe;
    // 收藏回来的别人的菜谱照样不给改
    expect(canEdit(store.favorites[0].recipe)).toBe(false);
    expect(canEdit(recipeOf(mine))).toBe(true);
  });

  it("未登录只显示本机自己的菜谱，收藏的与别人的缓存副本都不混进来", async () => {
    await insertRecipe({ name: "本机菜", owner_id: null });
    await db.execute("INSERT INTO local_accounts (user_id) VALUES (?)", ["B"]);
    await insertRecipe({ name: "B 的", owner_id: "B" });
    const favorited = await insertRecipe({ name: "收藏的", owner_id: "other" });
    await insertRecipe({ name: "别人的缓存", owner_id: "other" });
    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES (?)", [favorited]);

    expect(await listNames()).toEqual(["B 的", "本机菜"]);
  });

  it("未登录时可见范围只是本机自己的菜谱（收藏归收藏 tab）", async () => {
    expect(await visibleRecipeFilter()).toEqual({
      sql: "(owner_id IS NULL OR owner_id IN (SELECT user_id FROM local_accounts))",
      params: [],
    });
  });

  it("登录后可见范围只有 owner_id = 我", async () => {
    loginAs("me");

    const filter = await visibleRecipeFilter();

    expect(filter.sql).toBe("owner_id = ?");
    expect(filter.params).toEqual(["me"]);
  });

  it("登录后列表只留下自己名下的菜谱", async () => {
    loginAs("me");
    await insertRecipe({ name: "我的", owner_id: "me" });
    await insertRecipe({ name: "别人的", owner_id: "other" });
    await insertRecipe({ name: "本机未认领", owner_id: null });

    expect(await listNames()).toEqual(["我的"]);
  });

  it("新增菜谱写入当前用户", async () => {
    loginAs("me");
    const store = useRecipeStore();

    const id = await store.create(input("私人菜", { category_id: await categoryId() }));

    expect(await ownerIdOf(id)).toBe("me");
  });

  it("未登录新增的菜谱 owner_id 是 null", async () => {
    const store = useRecipeStore();

    const id = await store.create(input("本机菜", { category_id: await categoryId() }));

    expect(await ownerIdOf(id)).toBeNull();
  });

  it("改不动别人的菜谱：未登录与登录后都按权限拦住，且不混进「我的」列表", async () => {
    const otherId = await insertRecipe({ name: "别人的菜", owner_id: "other" });
    // 收藏的别人的菜谱详情可读（收藏是合法可见范围，C1），但改 / 删必须被权限拦住
    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES (?)", [otherId]);
    const before = await updatedAtOf(otherId);
    const store = useRecipeStore();

    // 未登录：它只在「收藏」数据源，不在「我的」列表
    expect(await listNames()).toEqual([]);
    await store.fetchFavorites();
    expect(store.favorites.map((item) => item.recipe.id)).toEqual([otherId]);
    await expect(
      store.update(otherId, input("改名", { category_id: await categoryId() })),
    ).rejects.toThrow("没有修改权限");
    await expect(store.remove(otherId)).rejects.toThrow("没有修改权限");
    expect(await updatedAtOf(otherId)).toBe(before);

    // 登录后：收藏的别人的菜谱仍能从收藏 tab 打开，但同样不给改
    loginAs("me");
    await expect(
      store.update(otherId, input("改名", { category_id: await categoryId() })),
    ).rejects.toThrow("没有修改权限");
    expect(await updatedAtOf(otherId)).toBe(before);
  });

  it("登录后收藏的别人的菜谱：fetchFavorites 含它，getDetail 也能打开（C1 回归）", async () => {
    loginAs("me");
    const otherId = await insertRecipe({ name: "别人公开的菜", owner_id: "other" });
    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES (?)", [otherId]);
    const store = useRecipeStore();

    await store.fetchFavorites();
    expect(store.favorites.map((item) => item.recipe.id)).toEqual([otherId]);

    const detail = await store.getDetail(otherId);
    expect(detail.recipe.id).toBe(otherId);
  });

  it("登录后没收藏的别人的菜谱，详情仍按不存在处理", async () => {
    loginAs("me");
    const otherId = await insertRecipe({ name: "别人的", owner_id: "other" });
    const store = useRecipeStore();

    await expect(store.getDetail(otherId)).rejects.toThrow("菜谱不存在");
  });

  it("新增、修改、删除后都把该条完整形状入同步队列，删除带墓碑", async () => {
    loginAs("me");
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
