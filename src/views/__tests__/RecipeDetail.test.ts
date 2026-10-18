import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { useAuthStore } from "@/stores/auth";
import type { UserProfile } from "@/services/community";
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
  replace: vi.fn(),
  back: vi.fn(),
  routeParams: {} as Record<string, string>,
  getDetail: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  isFavorited: vi.fn(),
  favorite: vi.fn(),
  unfavorite: vi.fn(),
  profile: vi.fn(),
  follow: vi.fn(),
  unfollow: vi.fn(),
  fetchWithAuth: vi.fn(),
  authReady: { value: true },
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, back: mocks.back }),
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

vi.mock("@/stores/community", () => ({
  useCommunityStore: () => ({
    isFavorited: mocks.isFavorited,
    favorite: mocks.favorite,
    unfavorite: mocks.unfavorite,
    profile: mocks.profile,
    follow: mocks.follow,
    unfollow: mocks.unfollow,
  }),
}));

// 步骤图也走鉴权下载通道补下来：网络层换成替身，文件 IO 用 setFileSyncDeps 注入假文件系统。
vi.mock("@/services/api", () => ({
  hasBaseUrl: () => true,
  fetchWithAuth: mocks.fetchWithAuth,
  authTokenReady: mocks.authReady,
}));

import { setFileSyncDeps, type FileSyncDeps } from "@/services/syncFiles";

const wrappers: VueWrapper[] = [];

/** 只喂 downloadOne 用到的 ok/status/arrayBuffer。 */
function fileRes(status: number, bytes: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  } as unknown as Response;
}

/** 内存假文件系统：只实现图片通道用到的 exists / writeFile / rename。 */
function fakeIo(): { deps: FileSyncDeps; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    deps: {
      readFile: async () => new Uint8Array(),
      exists: async (path) => store.has(path),
      writeFile: async (path, bytes) => {
        store.set(path, bytes);
      },
      rename: async (from, to) => {
        const bytes = store.get(from);
        store.delete(from);
        if (bytes) store.set(to, bytes);
      },
    },
  };
}

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
      owner_avatar_url: null,
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

/** 别人的公开菜谱：详情页只读，作者可点、可收藏。 */
function others(): RecipeDetailData {
  const data = detail();
  return {
    ...data,
    recipe: { ...data.recipe, owner_id: "u2", owner_nickname: "老王" },
  };
}

/** 作者资料：联网时补「公开 N 道」与关注态。 */
function authorProfile(count = 12, followed = false): UserProfile {
  return { id: "u2", nickname: "老王", avatar_url: null, followed, public_count: count };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.routeParams = { id: "r1" };
  mocks.getDetail.mockResolvedValue(detail());
  mocks.update.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.isFavorited.mockResolvedValue(false);
  mocks.favorite.mockResolvedValue(undefined);
  mocks.unfavorite.mockResolvedValue(undefined);
  mocks.profile.mockResolvedValue(authorProfile());
  mocks.follow.mockResolvedValue(undefined);
  mocks.unfollow.mockResolvedValue(undefined);
  mocks.authReady.value = true;
});

afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount();
  wrappers.length = 0;
  setFileSyncDeps(null);
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

  it("步骤图落盘后才渲染图；未落盘时宁可不显示也不出破图", async () => {
    const io = fakeIo();
    setFileSyncDeps(io.deps);
    mocks.fetchWithAuth.mockResolvedValue(fileRes(200, new Uint8Array([1, 2])));
    const data = detail();
    data.steps = [step("s1", 0, "切块", "step-1.jpg")];
    mocks.getDetail.mockResolvedValue(data);

    const wrapper = await page();

    await vi.waitFor(() => expect(wrapper.find('[data-test="step-image"]').exists()).toBe(true));
    const image = wrapper.get('[data-test="step-image"]');
    expect(image.attributes("src")).toBe("asset://localhost/images/step-1.jpg");
  });

  it("步骤图还没落盘时不渲染 <img>（首次打开社区菜谱的破图回归）", async () => {
    const io = fakeIo();
    setFileSyncDeps(io.deps);
    mocks.fetchWithAuth.mockRejectedValue(new Error("断网"));
    const data = detail();
    data.steps = [step("s1", 0, "切块", "step-1.jpg")];
    mocks.getDetail.mockResolvedValue(data);

    const wrapper = await page();

    await vi.waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalled());
    await flushPromises();
    expect(wrapper.find('[data-test="step-image"]').exists()).toBe(false);
    // 步骤本身照常显示，只是暂时没有图
    expect(wrapper.get('[data-test="step-text"]').text()).toBe("切块");
  });

  it("已配地址但未登录（guest）时打开缓存菜谱详情：零图片请求，不渲染 <img>", async () => {
    mocks.authReady.value = false;
    setFileSyncDeps(fakeIo().deps);
    const data = detail();
    data.steps = [step("s1", 0, "切块", "step-1.jpg")];
    mocks.getDetail.mockResolvedValue(data);

    const wrapper = await page();

    await flushPromises();
    // 未登录不发任何网络请求（spec §3）：已配地址也不行
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="step-image"]').exists()).toBe(false);
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

  it("点「编辑」跳到 /recipe/:id/edit，并带上「从详情页来」的标记", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="edit"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith({
      path: "/recipe/r1/edit",
      query: { from: "detail" },
    });
  });

  it("点顶栏电话图标进指导模式", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="guide"]').trigger("click");

    expect(mocks.push).toHaveBeenCalledWith("/recipe/r1/guide");
  });

  it("点「删除」弹 ConfirmDialog，确认后调 store.remove 并跳回列表", async () => {
    const wrapper = await page();

    await wrapper.get('[data-test="delete"]').trigger("click");

    expect(dialogRoot()).not.toBeNull();
    await dialogButton("删除").trigger("click");
    await flushPromises();

    expect(mocks.remove).toHaveBeenCalledWith("r1");
    // replace：删除后历史里不能留下这张已删除菜谱的详情
    expect(mocks.replace).toHaveBeenCalledWith("/");
    expect(mocks.push).not.toHaveBeenCalled();
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

  it("别人的菜谱显示作者昵称，点它进 /user/:id", async () => {
    mocks.getDetail.mockResolvedValue(others());

    const wrapper = await page();

    const author = wrapper.get('[data-test="recipe-author"]');
    expect(author.text()).toBe("老王");
    // 收藏按钮与作者同属「别人的菜谱」这一态，而且是顶栏里的图标按钮
    const favorite = wrapper.find('[data-test="recipe-favorite"]');
    expect(favorite.exists()).toBe(true);
    expect(wrapper.get("header").find('[data-test="recipe-favorite"]').exists()).toBe(true);
    await author.trigger("click");
    expect(mocks.push).toHaveBeenCalledWith("/user/u2");
  });

  it("作者卡片第一眼就有头像与昵称，断网不补数字、不发资料请求", async () => {
    const data = others();
    data.recipe.owner_avatar_url = "https://e.com/u2.png";
    mocks.getDetail.mockResolvedValue(data);

    const wrapper = await page();

    // 本地那份（昵称 + 头像）先画出来：昵称就在可点的卡片里
    expect(wrapper.get('[data-test="recipe-author"]').text()).toBe("老王");
    expect(wrapper.get('[data-test="recipe-author-avatar"] img').attributes("src")).toBe(
      "https://e.com/u2.png",
    );
    // 离线（guest）：一个资料请求都不发，数字与关注按钮都不出现
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="recipe-author-count"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="recipe-author-follow"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="recipe-favorite"]').exists()).toBe(true);
  });

  it("联网时补出公开菜谱数与关注按钮", async () => {
    setActivePinia(createPinia());
    useAuthStore().mode = "online";
    mocks.getDetail.mockResolvedValue(others());

    const wrapper = await page();

    expect(mocks.profile).toHaveBeenCalledWith("u2");
    expect(wrapper.get('[data-test="recipe-author-count"]').text()).toContain("12");
    expect(wrapper.get('[data-test="recipe-author-follow"]').attributes("aria-label")).toBe("关注");
    // 图标是这次改动的可见内容：没它按钮就只是个空圈
    expect(wrapper.get('[data-test="recipe-author-follow"]').find("svg").exists()).toBe(true);
  });

  it("已关注的作者显示「取消关注」", async () => {
    setActivePinia(createPinia());
    useAuthStore().mode = "online";
    mocks.getDetail.mockResolvedValue(others());
    mocks.profile.mockResolvedValue(authorProfile(3, true));

    const wrapper = await page();

    expect(wrapper.get('[data-test="recipe-author-count"]').text()).toContain("3");
    expect(wrapper.get('[data-test="recipe-author-follow"]').attributes("aria-label")).toBe("取消关注");
    expect(wrapper.get('[data-test="recipe-author-follow"]').find("svg").exists()).toBe(true);
  });

  it("点关注按钮只关注作者，不跳用户页", async () => {
    setActivePinia(createPinia());
    useAuthStore().mode = "online";
    mocks.getDetail.mockResolvedValue(others());

    const wrapper = await page();

    await wrapper.get('[data-test="recipe-author-follow"]').trigger("click");
    await flushPromises();

    expect(mocks.follow).toHaveBeenCalledWith("u2");
    expect(mocks.unfollow).not.toHaveBeenCalled();
    // @click.stop：关注按钮的点击不许冒到卡片上跳用户页
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("关注失败时按钮翻回原状并提示，不静默", async () => {
    setActivePinia(createPinia());
    useAuthStore().mode = "online";
    mocks.getDetail.mockResolvedValue(others());
    mocks.follow.mockRejectedValue(new Error("网络不可用"));

    const wrapper = await page();

    await wrapper.get('[data-test="recipe-author-follow"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="author-follow-error"]').text()).toContain("网络不可用");
    expect(wrapper.get('[data-test="recipe-author-follow"]').attributes("aria-label")).toBe("关注");
  });

  it("作者资料请求失败时完全静默：卡片照常，不报错也不画数字与关注按钮", async () => {
    setActivePinia(createPinia());
    useAuthStore().mode = "online";
    mocks.getDetail.mockResolvedValue(others());
    mocks.profile.mockRejectedValue(new Error("网络不可用"));

    const wrapper = await page();

    expect(wrapper.get('[data-test="recipe-author"]').text()).toBe("老王");
    expect(wrapper.find('[data-test="recipe-author-count"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="recipe-author-follow"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="author-follow-error"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="detail-name"]').text()).toBe("红烧肉");
  });

  it("离线时收藏按钮不可用（disabled，且视觉上也灰着）", async () => {
    setActivePinia(createPinia());
    mocks.getDetail.mockResolvedValue(others());

    const wrapper = await page();

    // 未登录（离线）也看得到按钮，只是不能点
    const favorite = wrapper.get('[data-test="recipe-favorite"]');
    expect(favorite.attributes("disabled")).toBeDefined();
    expect(favorite.classes()).toContain("disabled:opacity-50");
  });

  it("收藏成功后按钮显示已收藏", async () => {
    setActivePinia(createPinia());
    useAuthStore().mode = "online";
    mocks.getDetail.mockResolvedValue(others());

    const wrapper = await page();

    expect(wrapper.get('[data-test="recipe-favorite"]').attributes("aria-label")).toBe("收藏");
    await wrapper.get('[data-test="recipe-favorite"]').trigger("click");
    await flushPromises();

    expect(mocks.favorite).toHaveBeenCalledWith("r1");
    expect(wrapper.get('[data-test="recipe-favorite"]').attributes("aria-label")).toBe("已收藏");
  });

  it("本地已收藏的菜谱进详情页直接显示已收藏", async () => {
    mocks.getDetail.mockResolvedValue(others());
    mocks.isFavorited.mockResolvedValue(true);

    const wrapper = await page();

    expect(wrapper.get('[data-test="recipe-favorite"]').attributes("aria-label")).toBe("已收藏");
  });

  it("步骤图还在下载时不阻塞收藏态初始化（先读本地收藏，再等图）", async () => {
    setFileSyncDeps(fakeIo().deps);
    // 卡住下载：收藏初值读的是本地 SQL，不该等在途的网络
    mocks.fetchWithAuth.mockReturnValue(new Promise<Response>(() => {}));
    const data = others();
    data.steps = [step("s1", 0, "切块", "step-1.jpg")];
    mocks.getDetail.mockResolvedValue(data);
    mocks.isFavorited.mockResolvedValue(true);

    const wrapper = await page();

    expect(wrapper.get('[data-test="recipe-favorite"]').attributes("aria-label")).toBe("已收藏");
  });

  it("exists 读不了时不炸整页，收藏态照常初始化", async () => {
    const io = fakeIo();
    setFileSyncDeps({
      ...io.deps,
      exists: async () => {
        throw new Error("FS 读不了");
      },
    });
    mocks.fetchWithAuth.mockRejectedValue(new Error("断网"));
    const data = others();
    data.steps = [step("s1", 0, "切块", "step-1.jpg")];
    mocks.getDetail.mockResolvedValue(data);
    mocks.isFavorited.mockResolvedValue(true);

    const wrapper = await page();

    expect(wrapper.get('[data-test="detail-name"]').text()).toBe("红烧肉");
    expect(wrapper.get('[data-test="recipe-favorite"]').attributes("aria-label")).toBe("已收藏");
  });

  it("收藏失败时按钮回到原状并提示，不静默", async () => {
    setActivePinia(createPinia());
    useAuthStore().mode = "online";
    mocks.getDetail.mockResolvedValue(others());
    mocks.favorite.mockRejectedValue(new Error("网络不可用"));

    const wrapper = await page();

    await wrapper.get('[data-test="recipe-favorite"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="favorite-error"]').text()).toContain("网络不可用");
    expect(wrapper.get('[data-test="recipe-favorite"]').attributes("aria-label")).toBe("收藏");
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
    // 自己的菜谱不是「别人的」：没有作者入口、也没有收藏按钮
    expect(wrapper.find('[data-test="recipe-author"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="recipe-favorite"]').exists()).toBe(false);
  });
});
