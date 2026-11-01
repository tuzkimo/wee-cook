import { describe, expect, it } from "vitest";
import { initTables } from "@/db";
import { makeTestDb } from "./sqliteTestDb";

describe("数据库迁移", () => {
  it("recipes 加上了归属两列", async () => {
    const { db } = await makeTestDb();
    await initTables(db);
    const cols = await db.select<{ name: string }[]>("PRAGMA table_info(recipes)");
    const names = cols.map((c) => c.name);
    expect(names).toContain("owner_id");
    // 团队已下线：迁移不再给 recipes 加 team_id（已有旧库的列由 Task 2 的 DROP COLUMN 清掉）
    expect(names).not.toContain("team_id");
  });

  it("uploaded_files 建出来了", async () => {
    const { db } = await makeTestDb();
    await initTables(db);
    const cols = await db.select<{ name: string }[]>("PRAGMA table_info(uploaded_files)");
    expect(cols.map((c) => c.name)).toEqual(["name", "uploaded_at"]);
  });

  it("重复执行不会因为列已存在而报错", async () => {
    const { db } = await makeTestDb();
    await initTables(db);
    await expect(initTables(db)).resolves.toBeUndefined();
  });

  it("旧库升级后 recipes 补上 owner_nickname / owner_avatar_url / scope_id，且不带 is_public", async () => {
    const { db } = await makeTestDb();
    await db.execute(
      `CREATE TABLE recipes (id TEXT PRIMARY KEY, name TEXT NOT NULL, cover_path TEXT,
        category_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`,
    );
    await initTables(db);
    const names = (await db.select<{ name: string }[]>("PRAGMA table_info(recipes)")).map(
      (column) => column.name,
    );
    expect(names).toContain("owner_nickname");
    expect(names).toContain("owner_avatar_url");
    expect(names).toContain("scope_id");
    expect(names).not.toContain("is_public");
  });

  it("老库没有 scope_id 时补成 p:local（存量数据仍在游客范围里）", async () => {
    const { db } = await makeTestDb();
    await db.execute(
      `CREATE TABLE recipes (id TEXT PRIMARY KEY, name TEXT, cover_path TEXT,
        category_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`,
    );
    await db.execute(
      `INSERT INTO recipes (id, name, category_id, created_at, updated_at)
       VALUES ('r1', '红烧肉', 'c1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    await initTables(db);
    const rows = await db.select<{ id: string; scope_id: string }[]>(
      "SELECT id, scope_id FROM recipes",
    );
    expect(rows).toEqual([{ id: "r1", scope_id: "p:local" }]);
  });

  it("旧库升级后 team_id 列被删掉", async () => {
    const { db } = await makeTestDb();
    await db.execute(
      `CREATE TABLE recipes (id TEXT PRIMARY KEY, name TEXT NOT NULL, cover_path TEXT,
        category_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
        owner_id TEXT, team_id TEXT)`,
    );
    await initTables(db);
    const names = (await db.select<{ name: string }[]>("PRAGMA table_info(recipes)")).map(
      (column) => column.name,
    );
    expect(names).not.toContain("team_id");
  });

  it("favorite_recipes 与 local_accounts 不再建（社区已删除）", async () => {
    const { db } = await makeTestDb();
    await initTables(db);
    const names = (
      await db.select<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((row) => row.name);
    expect(names).not.toContain("favorite_recipes");
    expect(names).not.toContain("local_accounts");
  });

  it("老库的 ai_sessions 没有 user_id 时，initTables 会补上且可重复执行", async () => {
    const { db } = await makeTestDb();
    // 裸连接建旧结构的 ai_sessions：老库里的会话没有归属
    await db.execute(
      `CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, deleted_at TEXT)`,
    );
    await initTables(db);
    await expect(initTables(db)).resolves.toBeUndefined();
    const names = (await db.select<{ name: string }[]>("PRAGMA table_info(ai_sessions)")).map(
      (column) => column.name,
    );
    expect(names).toContain("user_id");
  });

  it("迁移不丢存量数据", async () => {
    const { db } = await makeTestDb();
    // 先建旧结构（只有 recipes 的旧列），插一行，再跑 initTables
    await db.execute(
      `CREATE TABLE recipes (id TEXT PRIMARY KEY, name TEXT NOT NULL, cover_path TEXT,
        category_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`,
    );
    await db.execute(
      `INSERT INTO recipes (id, name, category_id, created_at, updated_at)
       VALUES ('r1', '红烧肉', 'c1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    await initTables(db);
    const rows = await db.select<{ id: string; owner_id: string | null }[]>(
      "SELECT id, owner_id FROM recipes",
    );
    expect(rows).toEqual([{ id: "r1", owner_id: null }]);
  });

  it("旧库升级后 inventory_usages 补上 cook_id，老使用记录留 NULL", async () => {
    const { db } = await makeTestDb();
    await db.execute(
      `CREATE TABLE inventory_usages (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, owner_id TEXT,
       recipe_id TEXT NOT NULL, batch_id TEXT NOT NULL, amount REAL NOT NULL, used_at TEXT NOT NULL,
       updated_at TEXT NOT NULL, deleted_at TEXT)`,
    );
    await db.execute(
      `INSERT INTO inventory_usages (id, scope_id, owner_id, recipe_id, batch_id, amount, used_at, updated_at)
       VALUES ('us1','p:local',NULL,'r1','b1',10,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
    );
    await initTables(db);
    expect(await db.select("SELECT cook_id FROM inventory_usages WHERE id = 'us1'")).toEqual([
      { cook_id: null },
    ]);
  });
});
