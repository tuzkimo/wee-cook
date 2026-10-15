// Task 4：同步成功后的收藏对账与本机账号白名单。真 SQLite，不 mock SQL。
import { beforeEach, describe, expect, it } from "vitest";
import { type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import {
  bumpFavoriteOps,
  favoriteOpsEpoch,
  reconcileFavorites,
  registerLocalAccount,
} from "@/services/sync";

const NOW = "2026-10-15T10:00:00.000Z";
const ME = "me";
const B = "B";
const OTHER = "other";

let db: Db;

beforeEach(async () => {
  ({ db } = await freshTestDb());
  await db.execute(
    "INSERT INTO labels (id,name,kind,created_at,updated_at,deleted_at) VALUES ('cat','家常','category',?,?,NULL)",
    [NOW, NOW],
  );
  await db.execute(
    "INSERT INTO ingredients (id,name,created_at,updated_at,deleted_at) VALUES ('ing','盐',?,?,NULL)",
    [NOW, NOW],
  );
});

async function insertRecipe(opts: {
  owner: string | null;
  name: string;
  withChildren?: boolean;
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO recipes (id,name,cover_path,category_id,is_public,owner_nickname,created_at,updated_at,deleted_at,owner_id)
     VALUES (?,?,NULL,'cat',1,?,?,?,NULL,?)`,
    [id, opts.name, opts.owner, NOW, NOW, opts.owner],
  );
  if (opts.withChildren) {
    await db.execute(
      "INSERT INTO recipe_steps (id,recipe_id,sort_order,text,image_path,updated_at,deleted_at) VALUES (?,?,0,'切',NULL,?,NULL)",
      [crypto.randomUUID(), id, NOW],
    );
    await db.execute(
      "INSERT INTO recipe_ingredients (id,recipe_id,ingredient_id,amount,unit_id,sort_order,updated_at,deleted_at) VALUES (?,?,'ing',1,NULL,0,?,NULL)",
      [crypto.randomUUID(), id, NOW],
    );
    await db.execute("INSERT INTO recipe_labels (recipe_id,label_id) VALUES (?, 'cat')", [id]);
  }
  return id;
}

async function recipeIds(): Promise<string[]> {
  const rows = await db.select<{ id: string }[]>("SELECT id FROM recipes ORDER BY id");
  return rows.map((r) => r.id);
}

async function favoriteIds(): Promise<string[]> {
  const rows = await db.select<{ recipe_id: string }[]>(
    "SELECT recipe_id FROM favorite_recipes ORDER BY recipe_id",
  );
  return rows.map((r) => r.recipe_id);
}

async function childCount(recipeId: string): Promise<number> {
  const rows = await db.select<{ n: number }[]>(
    `SELECT (SELECT COUNT(*) FROM recipe_steps       WHERE recipe_id = ?)
          + (SELECT COUNT(*) FROM recipe_ingredients WHERE recipe_id = ?)
          + (SELECT COUNT(*) FROM recipe_labels      WHERE recipe_id = ?) AS n`,
    [recipeId, recipeId, recipeId],
  );
  return rows[0].n;
}

describe("reconcileFavorites", () => {
  it("整表替换收藏集合：旧收藏被换掉", async () => {
    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES ('old')");

    await reconcileFavorites(ME, ["new-1", "new-2"], db);

    expect(await favoriteIds()).toEqual(["new-1", "new-2"]);
  });

  it("清掉既不是我本机账号、又没被收藏的别人的菜谱（含子行）", async () => {
    const cached = await insertRecipe({ owner: OTHER, name: "别人的缓存", withChildren: true });

    await reconcileFavorites(ME, [], db);

    expect(await recipeIds()).toEqual([]);
    expect(await childCount(cached)).toBe(0);
  });

  it("本机上另一个账号自己的菜谱不被清掉（多账号回归）", async () => {
    const mine = await insertRecipe({ owner: ME, name: "我的" });
    await registerLocalAccount(B, db);
    const bRecipe = await insertRecipe({ owner: B, name: "B 的" });
    await insertRecipe({ owner: OTHER, name: "别人的" });

    await reconcileFavorites(ME, [], db);

    expect((await recipeIds()).sort()).toEqual([mine, bRecipe].sort());
  });

  it("我自己的菜谱不被清掉", async () => {
    const mine = await insertRecipe({ owner: ME, name: "我的" });

    await reconcileFavorites(ME, [], db);

    expect(await recipeIds()).toEqual([mine]);
  });

  it("收藏操作版本变了就跳过本轮对账", async () => {
    await db.execute("INSERT INTO favorite_recipes (recipe_id) VALUES ('kept')");
    const cached = await insertRecipe({ owner: OTHER, name: "别人的", withChildren: true });
    const epoch = favoriteOpsEpoch();

    bumpFavoriteOps();
    await reconcileFavorites(ME, ["new"], db);

    expect(favoriteOpsEpoch()).toBe(epoch + 1);
    // 收藏集合与缓存副本都原样不动（整段跳过）
    expect(await favoriteIds()).toEqual(["kept"]);
    expect(await recipeIds()).toEqual([cached]);
  });
});
