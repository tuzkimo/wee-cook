import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { useAuthStore } from "@/stores/auth";
import type {
  Label,
  LabelKind,
  RecipeDetail as RecipeDetailData,
  RecipeIngredientRow,
  RecipeStep,
} from "@/types";
import RecipeDetail from "@/views/RecipeDetail.vue";

const NOW = "2026-10-13T00:00:00.000Z";

// 页面只负责「拿到详情怎么画、点了往哪跳」，取数与排序由 Task 4 的 store 负责（其测试已覆盖）。
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  routeParams: {} as Record<string, string>,
  getDetail: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, back: mocks.back }),
  useRoute: () => ({ params: mocks.routeParams }),
}));

vi.mock("@/stores/recipe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/recipe")>();
  return {
    // canEdit 用真身（它读 auth store）：两个权限用例验的是 v-if 接线 + 真判据，不是桩
    ...actual,
    useRecipeStore: () => ({
      recipes: [],
      fetchAll: vi.fn(async () => {}),
      getDetail: mocks.getDetail,
      create: vi.fn(async () => ""),
      update: mocks.update,
      remove: mocks.remove,
    }),
  };
});

vi.mock("@/services/imageStore", () => ({
  imageSrc: (name: string) => `asset://localhost/images/${name}`,
}));

const wrappers: VueWrapper[] = [];

function label(id: string, name: string, kind: LabelKind): Label {
  return { id, name, kind, created_at: NOW, updated_at: NOW, deleted_at: null };
}

function step(id: string, sortOrder: number, text: string, image?: string): RecipeStep {
  return {
    id,
    recipe_id: "r1",
    sort_order: sortOrder,
    text,
    image_path: image ?? null,
    updated_at: NOW,
    deleted_at: null,
  };
}

function line(
  id: string,
  ingredientName: string,
  amount: number | null,
  unitName: string | null,
): RecipeIngredientRow {
  return {
    id,
    recipe_id: "r1",
    ingredient_id: `i-${id}`,
    amount,
    unit_id: unitName ? `u-${id}` : null,
    sort_order: 0,
    updated_at: NOW,
    deleted_at: null,
    ingredient_name: ingredientName,
    unit_name: unitName,
  };
}

function detail(): RecipeDetailData {
  return {
    recipe: {
      id: "r1",
      name: "红烧肉",
      cover_path: "c.jpg",
      category_id: "c1",
      is_public: 0,
      owner_nickname: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      owner_id: null,
    },
    category: label("c1", "荤菜", "category"),
    tags: [label("t1", "家常", "tag"), label("t2", "下饭", "tag")],
    steps: [step("s1", 0, "切块"), step("s2", 1, "下锅")],
    ingredients: [line("ri1", "五花肉", 200, "克")],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.routeParams = { id: "r1" };
  mocks.getDetail.mockResolvedValue(detail());
  mocks.update.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function page(): Promise<VueWrapper> {
  const wrapper = mount(RecipeDetail);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** ConfirmDialog Teleport 到 body，对话框里的东西一律查 document.body。 */
function dialogRoot(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".max-w-sm");
}

function dialogButton(text: string): DOMWrapper<Element> {
  const buttons = dialogRoot()?.querySelectorAll("button") ?? [];
  const found = [...buttons].find((button) => button.textContent?.trim() === text);
  if (!found) throw new Error(`对话框里找不到按钮：${text}`);
  return new DOMWrapper(found);
}

function rowTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-test="ingredient-row"]').map((node) => node.text());
}

describe("RecipeDetail", () => {
  it("显示菜名、分类、标签", async () => {
    const wrapper = await page();

    expect(mocks.getDetail).toHaveBeenCalledWith("r1");
    expect(wrapper.get('[data-test="detail-name"]').text()).toBe("红烧肉");
    expect(wrapper.get('[data-test="detail-category"]').text()).toBe("荤菜");
    expect(wrapper.findAll('[data-test="detail-tag"]').map((node) => node.text())).toEqual([
      "家常",
      "下饭",
    ]);
  });

  it("食材行显示「数量 单位 食材名」三段：2 个 鸡蛋 / 200 克 五花肉 / 适量 盐", async () => {
    const data = detail();
    data.ingredients = [
      line("ri1", "鸡蛋", 2, "个"),
      line("ri2", "五花肉", 200, "克"),
      line("ri3", "盐", null, null),
      // 只有数字没单位：只显示数字
      line("ri4", "蒜", 3, null),
    ];
    mocks.getDetail.mockResolvedValue(data);

    const wrapper = await page();

    expect(rowTexts(wrapper)).toEqual(["2 个 鸡蛋", "200 克 五花肉", "适量 盐", "3 蒜"]);
  });

  it("数量为空但有单位时读「适量 克」，不出现裸单位", async () => {
    const data = detail();
    data.ingredients = [line("ri1", "五花肉", null, "克")];
    mocks.getDetail.mockResolvedValue(data);

    const wrapper = await page();

    expect(rowTexts(wrapper)).toEqual(["适量 克 五花肉"]);
  });

  it("步骤按 sort_order 渲染，带序号", async () => {
    const data = detail();
    data.steps = [step("s2", 1, "下锅"), step("s1", 0, "切块")];
    mocks.getDetail.mockResolvedValue(data);

    const wrapper = await page();

    expect(wrapper.findAll('[data-test="step-text"]').map((node) => node.text())).toEqual([
      "切块",
      "下锅",
    ]);
    expect(wrapper.findAll('[data-test="step-order"]').map((node) => node.text())).toEqual(["1", "2"]);
  });

  it("步骤有插图时渲染图", async () => {
    const data = detail();
    data.steps = [step("s1", 0, "切块", "step-1.jpg")];
    mocks.getDetail.mockResolvedValue(data);

    const wrapper = await page();

    const image = wrapper.get('[data-test="step-image"]');
    expect(image.attributes("src")).toBe("asset://localhost/images/step-1.jpg");
  });

  it("空菜谱（无食材无步骤）不报错，两个区块各显示一句空态文案", async () => {
    const data = detail();
    data.ingredients = [];
    data.steps = [];
    mocks.getDetail.mockResolvedValue(data);

    const wrapper = await page();

    expect(wrapper.get('[data-test="detail-name"]').text()).toBe("红烧肉");
    expect(wrapper.text()).toContain("还没有食材");
    expect(wrapper.text()).toContain("还没有步骤");
    expect(wrapper.find('[data-test="not-found"]').exists()).toBe(false);
  });

  it("点「编辑」跳到 /recipe/:id/edit", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="edit"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/recipe/r1/edit");
  });

  it("点「删除」弹 ConfirmDialog，确认后调 store.remove 并跳回列表", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="delete"]').trigger("click");

    expect(dialogRoot()).not.toBeNull();
    await dialogButton("删除").trigger("click");
    await flushPromises();

    expect(mocks.remove).toHaveBeenCalledWith("r1");
    expect(mocks.push).toHaveBeenCalledWith("/");
  });

  it("删除失败时显示错误提示、不跳转、页面内容还在", async () => {
    mocks.remove.mockRejectedValue(new Error("数据库忙"));

    const wrapper = await page();

    await wrapper.get('[data-test="delete"]').trigger("click");
    await dialogButton("删除").trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="delete-error"]').text()).toContain("数据库忙");
    expect(mocks.push).not.toHaveBeenCalled();
    expect(wrapper.get('[data-test="detail-name"]').text()).toBe("红烧肉");
  });

  it("删除失败且抛出的不是 Error 时回落到「删除失败，请重试」", async () => {
    mocks.remove.mockRejectedValue("boom");

    const wrapper = await page();

    await wrapper.get('[data-test="delete"]').trigger("click");
    await dialogButton("删除").trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="delete-error"]').text()).toContain("删除失败，请重试");
  });

  it("id 不存在时显示「菜谱不存在」并能返回列表", async () => {
    mocks.routeParams = { id: "missing" };
    mocks.getDetail.mockRejectedValue(new Error("菜谱不存在"));

    const wrapper = await page();

    expect(wrapper.get('[data-test="not-found"]').text()).toContain("菜谱不存在");
    expect(wrapper.findAll('[data-test="ingredient-row"]')).toHaveLength(0);

    await wrapper.get('[data-test="back-to-list"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/");
  });

  it("根元素不再自带状态栏内边距（外壳已经统一留过）", async () => {
    const wrapper = await page();
    expect(wrapper.html()).not.toContain("safe-area-inset-top");
  });

  it("超长菜名不会把顶栏图标挤出去", async () => {
    mocks.getDetail.mockResolvedValue({
      ...detail(),
      recipe: { ...detail().recipe, name: "红烧".repeat(40) },
    });
    const wrapper = await page();

    const name = wrapper.get('[data-test="detail-name"]');
    expect(name.classes()).toContain("truncate");
    expect(name.classes()).toContain("min-w-0");
    // 菜名必须落在共享顶栏（和编辑/删除图标同一行）——旧页面自绘的 header 没有 min-h-14
    const header = name.element.closest("header");
    expect(header?.classList.contains("min-h-14")).toBe(true);
  });

  it("别人的菜谱不渲染编辑与删除按钮", async () => {
    mocks.getDetail.mockResolvedValue({
      ...detail(),
      recipe: { ...detail().recipe, owner_id: "other" },
    });

    const wrapper = await page();

    // 页面照常显示内容，只是没有可点的按钮（不是灰按钮）
    expect(wrapper.get('[data-test="detail-name"]').text()).toBe("红烧肉");
    expect(wrapper.find('[data-test="edit"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="delete"]').exists()).toBe(false);
  });

  it("我的菜谱详情页能一键公开，父行 is_public 变 1", async () => {
    const wrapper = await page();

    expect(wrapper.find('[data-test="recipe-public-toggle"]').exists()).toBe(true);
    await wrapper.get('[data-test="recipe-public-toggle"]').trigger("change");
    await flushPromises();

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const [id, input] = mocks.update.mock.calls[0];
    expect(id).toBe("r1");
    expect(input.is_public).toBe(1);
    // update 是整组替换子行：完整输入必须带上步骤 / 食材 / 标签 / 分类，漏了就清空这道菜
    expect(input.name).toBe("红烧肉");
    expect(input.cover_path).toBe("c.jpg");
    expect(input.category_id).toBe("c1");
    expect(input.tag_ids).toEqual(["t1", "t2"]);
    expect(input.steps).toEqual([
      { text: "切块", image_path: null },
      { text: "下锅", image_path: null },
    ]);
    expect(input.ingredients).toEqual([
      { ingredient_id: "i-ri1", amount: 200, unit_id: "u-ri1" },
    ]);
    // 页面立即反映新状态
    expect(
      (wrapper.get('[data-test="recipe-public-toggle"]').element as HTMLInputElement).checked,
    ).toBe(true);
    // 回归网：写完子行没被清掉
    expect(wrapper.findAll('[data-test="step-row"]')).toHaveLength(2);
    expect(rowTexts(wrapper)).toEqual(["200 克 五花肉"]);
  });

  it("别人的菜谱没有公开开关（也没有编辑/删除）", async () => {
    mocks.getDetail.mockResolvedValue({
      ...detail(),
      recipe: { ...detail().recipe, owner_id: "other" },
    });

    const wrapper = await page();

    expect(wrapper.find('[data-test="recipe-public-toggle"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="edit"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="delete"]').exists()).toBe(false);
    // 别人的菜谱根本不能触发写入：步骤与食材原样显示
    expect(mocks.update).not.toHaveBeenCalled();
    expect(wrapper.findAll('[data-test="step-row"]')).toHaveLength(2);
    expect(rowTexts(wrapper)).toEqual(["200 克 五花肉"]);
  });

  it("公开开关写入在途时重复点不会并发写（update 非事务，会互相删子行）", async () => {
    let resolveUpdate: () => void = () => {};
    mocks.update.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    const wrapper = await page();

    const toggle = wrapper.get('[data-test="recipe-public-toggle"]');
    await toggle.trigger("change");
    await toggle.trigger("change");

    expect(mocks.update).toHaveBeenCalledTimes(1);
    resolveUpdate();
    await flushPromises();
  });

  it("自己的菜谱渲染编辑与删除按钮", async () => {
    setActivePinia(createPinia());
    useAuthStore().serverUser = {
      id: "me",
      username: "me",
      nickname: "我",
      avatar_url: null,
      created_at: NOW,
      updated_at: NOW,
    };
    mocks.getDetail.mockResolvedValue({
      ...detail(),
      recipe: { ...detail().recipe, owner_id: "me" },
    });

    const wrapper = await page();

    expect(wrapper.find('[data-test="edit"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="delete"]').exists()).toBe(true);
  });
});
