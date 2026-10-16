// 字典读取与名字解析：loadDict 用真 SQLite，resolveFilter / validateSearchArgs 是纯函数。
import { beforeEach, describe, expect, it } from "vitest";
import { setDb } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import {
  loadDict,
  resolveFilter,
  validateSearchArgs,
  type Dict,
  type DictEntry,
} from "@/services/ai/filter";

const NOW = "2026-10-16T00:00:00Z";

function dictOf(parts: Partial<Dict> = {}): Dict {
  return { categories: [], tags: [], ingredients: [], ...parts };
}

function entry(id: string, name: string): DictEntry {
  return { id, name };
}

/** 分类/标签/食材三桶的样本：肉同时是「五花肉」「肉末」的子串 */
const dict: Dict = dictOf({
  categories: [entry("c1", "家常菜")],
  tags: [entry("t1", "快手")],
  ingredients: [entry("i1", "五花肉"), entry("i2", "肉末")],
});

beforeEach(() => {
  setDb(null);
});

describe("filter", () => {
  it("loadDict 只取未软删的，按分类/标签/食材分三桶", async () => {
    const { db } = await freshTestDb();
    setDb(db);

    const label = (id: string, name: string, kind: string, deleted: string | null = null) =>
      db.execute(
        `INSERT INTO labels (id, name, kind, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, kind, NOW, NOW, deleted],
      );
    const ingredient = (id: string, name: string, deleted: string | null = null) =>
      db.execute(
        `INSERT INTO ingredients (id, name, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, name, NOW, NOW, deleted],
      );

    await label("c2", "汤羹", "category");
    await label("c1", "家常菜", "category");
    await label("c9", "已删分类", "category", NOW);
    await label("t1", "快手", "tag");
    await label("t9", "已删标签", "tag", NOW);
    await ingredient("i2", "肉末");
    await ingredient("i1", "五花肉");
    await ingredient("i9", "已删食材", NOW);

    const loaded = await loadDict();

    // ORDER BY name：中文按码点序，「家」在「汤」前
    expect(loaded.categories).toEqual([entry("c1", "家常菜"), entry("c2", "汤羹")]);
    expect(loaded.tags).toEqual([entry("t1", "快手")]);
    expect(loaded.ingredients).toEqual([entry("i1", "五花肉"), entry("i2", "肉末")]);
  });

  it("解析顺序：精确 → 唯一包含 → 多命中给候选 → 零命中归未落定", () => {
    // 精确
    expect(resolveFilter({ ingredients: ["五花肉"] }, dict)).toEqual({
      filter: { keyword: "", categoryIds: [], tagIds: [], ingredientIds: ["i1"] },
      unresolved: { categories: [], tags: [], ingredients: [] },
    });

    // 唯一包含：「五花」只命中「五花肉」
    expect(resolveFilter({ ingredients: ["五花"] }, dict).filter.ingredientIds).toEqual(["i1"]);

    // 多命中：「肉」同时是「五花肉」「肉末」的子串 ⇒ 不猜，交给用户
    const many = resolveFilter({ ingredients: ["肉"] }, dict);
    expect(many.filter.ingredientIds).toEqual([]);
    expect(many.unresolved.ingredients).toEqual(["肉"]);

    // 零命中
    const none = resolveFilter({ ingredients: ["洋蓟"] }, dict);
    expect(none.filter.ingredientIds).toEqual([]);
    expect(none.unresolved.ingredients).toEqual(["洋蓟"]);

    // 分类走 categoryIds、标签走 tagIds，命中的与未落定的各归各位
    const labels = resolveFilter({ categories: ["家常菜", "汤羹"], labels: ["快手"] }, dict);
    expect(labels.filter.categoryIds).toEqual(["c1"]);
    expect(labels.filter.tagIds).toEqual(["t1"]);
    expect(labels.unresolved.categories).toEqual(["汤羹"]);
    expect(labels.unresolved.tags).toEqual([]);

    // 同名重复只收一个 id
    expect(resolveFilter({ ingredients: ["五花肉", "五花肉"] }, dict).filter.ingredientIds).toEqual(
      ["i1"],
    );
  });

  it("trim 与全角空格都要吃掉", () => {
    expect(resolveFilter({ ingredients: [" 五花肉 "] }, dict).filter.ingredientIds).toEqual([
      "i1",
    ]);
    expect(resolveFilter({ ingredients: ["\u3000五花肉"] }, dict).filter.ingredientIds).toEqual([
      "i1",
    ]);
  });

  it("校验：非法类型 / 空对象 / 多余字段", () => {
    // 非法 JSON、非对象、类型不对
    expect(validateSearchArgs("不是 JSON")).toMatchObject({ ok: false });
    expect(validateSearchArgs("[]")).toMatchObject({ ok: false });
    expect(validateSearchArgs('{"categories":"家常菜"}')).toMatchObject({ ok: false });
    expect(validateSearchArgs('{"keyword":123}')).toMatchObject({ ok: false });
    expect(validateSearchArgs('{"ingredients":["五花肉",1]}')).toMatchObject({ ok: false });

    // 四个条件全空 = 不加筛选，合法
    expect(validateSearchArgs("{}")).toEqual({ ok: true, args: {} });
    // 多余字段忽略，不报错
    expect(validateSearchArgs('{"nope":1}')).toEqual({ ok: true, args: {} });

    // 留下的就是模型给的那几个条件
    expect(
      validateSearchArgs('{"keyword":"红烧","categories":["家常菜"],"labels":["快手"]}'),
    ).toEqual({ ok: true, args: { keyword: "红烧", categories: ["家常菜"], labels: ["快手"] } });
  });

  it("解析结果里的 filter 是空的 RecipeFilter 形状，关键词原样带过", () => {
    expect(resolveFilter({ keyword: "红烧" }, dictOf())).toEqual({
      filter: { keyword: "红烧", categoryIds: [], tagIds: [], ingredientIds: [] },
      unresolved: { categories: [], tags: [], ingredients: [] },
    });
  });
});
