import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import { enqueueSync } from "@/services/sync";
import { LOCAL_SCOPE, personalScope, setActiveScope, teamScope } from "@/services/scope";
import { useAuthStore } from "@/stores/auth";
import { canEdit, useRecipeStore, visibleRecipeFilter } from "@/stores/recipe";
import type { RecipeInput } from "@/types";

// 只 mock 入队这一个动作（真要发同步就碰网络了）；sync 其余部分保持真身。
vi.mock("@/services/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/sync")>();
  return { ...actual, enqueueSync: vi.fn() };
});

const NOW = "2026-10-14T10:00:00.000Z";

let db: Db;

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
  localStorage.clear();
  setActiveScope(LOCAL_SCOPE);
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

/** 直接落一行菜谱：过滤用例不该依赖 create 的归属逻辑。 */
async function insertRecipe(opts: {
  name: string;
  scope_id: string;
  owner_id?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  const categoryId = `cat-${id}`;
  await db.execute(
    "INSERT INTO labels (id, scope_id, name, kind, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 'category', ?, ?, NULL)",
    [categoryId, opts.scope_id, categoryId, NOW, NOW],
  );
  await db.execute(
    `INSERT INTO recipes (id, scope_id, name, cover_path, category_id, created_at, updated_at, deleted_at, owner_id)
     VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
    [id, opts.scope_id, opts.name, categoryId, NOW, NOW, opts.owner_id ?? null],
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

async function scopeOf(id: string): Promise<string> {
  const rows = await db.select<{ scope_id: string }[]>(
    "SELECT scope_id FROM recipes WHERE id = ?",
    [id],
  );
  return rows[0].scope_id;
}

async function ownerIdOf(id: string): Promise<string | null> {
  const rows = await db.select<{ owner_id: string | null }[]>(
    "SELECT owner_id FROM recipes WHERE id = ?",
    [id],
  );
  return rows[0].owner_id;
}

async function categoryIdIn(scope: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    "INSERT INTO labels (id, scope_id, name, kind, created_at, updated_at, deleted_at) VALUES (?, ?, '炒菜', 'category', ?, ?, NULL)",
    [id, scope, NOW, NOW],
  );
  return id;
}

describe("菜谱按范围可见", () => {
  it("可见范围就是当前范围键", async () => {
    expect(await visibleRecipeFilter()).toEqual({ sql: "scope_id = ?", params: [LOCAL_SCOPE] });

    setActiveScope(teamScope("t1"));
    expect(await visibleRecipeFilter()).toEqual({ sql: "scope_id = ?", params: ["t:t1"] });

    setActiveScope(personalScope("me"));
    expect(await visibleRecipeFilter()).toEqual({ sql: "scope_id = ?", params: ["p:me"] });
  });

  it("未登录只看到 p:local 的菜谱", async () => {
    await insertRecipe({ name: "本机菜", scope_id: LOCAL_SCOPE });
    await insertRecipe({ name: "团队菜", scope_id: teamScope("t1") });
    await insertRecipe({ name: "别人的个人范围", scope_id: personalScope("other") });

    expect(await listNames()).toEqual(["本机菜"]);
  });

  it("切到团队范围后只看到该团队的菜谱", async () => {
    await insertRecipe({ name: "本机菜", scope_id: LOCAL_SCOPE });
    await insertRecipe({ name: "我家的菜", scope_id: teamScope("t1") });
    await insertRecipe({ name: "爸妈家的菜", scope_id: teamScope("t2") });

    setActiveScope(teamScope("t1"));
    expect(await listNames()).toEqual(["我家的菜"]);
  });

  it("团队里别人建的菜谱可见，但只有创建者能改（canEdit 只看 owner_id）", async () => {
    loginAs("me");
    setActiveScope(teamScope("t1"));
    const mine = await insertRecipe({
      name: "我加的菜",
      scope_id: teamScope("t1"),
      owner_id: "me",
    });
    const others = await insertRecipe({
      name: "队友加的菜",
      scope_id: teamScope("t1"),
      owner_id: "teammate",
    });

    const store = useRecipeStore();
    await store.fetchAll();
    expect(store.recipes.map((item) => item.recipe.name).sort()).toEqual(["我加的菜", "队友加的菜"]);

    const recipesById = new Map(store.recipes.map((item) => [item.recipe.id, item.recipe]));
    expect(canEdit(recipesById.get(mine)!)).toBe(true);
    expect(canEdit(recipesById.get(others)!)).toBe(false);
    // UI 藏了入口，直接调 store 也必须拦住
    await expect(
      store.update(others, input("改名", { category_id: await categoryIdIn(teamScope("t1")) })),
    ).rejects.toThrow("没有修改权限");
    await expect(store.remove(others)).rejects.toThrow("没有修改权限");
  });

  it("详情页直接输 URL 也取不到别的范围的菜谱", async () => {
    const other = await insertRecipe({ name: "另一个范围的菜", scope_id: teamScope("t2") });

    await expect(useRecipeStore().getDetail(other)).rejects.toThrow("菜谱不存在");

    setActiveScope(teamScope("t2"));
    expect((await useRecipeStore().getDetail(other)).recipe.id).toBe(other);
  });

  it("新增菜谱写当前范围与当前用户", async () => {
    loginAs("me");
    setActiveScope(teamScope("t1"));
    const store = useRecipeStore();

    const id = await store.create(
      input("团队菜", { category_id: await categoryIdIn(teamScope("t1")) }),
    );

    expect(await scopeOf(id)).toBe("t:t1");
    expect(await ownerIdOf(id)).toBe("me");
  });

  it("未登录新增的菜谱落在 p:local，owner_id 为 null", async () => {
    const store = useRecipeStore();

    const id = await store.create(
      input("本机菜", { category_id: await categoryIdIn(LOCAL_SCOPE) }),
    );

    expect(await scopeOf(id)).toBe(LOCAL_SCOPE);
    expect(await ownerIdOf(id)).toBeNull();
  });

  it("改菜谱时不改范围，也不改归属", async () => {
    loginAs("me");
    setActiveScope(teamScope("t1"));
    const store = useRecipeStore();
    const category = await categoryIdIn(teamScope("t1"));
    const id = await store.create(input("红烧肉", { category_id: category }));

    await store.update(id, input("回锅肉", { category_id: category }));

    expect(await scopeOf(id)).toBe("t:t1");
    expect(await ownerIdOf(id)).toBe("me");
  });

  it("新增、修改、删除后都把该条完整形状入同步队列，带范围与墓碑", async () => {
    loginAs("me");
    setActiveScope(teamScope("t1"));
    const store = useRecipeStore();
    const category_id = await categoryIdIn(teamScope("t1"));
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
      scope_id: "t:t1",
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
