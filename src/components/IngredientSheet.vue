<script setup lang="ts">
import { computed, ref, toValue, watch } from "vue";
import RefSheet from "@/components/RefSheet.vue";
import { useKeyboardInset } from "@/composables/useKeyboardInset";
import { useIngredientStore, useUnitStore } from "@/stores/ingredient";

const props = defineProps<{ visible: boolean }>();

const emit = defineEmits<{
  close: [];
  add: [payload: { ingredient_id: string; amount: number | null; unit_id: string | null }];
}>();

// Pinia setup store 的 items 被解包成裸数组，RefSheet 用 toValue 读，直接当 store 传即可（R12）
const ingredientStore = useIngredientStore();
const unitStore = useUnitStore();

// 软键盘高度：与 RefSheet 同一套 insets 处理
const keyboardInset = useKeyboardInset();
// 键盘高度 + 常规内边距 + 手势导航条的安全区，底不贴系统栏
const panelPadBottom = computed(
  () => `calc(${keyboardInset.value}px + 2rem + env(safe-area-inset-bottom))`,
);

// 两步一个面板：pick 复用 RefSheet 的列表/筛选/新建，amount 是本组件自己的
const step = ref<"pick" | "amount">("pick");
const ingredientId = ref("");
// v-model 在 type="number" 上写回的是 number，清空时是 ""，所以两种都要收
const amountText = ref<string | number>("");
const unitId = ref<string | null>(null);
const showUnitSheet = ref(false);
const amountError = ref("");

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
    amountError.value = "";
  },
  { immediate: true },
);

/** RefSheet 单选模式的 select 就是「这一步定了」，退到第二步。 */
function pickIngredient(ids: string[]): void {
  const picked = ids[0] ?? "";
  if (!picked) return;
  ingredientId.value = picked;
  amountText.value = "";
  unitId.value = null;
  amountError.value = "";
  step.value = "amount";
}

function pickUnit(ids: string[]): void {
  unitId.value = ids[0] ?? null;
  showUnitSheet.value = false;
}

type Amount = { ok: true; value: number | null } | { ok: false };

/** R6：0 与负数是有意为之，报错；非数字（粘进来的 "abc"）当空。 */
function parseAmount(text: string | number): Amount {
  const trimmed = String(text).trim();
  if (!trimmed) return { ok: true, value: null };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { ok: true, value: null };
  if (parsed <= 0) return { ok: false };
  return { ok: true, value: parsed };
}

function confirm(): void {
  const amount = parseAmount(amountText.value);
  if (!amount.ok) {
    amountError.value = "数量要大于 0";
    return;
  }
  amountError.value = "";
  emit("add", { ingredient_id: ingredientId.value, amount: amount.value, unit_id: unitId.value });
  emit("close");
}
</script>

<template>
  <!-- 第二步的弹层；第一步由 RefSheet 自己弹。
       这一层必须永远低于 RefSheet 的遮罩/面板（z-40 / z-50）：单位选择器是在本层之上打开的，
       z 值相同时本层会盖在单位遮罩之上，露出的 ✕ / 数量 / 确定 就既不变暗也拦不住点击。 -->
  <Teleport to="body">
    <Transition name="sheet-fade">
      <div
        v-if="visible && step === 'amount'"
        class="fixed inset-0 z-20 bg-black/40"
        @click="emit('close')"
      />
    </Transition>

    <Transition name="sheet-slide-up">
      <div
        v-if="visible && step === 'amount'"
        class="fixed inset-x-0 bottom-0 z-30 flex max-h-[85vh] flex-col rounded-t-2xl bg-surface px-4 pt-4 shadow-xl"
        :style="{ paddingBottom: panelPadBottom }"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">{{ ingredientName }}</h2>
          <button
            data-test="ingredient-close"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-gray-100"
            aria-label="关闭"
            @click="emit('close')"
          >
            ✕
          </button>
        </div>

        <label class="block text-sm font-medium text-text-secondary">
          数量
          <input
            v-model="amountText"
            data-test="ingredient-amount"
            type="number"
            inputmode="decimal"
            placeholder="留空表示适量"
            class="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />
        </label>
        <p v-if="amountError" data-test="ingredient-amount-error" class="mt-2 text-sm text-danger">
          {{ amountError }}
        </p>

        <button
          data-test="ingredient-unit"
          class="mt-4 flex items-center justify-between rounded-xl border border-gray-200 px-3 py-3 text-sm transition-colors hover:bg-gray-50"
          @click="showUnitSheet = true"
        >
          <span class="text-text-secondary">单位</span>
          <span class="text-text">{{ unitName || "未选" }}</span>
        </button>

        <button
          data-test="ingredient-confirm"
          class="mt-4 w-full rounded-xl bg-primary py-3 text-base font-semibold text-white transition-colors hover:bg-primary-dark"
          @click="confirm"
        >
          确定
        </button>
      </div>
    </Transition>
  </Teleport>

  <!-- 第一步：选食材。选中那一刻 RefSheet 发 select，我们据此切第二步 -->
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

  <!-- 第二步的「单位」行：单位 sheet 关掉只回第二步，不关整个面板 -->
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
