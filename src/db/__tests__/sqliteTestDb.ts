import { DatabaseSync } from "node:sqlite";
import { initTables, type Db } from "@/db";

/** 把 node:sqlite 的 DatabaseSync 包成 @tauri-apps/plugin-sql 的 Db 形状，测试跑真 SQL。 */
function wrap(raw: DatabaseSync): Db {
  return {
    // async 是为了让同步抛出的 SQL 错误变成 rejected promise
    select: async <T>(sql: string, params: unknown[] = []): Promise<T> =>
      raw.prepare(sql).all(...(params as never[])) as T,
    execute: async (sql: string, params: unknown[] = []): Promise<unknown> =>
      raw.prepare(sql).run(...(params as never[])),
  };
}

export function makeTestDb(): { db: Db; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  return { db: wrap(raw), raw };
}

/** 已跑过 initTables 的测试库 */
export async function freshTestDb(): Promise<{ db: Db; raw: DatabaseSync }> {
  const { db, raw } = makeTestDb();
  await initTables(db);
  return { db, raw };
}
