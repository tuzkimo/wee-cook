import { describe, expect, it } from "vitest";
import { type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import {
  applyRemoteChanges,
  compareTimestamp,
  emptyPayload,
  recipePayloadFor,
  type RecipePayload,
  type SyncPayload,
} from "@/services/sync";
import type { InventoryBatch, InventoryUsage } from "@/types";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";

/** 一份只带需要字段的远端载荷；未指定的集合默认为空。 */
function remote(over: Partial<SyncPayload>): SyncPayload {
  return { ...emptyPayload(), ...over };
}

function recipe(over: Partial<RecipePayload> & { id: string }): RecipePayload {
  return {
    name: "菜",
    cover_path: null,
    category_id: "c1",
    owner_nickname: null,
    scope_id: "p:local",
    owner_avatar_url: null,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    owner_id: null,
    steps: [],
    ingredients: [],
    label_ids: [],
    ...over,
  };
}

/** 包装真库顺便记录写语句，用来断言「相同 updated_at 不重复写」。 */
function countingDb(db: Db): { db: Db; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    db: {
      select: (sql, params) => db.select(sql, params),
      execute: async (sql, params) => {
        writes.push(sql);
        return db.execute(sql, params);
      },
    },
  };
}

describe("applyRemoteChanges", () => {
  it("远端更新的行覆盖本地较旧的行（LWW）", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('u1','p:local','克',?,?,NULL)",
      [T0, T0],
    );

    await applyRemoteChanges(
      remote({
        units: [{ id: "u1", scope_id: "p:local", name: "毫升", created_at: T0, updated_at: T1, deleted_at: null }],
      }),
      db,
    );

    const rows = await db.select<{ name: string }[]>("SELECT name FROM units WHERE id = 'u1'");
    expect(rows).toEqual([{ name: "毫升" }]);
  });

  it("远端更旧的行被跳过，本地不被回滚", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('u1','p:local','克',?,?,NULL)",
      [T0, T1],
    );

    await applyRemoteChanges(
      remote({
        units: [{ id: "u1", scope_id: "p:local", name: "毫升", created_at: T0, updated_at: T0, deleted_at: null }],
      }),
      db,
    );

    const rows = await db.select<{ name: string }[]>("SELECT name FROM units WHERE id = 'u1'");
    expect(rows).toEqual([{ name: "克" }]);
  });

  it("相同 updated_at 时不重复写（幂等）", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('u1','p:local','克',?,?,NULL)",
      [T0, T0],
    );
    const counted = countingDb(db);

    await applyRemoteChanges(
      remote({
        units: [{ id: "u1", scope_id: "p:local", name: "克", created_at: T0, updated_at: T0, deleted_at: null }],
      }),
      counted.db,
    );

    expect(counted.writes).toEqual([]);
  });

  it("同名字典行合并：本地已有同名 X，收到 Y → 引用改指 Y 并删掉 X", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('lab-x','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('tag-x','p:local','快手','tag',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('ing-x','p:local','盐',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('unit-x','p:local','克',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,scope_id,name,cover_path,category_id,created_at,updated_at,deleted_at)
       VALUES ('r1','p:local','红烧肉',NULL,'lab-x',?,?,NULL)`,
      [T0, T0],
    );
    await db.execute("INSERT INTO recipe_labels (recipe_id,label_id) VALUES ('r1','tag-x')");
    await db.execute(
      `INSERT INTO recipe_ingredients
         (id,recipe_id,ingredient_id,amount,unit_id,sort_order,updated_at,deleted_at)
       VALUES ('ri1','r1','ing-x',1,'unit-x',0,?,NULL)`,
      [T0],
    );

    await applyRemoteChanges(
      remote({
        labels: [
          { id: "lab-y", scope_id: "p:local", name: "家常", kind: "category", created_at: T0, updated_at: T0, deleted_at: null },
          { id: "tag-y", scope_id: "p:local", name: "快手", kind: "tag", created_at: T0, updated_at: T0, deleted_at: null },
        ],
        ingredients: [{ id: "ing-y", scope_id: "p:local", name: "盐", created_at: T0, updated_at: T0, deleted_at: null }],
        units: [{ id: "unit-y", scope_id: "p:local", name: "克", created_at: T0, updated_at: T0, deleted_at: null }],
      }),
      db,
    );

    expect(await db.select("SELECT category_id FROM recipes WHERE id = 'r1'")).toEqual([
      { category_id: "lab-y" },
    ]);
    expect(await db.select("SELECT label_id FROM recipe_labels WHERE recipe_id = 'r1'")).toEqual([
      { label_id: "tag-y" },
    ]);
    expect(
      await db.select("SELECT ingredient_id, unit_id FROM recipe_ingredients WHERE id = 'ri1'"),
    ).toEqual([{ ingredient_id: "ing-y", unit_id: "unit-y" }]);
    expect(await db.select("SELECT id FROM labels ORDER BY id")).toEqual([
      { id: "lab-y" },
      { id: "tag-y" },
    ]);
    expect(await db.select("SELECT id FROM ingredients")).toEqual([{ id: "ing-y" }]);
    expect(await db.select("SELECT id FROM units")).toEqual([{ id: "unit-y" }]);
  });

  it("labels 的同名合并按 (name, kind)：同名不同 kind 不合并且不删行", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('x','p:local','辣','tag',?,?,NULL)",
      [T0, T0],
    );

    await applyRemoteChanges(
      remote({
        labels: [
          { id: "y", scope_id: "p:local", name: "辣", kind: "category", created_at: T0, updated_at: T0, deleted_at: null },
        ],
      }),
      db,
    );

    expect(await db.select("SELECT id, kind FROM labels ORDER BY id")).toEqual([
      { id: "x", kind: "tag" },
      { id: "y", kind: "category" },
    ]);
    expect(await db.select("SELECT deleted_at FROM labels WHERE id = 'x'")).toEqual([
      { deleted_at: null },
    ]);
  });

  it("远端菜谱的 scope_id 与 owner_nickname 落到本地", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('c1','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );

    // 新行走 INSERT：远端首次下发就带范围与作者昵称
    await applyRemoteChanges(
      remote({ recipes: [recipe({ id: "r1", scope_id: "t:t1", owner_nickname: "小明" })] }),
      db,
    );
    expect(
      await db.select("SELECT scope_id, owner_nickname FROM recipes WHERE id = 'r1'"),
    ).toEqual([{ scope_id: "t:t1", owner_nickname: "小明" }]);

    // 已有行走 UPDATE：范围随远端走（同一条菜谱在库里不会有第二种范围），昵称回落
    await applyRemoteChanges(
      remote({ recipes: [recipe({ id: "r1", updated_at: T1 })] }),
      db,
    );
    expect(
      await db.select("SELECT scope_id, owner_nickname FROM recipes WHERE id = 'r1'"),
    ).toEqual([{ scope_id: "p:local", owner_nickname: null }]);
  });

  it("新菜谱落库带上作者头像", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('c1','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );

    await applyRemoteChanges(
      remote({
        recipes: [
          recipe({
            id: "r1",
            owner_nickname: "小明",
            scope_id: "p:local",
            owner_avatar_url: "data:image/jpeg;base64,AV",
          }),
        ],
      }),
      db,
    );

    expect(
      await db.select("SELECT owner_nickname, owner_avatar_url FROM recipes WHERE id = 'r1'"),
    ).toEqual([{ owner_nickname: "小明", owner_avatar_url: "data:image/jpeg;base64,AV" }]);
  });

  it("远端更旧时菜谱本体不过 LWW，但作者两列仍被刷新", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('c1','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );
    // 本地行比远端新：菜名是本地改过的，作者头像尚未拿到
    await db.execute(
      `INSERT INTO recipes (id,scope_id,name,cover_path,category_id,owner_nickname,owner_avatar_url,created_at,updated_at,deleted_at,owner_id)
       VALUES ('r1','p:local','本地改过的名字',NULL,'c1',NULL,NULL,?,?,NULL,NULL)`,
      [T0, T1],
    );

    await applyRemoteChanges(
      remote({
        recipes: [
          recipe({
            id: "r1",
            name: "服务端的名字",
            owner_nickname: "小明",

            owner_avatar_url: "data:image/jpeg;base64,AV",
          }),
        ],
      }),
      db,
    );

    expect(
      await db.select("SELECT name, owner_nickname, owner_avatar_url FROM recipes WHERE id = 'r1'"),
    ).toEqual([
      {
        name: "本地改过的名字",
        owner_nickname: "小明",
        owner_avatar_url: "data:image/jpeg;base64,AV",
      },
    ]);
  });

  it("载荷里没有 owner_avatar_url 这个键时不动本地的值", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('c1','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,scope_id,name,cover_path,category_id,owner_nickname,owner_avatar_url,created_at,updated_at,deleted_at,owner_id)
       VALUES ('r1','p:local','红烧肉',NULL,'c1','小明','🐱',?,?,NULL,NULL)`,
      [T0, T1],
    );

    // 旧版服务端的载荷里没有这个键（JSON.parse 之后 `in` 为 false）
    const oldServerRecipe = recipe({ id: "r1", owner_nickname: "小明" });
    delete (oldServerRecipe as Partial<RecipePayload>).owner_avatar_url;

    await applyRemoteChanges(remote({ recipes: [oldServerRecipe] }), db);

    expect(await db.select("SELECT owner_avatar_url FROM recipes WHERE id = 'r1'")).toEqual([
      { owner_avatar_url: "🐱" },
    ]);
  });

  it("菜谱的子行整组替换：远端步骤里没有的旧步骤本地必须消失", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('c1','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,scope_id,name,cover_path,category_id,created_at,updated_at,deleted_at)
       VALUES ('r1','p:local','旧菜',NULL,'c1',?,?,NULL)`,
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipe_steps (id,recipe_id,sort_order,text,image_path,updated_at,deleted_at)
       VALUES ('s1','r1',0,'旧步骤一',NULL,?,NULL)`,
      [T0],
    );
    await db.execute(
      `INSERT INTO recipe_steps (id,recipe_id,sort_order,text,image_path,updated_at,deleted_at)
       VALUES ('s2','r1',1,'旧步骤二',NULL,?,NULL)`,
      [T0],
    );

    await applyRemoteChanges(
      remote({
        recipes: [
          recipe({
            id: "r1",
            name: "新菜",
            updated_at: T1,
            steps: [{ id: "s3", sort_order: 0, text: "新步骤", image_path: null }],
          }),
        ],
      }),
      db,
    );

    expect(
      await db.select<{ id: string }[]>(
        "SELECT id FROM recipe_steps WHERE recipe_id = 'r1' ORDER BY id",
      ),
    ).toEqual([{ id: "s3" }]);
  });

  it("墓碑：远端 deleted_at 非空 → 本地列表里不再出现", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('c1','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,scope_id,name,cover_path,category_id,created_at,updated_at,deleted_at)
       VALUES ('r1','p:local','要删的菜',NULL,'c1',?,?,NULL)`,
      [T0, T0],
    );

    await applyRemoteChanges(
      remote({ recipes: [recipe({ id: "r1", updated_at: T1, deleted_at: T1 })] }),
      db,
    );

    expect(
      await db.select("SELECT id FROM recipes WHERE deleted_at IS NULL"),
    ).toEqual([]);
    const rows = await db.select<{ deleted_at: string | null }[]>(
      "SELECT deleted_at FROM recipes WHERE id = 'r1'",
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('比较时间戳前先归一化："2026-01-01 00:00:01" 与 "2026-01-01T00:00:00.000Z" 能正确比大小', async () => {
    expect(compareTimestamp("2026-01-01 00:00:01", "2026-01-01T00:00:00.000Z")).toBe(1000);

    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('u1','p:local','旧',?,?,NULL)",
      [T0, T0],
    );
    await applyRemoteChanges(
      remote({
        units: [
          { id: "u1", scope_id: "p:local", name: "新", created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:01", deleted_at: null },
        ],
      }),
      db,
    );
    expect(await db.select("SELECT name FROM units WHERE id = 'u1'")).toEqual([{ name: "新" }]);
  });

  it("同名合并优先取活行：本地同时有软删同名行与活同名行时不撞唯一索引（回归）", async () => {
    const { db } = await freshTestDb();
    // 本地历史：先建了同名行并软删（旧），后来又重建了同名活行（新）。
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('ing-gone','p:local','盐',?,?,?)",
      [T0, T0, T0],
    );
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('ing-live','p:local','盐',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('unit-gone','p:local','克',?,?,?)",
      [T0, T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('unit-live','p:local','克',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('lab-gone','p:local','家常','category',?,?,?)",
      [T0, T0, T0],
    );
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('lab-live','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,scope_id,name,cover_path,category_id,created_at,updated_at,deleted_at)
       VALUES ('r1','p:local','红烧肉',NULL,'lab-live',?,?,NULL)`,
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipe_ingredients
         (id,recipe_id,ingredient_id,amount,unit_id,sort_order,updated_at,deleted_at)
       VALUES ('ri1','r1','ing-live',1,'unit-live',0,?,NULL)`,
      [T0],
    );

    // 服务端按 spec §7.4 归并出第三个 UUID 的同名行下发。
    await applyRemoteChanges(
      remote({
        ingredients: [{ id: "ing-remote", scope_id: "p:local", name: "盐", created_at: T0, updated_at: T1, deleted_at: null }],
        units: [{ id: "unit-remote", scope_id: "p:local", name: "克", created_at: T0, updated_at: T1, deleted_at: null }],
        labels: [
          { id: "lab-remote", scope_id: "p:local", name: "家常", kind: "category", created_at: T0, updated_at: T1, deleted_at: null },
        ],
      }),
      db,
    );

    // 只剩一条活行，且是服务端那个 id
    expect(await db.select("SELECT id FROM ingredients WHERE deleted_at IS NULL")).toEqual([
      { id: "ing-remote" },
    ]);
    expect(await db.select("SELECT id FROM units WHERE deleted_at IS NULL")).toEqual([
      { id: "unit-remote" },
    ]);
    expect(await db.select("SELECT id FROM labels WHERE deleted_at IS NULL")).toEqual([
      { id: "lab-remote" },
    ]);
    // 引用改指到新的活行
    expect(
      await db.select("SELECT ingredient_id, unit_id FROM recipe_ingredients WHERE id = 'ri1'"),
    ).toEqual([{ ingredient_id: "ing-remote", unit_id: "unit-remote" }]);
    expect(await db.select("SELECT category_id FROM recipes WHERE id = 'r1'")).toEqual([
      { category_id: "lab-remote" },
    ]);
    // 本地那条软删的同名旧行仍是软删
    expect(await db.select("SELECT deleted_at FROM ingredients WHERE id = 'ing-gone'")).toEqual([
      { deleted_at: T0 },
    ]);
    expect(await db.select("SELECT deleted_at FROM labels WHERE id = 'lab-gone'")).toEqual([
      { deleted_at: T0 },
    ]);
  });

  it("子行引用的食材/单位 id 在同一批 remote.recipes 里也要 remap", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('lab-x','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('ing-x','p:local','盐',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('unit-x','p:local','克',?,?,NULL)",
      [T0, T0],
    );

    await applyRemoteChanges(
      remote({
        ingredients: [{ id: "ing-y", scope_id: "p:local", name: "盐", created_at: T0, updated_at: T0, deleted_at: null }],
        units: [{ id: "unit-y", scope_id: "p:local", name: "克", created_at: T0, updated_at: T0, deleted_at: null }],
        labels: [
          { id: "lab-y", scope_id: "p:local", name: "家常", kind: "category", created_at: T0, updated_at: T0, deleted_at: null },
        ],
        recipes: [
          recipe({
            id: "r2",
            category_id: "lab-x",
            label_ids: ["lab-x"],
            ingredients: [
              { id: "ri2", ingredient_id: "ing-x", amount: 2, unit_id: "unit-x", sort_order: 0 },
            ],
          }),
        ],
      }),
      db,
    );

    expect(await db.select("SELECT category_id FROM recipes WHERE id = 'r2'")).toEqual([
      { category_id: "lab-y" },
    ]);
    expect(await db.select("SELECT label_id FROM recipe_labels WHERE recipe_id = 'r2'")).toEqual([
      { label_id: "lab-y" },
    ]);
    expect(
      await db.select("SELECT ingredient_id, unit_id FROM recipe_ingredients WHERE recipe_id = 'r2'"),
    ).toEqual([{ ingredient_id: "ing-y", unit_id: "unit-y" }]);
  });

  it("远端复活本地已软删的同名行时，先并掉本地同名的活行（不撞唯一索引，回归 C1）", async () => {
    const { db } = await freshTestDb();
    // 本地历史：X 先建后软删，Y 是后来重建的同名活行。
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('ing-x','p:local','盐',?,?,?)",
      [T0, T0, T0],
    );
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('ing-y','p:local','盐',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('unit-x','p:local','克',?,?,?)",
      [T0, T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('unit-y','p:local','克',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('lab-x','p:local','家常','category',?,?,?)",
      [T0, T0, T0],
    );
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('lab-y','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,scope_id,name,cover_path,category_id,created_at,updated_at,deleted_at)
       VALUES ('r1','p:local','红烧肉',NULL,'lab-y',?,?,NULL)`,
      [T0, T0],
    );
    await db.execute("INSERT INTO recipe_labels (recipe_id,label_id) VALUES ('r1','lab-y')");
    await db.execute(
      `INSERT INTO recipe_ingredients
         (id,recipe_id,ingredient_id,amount,unit_id,sort_order,updated_at,deleted_at)
       VALUES ('ri1','r1','ing-y',1,'unit-y',0,?,NULL)`,
      [T0],
    );

    // 远端按 id 命中 X 并把它复活（updated_at 更新）。
    await expect(
      applyRemoteChanges(
        remote({
          ingredients: [{ id: "ing-x", scope_id: "p:local", name: "盐", created_at: T0, updated_at: T1, deleted_at: null }],
          units: [{ id: "unit-x", scope_id: "p:local", name: "克", created_at: T0, updated_at: T1, deleted_at: null }],
          labels: [{ id: "lab-x", scope_id: "p:local", name: "家常", kind: "category", created_at: T0, updated_at: T1, deleted_at: null }],
        }),
        db,
      ),
    ).resolves.toBeUndefined();

    // 每张表只剩一条活行，且是被复活的 X；同名的活行 Y 不残留。
    expect(await db.select("SELECT id FROM ingredients WHERE deleted_at IS NULL")).toEqual([
      { id: "ing-x" },
    ]);
    expect(await db.select("SELECT id FROM units WHERE deleted_at IS NULL")).toEqual([
      { id: "unit-x" },
    ]);
    expect(await db.select("SELECT id FROM labels WHERE deleted_at IS NULL")).toEqual([
      { id: "lab-x" },
    ]);
    expect(await db.select("SELECT id FROM ingredients WHERE id='ing-y'")).toEqual([]);
    expect(await db.select("SELECT id FROM units WHERE id='unit-y'")).toEqual([]);
    expect(await db.select("SELECT id FROM labels WHERE id='lab-y'")).toEqual([]);

    // 引用从 Y 改指到存活的 X。
    expect(
      await db.select("SELECT ingredient_id, unit_id FROM recipe_ingredients WHERE id='ri1'"),
    ).toEqual([{ ingredient_id: "ing-x", unit_id: "unit-x" }]);
    expect(await db.select("SELECT category_id FROM recipes WHERE id='r1'")).toEqual([
      { category_id: "lab-x" },
    ]);
    expect(await db.select("SELECT label_id FROM recipe_labels WHERE recipe_id='r1'")).toEqual([
      { label_id: "lab-x" },
    ]);
  });
});

describe("recipePayloadFor", () => {
  it("我推上去的菜谱载荷带 scope_id", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,scope_id,name,kind,created_at,updated_at,deleted_at) VALUES ('c1','p:local','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,scope_id,name,cover_path,category_id,owner_nickname,created_at,updated_at,deleted_at,owner_id)
       VALUES ('r1','t:t1','红烧肉',NULL,'c1','小明',?,?,NULL,'u1')`,
      [T0, T0],
    );

    const payload = await recipePayloadFor("r1", db);

    expect(payload?.scope_id).toBe("t:t1");
    expect(payload?.owner_nickname).toBe("小明");
  });
});

describe("字典合并时库存批次跟着重指", () => {
  /** 本地先有一条引用旧 id 的批次，合并后它必须指向合并后的 id，否则库存静默消失 */
  async function seed(db: Db): Promise<void> {
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('ing-old','p:local','盐',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('unit-old','p:local','克',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO inventory_batches
         (id, scope_id, ingredient_id, amount, unit_id, produced_at, shelf_life_days, expires_at,
          created_at, updated_at, deleted_at)
       VALUES ('b1','p:local','ing-old',100,'unit-old',NULL,NULL,NULL,?,?,NULL)`,
      [T0, T0],
    );
  }

  it("食材与单位合并后批次指向合并后的 id", async () => {
    const { db } = await freshTestDb();
    await seed(db);

    await applyRemoteChanges(
      remote({
        ingredients: [{ id: "ing-new", scope_id: "p:local", name: "盐", created_at: T0, updated_at: T0, deleted_at: null }],
        units: [{ id: "unit-new", scope_id: "p:local", name: "克", created_at: T0, updated_at: T0, deleted_at: null }],
      }),
      db,
    );

    expect(await db.select("SELECT ingredient_id, unit_id FROM inventory_batches WHERE id = 'b1'"))
      .toEqual([{ ingredient_id: "ing-new", unit_id: "unit-new" }]);
    expect(await db.select("SELECT id FROM ingredients")).toEqual([{ id: "ing-new" }]);
    expect(await db.select("SELECT id FROM units")).toEqual([{ id: "unit-new" }]);
  });
});

// --- 库存进同步（Task 11） ---

function batch(over: Partial<InventoryBatch> & { id: string }): InventoryBatch {
  return {
    scope_id: "p:local",
    owner_id: "u1",
    ingredient_id: "i1",
    amount: 100,
    unit_id: null,
    produced_at: null,
    shelf_life_days: null,
    expires_at: null,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    ...over,
  };
}

function usage(over: Partial<InventoryUsage> & { id: string }): InventoryUsage {
  return {
    scope_id: "p:local",
    owner_id: "u1",
    recipe_id: "r1",
    batch_id: "b1",
    amount: 10,
    used_at: T0,
    updated_at: T0,
    deleted_at: null,
    ...over,
  };
}

describe("applyRemoteChanges：库存", () => {
  it("批次按 LWW：旧的不覆盖新的，软删墓碑落库", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('i1','p:local','鸡蛋',?,?,NULL)",
      [T0, T0],
    );

    await applyRemoteChanges(remote({ inventory_batches: [batch({ id: "b1", amount: 500 })] }), db);
    await applyRemoteChanges(
      remote({ inventory_batches: [batch({ id: "b1", amount: 300, updated_at: T1 })] }),
      db,
    );
    // 更旧的一次推送不得回滚
    await applyRemoteChanges(
      remote({ inventory_batches: [batch({ id: "b1", amount: 999, updated_at: T0 })] }),
      db,
    );
    expect(await db.select("SELECT amount FROM inventory_batches WHERE id = 'b1'")).toEqual([
      { amount: 300 },
    ]);

    // 软删墓碑（时间更新才生效）
    const T2 = "2026-01-03T00:00:00.000Z";
    await applyRemoteChanges(
      remote({
        inventory_batches: [batch({ id: "b1", amount: 300, updated_at: T2, deleted_at: T2 })],
      }),
      db,
    );
    expect(
      await db.select("SELECT deleted_at FROM inventory_batches WHERE id = 'b1'"),
    ).toEqual([{ deleted_at: T2 }]);
  });

  it("使用记录 INSERT OR IGNORE：同 id 推两次只一行", async () => {
    const { db } = await freshTestDb();
    const row = usage({ id: "us1" });

    await applyRemoteChanges(remote({ inventory_usages: [row] }), db);
    await applyRemoteChanges(remote({ inventory_usages: [row] }), db);

    expect(await db.select("SELECT count(*) AS n FROM inventory_usages")).toEqual([{ n: 1 }]);
    // 使用记录不参与 LWW：远端再来一条同 id 也改不动它
    await applyRemoteChanges(
      remote({ inventory_usages: [usage({ id: "us1", amount: 99, updated_at: T1 })] }),
      db,
    );
    expect(await db.select("SELECT amount FROM inventory_usages WHERE id = 'us1'")).toEqual([
      { amount: 10 },
    ]);
  });

  it("字典同名合并不跨范围：p:a 与 p:b 各一个「生抽」都保留", async () => {
    const { db } = await freshTestDb();

    await applyRemoteChanges(
      remote({
        ingredients: [
          { id: "i-a", scope_id: "p:a", name: "生抽", created_at: T0, updated_at: T0, deleted_at: null },
        ],
      }),
      db,
    );
    await applyRemoteChanges(
      remote({
        ingredients: [
          { id: "i-b", scope_id: "p:b", name: "生抽", created_at: T0, updated_at: T0, deleted_at: null },
        ],
      }),
      db,
    );

    expect(
      await db.select("SELECT id FROM ingredients WHERE name = '生抽' ORDER BY id"),
    ).toEqual([{ id: "i-a" }, { id: "i-b" }]);
  });

  it("字典同名合并把本地批次的 ingredient_id 与 unit_id 改指到存活的行", async () => {
    const { db } = await freshTestDb();
    // 本地已有「生抽」i-old / 「勺」u-old，以及一条引用它们的批次
    await db.execute(
      "INSERT INTO ingredients (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('i-old','p:local','生抽',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,scope_id,name,created_at,updated_at,deleted_at) VALUES ('u-old','p:local','勺',?,?,NULL)",
      [T0, T0],
    );
    await applyRemoteChanges(
      remote({
        inventory_batches: [
          batch({ id: "b1", ingredient_id: "i-old", unit_id: "u-old" }),
        ],
      }),
      db,
    );

    // 同步推来了同范围同名的 i-new / u-new：本地那两条被并掉，批次引用必须跟着改指
    await applyRemoteChanges(
      remote({
        ingredients: [
          { id: "i-new", scope_id: "p:local", name: "生抽", created_at: T0, updated_at: T1, deleted_at: null },
        ],
        units: [
          { id: "u-new", scope_id: "p:local", name: "勺", created_at: T0, updated_at: T1, deleted_at: null },
        ],
      }),
      db,
    );

    expect(
      await db.select("SELECT ingredient_id, unit_id FROM inventory_batches WHERE id = 'b1'"),
    ).toEqual([{ ingredient_id: "i-new", unit_id: "u-new" }]);
  });
});
