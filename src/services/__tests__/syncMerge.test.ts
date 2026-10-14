import { describe, expect, it } from "vitest";
import { type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import {
  applyRemoteChanges,
  compareTimestamp,
  emptyPayload,
  type RecipePayload,
  type SyncPayload,
} from "@/services/sync";

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
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    owner_id: null,
    team_id: null,
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
      "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('u1','克',?,?,NULL)",
      [T0, T0],
    );

    await applyRemoteChanges(
      remote({
        units: [{ id: "u1", name: "毫升", created_at: T0, updated_at: T1, deleted_at: null }],
      }),
      db,
    );

    const rows = await db.select<{ name: string }[]>("SELECT name FROM units WHERE id = 'u1'");
    expect(rows).toEqual([{ name: "毫升" }]);
  });

  it("远端更旧的行被跳过，本地不被回滚", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('u1','克',?,?,NULL)",
      [T0, T1],
    );

    await applyRemoteChanges(
      remote({
        units: [{ id: "u1", name: "毫升", created_at: T0, updated_at: T0, deleted_at: null }],
      }),
      db,
    );

    const rows = await db.select<{ name: string }[]>("SELECT name FROM units WHERE id = 'u1'");
    expect(rows).toEqual([{ name: "克" }]);
  });

  it("相同 updated_at 时不重复写（幂等）", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('u1','克',?,?,NULL)",
      [T0, T0],
    );
    const counted = countingDb(db);

    await applyRemoteChanges(
      remote({
        units: [{ id: "u1", name: "克", created_at: T0, updated_at: T0, deleted_at: null }],
      }),
      counted.db,
    );

    expect(counted.writes).toEqual([]);
  });

  it("同名字典行合并：本地已有同名 X，收到 Y → 引用改指 Y 并删掉 X", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('lab-x','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('tag-x','快手','tag',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO ingredients (id,name,created_at,updated_at,deleted_at) VALUES ('ing-x','盐',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('unit-x','克',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,name,cover_path,category_id,created_at,updated_at,deleted_at)
       VALUES ('r1','红烧肉',NULL,'lab-x',?,?,NULL)`,
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
          { id: "lab-y", name: "家常", kind: "category", created_at: T0, updated_at: T0, deleted_at: null },
          { id: "tag-y", name: "快手", kind: "tag", created_at: T0, updated_at: T0, deleted_at: null },
        ],
        ingredients: [{ id: "ing-y", name: "盐", created_at: T0, updated_at: T0, deleted_at: null }],
        units: [{ id: "unit-y", name: "克", created_at: T0, updated_at: T0, deleted_at: null }],
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
      "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('x','辣','tag',?,?,NULL)",
      [T0, T0],
    );

    await applyRemoteChanges(
      remote({
        labels: [
          { id: "y", name: "辣", kind: "category", created_at: T0, updated_at: T0, deleted_at: null },
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

  it("菜谱的子行整组替换：远端步骤里没有的旧步骤本地必须消失", async () => {
    const { db } = await freshTestDb();
    await db.execute(
      "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('c1','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,name,cover_path,category_id,created_at,updated_at,deleted_at)
       VALUES ('r1','旧菜',NULL,'c1',?,?,NULL)`,
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
      "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('c1','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,name,cover_path,category_id,created_at,updated_at,deleted_at)
       VALUES ('r1','要删的菜',NULL,'c1',?,?,NULL)`,
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
      "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('u1','旧',?,?,NULL)",
      [T0, T0],
    );
    await applyRemoteChanges(
      remote({
        units: [
          { id: "u1", name: "新", created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:01", deleted_at: null },
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
      "INSERT INTO ingredients (id,name,created_at,updated_at,deleted_at) VALUES ('ing-gone','盐',?,?,?)",
      [T0, T0, T0],
    );
    await db.execute(
      "INSERT INTO ingredients (id,name,created_at,updated_at,deleted_at) VALUES ('ing-live','盐',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('unit-gone','克',?,?,?)",
      [T0, T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('unit-live','克',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('lab-gone','家常','category',?,?,?)",
      [T0, T0, T0],
    );
    await db.execute(
      "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('lab-live','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      `INSERT INTO recipes (id,name,cover_path,category_id,created_at,updated_at,deleted_at)
       VALUES ('r1','红烧肉',NULL,'lab-live',?,?,NULL)`,
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
        ingredients: [{ id: "ing-remote", name: "盐", created_at: T0, updated_at: T1, deleted_at: null }],
        units: [{ id: "unit-remote", name: "克", created_at: T0, updated_at: T1, deleted_at: null }],
        labels: [
          { id: "lab-remote", name: "家常", kind: "category", created_at: T0, updated_at: T1, deleted_at: null },
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
      "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('lab-x','家常','category',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO ingredients (id,name,created_at,updated_at,deleted_at) VALUES ('ing-x','盐',?,?,NULL)",
      [T0, T0],
    );
    await db.execute(
      "INSERT INTO units (id,name,created_at,updated_at,deleted_at) VALUES ('unit-x','克',?,?,NULL)",
      [T0, T0],
    );

    await applyRemoteChanges(
      remote({
        ingredients: [{ id: "ing-y", name: "盐", created_at: T0, updated_at: T0, deleted_at: null }],
        units: [{ id: "unit-y", name: "克", created_at: T0, updated_at: T0, deleted_at: null }],
        labels: [
          { id: "lab-y", name: "家常", kind: "category", created_at: T0, updated_at: T0, deleted_at: null },
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
});
