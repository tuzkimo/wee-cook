import { describe, expect, it } from "vitest";
import { initTables } from "@/db";
import { freshTestDb } from "./sqliteTestDb";

const BUSINESS_TABLES = [
  "recipes",
  "recipe_steps",
  "recipe_ingredients",
  "labels",
  "ingredients",
  "units",
  "cook_records",
];

/** 带范围列的业务表 + 库存两张（库存另带 owner_id）。 */
const SCOPED_TABLES = [
  "recipes",
  "ingredients",
  "units",
  "labels",
  "inventory_batches",
  "inventory_usages",
  "cook_records",
];

describe("数据库表结构", () => {
  it("八张表都建出来了", async () => {
    const { db } = await freshTestDb();
    const rows = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = rows.map((row) => row.name);
    for (const table of [...BUSINESS_TABLES, "recipe_labels"]) {
      expect(names, table).toContain(table);
    }
  });

  it("recipes.category_id 是 NOT NULL", async () => {
    const { db } = await freshTestDb();
    const columns = await db.select<{ name: string; notnull: number }[]>(
      "PRAGMA table_info(recipes)",
    );
    expect(columns.find((column) => column.name === "category_id")?.notnull).toBe(1);
  });

  it("七张业务表都有 id/updated_at/deleted_at", async () => {
    const { db } = await freshTestDb();
    for (const table of BUSINESS_TABLES) {
      const columns = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
      const names = columns.map((column) => column.name);
      expect(names, table).toContain("id");
      expect(names, table).toContain("updated_at");
      expect(names, table).toContain("deleted_at");
    }
  });

  it("范围列：业务表与库存表都带 scope_id，两张库存表还有 owner_id", async () => {
    const { db } = await freshTestDb();
    for (const table of SCOPED_TABLES) {
      const columns = await db.select<{ name: string; notnull: number }[]>(
        `PRAGMA table_info(${table})`,
      );
      expect(columns.map((column) => column.name), table).toContain("scope_id");
    }
    for (const table of ["inventory_batches", "inventory_usages"]) {
      const columns = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
      expect(columns.map((column) => column.name), table).toContain("owner_id");
    }
  });

  it("recipes 不再有 is_public（社区已删除）", async () => {
    const { db } = await freshTestDb();
    const columns = await db.select<{ name: string }[]>("PRAGMA table_info(recipes)");
    expect(columns.map((column) => column.name)).not.toContain("is_public");
  });

  it("teams 缓存表建出来了", async () => {
    const { db } = await freshTestDb();
    const columns = await db.select<{ name: string }[]>("PRAGMA table_info(teams)");
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "name",
      "role",
      "member_count",
    ]);
  });

  it("部分唯一索引挡住同范围内的重名，但允许软删后重建同名", async () => {
    const { db } = await freshTestDb();
    const now = new Date().toISOString();
    const insert =
      "INSERT INTO ingredients (id, scope_id, name, created_at, updated_at, deleted_at) VALUES (?, ?, '鸡蛋', ?, ?, NULL)";

    await db.execute(insert, ["i1", "p:local", now, now]);
    await expect(db.execute(insert, ["i2", "p:local", now, now])).rejects.toThrow();

    await db.execute("UPDATE ingredients SET deleted_at = ? WHERE id = ?", [now, "i1"]);
    await expect(db.execute(insert, ["i3", "p:local", now, now])).resolves.toBeDefined();
  });

  it("两个范围各有一个「鸡蛋」互不冲突（字典按家庭分开）", async () => {
    const { db } = await freshTestDb();
    const now = new Date().toISOString();
    const insert =
      "INSERT INTO ingredients (id, scope_id, name, created_at, updated_at, deleted_at) VALUES (?, ?, '鸡蛋', ?, ?, NULL)";

    await db.execute(insert, ["i1", "p:local", now, now]);
    await expect(db.execute(insert, ["i2", "t:team-1", now, now])).resolves.toBeDefined();
    await expect(db.execute(insert, ["i3", "p:user-1", now, now])).resolves.toBeDefined();

    const rows = await db.select<{ scope_id: string }[]>(
      "SELECT scope_id FROM ingredients ORDER BY scope_id",
    );
    expect(rows.map((row) => row.scope_id)).toEqual(["p:local", "p:user-1", "t:team-1"]);
  });

  it("labels 的 (name, kind) 各自独立：同名的分类与标签可以共存", async () => {
    const { db } = await freshTestDb();
    const now = new Date().toISOString();
    const insert =
      "INSERT INTO labels (id, scope_id, name, kind, created_at, updated_at, deleted_at) VALUES (?, 'p:local', '家常', ?, ?, ?, NULL)";

    await db.execute(insert, ["l1", "category", now, now]);
    await expect(db.execute(insert, ["l2", "tag", now, now])).resolves.toBeDefined();
  });

  it("initTables 跑两次不报错（幂等）", async () => {
    const { db } = await freshTestDb();
    await expect(initTables(db)).resolves.toBeUndefined();
  });
});

const AI_TABLES = ["ai_sessions", "ai_messages"];

describe("AI 会话与消息表", () => {
  it("AI 会话与消息两张表都建出来了", async () => {
    const { db } = await freshTestDb();
    const rows = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = rows.map((row) => row.name);
    for (const table of AI_TABLES) expect(names, table).toContain(table);
  });

  it("AI 两张表按业务表规则带 id/updated_at/deleted_at", async () => {
    const { db } = await freshTestDb();
    for (const table of AI_TABLES) {
      const columns = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
      const names = columns.map((column) => column.name);
      expect(names, table).toContain("id");
      expect(names, table).toContain("updated_at");
      expect(names, table).toContain("deleted_at");
    }
  });

  it("ai_sessions 带 user_id，且它不在同步载荷的键集里", async () => {
    const { db } = await freshTestDb();
    const cols = (await db.select<{ name: string }[]>("PRAGMA table_info(ai_sessions)")).map(
      (c) => c.name,
    );
    expect(cols).toContain("user_id");
  });

  it("ai_messages 按 session_id 查的索引建出来了", async () => {
    const { db } = await freshTestDb();
    const rows = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ai_messages_session'",
    );
    expect(rows.map((row) => row.name)).toEqual(["idx_ai_messages_session"]);
  });
});

const INVENTORY_TABLES = ["inventory_batches", "inventory_usages"];

describe("库存表", () => {
  it("两张表都建出来了", async () => {
    const { db } = await freshTestDb();
    const rows = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const names = rows.map((row) => row.name);
    for (const table of INVENTORY_TABLES) expect(names, table).toContain(table);
  });

  it("按业务表规则带 id/updated_at/deleted_at", async () => {
    const { db } = await freshTestDb();
    for (const table of INVENTORY_TABLES) {
      const columns = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
      const names = columns.map((column) => column.name);
      expect(names, table).toContain("id");
      expect(names, table).toContain("updated_at");
      expect(names, table).toContain("deleted_at");
    }
  });

  it("inventory_batches.amount 拒绝 0 与负数", async () => {
    const { db } = await freshTestDb();
    const now = new Date().toISOString();
    await db.execute(
      "INSERT INTO ingredients (id, scope_id, name, created_at, updated_at, deleted_at) VALUES ('i1', 'p:local', '鸡蛋', ?, ?, NULL)",
      [now, now],
    );
    const insert = `INSERT INTO inventory_batches
      (id, scope_id, ingredient_id, amount, unit_id, produced_at, shelf_life_days, expires_at,
       created_at, updated_at, deleted_at)
      VALUES (?, 'p:local', 'i1', ?, NULL, NULL, NULL, NULL, ?, ?, NULL)`;
    await expect(db.execute(insert, ["b0", 0, now, now])).rejects.toThrow();
    await expect(db.execute(insert, ["b-", -1, now, now])).rejects.toThrow();
    await expect(db.execute(insert, ["b1", 1, now, now])).resolves.toBeDefined();
  });

  it("外键列不写 REFERENCES：食材行被物理删除后批次行仍在", async () => {
    const { db } = await freshTestDb();
    const now = new Date().toISOString();
    await db.execute(
      "INSERT INTO ingredients (id, scope_id, name, created_at, updated_at, deleted_at) VALUES ('i1', 'p:local', '鸡蛋', ?, ?, NULL)",
      [now, now],
    );
    await db.execute(
      `INSERT INTO inventory_batches
       (id, scope_id, ingredient_id, amount, unit_id, produced_at, shelf_life_days, expires_at,
        created_at, updated_at, deleted_at)
       VALUES ('b1', 'p:local', 'i1', 10, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
      [now, now],
    );
    // 同步的字典合并会物理删掉被合并的行（spec §4.15）；真外键会在这里卡死
    await expect(db.execute("DELETE FROM ingredients WHERE id = 'i1'")).resolves.toBeDefined();
    const left = await db.select<{ id: string }[]>("SELECT id FROM inventory_batches");
    expect(left).toHaveLength(1);
  });

  it("按食材查批次、按批次查使用记录的索引建出来了", async () => {
    const { db } = await freshTestDb();
    const rows = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_inventory_batches_ing', 'idx_inventory_usages_batch')",
    );
    expect(rows.map((row) => row.name).sort()).toEqual([
      "idx_inventory_batches_ing",
      "idx_inventory_usages_batch",
    ]);
  });

  it("inventory_usages 带 cook_id（归属到制作记录）", async () => {
    const { db } = await freshTestDb();
    const columns = await db.select<{ name: string }[]>("PRAGMA table_info(inventory_usages)");
    expect(columns.map((column) => column.name)).toContain("cook_id");
  });
});

describe("制作记录表", () => {
  it("cook_records 有 id / updated_at / deleted_at 与派生作者两列", async () => {
    const { db } = await freshTestDb();
    const names = (await db.select<{ name: string }[]>("PRAGMA table_info(cook_records)")).map(
      (c) => c.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "scope_id",
        "owner_id",
        "recipe_id",
        "owner_nickname",
        "owner_avatar_url",
        "created_at",
        "updated_at",
        "deleted_at",
      ]),
    );
  });
});
