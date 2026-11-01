import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { setDb, type Db } from "@/db";
import { freshTestDb } from "@/db/__tests__/sqliteTestDb";
import { setActiveScope } from "@/services/scope";
import { useInventoryStore } from "@/stores/inventory";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  routeParams: { id: "r1", cookId: "cr1" } as Record<string, string>,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, back: mocks.back }),
  useRoute: () => ({ params: mocks.routeParams }),
}));

import CookRecordDetail from "@/views/CookRecordDetail.vue";

/** 本地时区 YYYY-MM-DD HH:mm，与页面独立实现（不调被测函数） */
function local(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

const NOW = "2026-11-01T18:20:00.000Z";
let db: Db;
const wrappers: VueWrapper[] = [];

beforeEach(async () => {
  setActivePinia(createPinia());
  ({ db } = await freshTestDb());
  setDb(db);
  setActiveScope("p:local");
  vi.clearAllMocks();
  mocks.routeParams = { id: "r1", cookId: "cr1" };
  await seedCatalog();
});

/** 菜谱 + 食材 + 一批库存：明细靠使用记录 JOIN 批次派生 */
async function seedCatalog(): Promise<void> {
  await db.execute(
    "INSERT INTO labels (id, scope_id, name, kind, created_at, updated_at) VALUES ('c1','p:local','家常','category',?,?)",
    [NOW, NOW],
  );
  await db.execute(
    `INSERT INTO recipes (id, scope_id, name, category_id, created_at, updated_at)
     VALUES ('r1','p:local','红烧肉','c1',?,?)`,
    [NOW, NOW],
  );
  await db.execute(
    "INSERT INTO ingredients (id, scope_id, name, created_at, updated_at) VALUES ('i1','p:local','鸡蛋',?,?)",
    [NOW, NOW],
  );
  await db.execute(
    `INSERT INTO inventory_batches (id, scope_id, ingredient_id, amount, created_at, updated_at)
     VALUES ('b1','p:local','i1',500,?,?)`,
    [NOW, NOW],
  );
}

async function seedCook(o: {
  id: string;
  ownerId: string | null;
  nickname?: string | null;
  amount: number | null;
}): Promise<void> {
  await db.execute(
    `INSERT INTO cook_records
       (id, scope_id, owner_id, recipe_id, owner_nickname, owner_avatar_url, created_at, updated_at)
     VALUES (?, 'p:local', ?, 'r1', ?, NULL, ?, ?)`,
    [o.id, o.ownerId, o.nickname ?? null, NOW, NOW],
  );
  if (o.amount !== null) {
    await db.execute(
      `INSERT INTO inventory_usages (id, scope_id, cook_id, recipe_id, batch_id, amount, used_at, updated_at)
       VALUES (?, 'p:local', ?, 'r1', 'b1', ?, ?, ?)`,
      [crypto.randomUUID(), o.id, o.amount, NOW, NOW],
    );
  }
}

async function open(): Promise<VueWrapper> {
  const wrapper = mount(CookRecordDetail);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe("CookRecordDetail", () => {
  it("显示菜谱名、作者、时间与明细", async () => {
    await seedCook({ id: "cr1", ownerId: "u2", nickname: "老王", amount: 150 });

    const wrapper = await open();

    expect(wrapper.get('[data-test="cook-record-recipe"]').text()).toBe("红烧肉");
    expect(wrapper.get('[data-test="cook-record-author"]').text()).toBe("老王");
    expect(wrapper.text()).toContain(local(NOW));
    const line = wrapper.get('[data-test="cook-record-line"]');
    expect(line.text()).toContain("鸡蛋");
    expect(line.text()).toContain("150");
  });

  it("明细为空时显示「这次没有扣任何库存」", async () => {
    await seedCook({ id: "cr1", ownerId: null, amount: null });

    const wrapper = await open();

    expect(wrapper.get('[data-test="cook-record-empty"]').text()).toContain(
      "这次没有扣任何库存",
    );
    expect(wrapper.findAll('[data-test="cook-record-line"]')).toHaveLength(0);
  });

  it("记录不存在时给出提示", async () => {
    mocks.routeParams = { id: "r1", cookId: "nope" };

    const wrapper = await open();

    expect(wrapper.text()).toContain("记录不存在");
  });

  it("自己做的记录回退到当前账号（本机新建的两列为 NULL）", async () => {
    const auth = (await import("@/stores/auth")).useAuthStore();
    auth.nickname = "我自己";
    await seedCook({ id: "cr1", ownerId: null, amount: 10 });

    const wrapper = await open();

    expect(wrapper.get('[data-test="cook-record-author"]').text()).toBe("我自己");
    // 作者解析只在 store 一处：页面拿到的就是 store 算好的结果
    expect((await useInventoryStore().fetchCookRecord("cr1"))?.author.name).toBe("我自己");
  });
});
