<script setup lang="ts">
// 制作消耗页（spec §6.5）：菜谱食材预填成表单，改完确认就按最早过期优先扣库存。
// 「填 0 = 这次不用这个食材」比多一个复选框少一次点击（spec §4.6）。
import { computed, onMounted, ref, toValue } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import { useKeyboardInset } from "@/composables/useKeyboardInset";
import RefSheet from "@/components/RefSheet.vue";
import { useUnitStore } from "@/stores/ingredient";
import { useInventoryStore } from "@/stores/inventory";
import { useRecipeStore } from "@/stores/recipe";
import type { CookResult } from "@/types";

interface CookRow {
  ingredient_id: string;
  ingredient_name: string;
  unit_id: string | null;
  unit_name: string | null;
  /** 输入框里的原文：菜谱「适量」的行预填空 */
  amountText: string;
}

const route = useRoute();
const router = useRouter();
const recipeStore = useRecipeStore();
const inventoryStore = useInventoryStore();
const unitStore = useUnitStore();

const recipeId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));
const rows = ref<CookRow[]>([]);
const result = ref<CookResult | null>(null);
const error = ref("");
const confirming = ref(false);
const showUnitSheet = ref(false);
const unitRowIndex = ref(0);
const loadError = ref("");
const keyboardInset = useKeyboardInset();
// 键盘高度 + 常规内边距 + 手势条安全区，与 RefSheet / FilterPage 同一套（Android 上 h-dvh 不收缩）
const actionsPadBottom = computed(
  () => `calc(${keyboardInset.value}px + 0.75rem + env(safe-area-inset-bottom))`,
);

/** 该食材各单位余量，进页面查一次，改单位时不再查库 */
let availability = new Map<string, { unit_id: string | null; remaining: number }[]>();

onMounted(async () => {
  const id = recipeId.value;
  if (!id) {
    loadError.value = "菜谱不存在";
    return;
  }
  // 单位名全靠这张字典：不查回来，切到别的单位时只能显示「选单位」
  await unitStore.fetchAll();
  await inventoryStore.fetchAll();
  let detail;
  try {
    detail = await recipeStore.getDetail(id);
  } catch (failure: unknown) {
    // 缓存的社区菜谱会被同步物理删除，这里不能白屏
    loadError.value = failure instanceof Error && failure.message ? failure.message : "菜谱不存在";
    return;
  }
  availability = inventoryStore.remainingByIngredient(detail.ingredients.map((line) => line.ingredient_id));
  rows.value = detail.ingredients.map((line) => {
    const parts = availability.get(line.ingredient_id) ?? [];
    const own = parts.find((part) => part.unit_id === line.unit_id);
    // 菜谱单位没货、别的单位有货时直接切过去：不然「2 个」永远扣不掉「500 g」（spec §4.19）
    const fallback = own || parts.length === 0 ? null : pickRichest(parts);
    return {
      ingredient_id: line.ingredient_id,
      ingredient_name: line.ingredient_name,
      unit_id: fallback ? fallback.unit_id : line.unit_id,
      unit_name: fallback ? unitName(fallback.unit_id) : line.unit_name,
      amountText: line.amount === null ? "" : String(line.amount),
    };
  });
});

function pickRichest(
  parts: { unit_id: string | null; remaining: number }[],
): { unit_id: string | null; remaining: number } {
  return [...parts].sort((a, b) => {
    if (a.remaining !== b.remaining) return b.remaining - a.remaining;
    const nameA = unitName(a.unit_id) ?? "";
    const nameB = unitName(b.unit_id) ?? "";
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  })[0];
}

function unitName(unitId: string | null): string | null {
  if (!unitId) return null;
  return toValue(unitStore.items).find((item) => item.id === unitId)?.name ?? null;
}

/** "abc"、""、"-1" 都当 0：负数与空都不扣 */
function amountOf(row: CookRow): number {
  const parsed = Number(String(row.amountText).trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function remainingOf(row: CookRow): number {
  const parts = availability.get(row.ingredient_id) ?? [];
  return parts.find((part) => part.unit_id === row.unit_id)?.remaining ?? 0;
}

function availableText(row: CookRow): string {
  const amount = Number(remainingOf(row).toFixed(2));
  return `库存 ${amount}${row.unit_name ? ` ${row.unit_name}` : ""}`;
}

const canConfirm = computed(() => rows.value.some((row) => amountOf(row) > 0));
const hasShortfall = computed(() =>
  rows.value.some((row) => {
    const want = amountOf(row);
    return want > 0 && want > remainingOf(row);
  }),
);

function openUnitSheet(index: number): void {
  unitRowIndex.value = index;
  showUnitSheet.value = true;
}

function pickUnit(ids: string[]): void {
  const picked = ids[0] ?? "";
  const row = rows.value[unitRowIndex.value];
  if (picked && row) {
    row.unit_id = picked;
    row.unit_name = unitName(picked);
  }
  showUnitSheet.value = false;
}

async function confirm(): Promise<void> {
  if (!canConfirm.value || confirming.value) return;
  error.value = "";
  confirming.value = true;
  try {
    result.value = await inventoryStore.commitCook(
      recipeId.value,
      rows.value
        .filter((row) => amountOf(row) > 0)
        .map((row) => ({
          ingredient_id: row.ingredient_id,
          ingredient_name: row.ingredient_name,
          unit_id: row.unit_id,
          unit_name: row.unit_name,
          amount: amountOf(row),
        })),
    );
  } catch (failure: unknown) {
    error.value =
      failure instanceof Error && failure.message ? failure.message : "没记成功，再试一次";
  } finally {
    confirming.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="制作" show-back @back="router.back()" />

    <template v-if="result">
      <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
        <p class="text-base font-semibold text-text">已记录</p>
        <ul v-if="result.deducted.length > 0" data-test="cook-deducted" class="mt-3 flex flex-col gap-1">
          <li v-for="(item, index) in result.deducted" :key="index" class="text-sm text-text">
            {{ item.ingredient_name }} 扣了 {{ item.amount }}{{ item.unit_name ? ` ${item.unit_name}` : "" }}
          </li>
        </ul>
        <ul v-if="result.shortfall.length > 0" data-test="cook-shortfall" class="mt-3 flex flex-col gap-1">
          <li v-for="(item, index) in result.shortfall" :key="index" class="text-sm text-danger">
            {{ item.ingredient_name }} 还差 {{ item.missing }}{{ item.unit_name ? ` ${item.unit_name}` : "" }}（库存已扣完）
          </li>
        </ul>
        <p v-if="result.deducted.length === 0" class="mt-3 text-sm text-text-secondary">
          没有可扣的库存，这次没有记账
        </p>
      </div>
      <div data-test="cook-actions" class="shrink-0 px-4 py-3" :style="{ paddingBottom: actionsPadBottom }">
        <button
          type="button"
          data-test="cook-done"
          class="w-full rounded-xl bg-primary py-3 text-base font-semibold text-white transition-colors hover:bg-primary-dark"
          @click="router.back()"
        >
          完成
        </button>
      </div>
    </template>

    <template v-else>
      <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
        <p
          v-if="loadError"
          data-test="cook-load-error"
          class="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {{ loadError }}
        </p>
        <p v-else class="mb-3 text-xs text-text-secondary">按实际用量改，填 0 表示这次不用这样</p>

        <p
          v-if="error"
          data-test="cook-error"
          class="mb-3 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {{ error }}
        </p>

        <ul class="flex flex-col gap-2">
          <li
            v-for="(row, index) in rows"
            :key="`${row.ingredient_id}-${index}`"
            data-test="cook-row"
            class="rounded-xl bg-surface px-4 py-3"
          >
            <div class="flex items-center justify-between gap-3">
              <span data-test="cook-name" class="min-w-0 flex-1 truncate text-sm text-text">
                {{ row.ingredient_name }}
              </span>
              <span data-test="cook-available" class="shrink-0 text-xs text-text-secondary">
                {{ availableText(row) }}
              </span>
            </div>
            <div class="mt-2 flex items-center gap-2">
              <input
                v-model="row.amountText"
                data-test="cook-amount"
                type="number"
                inputmode="decimal"
                placeholder="用量"
                class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-text outline-none focus:border-primary"
              />
              <button
                type="button"
                data-test="cook-unit"
                class="shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-sm text-text transition-colors hover:bg-gray-50"
                @click="openUnitSheet(index)"
              >
                {{ row.unit_name || "选单位" }}
              </button>
            </div>
          </li>
        </ul>

        <p v-if="hasShortfall" data-test="cook-shortfall-hint" class="mt-3 text-sm text-danger">
          有几行库存不够，确认后只扣现有的
        </p>
      </div>

      <div data-test="cook-actions" class="shrink-0 px-4 py-3" :style="{ paddingBottom: actionsPadBottom }">
        <button
          type="button"
          data-test="cook-confirm"
          :disabled="!canConfirm || confirming"
          class="w-full rounded-xl bg-primary py-3 text-base font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
          @click="confirm"
        >
          确认制作
        </button>
      </div>
    </template>

    <RefSheet
      :visible="showUnitSheet"
      title="选择单位"
      :store="unitStore"
      mode="single"
      :selected-ids="[]"
      empty-hint="还没有单位，输入名称即可新建"
      @close="showUnitSheet = false"
      @select="pickUnit"
    />
  </div>
</template>
