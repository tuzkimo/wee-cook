// 启动时在 mount 之前 await initDb()：首屏组件一挂载就会查库，
// 连接没就绪会白屏或报「数据库未打开」。
import Database from "@tauri-apps/plugin-sql";

export interface Db {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  select<T>(sql: string, params?: unknown[]): Promise<T>;
}

let db: Db | null = null;

export function setDb(next: Db | null): void {
  db = next;
}

export function getDb(): Db {
  if (!db) throw new Error("数据库未打开");
  return db;
}

// 规格 §4 DDL：七张表 + 七个索引，外加同步用的 uploaded_files。逐字照抄，不在这里拼字符串。
const DDL = [
  `CREATE TABLE IF NOT EXISTS recipes (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    cover_path   TEXT,
    category_id  TEXT NOT NULL REFERENCES labels(id),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    deleted_at   TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_steps (
    id          TEXT PRIMARY KEY,
    recipe_id   TEXT NOT NULL REFERENCES recipes(id),
    sort_order  INTEGER NOT NULL,
    text        TEXT NOT NULL,
    image_path  TEXT,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id             TEXT PRIMARY KEY,
    recipe_id      TEXT NOT NULL REFERENCES recipes(id),
    ingredient_id  TEXT NOT NULL REFERENCES ingredients(id),
    amount         REAL,
    unit_id        TEXT REFERENCES units(id),
    sort_order     INTEGER NOT NULL,
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS labels (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS recipe_labels (
    recipe_id  TEXT NOT NULL REFERENCES recipes(id),
    label_id   TEXT NOT NULL REFERENCES labels(id),
    PRIMARY KEY (recipe_id, label_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ingredients (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS units (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS uploaded_files (
    name        TEXT PRIMARY KEY,
    uploaded_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_name_kind  ON labels(name, kind) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredients_name  ON ingredients(name)  WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_units_name        ON units(name)        WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_steps_recipe      ON recipe_steps(recipe_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_ing   ON recipe_ingredients(ingredient_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_unit  ON recipe_ingredients(unit_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_labels_label      ON recipe_labels(label_id)`,
];

/** 真 DDL 的唯一来源，测试直接调它。 */
export async function initTables(db: Db): Promise<void> {
  for (const sql of DDL) await db.execute(sql);
  await migrateTables(db);
}

/** 表结构演进。每步先查 PRAGMA 再 ALTER：ALTER ADD COLUMN 重复执行会报错，不能用异常兜底。 */
async function migrateTables(db: Db): Promise<void> {
  const cols = await db.select<{ name: string }[]>("PRAGMA table_info(recipes)");
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("owner_id")) await db.execute("ALTER TABLE recipes ADD COLUMN owner_id TEXT");
}

export async function initDb(): Promise<void> {
  const conn = await Database.load("sqlite:weecook.db");
  setDb(conn);
  await initTables(conn);
}
