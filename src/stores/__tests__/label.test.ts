import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import { useLabelStore } from "@/stores/label";
import type { LabelKind, LabelWithUsage } from "@/types";

let db: Db;

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
});

async function seedLabel(kind: LabelKind, name: string): Promise<string> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.execute(
    "INSERT INTO labels (id, name, kind, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)",
    [id, name, kind, now, now],
  );
  return id;
}

/** 造一道菜：必填分类，可选若干标签。 */
async function seedRecipe(categoryId: string, tagIds: string[] = []): Promise<string> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO recipes (id, name, cover_path, category_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, ?, ?, ?, NULL)`,
    [id, id, categoryId, now, now],
  );
  for (const tagId of tagIds) {
    await db.execute("INSERT INTO recipe_labels (recipe_id, label_id) VALUES (?, ?)", [id, tagId]);
  }
  return id;
}

function usageOf(labels: LabelWithUsage[], name: string): number {
  return labels.find((label) => label.name === name)?.usage_count ?? -1;
}

describe("labelStore", () => {
  it("fetchAll(kind) 只返回该 kind 的行", async () => {
    const store = useLabelStore();
    await store.add("category", "炒菜");
    await store.add("tag", "吐司");

    await store.fetchAll("tag");
    expect(store.labels.map((label) => label.name)).toEqual(["吐司"]);

    await store.fetchAll("category");
    expect(store.labels.map((label) => label.name)).toEqual(["炒菜"]);
  });

  it("使用次数把两条路径都算进来：被选为分类的菜谱数 + 被打成标签的菜谱数", async () => {
    const store = useLabelStore();
    const stir = await store.add("category", "炒菜");
    const toast = await store.add("tag", "吐司");
    await seedRecipe(stir.id, [toast.id]);
    await seedRecipe(stir.id, [toast.id]);
    // 同一道菜两种路径都用同一个标签时只算一次
    await seedRecipe(stir.id, [stir.id]);

    await store.fetchAll("category");
    expect(usageOf(store.labels, "炒菜")).toBe(3);
    await store.fetchAll("tag");
    expect(usageOf(store.labels, "吐司")).toBe(2);
  });

  it("软删的菜谱不计入使用次数", async () => {
    const store = useLabelStore();
    const stir = await store.add("category", "炒菜");
    const toast = await store.add("tag", "吐司");
    await seedRecipe(stir.id, [toast.id]);
    const gone = await seedRecipe(stir.id, [toast.id]);
    await db.execute("UPDATE recipes SET deleted_at = ? WHERE id = ?", [
      new Date().toISOString(),
      gone,
    ]);

    await store.fetchAll("category");
    expect(usageOf(store.labels, "炒菜")).toBe(1);
    await store.fetchAll("tag");
    expect(usageOf(store.labels, "吐司")).toBe(1);
  });

  it("分类与标签可以重名，互不冲突", async () => {
    const store = useLabelStore();
    const category = await store.add("category", "面包");
    const tag = await store.add("tag", "面包");

    expect(category.kind).toBe("category");
    expect(tag.kind).toBe("tag");
    expect(tag.id).not.toBe(category.id);
  });

  it("同一 kind 内重名（忽略大小写）被拒绝", async () => {
    const store = useLabelStore();
    const bread = await store.add("category", "Bread");
    await store.add("tag", "sweet");

    await expect(store.add("category", "bread")).rejects.toThrow("同名分类已存在");
    await expect(store.add("tag", "SWEET")).rejects.toThrow("同名标签已存在");
    const rows = await db.select<{ id: string }[]>("SELECT id FROM labels");
    expect(rows).toHaveLength(2);

    // 软删后旧名字让位
    await store.remove(bread.id);
    await expect(store.add("category", "bread")).resolves.toMatchObject({ name: "bread" });
  });

  it("add trim、纯空格拒绝", async () => {
    const store = useLabelStore();
    expect((await store.add("category", "  炒菜 ")).name).toBe("炒菜");

    await expect(store.add("category", "   ")).rejects.toThrow("请输入分类名称");
    await expect(store.add("tag", "")).rejects.toThrow("请输入标签名称");
    const rows = await db.select<{ name: string }[]>("SELECT name FROM labels");
    expect(rows.map((row) => row.name)).toEqual(["炒菜"]);
  });

  it("update 改名、忽略大小写挡重名、原地重排", async () => {
    const store = useLabelStore();
    const cool = await store.add("category", "凉菜");
    const stir = await store.add("category", "炒菜");
    await store.add("category", "青菜");

    // add 之后就已经是有序的
    expect(store.labels.map((label) => label.name)).toEqual(["凉菜", "炒菜", "青菜"]);

    await store.update(stir.id, "小炒");
    expect(store.labels.map((label) => label.name)).toEqual(["凉菜", "小炒", "青菜"]);

    // 改名后跨过邻居也要重排
    await store.update(cool.id, "蒸菜");
    expect(store.labels.map((label) => label.name)).toEqual(["小炒", "蒸菜", "青菜"]);

    await expect(store.update(stir.id, "   ")).rejects.toThrow("请输入分类名称");
    await expect(store.update(stir.id, "青菜")).rejects.toThrow("同名分类已存在");
    const rows = await db.select<{ name: string }[]>(
      "SELECT name FROM labels WHERE id = ?",
      [stir.id],
    );
    expect(rows[0].name).toBe("小炒");
  });

  it("remove 被引用的分类被拒绝且不改库", async () => {
    const store = useLabelStore();
    const stir = await store.add("category", "炒菜");
    await seedRecipe(stir.id);
    // items 里没有这一行，名字仍要能从库里取到
    await store.fetchAll("tag");

    await expect(store.remove(stir.id)).rejects.toThrow("有 1 道菜谱在用「炒菜」，不能删除");
    const rows = await db.select<{ deleted_at: string | null }[]>(
      "SELECT deleted_at FROM labels WHERE id = ?",
      [stir.id],
    );
    expect(rows[0].deleted_at).toBeNull();
  });

  it("remove 被引用的标签被拒绝", async () => {
    const store = useLabelStore();
    const stir = await store.add("category", "炒菜");
    const toast = await store.add("tag", "吐司");
    await seedRecipe(stir.id, [toast.id]);
    await store.fetchAll("tag");

    await expect(store.remove(toast.id)).rejects.toThrow("有 1 道菜谱在用「吐司」，不能删除");
  });

  it("remove 未被引用成功软删，同名可以再建", async () => {
    const store = useLabelStore();
    const toast = await store.add("tag", "吐司");
    await store.fetchAll("tag");

    await store.remove(toast.id);
    const rows = await db.select<{ deleted_at: string | null }[]>(
      "SELECT deleted_at FROM labels WHERE id = ?",
      [toast.id],
    );
    expect(rows[0].deleted_at).not.toBeNull();
    expect(store.labels.some((label) => label.id === toast.id)).toBe(false);

    const again = await store.add("tag", "吐司");
    expect(again.id).not.toBe(toast.id);
    await store.fetchAll("tag");
    expect(store.labels.map((label) => label.name)).toEqual(["吐司"]);
  });

  it("asRefStore(kind) 返回的形状能被 RefSheet 用（items/fetchAll/add/update/remove 五个都在）", async () => {
    const store = useLabelStore();
    await seedLabel("category", "炒菜");
    await seedLabel("tag", "吐司");
    const refStore = store.asRefStore("tag");

    await refStore.fetchAll();
    expect(refStore.items.value.map((item) => item.name)).toEqual(["吐司"]);

    const added = await refStore.add("  果酱 ");
    expect(added.name).toBe("果酱");
    // RefStore 的返回类型不带 kind，靠 items 里能看见它来证明建的是标签
    expect(refStore.items.value.map((item) => item.name)).toContain("果酱");

    await refStore.update(added.id, "草莓酱");
    expect(refStore.items.value.find((item) => item.id === added.id)?.name).toBe("草莓酱");

    await refStore.remove(added.id);
    expect(refStore.items.value.some((item) => item.id === added.id)).toBe(false);
  });

  it("两个 asRefStore 实例各自持有列表，后一次 fetchAll 不会清空另一个", async () => {
    const store = useLabelStore();
    const categories = store.asRefStore("category");
    const tags = store.asRefStore("tag");
    await seedLabel("category", "炒菜");
    await seedLabel("tag", "吐司");

    await tags.fetchAll();
    await categories.fetchAll();
    expect(categories.items.value.map((item) => item.name)).toEqual(["炒菜"]);
    expect(tags.items.value.map((item) => item.name)).toEqual(["吐司"]);

    // 反向再来一次，后 fetchAll 的那个不能把先前的挤空
    await categories.fetchAll();
    await tags.fetchAll();
    expect(tags.items.value.map((item) => item.name)).toEqual(["吐司"]);
    expect(categories.items.value.map((item) => item.name)).toEqual(["炒菜"]);

    // add 只进自己的列表，不串到另一个 kind
    await categories.add("面食");
    expect(categories.items.value.map((item) => item.name)).toContain("面食");
    expect(tags.items.value.map((item) => item.name)).toEqual(["吐司"]);
  });
});
