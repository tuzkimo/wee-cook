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
    expect(names).toContain("team_id");
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
});
