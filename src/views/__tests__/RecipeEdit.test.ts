import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { ref } from "vue";
import IngredientSheet from "@/components/IngredientSheet.vue";
import RecipeEdit from "@/views/RecipeEdit.vue";
import type { RefRow, RefStore } from "@/stores/refStore";
import type {
  Label,
  LabelKind,
  RecipeDetail,
  RecipeIngredientRow,
  RecipeStep,
  WithUsage,
} from "@/types";

type Row = WithUsage<RefRow>;
type LabelStoreLike = { asRefStore(kind: LabelKind): RefStore };

// 页面直接调 store 模块，所以整块换成手写假实现；真 store 的查询由 Task 2/3/4 覆盖。
// 这里只测「拿到数据怎么画、点了往哪跳、提交前清洗成什么形状」。
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  routeParams: {} as Record<string, string>,
  leaveGuard: undefined as undefined | (() => boolean),
  getDetail: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  ingredientStore: undefined as unknown as RefStore,
  unitStore: undefined as unknown as RefStore,
  labelStore: undefined as unknown as LabelStoreLike,
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, back: mocks.back }),
  useRoute: () => ({ params: mocks.routeParams }),
  onBeforeRouteLeave: (callback: () => boolean) => {
    mocks.leaveGuard = callback;
  },
}));

vi.mock("@/stores/recipe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/recipe")>();
  return {
    // canEdit 用真身（它读 auth store）：权限用例验的是「页面接线 + 真判据」
    ...actual,
    useRecipeStore: () => ({
      recipes: [],
      fetchAll: vi.fn(async () => {}),
      getDetail: mocks.getDetail,
      create: mocks.create,
      update: mocks.update,
      remove: vi.fn(async () => {}),
    }),
  };
});

vi.mock("@/stores/label", () => ({ useLabelStore: () => mocks.labelStore }));

vi.mock("@/stores/ingredient", () => ({
  useIngredientStore: () => mocks.ingredientStore,
  useUnitStore: () => mocks.unitStore,
}));

vi.mock("@/services/imageStore", () => ({
  imageSrc: (name: string) => `asset://localhost/images/${name}`,
  pickAndSaveImage: vi.fn(),
  saveImageBytes: vi.fn(),
}));

const NOW = "2026-10-13T00:00:00.000Z";

function row(id: string, name: string, usageCount = 0): Row {
  return {
    id,
    name,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    usage_count: usageCount,
  };
}

function label(id: string, name: string, kind: LabelKind): Label {
  return { id, name, kind, created_at: NOW, updated_at: NOW, deleted_at: null };
}

function fakeRefStore(rows: Row[]): RefStore {
  const items = ref<Row[]>(rows);
  let seq = 0;
  return {
    items,
    fetchAll: vi.fn(async () => {}),
    add: vi.fn(async (name: string) => {
      const item = row(`new-${++seq}`, name);
      items.value = [...items.value, item];
      return item;
    }),
    update: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.leaveGuard = undefined;
  mocks.routeParams = {};
  mocks.ingredientStore = fakeRefStore([row("i1", "鸡蛋", 5), row("i2", "盐", 0)]);
  mocks.unitStore = fakeRefStore([row("u1", "克", 3), row("u2", "个", 1)]);
  const categories = [row("c1", "家常菜", 3), row("c2", "荤菜", 1)];
  const tags = [row("t1", "家常", 2), row("t2", "下饭", 1)];
  mocks.labelStore = {
    asRefStore: (kind) => fakeRefStore(kind === "category" ? categories : tags),
  };
  mocks.create.mockResolvedValue("new-1");
  mocks.update.mockResolvedValue(undefined);
  mocks.getDetail.mockResolvedValue(detail());
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function detail(): RecipeDetail {
  const step: RecipeStep = {
    id: "s1",
    recipe_id: "r1",
    sort_order: 0,
    text: "切块",
    image_path: "s.jpg",
    updated_at: NOW,
    deleted_at: null,
  };
  const line: RecipeIngredientRow = {
    id: "ri1",
    recipe_id: "r1",
    ingredient_id: "i1",
    amount: 200,
    unit_id: "u1",
    sort_order: 0,
    updated_at: NOW,
    deleted_at: null,
    ingredient_name: "五花肉",
    unit_name: "克",
  };
  return {
    recipe: {
      id: "r1",
      name: "红烧肉",
      cover_path: "c.jpg",
      category_id: "c1",
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      owner_id: null,
    },
    category: label("c1", "荤菜", "category"),
    tags: [label("t1", "家常", "tag")],
    steps: [step],
    ingredients: [line],
  };
}

async function page(): Promise<VueWrapper> {
  const wrapper = mount(RecipeEdit);
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** 组件 Teleport 到 body，sheet 里的东西一律查 document.body。 */
function bodyEl(selector: string): DOMWrapper<Element> {
  const found = document.body.querySelector(selector);
  if (!found) throw new Error(`找不到元素：${selector}`);
  return new DOMWrapper(found);
}

function has(selector: string): boolean {
  return document.body.querySelector(selector) !== null;
}

function bodyRow(name: string): DOMWrapper<Element> {
  const rows = [...document.body.querySelectorAll<HTMLElement>('[data-test="ref-row"]')];
  const found = rows.find(
    (el) => el.querySelector('[data-test="ref-name"]')?.textContent?.trim() === name,
  );
  if (!found) throw new Error(`找不到行：${name}`);
  return new DOMWrapper(found);
}

/** ConfirmDialog 的面板（与 sheet 的按钮区分开）。 */
function dialogRoot(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".max-w-sm");
}

function dialogButton(text: string): DOMWrapper<Element> {
  const buttons = dialogRoot()?.querySelectorAll("button") ?? [];
  const found = [...buttons].find((button) => button.textContent?.trim() === text);
  if (!found) throw new Error(`对话框里找不到按钮：${text}`);
  return new DOMWrapper(found);
}

function inputValue(wrapper: VueWrapper, selector: string): string {
  return (wrapper.get(selector).element as HTMLInputElement | HTMLTextAreaElement).value;
}

function stepTexts(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('[data-test="step-text"]')
    .map((node) => (node.element as HTMLTextAreaElement).value);
}

function stepOrders(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-test="step-order"]').map((node) => node.text());
}

async function chooseCategory(wrapper: VueWrapper, name: string): Promise<void> {
  await wrapper.get('[data-test="category-row"]').trigger("click");
  await flushPromises();
  await bodyRow(name).trigger("click");
  await flushPromises();
}

async function save(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-test="save"]').trigger("click");
  await flushPromises();
}

/** 绕过 sheet 的 UI，直接把 add 事件塞给页面（模拟「值从外面进来」）。 */
async function emitIngredientAdd(
  wrapper: VueWrapper,
  payload: { ingredient_id: string; amount: number | null; unit_id: string | null },
): Promise<void> {
  wrapper.findComponent(IngredientSheet).vm.$emit("add", payload);
  await flushPromises();
}

describe("RecipeEdit", () => {
  it("新建模式：菜名空时保存按钮不可点", async () => {
    const wrapper = await page();

    expect(wrapper.get('[data-test="save"]').attributes("disabled")).toBeDefined();

    await wrapper.get('[data-test="name"]').setValue("红烧肉");

    expect(wrapper.get('[data-test="save"]').attributes("disabled")).toBeUndefined();
  });

  it("新建模式：菜名填了但没选分类 → 报「请选择分类」，store.create 未被调用", async () => {
    const wrapper = await page();
    await wrapper.get('[data-test="name"]').setValue("红烧肉");

    await save(wrapper);

    expect(wrapper.get('[data-test="form-error"]').text()).toContain("请选择分类");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("填了菜名和分类即可保存一个空菜谱（无步骤无食材）", async () => {
    const wrapper = await page();
    await wrapper.get('[data-test="name"]').setValue("红烧肉");
    await chooseCategory(wrapper, "家常菜");

    await save(wrapper);

    expect(mocks.create).toHaveBeenCalledWith({
      name: "红烧肉",
      cover_path: null,
      category_id: "c1",
      tag_ids: [],
      steps: [],
      ingredients: [],
    });
    expect(mocks.push).toHaveBeenCalledWith("/recipe/new-1");
  });

  it("点分类行打开 RefSheet 单选，选中后行上显示分类名", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="category-row"]').trigger("click");
    await flushPromises();

    expect(has('[data-test="ref-row"]')).toBe(true);
    await bodyRow("家常菜").trigger("click");
    await flushPromises();

    // R3：单选点行即 emit select，页面把 visible 翻回去
    expect(wrapper.get('[data-test="category-name"]').text()).toBe("家常菜");
    expect(has('[data-test="ref-row"]')).toBe(false);
  });

  it("点标签行打开 RefSheet 多选，选中显示为 chip，点 chip 的 × 取消", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="tag-row"]').trigger("click");
    await flushPromises();

    // 多选：点行只勾选，不对外发选择
    await bodyRow("家常").trigger("click");
    await bodyRow("下饭").trigger("click");
    await bodyEl('[data-test="ref-confirm"]').trigger("click");
    await flushPromises();

    expect(
      wrapper.findAll('[data-test="tag-chip-name"]').map((node) => node.text()),
    ).toEqual(["家常", "下饭"]);
    expect(has('[data-test="ref-row"]')).toBe(false);

    await wrapper.findAll('[data-test="tag-remove"]')[0].trigger("click");

    expect(
      wrapper.findAll('[data-test="tag-chip-name"]').map((node) => node.text()),
    ).toEqual(["下饭"]);
  });

  it("点「添加食材」打开 IngredientSheet，确认后追加一行「食材名 数量 单位」", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="add-ingredient"]').trigger("click");
    await flushPromises();
    await bodyRow("鸡蛋").trigger("click");
    await flushPromises();
    await bodyEl('[data-test="ingredient-amount"]').setValue("2");
    await bodyEl('[data-test="ingredient-unit"]').trigger("click");
    await flushPromises();
    await bodyRow("个").trigger("click");
    await flushPromises();
    await bodyEl('[data-test="ingredient-confirm"]').trigger("click");
    await flushPromises();

    const line = wrapper.get('[data-test="ingredient-row"]');
    expect(line.get('[data-test="ingredient-row-name"]').text()).toBe("鸡蛋");
    expect(line.get('[data-test="ingredient-row-amount"]').text()).toContain("2");
    expect(line.get('[data-test="ingredient-row-amount"]').text()).toContain("个");
  });

  it("食材行可删，删完回到空态不报错", async () => {
    const wrapper = await page();
    await emitIngredientAdd(wrapper, { ingredient_id: "i1", amount: 2, unit_id: "u2" });
    expect(wrapper.findAll('[data-test="ingredient-row"]')).toHaveLength(1);

    await wrapper.get('[data-test="ingredient-row-remove"]').trigger("click");

    expect(wrapper.findAll('[data-test="ingredient-row"]')).toHaveLength(0);
    expect(wrapper.text()).toContain("还没有食材");
    expect(wrapper.find('[data-test="form-error"]').exists()).toBe(false);
  });

  it("步骤可加、可删、可上下移，序号跟着重排", async () => {
    const wrapper = await page();
    for (const text of ["A", "B", "C"]) {
      await wrapper.get('[data-test="add-step"]').trigger("click");
      const inputs = wrapper.findAll('[data-test="step-text"]');
      await inputs[inputs.length - 1].setValue(text);
    }

    expect(stepTexts(wrapper)).toEqual(["A", "B", "C"]);
    expect(stepOrders(wrapper)).toEqual(["1", "2", "3"]);

    await wrapper.findAll('[data-test="step-down"]')[0].trigger("click");
    expect(stepTexts(wrapper)).toEqual(["B", "A", "C"]);

    await wrapper.findAll('[data-test="step-up"]')[2].trigger("click");
    expect(stepTexts(wrapper)).toEqual(["B", "C", "A"]);

    // 序号永远是当前顺序，不跟着原来的行号走
    expect(stepOrders(wrapper)).toEqual(["1", "2", "3"]);

    await wrapper.findAll('[data-test="step-remove"]')[1].trigger("click");
    expect(stepTexts(wrapper)).toEqual(["B", "A"]);
    expect(stepOrders(wrapper)).toEqual(["1", "2"]);
  });

  it("步骤文本纯空白的行在保存时被丢弃", async () => {
    const wrapper = await page();
    await wrapper.get('[data-test="name"]').setValue("  红烧肉  ");
    await chooseCategory(wrapper, "家常菜");

    await wrapper.get('[data-test="add-step"]').trigger("click");
    await wrapper.findAll('[data-test="step-text"]')[0].setValue("   ");
    await wrapper.get('[data-test="add-step"]').trigger("click");
    await wrapper.findAll('[data-test="step-text"]')[1].setValue("  下锅  ");

    await save(wrapper);

    // 菜名 trim、步骤文本 trim、纯空白步骤丢弃；本地 key 不在提交对象里
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "红烧肉", steps: [{ text: "下锅", image_path: null }] }),
    );
  });

  it("数量在 store 层被挡：构造 amount 为负数时保存报错而不是写库", async () => {
    const wrapper = await page();
    await wrapper.get('[data-test="name"]').setValue("红烧肉");
    await chooseCategory(wrapper, "家常菜");
    // 绕过 sheet 的校验，模拟外部塞进来的负数
    await emitIngredientAdd(wrapper, { ingredient_id: "i1", amount: -3, unit_id: "u2" });

    await save(wrapper);

    expect(wrapper.get('[data-test="form-error"]').text()).toContain("数量要大于 0");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("没有修改权限的菜谱：onMounted 退回详情页，不填表单", async () => {
    mocks.routeParams = { id: "r1" };
    mocks.getDetail.mockResolvedValue({
      ...detail(),
      recipe: { ...detail().recipe, owner_id: "other" },
    });

    const wrapper = await page();

    expect(mocks.replace).toHaveBeenCalledWith("/recipe/r1");
    expect(inputValue(wrapper, '[data-test="name"]')).toBe("");
    // 离页守卫不能拦住这次退回
    expect(mocks.leaveGuard?.()).toBe(true);
  });

  it("编辑模式：onMounted 拉详情，各字段被填上", async () => {
    mocks.routeParams = { id: "r1" };

    const wrapper = await page();

    expect(mocks.getDetail).toHaveBeenCalledWith("r1");
    expect(inputValue(wrapper, '[data-test="name"]')).toBe("红烧肉");
    expect(wrapper.get('[data-test="category-name"]').text()).toBe("荤菜");
    expect(wrapper.findAll('[data-test="tag-chip-name"]').map((node) => node.text())).toEqual([
      "家常",
    ]);
    expect(stepTexts(wrapper)).toEqual(["切块"]);
    expect(inputValue(wrapper, '[data-test="step-text"]')).toBe("切块");
    const line = wrapper.get('[data-test="ingredient-row"]');
    expect(line.get('[data-test="ingredient-row-name"]').text()).toBe("五花肉");
    expect(line.get('[data-test="ingredient-row-amount"]').text()).toContain("200");
    expect(line.get('[data-test="ingredient-row-amount"]').text()).toContain("克");
    // 封面图 + 步骤图两张图都从详情里恢复
    expect(wrapper.findAll('[data-test="image-preview"]')).toHaveLength(2);
  });

  it("编辑模式：删掉最后一条步骤后保存，回读详情里没有步骤", async () => {
    mocks.routeParams = { id: "r1" };
    const wrapper = await page();

    await wrapper.get('[data-test="step-remove"]').trigger("click");
    await save(wrapper);

    expect(mocks.update).toHaveBeenCalledWith("r1", {
      name: "红烧肉",
      cover_path: "c.jpg",
      category_id: "c1",
      tag_ids: ["t1"],
      steps: [],
      ingredients: [{ ingredient_id: "i1", amount: 200, unit_id: "u1" }],
    });
  });

  it("有未保存改动时点返回 → 弹 ConfirmDialog，取消则不跳转", async () => {
    const wrapper = await page();
    await wrapper.get('[data-test="name"]').setValue("红烧肉");

    await wrapper.get('[data-test="back"]').trigger("click");

    expect(dialogRoot()).not.toBeNull();
    await dialogButton("继续编辑").trigger("click");
    await flushPromises();

    expect(dialogRoot()).toBeNull();
    expect(mocks.back).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    // 还留在页面上，改动没丢
    expect(inputValue(wrapper, '[data-test="name"]')).toBe("红烧肉");
  });

  it("保存成功后跳到详情页 /recipe/:id", async () => {
    mocks.routeParams = { id: "r1" };
    const wrapper = await page();

    await save(wrapper);

    expect(mocks.push).toHaveBeenCalledWith("/recipe/r1");
  });

  it("store.create 抛错 → 错误显示在页面上，不跳转", async () => {
    mocks.create.mockRejectedValue(new Error("数据库未打开"));
    const wrapper = await page();
    await wrapper.get('[data-test="name"]').setValue("红烧肉");
    await chooseCategory(wrapper, "家常菜");

    await save(wrapper);

    expect(wrapper.get('[data-test="form-error"]').text()).toContain("数据库未打开");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("保存进行中再点一次不会创建两道菜谱", async () => {
    let finishCreate!: (id: string) => void;
    mocks.create.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishCreate = resolve;
        }),
    );
    const wrapper = await page();
    await wrapper.get('[data-test="name"]').setValue("红烧肉");
    await chooseCategory(wrapper, "家常菜");

    await wrapper.get('[data-test="save"]').trigger("click");
    expect(wrapper.get('[data-test="save"]').attributes("disabled")).toBeDefined();
    await wrapper.get('[data-test="save"]').trigger("click");

    expect(mocks.create).toHaveBeenCalledTimes(1);

    finishCreate("new-1");
    await flushPromises();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith("/recipe/new-1");
    // 保存成功后不再是「有未保存改动」，守卫不会拦住去详情页的跳转
    expect(mocks.leaveGuard?.()).toBe(true);
  });

  it("保存失败后按钮恢复可点，能重试", async () => {
    mocks.create.mockRejectedValueOnce(new Error("数据库未打开"));
    const wrapper = await page();
    await wrapper.get('[data-test="name"]').setValue("红烧肉");
    await chooseCategory(wrapper, "家常菜");

    await save(wrapper);
    expect(wrapper.get('[data-test="save"]').attributes("disabled")).toBeUndefined();

    mocks.create.mockResolvedValueOnce("new-2");
    await save(wrapper);

    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.push).toHaveBeenCalledWith("/recipe/new-2");
  });

  it("表单干净时路由守卫放行（硬件返回键直接离页）", async () => {
    await page();

    expect(mocks.leaveGuard?.()).toBe(true);
  });

  it("有未保存改动时路由守卫拦下并弹确认框", async () => {
    const wrapper = await page();
    await wrapper.get('[data-test="name"]').setValue("红烧肉");

    expect(mocks.leaveGuard?.()).toBe(false);
    await flushPromises();
    expect(dialogRoot()).not.toBeNull();
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it("守卫拦下后点「放弃」放行一次并返回上页", async () => {
    const wrapper = await page();
    await wrapper.get('[data-test="name"]').setValue("红烧肉");
    await wrapper.get('[data-test="back"]').trigger("click");
    await flushPromises();

    await dialogButton("放弃").trigger("click");
    await flushPromises();

    expect(mocks.back).toHaveBeenCalledTimes(1);
    expect(mocks.leaveGuard?.()).toBe(true);
  });

  it("根元素不再自带状态栏内边距，底部也没有 fixed 的按钮条", async () => {
    const wrapper = await page();
    expect(wrapper.html()).not.toContain("safe-area-inset-top");
    expect(wrapper.find('[data-test="cancel"]').exists()).toBe(false);
  });
});
