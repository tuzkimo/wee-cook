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

// 规格 §7.1 DDL。逐字照抄，不在这里拼字符串。
// scope_id 是范围键：'p:<uid>' 个人 / 't:<teamId>' 团队 / 'p:local' 未登录。
const DDL = [
  `CREATE TABLE IF NOT EXISTS recipes (
    id           TEXT PRIMARY KEY,
    scope_id     TEXT NOT NULL,
    name         TEXT NOT NULL,
    cover_path   TEXT,
    category_id  TEXT NOT NULL REFERENCES labels(id),
    owner_nickname TEXT,
    owner_avatar_url TEXT,
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
    scope_id    TEXT NOT NULL,
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
    scope_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS units (
    id          TEXT PRIMARY KEY,
    scope_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS uploaded_files (
    name        TEXT PRIMARY KEY,
    uploaded_at TEXT NOT NULL
  )`,
  // 团队列表缓存：GET /teams 的全量快照。不是业务实体（团队不进同步载荷），
  // 登录整表替换、登出清空，所以不带 updated_at / deleted_at（spec §13 的确认例外）。
  `CREATE TABLE IF NOT EXISTS teams (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    role         TEXT NOT NULL,
    member_count INTEGER NOT NULL DEFAULT 0
  )`,
  // AI 会话与消息永不参与同步（规格 §4.5）：对话含用户的厨房情况与截图，没有理由送上服务器。
  // 带 id/updated_at/deleted_at 是按 AGENTS.md 的业务表规则；同步载荷逐表列举，不会带上它们。
  `CREATE TABLE IF NOT EXISTS ai_sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_messages (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES ai_sessions(id),
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    payload         TEXT,
    prompt_version  TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    deleted_at      TEXT
  )`,
  // 库存跟着同步走（spec §8.1）。三个业务外键刻意不写 REFERENCES ——
  // 同步的字典合并会物理 DELETE 那些行，真外键换来的只有同步卡死（spec §4.15）。
  // owner_id 是录入者（不展示，只用来推「我的批次」）。
  `CREATE TABLE IF NOT EXISTS inventory_batches (
    id              TEXT PRIMARY KEY,
    scope_id        TEXT NOT NULL,
    owner_id        TEXT,
    ingredient_id   TEXT NOT NULL,
    amount          REAL NOT NULL CHECK (amount > 0),
    unit_id         TEXT,
    produced_at     TEXT,
    shelf_life_days INTEGER,
    expires_at      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    deleted_at      TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS inventory_usages (
    id          TEXT PRIMARY KEY,
    scope_id    TEXT NOT NULL,
    owner_id    TEXT,
    cook_id     TEXT,
    recipe_id   TEXT NOT NULL,
    batch_id    TEXT NOT NULL,
    amount      REAL NOT NULL CHECK (amount > 0),
    used_at     TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,
  // 一次制作一条记录，使用记录用 cook_id 归到它下面（spec §4.1）。
  // 两列作者由服务端 JOIN users 派生，本机新建时为 NULL（与 recipes 同构）。
  `CREATE TABLE IF NOT EXISTS cook_records (
    id               TEXT PRIMARY KEY,
    scope_id         TEXT NOT NULL,
    owner_id         TEXT,
    recipe_id        TEXT NOT NULL,
    owner_nickname   TEXT,
    owner_avatar_url TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    deleted_at       TEXT
  )`,
];

// 索引必须等表结构演进完再建：老库的 recipes 没有 scope_id 时，
// CREATE INDEX ... ON recipes(scope_id) 会直接 no such column。
const DDL_INDEXES = [
  // 字典的唯一键带范围：两个家庭各有一个「生抽」互不影响
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_scope_name_kind ON labels(scope_id, name, kind) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredients_scope_name ON ingredients(scope_id, name)  WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_units_scope_name       ON units(scope_id, name)        WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_recipes_scope                 ON recipes(scope_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_steps_recipe      ON recipe_steps(recipe_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_ing   ON recipe_ingredients(ingredient_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_unit  ON recipe_ingredients(unit_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recipe_labels_label      ON recipe_labels(label_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_batches_scope ON inventory_batches(scope_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_usages_scope  ON inventory_usages(scope_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_batches_ing  ON inventory_batches(ingredient_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_usages_batch ON inventory_usages(batch_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cook_records_scope  ON cook_records(scope_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cook_records_recipe ON cook_records(recipe_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_inventory_usages_cook ON inventory_usages(cook_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id)`,
];

/** 真 DDL 的唯一来源，测试直接调它。 */
export async function initTables(db: Db): Promise<void> {
  for (const sql of DDL) await db.execute(sql);
  await migrateTables(db);
  for (const sql of DDL_INDEXES) await db.execute(sql);
}

/** 表结构演进。每步先查 PRAGMA 再 ALTER：ALTER ADD COLUMN 重复执行会报错，不能用异常兜底。 */
async function migrateTables(db: Db): Promise<void> {
  const cols = await db.select<{ name: string }[]>("PRAGMA table_info(recipes)");
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("owner_id")) await db.execute("ALTER TABLE recipes ADD COLUMN owner_id TEXT");
  // 社区已删除：旧库里的 is_public 一并清掉，免得同步还在读它
  if (names.has("is_public")) await db.execute("ALTER TABLE recipes DROP COLUMN is_public");
  if (!names.has("owner_nickname"))
    await db.execute("ALTER TABLE recipes ADD COLUMN owner_nickname TEXT");
  if (!names.has("owner_avatar_url"))
    await db.execute("ALTER TABLE recipes ADD COLUMN owner_avatar_url TEXT");
  // 旧库（未发布的团队版）留下的列：SQLite 3.35+ 支持 DROP COLUMN，两个运行时都够新
  if (names.has("team_id")) await db.execute("ALTER TABLE recipes DROP COLUMN team_id");

  // 老库的存量数据都在「未登录」范围里：补列时给默认值，登录后由认领整批改写（spec §11.5）。
  for (const table of ["recipes", "ingredients", "units", "labels"]) {
    await addColumnIfMissing(db, table, "scope_id", "TEXT NOT NULL DEFAULT 'p:local'");
  }
  for (const table of ["inventory_batches", "inventory_usages"]) {
    await addColumnIfMissing(db, table, "scope_id", "TEXT NOT NULL DEFAULT 'p:local'");
    await addColumnIfMissing(db, table, "owner_id", "TEXT");
  }
  // 老使用记录没有制作记录可归：留 NULL，照旧参与余量计算，但不出现在历史里。
  await addColumnIfMissing(db, "inventory_usages", "cook_id", "TEXT");

  // 老库的 AI 会话没有归属：user_id 为 NULL ⇒ 永不匹配任何账号、不再显示。
  // 不删它们：没人知道这些会话属于谁。
  const sessionCols = await db.select<{ name: string }[]>("PRAGMA table_info(ai_sessions)");
  if (!sessionCols.some((c) => c.name === "user_id")) {
    await db.execute("ALTER TABLE ai_sessions ADD COLUMN user_id TEXT");
  }
}

/** 只在缺列时 ALTER：ALTER ADD COLUMN 重复执行会报错，不能靠异常兜底。 */
async function addColumnIfMissing(
  db: Db,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const cols = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export async function initDb(): Promise<void> {
  const conn = await Database.load("sqlite:weecook.db");
  setDb(conn);
  await initTables(conn);
}
