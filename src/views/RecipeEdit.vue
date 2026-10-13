<script setup lang="ts">
// 录入/编辑共用一页：新建走 /recipe/new，编辑走 /recipe/:id/edit（规格 §6.2）。
// 字段顺序：菜名 → 封面图 → 分类 → 标签 → 食材 → 步骤 → 保存/取消。
//
// 页面负责 store 不做的两件事（裁决 R6）：提交前的输入清洗（菜名 trim、空步骤丢弃、
// 本地 key 剥掉、数量 0/负数报错）与「未保存就退出」的确认。
import { computed, onMounted, ref, toValue } from "vue";
import { useRoute, useRouter } from "vue-router";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import ImagePicker from "@/components/ImagePicker.vue";
import IngredientSheet from "@/components/IngredientSheet.vue";
import RefSheet from "@/components/RefSheet.vue";
import { useIngredientStore, useUnitStore } from "@/stores/ingredient";
import { useLabelStore } from "@/stores/label";
import { useRecipeStore } from "@/stores/recipe";
import type { RefStore } from "@/stores/refStore";
import type { RecipeDetail, RecipeInput } from "@/types";

/** 步骤/食材行带一个只用于 v-for 的本地 key，提交前剥掉（删中间一行时 DOM 不串行）。 */
type StepDraft = RecipeInput["steps"][number] & { key: number };
type IngredientDraft = RecipeInput["ingredients"][number] & {
  key: number;
  ingredient_name: string;
  unit_name: string | null;
};

interface Form {
  name: string;
  cover_path: string | null;
  category_id: string;
  tag_ids: string[];
  steps: StepDraft[];
  ingredients: IngredientDraft[];
}

function emptyForm(): Form {
  return { name: "", cover_path: null, category_id: "", tag_ids: [], steps: [], ingredients: [] };
}

const route = useRoute();
const router = useRouter();
const recipeStore = useRecipeStore();
const labelStore = useLabelStore();
const ingredientStore = useIngredientStore();
const unitStore = useUnitStore();

// asRefStore 各持一份列表（R11），所以分类与标签 sheet 同时开也互不覆盖
const categoryRefStore = labelStore.asRefStore("category");
const tagRefStore = labelStore.asRefStore("tag");

const recipeId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));

const form = ref<Form>(emptyForm());
// id → 名称。详情页给的、sheet 里选中的都往里塞，模板据此画分类名与标签 chip
const labelNames = ref<Record<string, string>>({});
const categoryName = computed(() => labelNames.value[form.value.category_id] ?? "");
const tagRows = computed(() =>
  form.value.tag_ids.map((id) => ({ id, name: labelNames.value[id] ?? "" })),
);

const error = ref("");
const showCategorySheet = ref(false);
const showTagSheet = ref(false);
const showIngredientSheet = ref(false);
const showLeaveConfirm = ref(false);

/** 用来判断「有没有未保存改动」的基线，编辑模式要等详情加载完才定格。 */
const initial = ref("");
const dirty = computed(() => snapshot() !== initial.value);

let keySeq = 0;
function nextKey(): number {
  return ++keySeq;
}

function snapshot(): string {
  return JSON.stringify(form.value);
}

function nameOf(store: RefStore, id: string): string {
  return toValue(store.items).find((item) => item.id === id)?.name ?? "";
}

function fill(detail: RecipeDetail): void {
  form.value = {
    name: detail.recipe.name,
    cover_path: detail.recipe.cover_path,
    category_id: detail.category.id,
    tag_ids: detail.tags.map((tag) => tag.id),
    steps: detail.steps.map((step) => ({
      key: nextKey(),
      text: step.text,
      image_path: step.image_path,
    })),
    ingredients: detail.ingredients.map((line) => ({
      key: nextKey(),
      ingredient_id: line.ingredient_id,
      ingredient_name: line.ingredient_name,
      amount: line.amount,
      unit_id: line.unit_id,
      unit_name: line.unit_name,
    })),
  };
  labelNames.value = Object.fromEntries(
    [detail.category, ...detail.tags].map((item): [string, string] => [item.id, item.name]),
  );
}

onMounted(async () => {
  const id = recipeId.value;
  if (id) {
    try {
      fill(await recipeStore.getDetail(id));
    } catch (loadError: unknown) {
      error.value = loadError instanceof Error ? loadError.message : "菜谱加载失败";
    }
  }
  initial.value = snapshot();
});

/** RefSheet 单选不自己关窗（R3），由这里把 visible 翻回去。 */
function selectCategory(ids: string[]): void {
  const id = ids[0];
  if (!id) return;
  form.value.category_id = id;
  labelNames.value = { ...labelNames.value, [id]: nameOf(categoryRefStore, id) };
  showCategorySheet.value = false;
}

function selectTags(ids: string[]): void {
  form.value.tag_ids = [...ids];
  const names = { ...labelNames.value };
  for (const id of ids) names[id] = nameOf(tagRefStore, id);
  labelNames.value = names;
  showTagSheet.value = false;
}

function removeTag(id: string): void {
  form.value.tag_ids = form.value.tag_ids.filter((tagId) => tagId !== id);
}

function addIngredient(payload: {
  ingredient_id: string;
  amount: number | null;
  unit_id: string | null;
}): void {
  form.value.ingredients.push({
    key: nextKey(),
    ingredient_id: payload.ingredient_id,
    ingredient_name: nameOf(ingredientStore, payload.ingredient_id),
    amount: payload.amount,
    unit_id: payload.unit_id,
    unit_name: payload.unit_id ? nameOf(unitStore, payload.unit_id) : null,
  });
}

function removeIngredient(index: number): void {
  form.value.ingredients.splice(index, 1);
}

function addStep(): void {
  form.value.steps.push({ key: nextKey(), text: "", image_path: null });
}

function removeStep(index: number): void {
  form.value.steps.splice(index, 1);
}

/** 上下移用按钮，不做拖拽——手机上拖拽会和 sheet 的滚动打架。 */
function moveStep(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= form.value.steps.length) return;
  const [step] = form.value.steps.splice(index, 1);
  form.value.steps.splice(target, 0, step);
}

type CleanedAmount = { ok: true; value: number | null } | { ok: false };

/** R6：正有限数才落库；0 与负数是有意为之，报错；非数字当空（null = 适量）。 */
function cleanAmount(value: number | null): CleanedAmount {
  if (value === null || !Number.isFinite(value)) return { ok: true, value: null };
  if (value <= 0) return { ok: false };
  return { ok: true, value };
}

type BuildResult = { input: RecipeInput } | { error: string };

function buildInput(): BuildResult {
  const name = form.value.name.trim();
  if (!name) return { error: "请输入菜名" };

  const ingredients: RecipeInput["ingredients"] = [];
  for (const line of form.value.ingredients) {
    const amount = cleanAmount(line.amount);
    if (!amount.ok) return { error: "数量要大于 0" };
    ingredients.push({
      ingredient_id: line.ingredient_id,
      amount: amount.value,
      unit_id: line.unit_id,
    });
  }

  return {
    input: {
      name,
      cover_path: form.value.cover_path,
      category_id: form.value.category_id,
      tag_ids: [...form.value.tag_ids],
      steps: form.value.steps
        .map((step) => ({ text: step.text.trim(), image_path: step.image_path }))
        .filter((step) => step.text !== ""),
      ingredients,
    },
  };
}

async function save(): Promise<void> {
  const built = buildInput();
  if ("error" in built) {
    error.value = built.error;
    return;
  }
  const input = built.input;
  if (!input.category_id) {
    error.value = "请选择分类";
    return;
  }
  error.value = "";

  let id = recipeId.value;
  try {
    if (id) await recipeStore.update(id, input);
    else id = await recipeStore.create(input);
  } catch (saveError: unknown) {
    error.value = saveError instanceof Error ? saveError.message : "保存失败";
    return;
  }
  await router.push(`/recipe/${id}`);
}

function goBack(): void {
  if (dirty.value) {
    showLeaveConfirm.value = true;
    return;
  }
  void router.back();
}

function leave(): void {
  showLeaveConfirm.value = false;
  void router.back();
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 pb-28 dark:bg-slate-900">
    <header class="flex items-center gap-2 px-4 py-3">
      <button
        type="button"
        data-test="back"
        aria-label="返回"
        class="flex h-9 w-9 items-center justify-center rounded-full text-xl text-slate-600 transition-colors hover:bg-gray-100 dark:text-slate-300"
        @click="goBack"
      >
        ←
      </button>
      <h1 class="text-lg font-semibold text-slate-900 dark:text-slate-50">
        {{ recipeId ? "编辑菜谱" : "新建菜谱" }}
      </h1>
    </header>

    <div class="flex flex-col gap-6 px-4">
      <label class="block">
        <span class="mb-1 block text-sm font-medium text-slate-900 dark:text-slate-100">菜名</span>
        <input
          v-model="form.name"
          data-test="name"
          type="text"
          placeholder="比如：红烧肉"
          class="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-50"
        />
      </label>

      <ImagePicker v-model="form.cover_path" />

      <button
        type="button"
        data-test="category-row"
        class="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm transition-colors hover:bg-gray-50 dark:border-slate-700 dark:hover:bg-slate-800"
        @click="showCategorySheet = true"
      >
        <span class="text-slate-500 dark:text-slate-400">分类</span>
        <span data-test="category-name" class="text-slate-900 dark:text-slate-50">
          {{ categoryName || "未选" }}
        </span>
      </button>

      <section>
        <button
          type="button"
          data-test="tag-row"
          class="flex w-full items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm transition-colors hover:bg-gray-50 dark:border-slate-700 dark:hover:bg-slate-800"
          @click="showTagSheet = true"
        >
          <span class="text-slate-500 dark:text-slate-400">标签</span>
          <span class="text-slate-900 dark:text-slate-50">
            {{ form.tag_ids.length > 0 ? `已选 ${form.tag_ids.length} 个` : "未选" }}
          </span>
        </button>
        <div v-if="tagRows.length > 0" class="mt-2 flex flex-wrap gap-2">
          <span
            v-for="tag in tagRows"
            :key="tag.id"
            data-test="tag-chip"
            class="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200"
          >
            <span data-test="tag-chip-name">{{ tag.name }}</span>
            <button
              type="button"
              data-test="tag-remove"
              :aria-label="`移除${tag.name}`"
              class="text-slate-500 hover:text-red-600"
              @click="removeTag(tag.id)"
            >
              ✕
            </button>
          </span>
        </div>
      </section>

      <section>
        <h2 class="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">食材</h2>
        <p
          v-if="form.ingredients.length === 0"
          class="rounded-xl border border-dashed border-gray-200 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
        >
          还没有食材
        </p>
        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="(line, index) in form.ingredients"
            :key="line.key"
            data-test="ingredient-row"
            class="flex items-center gap-3 rounded-xl bg-white px-3 py-2.5 text-sm shadow-sm dark:bg-slate-800"
          >
            <span
              data-test="ingredient-row-name"
              class="min-w-0 flex-1 truncate text-slate-900 dark:text-slate-50"
            >
              {{ line.ingredient_name }}
            </span>
            <span data-test="ingredient-row-amount" class="shrink-0 text-slate-500 dark:text-slate-400">
              {{ line.amount === null ? "适量" : line.amount }}{{ line.unit_name ? ` ${line.unit_name}` : "" }}
            </span>
            <button
              type="button"
              data-test="ingredient-row-remove"
              :aria-label="`删除${line.ingredient_name}`"
              class="shrink-0 text-slate-400 hover:text-red-600"
              @click="removeIngredient(index)"
            >
              ✕
            </button>
          </li>
        </ul>
        <button
          type="button"
          data-test="add-ingredient"
          class="mt-2 w-full rounded-xl border border-dashed border-gray-300 py-2.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 dark:border-slate-600 dark:hover:bg-slate-800"
          @click="showIngredientSheet = true"
        >
          + 添加食材
        </button>
      </section>

      <section>
        <h2 class="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">步骤</h2>
        <p
          v-if="form.steps.length === 0"
          class="rounded-xl border border-dashed border-gray-200 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
        >
          还没有步骤
        </p>
        <div
          v-for="(step, index) in form.steps"
          :key="step.key"
          data-test="step-row"
          class="mb-3 rounded-xl bg-white p-3 shadow-sm dark:bg-slate-800"
        >
          <div class="mb-2 flex items-center gap-2">
            <span
              data-test="step-order"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-200"
            >
              {{ index + 1 }}
            </span>
            <button
              type="button"
              data-test="step-up"
              :disabled="index === 0"
              aria-label="上移"
              class="rounded px-2 py-1 text-slate-500 disabled:opacity-30"
              @click="moveStep(index, -1)"
            >
              ↑
            </button>
            <button
              type="button"
              data-test="step-down"
              :disabled="index === form.steps.length - 1"
              aria-label="下移"
              class="rounded px-2 py-1 text-slate-500 disabled:opacity-30"
              @click="moveStep(index, 1)"
            >
              ↓
            </button>
            <button
              type="button"
              data-test="step-remove"
              class="ml-auto rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
              @click="removeStep(index)"
            >
              删除
            </button>
          </div>
          <textarea
            v-model="step.text"
            data-test="step-text"
            rows="2"
            placeholder="这一步做什么"
            class="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-50"
          ></textarea>
          <ImagePicker v-model="step.image_path" label="步骤图" />
        </div>
        <button
          type="button"
          data-test="add-step"
          class="w-full rounded-xl border border-dashed border-gray-300 py-2.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-50 dark:border-slate-600 dark:hover:bg-slate-800"
          @click="addStep"
        >
          + 添加步骤
        </button>
      </section>

      <p v-if="error" data-test="form-error" class="text-sm text-red-600">{{ error }}</p>
    </div>

    <div
      class="fixed inset-x-0 bottom-0 flex gap-3 border-t border-gray-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900"
    >
      <button
        type="button"
        data-test="cancel"
        class="flex-1 rounded-xl border border-gray-200 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-gray-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        @click="goBack"
      >
        取消
      </button>
      <button
        type="button"
        data-test="save"
        :disabled="!form.name.trim()"
        class="flex-1 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-slate-700"
        @click="save"
      >
        保存
      </button>
    </div>

    <RefSheet
      :visible="showCategorySheet"
      title="选择分类"
      :store="categoryRefStore"
      mode="single"
      :selected-ids="form.category_id ? [form.category_id] : []"
      empty-hint="还没有分类，点下面新建一个"
      @close="showCategorySheet = false"
      @select="selectCategory"
    />
    <RefSheet
      :visible="showTagSheet"
      title="选择标签"
      :store="tagRefStore"
      mode="multiple"
      :selected-ids="form.tag_ids"
      empty-hint="还没有标签，点下面新建一个"
      @close="showTagSheet = false"
      @select="selectTags"
    />
    <IngredientSheet
      :visible="showIngredientSheet"
      @close="showIngredientSheet = false"
      @add="addIngredient"
    />

    <ConfirmDialog
      :visible="showLeaveConfirm"
      title="放弃修改？"
      description="有未保存的改动，返回后不会保留。"
      confirm-text="放弃"
      cancel-text="继续编辑"
      danger
      @confirm="leave"
      @cancel="showLeaveConfirm = false"
    />
  </main>
</template>
