<script setup lang="ts">
// 录入/编辑共用一页：新建走 /recipe/new，编辑走 /recipe/:id/edit（规格 §6.2）。
// 字段顺序：菜名 → 封面图 → 分类 → 标签 → 食材 → 步骤 → 保存/取消。
//
// 页面负责 store 不做的两件事（裁决 R6）：提交前的输入清洗（菜名 trim、空步骤丢弃、
// 本地 key 剥掉、数量 0/负数报错）与「未保存就退出」的确认。
import { computed, onMounted, ref, toValue } from "vue";
import { useRoute, useRouter, onBeforeRouteLeave } from "vue-router";
import { Check } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import ImagePicker from "@/components/ImagePicker.vue";
import IngredientSheet from "@/components/IngredientSheet.vue";
import RefSheet from "@/components/RefSheet.vue";
import { useIngredientStore, useUnitStore } from "@/stores/ingredient";
import { useLabelStore } from "@/stores/label";
import { canEdit, useRecipeStore } from "@/stores/recipe";
import type { RefStore } from "@/stores/refStore";
import type { RecipeDetail, RecipeInput } from "@/types";
import { amountText } from "@/utils/amount";

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
  /** 开关是布尔；提交时转成协议里的 0 / 1（spec §3）。 */
  is_public: boolean;
  tag_ids: string[];
  steps: StepDraft[];
  ingredients: IngredientDraft[];
}

function emptyForm(): Form {
  return {
    name: "",
    cover_path: null,
    category_id: "",
    is_public: false,
    tag_ids: [],
    steps: [],
    ingredients: [],
  };
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
const saving = ref(false);
// 确认过的一次离页放行标记：守卫据此放行，别让对话框循环弹
const leaveConfirmed = ref(false);
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
    is_public: detail.recipe.is_public === 1,
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
      const loaded = await recipeStore.getDetail(id);
      // 没有修改权限（别人的菜谱）：退回详情页，别让用户白编一通
      if (!canEdit(loaded.recipe)) {
        initial.value = snapshot(); // 先定格基线，否则离页守卫会拦住这次 replace
        await router.replace(`/recipe/${id}`);
        return;
      }
      fill(loaded);
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
      is_public: form.value.is_public ? 1 : 0,
      tag_ids: [...form.value.tag_ids],
      steps: form.value.steps
        .map((step) => ({ text: step.text.trim(), image_path: step.image_path }))
        .filter((step) => step.text !== ""),
      ingredients,
    },
  };
}

async function save(): Promise<void> {
  if (saving.value) return;
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

  saving.value = true;
  let id = recipeId.value;
  try {
    if (id) await recipeStore.update(id, input);
    else id = await recipeStore.create(input);
  } catch (saveError: unknown) {
    error.value = saveError instanceof Error ? saveError.message : "保存失败";
    return;
  } finally {
    // 失败也要放开：用户可能只是想改一下重试
    saving.value = false;
  }
  // 已落库，表单不再是「有未保存改动」，否则离页守卫会把保存后的跳转拦下来
  initial.value = snapshot();
  // 保存后回到「来处」：从详情页进来的编辑用 back() 弹掉编辑页，否则历史会叠成
  // 列表→详情→编辑→详情，返回键要按三次；新建用 replace()，免得退回一张空表单。
  if (recipeId.value && route.query.from === "detail") await router.back();
  else await router.replace(`/recipe/${id}`);
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
  // 放行守卫：确认过的一次离页只能放一次
  leaveConfirmed.value = true;
  void router.back();
}

// Android 的硬件返回键不经过页内按钮，只有路由守卫能拦住它（规格 §6.2）
onBeforeRouteLeave(() => {
  if (!dirty.value || leaveConfirmed.value) return true;
  showLeaveConfirm.value = true;
  return false;
});
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader :title="recipeId ? '编辑菜谱' : '新建菜谱'" show-back @back="goBack">
      <template #action>
        <button
          type="button"
          data-test="save"
          aria-label="保存"
          :disabled="!form.name.trim() || saving"
          class="flex h-8 w-8 items-center justify-center rounded-full disabled:opacity-30"
          @click="save"
        >
          <Check :size="20" class="text-primary" />
        </button>
      </template>
    </AppHeader>

    <div class="flex flex-1 min-h-0 flex-col gap-6 overflow-auto px-4 py-4">
      <label class="block">
        <span class="mb-1 block text-xs text-text-secondary">菜名</span>
        <input
          v-model="form.name"
          data-test="name"
          type="text"
          placeholder="比如：红烧肉"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
      </label>

      <ImagePicker v-model="form.cover_path" />

      <button
        type="button"
        data-test="category-row"
        class="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm transition-colors hover:bg-gray-50"
        @click="showCategorySheet = true"
      >
        <span class="text-text-secondary">分类</span>
        <span data-test="category-name" class="text-text">
          {{ categoryName || "未选" }}
        </span>
      </button>

      <section>
        <button
          type="button"
          data-test="tag-row"
          class="flex w-full items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm transition-colors hover:bg-gray-50"
          @click="showTagSheet = true"
        >
          <span class="text-text-secondary">标签</span>
          <span class="text-text">
            {{ form.tag_ids.length > 0 ? `已选 ${form.tag_ids.length} 个` : "未选" }}
          </span>
        </button>
        <div v-if="tagRows.length > 0" class="mt-2 flex flex-wrap gap-2">
          <span
            v-for="tag in tagRows"
            :key="tag.id"
            data-test="tag-chip"
            class="flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs text-text"
          >
            <span data-test="tag-chip-name">{{ tag.name }}</span>
            <button
              type="button"
              data-test="tag-remove"
              :aria-label="`移除${tag.name}`"
              class="text-text-secondary hover:text-danger"
              @click="removeTag(tag.id)"
            >
              ✕
            </button>
          </span>
        </div>
      </section>

      <label
        class="flex items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm"
      >
        <span class="text-text-secondary">公开到社区</span>
        <input
          v-model="form.is_public"
          data-test="recipe-public"
          type="checkbox"
          class="h-5 w-5 accent-primary"
        />
      </label>

      <section>
        <h2 class="mb-2 text-xs font-medium text-text-secondary">食材</h2>
        <p
          v-if="form.ingredients.length === 0"
          class="rounded-lg border border-dashed border-gray-300 py-6 text-center text-sm text-text-secondary"
        >
          还没有食材
        </p>
        <ul v-else class="flex flex-col gap-2">
          <li
            v-for="(line, index) in form.ingredients"
            :key="line.key"
            data-test="ingredient-row"
            class="flex items-center gap-3 rounded-xl bg-surface px-3 py-2.5 text-sm"
          >
            <span
              data-test="ingredient-row-name"
              class="min-w-0 flex-1 truncate text-text"
            >
              {{ line.ingredient_name }}
            </span>
            <span data-test="ingredient-row-amount" class="shrink-0 text-text-secondary">
              {{ amountText(line) }}
            </span>
            <button
              type="button"
              data-test="ingredient-row-remove"
              :aria-label="`删除${line.ingredient_name}`"
              class="shrink-0 text-text-secondary hover:text-danger"
              @click="removeIngredient(index)"
            >
              ✕
            </button>
          </li>
        </ul>
        <button
          type="button"
          data-test="add-ingredient"
          class="mt-2 w-full rounded-lg border border-dashed border-gray-300 py-2.5 text-sm font-medium text-primary hover:bg-primary/10"
          @click="showIngredientSheet = true"
        >
          + 添加食材
        </button>
      </section>

      <section>
        <h2 class="mb-2 text-xs font-medium text-text-secondary">步骤</h2>
        <p
          v-if="form.steps.length === 0"
          class="rounded-lg border border-dashed border-gray-300 py-6 text-center text-sm text-text-secondary"
        >
          还没有步骤
        </p>
        <div
          v-for="(step, index) in form.steps"
          :key="step.key"
          data-test="step-row"
          class="mb-3 rounded-xl bg-surface p-3"
        >
          <div class="mb-2 flex items-center gap-2">
            <span
              data-test="step-order"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-text-secondary"
            >
              {{ index + 1 }}
            </span>
            <button
              type="button"
              data-test="step-up"
              :disabled="index === 0"
              aria-label="上移"
              class="rounded px-2 py-1 text-text-secondary disabled:opacity-30"
              @click="moveStep(index, -1)"
            >
              ↑
            </button>
            <button
              type="button"
              data-test="step-down"
              :disabled="index === form.steps.length - 1"
              aria-label="下移"
              class="rounded px-2 py-1 text-text-secondary disabled:opacity-30"
              @click="moveStep(index, 1)"
            >
              ↓
            </button>
            <button
              type="button"
              data-test="step-remove"
              class="ml-auto rounded px-2 py-1 text-xs text-danger hover:bg-danger/10"
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
            class="mb-3 w-full rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
          ></textarea>
          <ImagePicker v-model="step.image_path" label="步骤图" />
        </div>
        <button
          type="button"
          data-test="add-step"
          class="w-full rounded-lg border border-dashed border-gray-300 py-2.5 text-sm font-medium text-primary hover:bg-primary/10"
          @click="addStep"
        >
          + 添加步骤
        </button>
      </section>

      <p v-if="error" data-test="form-error" class="text-sm text-danger">{{ error }}</p>
    </div>

    <RefSheet
      :visible="showCategorySheet"
      title="选择分类"
      :store="categoryRefStore"
      mode="single"
      :selected-ids="form.category_id ? [form.category_id] : []"
      empty-hint="还没有分类，输入名称即可新建"
      @close="showCategorySheet = false"
      @select="selectCategory"
    />
    <RefSheet
      :visible="showTagSheet"
      title="选择标签"
      :store="tagRefStore"
      mode="multiple"
      :selected-ids="form.tag_ids"
      empty-hint="还没有标签，输入名称即可新建"
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
  </div>
</template>
