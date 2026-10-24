<script setup lang="ts">
import { computed, ref, toValue, watch } from "vue";
import RefSheet from "@/components/RefSheet.vue";
import { useKeyboardInset } from "@/composables/useKeyboardInset";
import { useIngredientStore, useUnitStore } from "@/stores/ingredient";
import { useInventoryStore } from "@/stores/inventory";
import { computeExpiresAt } from "@/utils/inventory";

const props = defineProps<{ visible: boolean }>();

const emit = defineEmits<{ close: []; saved: [] }>();

const ingredientStore = useIngredientStore();
const unitStore = useUnitStore();
const inventoryStore = useInventoryStore();

// 软键盘高度：与 IngredientSheet 同一套 insets 处理
const keyboardInset = useKeyboardInset();
const panelPadBottom = computed(
  () => `calc(${keyboardInset.value}px + 2rem + env(safe-area-inset-bottom))`,
);

// 两步一个面板：pick 复用 RefSheet 选食材，form 是本组件自己的
const step = ref<"pick" | "form">("pick");
const ingredientId = ref("");
const amountText = ref<string | number>("");
const unitId = ref<string | null>(null);
const producedAt = ref("");
const shelfLifeText = ref<string | number>("");
const expiresAt = ref("");
// 手改过期日后不再被自动值覆盖；清空过期日就恢复自动（spec §6.4）
const expiryTouched = ref(false);
const showUnitSheet = ref(false);
const error = ref("");
// 保存中禁用按钮：双击会真的买两批一样的东西
const saving = ref(false);

const ingredientName = computed(
  () => toValue(ingredientStore.items).find((item) => item.id === ingredientId.value)?.name ?? "",
);
const unitName = computed(
  () => toValue(unitStore.items).find((item) => item.id === unitId.value)?.name ?? "",
);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) {
      showUnitSheet.value = false;
      return;
    }
    // 每次打开都从第一步开始，上一轮的草稿不留
    step.value = "pick";
    ingredientId.value = "";
    amountText.value = "";
    unitId.value = null;
    producedAt.value = "";
    shelfLifeText.value = "";
    expiresAt.value = "";
    expiryTouched.value = false;
    error.value = "";
    saving.value = false;
  },
  { immediate: true },
);

/** 保质期天数：空或非数字都当成「没填」，交给 store 判正数 */
function shelfLifeDays(): number | null {
  const text = String(shelfLifeText.value).trim();
  return text === "" ? null : Number(text);
}

// 生产日期 / 保质期天数一变就重算过期日；用户手改过就不再动它
watch([producedAt, shelfLifeText], () => {
  if (expiryTouched.value) return;
  const days = shelfLifeDays();
  expiresAt.value = computeExpiresAt(producedAt.value || null, days) ?? "";
});

function onExpiresInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  expiryTouched.value = value !== "";
  // 清空即恢复自动计算：立刻按当前生产日期与保质期重算一次
  expiresAt.value = expiryTouched.value
    ? value
    : (computeExpiresAt(producedAt.value || null, shelfLifeDays()) ?? "");
}

/** RefSheet 单选模式的 select 就是「这一步定了」 */
function pickIngredient(ids: string[]): void {
  const picked = ids[0] ?? "";
  if (!picked) return;
  ingredientId.value = picked;
  error.value = "";
  step.value = "form";
}

function pickUnit(ids: string[]): void {
  unitId.value = ids[0] ?? null;
  showUnitSheet.value = false;
}

async function save(): Promise<void> {
  if (saving.value) return;
  error.value = "";
  saving.value = true;
  try {
    await inventoryStore.addBatch({
      ingredient_id: ingredientId.value,
      amount: Number(amountText.value),
      unit_id: unitId.value,
      produced_at: producedAt.value || null,
      shelf_life_days: shelfLifeDays(),
      expires_at: expiresAt.value || null,
    });
    saving.value = false;
  } catch (saveError: unknown) {
    // 校验与写库错误都由 store 给出中文文案，这里不重复一份规则
    error.value =
      saveError instanceof Error && saveError.message ? saveError.message : "保存失败，请重试";
    saving.value = false;
    return;
  }
  emit("saved");
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-fade">
      <div v-if="visible && step === 'form'" class="fixed inset-0 z-20 bg-black/40" @click="emit('close')" />
    </Transition>

    <Transition name="sheet-slide-up">
      <div
        v-if="visible && step === 'form'"
        class="fixed inset-x-0 bottom-0 z-30 flex max-h-[85vh] flex-col rounded-t-2xl bg-surface px-4 pt-4 shadow-xl"
        :style="{ paddingBottom: panelPadBottom }"
      >
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">{{ ingredientName }}</h2>
          <button
            data-test="batch-close"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-gray-100"
            aria-label="关闭"
            @click="emit('close')"
          >
            ✕
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-auto">
          <label class="block text-sm font-medium text-text-secondary">
            数量
            <input
              v-model="amountText"
              data-test="batch-amount"
              type="number"
              inputmode="decimal"
              placeholder="这次买了多少"
              class="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
            />
          </label>

          <button
            data-test="batch-unit"
            class="mt-3 flex w-full items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm transition-colors hover:bg-gray-50"
            @click="showUnitSheet = true"
          >
            <span class="text-text-secondary">单位</span>
            <span class="text-text">{{ unitName || "未选" }}</span>
          </button>

          <label class="mt-3 block text-sm font-medium text-text-secondary">
            生产日期
            <input
              v-model="producedAt"
              data-test="batch-produced"
              type="date"
              class="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
            />
          </label>

          <label class="mt-3 block text-sm font-medium text-text-secondary">
            保质期（天）
            <input
              v-model="shelfLifeText"
              data-test="batch-shelf-life"
              type="number"
              inputmode="numeric"
              placeholder="留空就自己填过期日"
              class="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
            />
          </label>

          <label class="mt-3 block text-sm font-medium text-text-secondary">
            过期日
            <input
              :value="expiresAt"
              data-test="batch-expires"
              type="date"
              class="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
              @input="onExpiresInput"
            />
          </label>
          <p class="mt-1 text-xs text-text-secondary">填了生产日期和保质期就自动算，也可以自己改</p>
        </div>

        <p v-if="error" data-test="batch-error" class="mt-3 text-sm text-danger">{{ error }}</p>

        <button
          data-test="batch-save"
          :disabled="saving"
          class="mt-3 w-full rounded-xl bg-primary py-3 text-base font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
          @click="save"
        >
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </div>
    </Transition>
  </Teleport>

  <!-- 第一步：选食材。选中那一刻 RefSheet 发 select，我们据此切表单 -->
  <RefSheet
    :visible="visible && step === 'pick'"
    title="选择食材"
    :store="ingredientStore"
    mode="single"
    :selected-ids="[]"
    empty-hint="还没有食材，输入名称即可新建"
    @close="emit('close')"
    @select="pickIngredient"
  />

  <RefSheet
    :visible="visible && showUnitSheet"
    title="选择单位"
    :store="unitStore"
    mode="single"
    :selected-ids="unitId ? [unitId] : []"
    empty-hint="还没有单位，输入名称即可新建"
    @close="showUnitSheet = false"
    @select="pickUnit"
  />
</template>
