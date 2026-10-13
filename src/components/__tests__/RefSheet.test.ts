import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { ref } from "vue";
import RefSheet from "@/components/RefSheet.vue";
import { useIngredientStore } from "@/stores/ingredient";
import type { RefRow, RefStore } from "@/stores/refStore";
import type { WithUsage } from "@/types";

type Row = WithUsage<RefRow>;

const NOW = "2026-10-13T00:00:00.000Z";

function row(id: string, name: string, usageCount: number): Row {
  return {
    id,
    name,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    usage_count: usageCount,
  };
}

type FakeStore = {
  items: RefStore["items"];
  fetchAll: Mock<RefStore["fetchAll"]>;
  add: Mock<RefStore["add"]>;
  update: Mock<RefStore["update"]>;
  remove: Mock<RefStore["remove"]>;
};

/** 手写假 store：本任务测的是组件，真 store 已由 Task 2、3 覆盖。 */
function makeStore(initial: Row[]): FakeStore {
  const items = ref<Row[]>(initial);
  let seq = 0;
  return {
    items,
    fetchAll: vi.fn<RefStore["fetchAll"]>(async () => {}),
    add: vi.fn<RefStore["add"]>(async (name: string) => {
      const item = row(`new-${++seq}`, name, 0);
      items.value = [...items.value, item];
      return item;
    }),
    update: vi.fn<RefStore["update"]>(async (id: string, name: string) => {
      const target = items.value.find((item) => item.id === id);
      if (target) target.name = name;
    }),
    remove: vi.fn<RefStore["remove"]>(async (id: string) => {
      items.value = items.value.filter((item) => item.id !== id);
    }),
  };
}

/** Pinia setup store 交出来的形状：ref 被解包成裸数组（R12），组件的 store prop 不该要求真 Ref。 */
function makeArrayStore(items: RefStore["items"]): RefStore {
  return {
    items,
    fetchAll: async () => {},
    add: async (name: string) => row("new-1", name, 0),
    update: async () => {},
    remove: async () => {},
  };
}

const wrappers: VueWrapper[] = [];

function openSheet(options: {
  store: RefStore;
  mode?: "single" | "multiple";
  selectedIds?: string[];
}): VueWrapper {
  const wrapper = mount(RefSheet, {
    props: {
      visible: true,
      title: "管理食材",
      store: options.store,
      mode: options.mode ?? "single",
      selectedIds: options.selectedIds ?? [],
      emptyHint: "还没有食材，点下面新建一个",
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

/** 组件 Teleport 到 body，所以一律查 document.body。 */
function el(selector: string): DOMWrapper<Element> {
  const found = document.body.querySelector(selector);
  if (!found) throw new Error(`找不到元素：${selector}`);
  return new DOMWrapper(found);
}

function has(selector: string): boolean {
  return document.body.querySelector(selector) !== null;
}

function rowElements(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[data-test="ref-row"]')];
}

function rowName(rowEl: HTMLElement): string {
  return rowEl.querySelector('[data-test="ref-name"]')?.textContent?.trim() ?? "";
}

function names(): string[] {
  return rowElements().map(rowName);
}

function checkedNames(): string[] {
  return rowElements()
    .filter((rowEl) => rowEl.querySelector('[data-test="ref-check"]') !== null)
    .map(rowName);
}

function rowByName(name: string): DOMWrapper<Element> {
  const found = rowElements().find((rowEl) => rowName(rowEl) === name);
  if (!found) throw new Error(`找不到行：${name}`);
  return new DOMWrapper(found);
}

/** ConfirmDialog 的面板，用来区分弹窗和 sheet 自己的按钮。 */
function dialogRoot(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(".max-w-sm");
}

function dialogButton(label: string): DOMWrapper<Element> {
  const buttons = dialogRoot()?.querySelectorAll("button") ?? [];
  const found = [...buttons].find((button) => button.textContent?.trim() === label);
  if (!found) throw new Error(`对话框里找不到按钮：${label}`);
  return new DOMWrapper(found);
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  document.body.innerHTML = "";
});

describe("RefSheet", () => {
  it("列表按 store.items 的顺序渲染，新建的条目排在该位置", async () => {
    const store = makeStore([row("i1", "常用料", 5), row("i2", "冷门料", 0)]);
    openSheet({ store });
    await flushPromises();

    // 使用次数只由 store 的 ORDER BY 决定，组件不重排
    expect(names()).toEqual(["常用料", "冷门料"]);
    expect(store.fetchAll).toHaveBeenCalledTimes(1);

    await el('[data-test="ref-new"]').trigger("click");
    await el('[data-test="ref-form-name"]').setValue("新料");
    await el('[data-test="ref-form-save"]').trigger("click");
    await flushPromises();

    expect(names()).toEqual(["常用料", "冷门料", "新料"]);
  });

  it("真 Pinia setup store（items 被解包成裸数组）直接当 store 传就能渲染", async () => {
    setActivePinia(createPinia());
    const store = useIngredientStore();
    vi.spyOn(store, "fetchAll").mockResolvedValue();
    store.items = [row("i1", "鸡蛋", 5), row("i2", "盐", 0)];
    // 旧实现读 items.value 就是死在这：Pinia 交出来的是裸数组
    expect(Array.isArray(store.items)).toBe(true);

    openSheet({ store });
    await flushPromises();

    expect(names()).toEqual(["鸡蛋", "盐"]);

    await el('[data-test="ref-filter"]').setValue("鸡");
    expect(names()).toEqual(["鸡蛋"]);
  });

  it("store.items 是 getter 时也能渲染", async () => {
    const backing = ref<Row[]>([row("i1", "克", 0)]);
    openSheet({ store: makeArrayStore(() => backing.value) });
    await flushPromises();

    expect(names()).toEqual(["克"]);
  });

  it("筛选框按名称包含过滤，清空后恢复全部", async () => {
    const store = makeStore([
      row("i1", "鸡蛋", 5),
      row("i2", "鸡胸肉", 0),
      row("i3", "盐", 0),
    ]);
    openSheet({ store });
    await flushPromises();

    await el('[data-test="ref-filter"]').setValue("鸡");
    expect(names()).toEqual(["鸡蛋", "鸡胸肉"]);

    await el('[data-test="ref-filter"]').setValue("没有这样一项");
    expect(names()).toEqual([]);
    expect(bodyText()).toContain("没有匹配的条目");

    await el('[data-test="ref-filter"]').setValue("");
    expect(names()).toEqual(["鸡蛋", "鸡胸肉", "盐"]);
  });

  it("single 模式点第二行时替换选中，只有一个勾", async () => {
    const store = makeStore([row("i1", "鸡蛋", 5), row("i2", "盐", 0)]);
    const wrapper = openSheet({ store, mode: "single", selectedIds: ["i1"] });
    await flushPromises();
    expect(checkedNames()).toEqual(["鸡蛋"]);

    await rowByName("盐").trigger("click");

    expect(checkedNames()).toEqual(["盐"]);
    expect(wrapper.emitted("select")).toEqual([[["i2"]]]);
    // R3：关窗是父组件的事，RefSheet 自己从不发 close
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("multiple 模式点两行有两个勾，再点一次取消勾选", async () => {
    const store = makeStore([row("i1", "鸡蛋", 5), row("i2", "盐", 0)]);
    const wrapper = openSheet({ store, mode: "multiple" });
    await flushPromises();

    await rowByName("鸡蛋").trigger("click");
    await rowByName("盐").trigger("click");
    expect(checkedNames()).toEqual(["鸡蛋", "盐"]);

    await rowByName("鸡蛋").trigger("click");
    expect(checkedNames()).toEqual(["盐"]);
    // 未点「确定」前不对外发选择
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("确定按钮 emit('select', [...]) 并把选中 id 传出去", async () => {
    const store = makeStore([row("i1", "鸡蛋", 5), row("i2", "盐", 0)]);
    const wrapper = openSheet({ store, mode: "multiple", selectedIds: ["i1"] });
    await flushPromises();

    await rowByName("盐").trigger("click");
    await el('[data-test="ref-confirm"]').trigger("click");

    expect(wrapper.emitted("select")).toEqual([[["i1", "i2"]]]);
  });

  it("列表为空时显示 emptyHint", async () => {
    openSheet({ store: makeStore([]) });
    await flushPromises();

    expect(names()).toEqual([]);
    expect(bodyText()).toContain("还没有食材，点下面新建一个");
  });

  it("点「新建」进表单模式，输入名称保存后回到列表且选中它", async () => {
    const store = makeStore([row("i1", "鸡蛋", 5)]);
    const wrapper = openSheet({ store, mode: "single" });
    await flushPromises();

    await el('[data-test="ref-new"]').trigger("click");
    expect(has('[data-test="ref-form-name"]')).toBe(true);

    await el('[data-test="ref-form-name"]').setValue("酱油");
    await el('[data-test="ref-form-save"]').trigger("click");
    await flushPromises();

    expect(store.add).toHaveBeenCalledWith("酱油");
    expect(has('[data-test="ref-form-name"]')).toBe(false);
    expect(checkedNames()).toEqual(["酱油"]);
    expect(names()).toEqual(["鸡蛋", "酱油"]);
    // 仅单选模式：新建后立刻回报选择，父组件据此进下一步
    expect(wrapper.emitted("select")).toEqual([[["new-1"]]]);
  });

  it("点「编辑」进表单，改名保存后回到列表且不额外发 select", async () => {
    const store = makeStore([row("i1", "鸡蛋", 5)]);
    const wrapper = openSheet({ store, mode: "single" });
    await flushPromises();

    await el('[data-test="ref-edit"]').trigger("click");
    // @click.stop：点行内按钮不会顺手选中这一行
    expect(wrapper.emitted("select")).toBeUndefined();
    expect((el('[data-test="ref-form-name"]').element as HTMLInputElement).value).toBe("鸡蛋");

    await el('[data-test="ref-form-name"]').setValue("土鸡蛋");
    await el('[data-test="ref-form-save"]').trigger("click");
    await flushPromises();

    expect(store.update).toHaveBeenCalledWith("i1", "土鸡蛋");
    expect(has('[data-test="ref-form-name"]')).toBe(false);
    expect(names()).toEqual(["土鸡蛋"]);
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("保存时名称纯空格 → 显示错误、不调 store.add", async () => {
    const store = makeStore([]);
    openSheet({ store });
    await flushPromises();

    await el('[data-test="ref-new"]').trigger("click");
    await el('[data-test="ref-form-name"]').setValue("   ");
    await el('[data-test="ref-form-save"]').trigger("click");
    await flushPromises();

    expect(store.add).not.toHaveBeenCalled();
    expect(el('[data-test="ref-form-error"]').text()).not.toBe("");
    expect(has('[data-test="ref-form-name"]')).toBe(true);
  });

  it("store.add 抛「同名食材已存在」→ 错误显示在表单里且留在表单模式", async () => {
    const store = makeStore([row("i1", "鸡蛋", 5)]);
    store.add.mockRejectedValueOnce(new Error("同名食材已存在"));
    openSheet({ store });
    await flushPromises();

    await el('[data-test="ref-new"]').trigger("click");
    await el('[data-test="ref-form-name"]').setValue("鸡蛋");
    await el('[data-test="ref-form-save"]').trigger("click");
    await flushPromises();

    expect(el('[data-test="ref-form-error"]').text()).toContain("同名食材已存在");
    expect(has('[data-test="ref-form-name"]')).toBe(true);
  });

  it("点「删除」弹 ConfirmDialog，确认后才调 store.remove", async () => {
    const store = makeStore([row("i1", "鸡蛋", 5)]);
    const wrapper = openSheet({ store });
    await flushPromises();

    await el('[data-test="ref-delete"]').trigger("click");

    expect(dialogRoot()).not.toBeNull();
    expect(bodyText()).toContain("确定要删除「鸡蛋」吗？");
    expect(store.remove).not.toHaveBeenCalled();
    // @click.stop：点行内按钮不会顺手选中这一行，也不会关窗
    expect(wrapper.emitted("select")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();

    await dialogButton("确认删除").trigger("click");
    await flushPromises();

    expect(store.remove).toHaveBeenCalledWith("i1");
    expect(dialogRoot()).toBeNull();
  });

  it("store.remove 抛错 → 弹提示对话框，条目还在列表里", async () => {
    const store = makeStore([row("i1", "鸡蛋", 5)]);
    store.remove.mockRejectedValueOnce(new Error("有 1 道菜谱在用「鸡蛋」，不能删除"));
    openSheet({ store });
    await flushPromises();

    await el('[data-test="ref-delete"]').trigger("click");
    await dialogButton("确认删除").trigger("click");
    await flushPromises();

    expect(bodyText()).toContain("有 1 道菜谱在用「鸡蛋」，不能删除");
    expect(names()).toEqual(["鸡蛋"]);

    await dialogButton("知道了").trigger("click");
    await flushPromises();
    expect(dialogRoot()).toBeNull();
  });

  it("关闭再打开时选中态与筛选框被重置", async () => {
    const store = makeStore([row("i1", "鸡蛋", 5), row("i2", "盐", 0)]);
    const wrapper = openSheet({ store, mode: "single", selectedIds: ["i1"] });
    await flushPromises();
    expect(checkedNames()).toEqual(["鸡蛋"]);

    await rowByName("盐").trigger("click");
    await el('[data-test="ref-filter"]').setValue("盐");
    expect(names()).toEqual(["盐"]);

    await wrapper.setProps({ visible: false });
    await wrapper.setProps({ visible: true });
    await flushPromises();

    expect(checkedNames()).toEqual(["鸡蛋"]);
    expect((el('[data-test="ref-filter"]').element as HTMLInputElement).value).toBe("");
    expect(names()).toEqual(["鸡蛋", "盐"]);
    expect(store.fetchAll).toHaveBeenCalledTimes(2);
  });
});
