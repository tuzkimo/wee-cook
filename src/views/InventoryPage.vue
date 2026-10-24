<script setup lang="ts">
// 库存页（spec §6.3）：按食材汇总余量，展开看每批次。
// 余量全部由 store 从「批次数量 − 使用记录」派生，这一页不自己算账。
import { computed, onMounted, ref } from "vue";
import { Plus, Trash2 } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import BatchSheet from "@/components/BatchSheet.vue";
import TeamSwitcher from "@/components/TeamSwitcher.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import { useInventoryStore } from "@/stores/inventory";
import { useTeamStore } from "@/stores/team";
import type { BatchStock, IngredientStock } from "@/types";
import { expiryState, groupStockRows, localToday, sortStockRows } from "@/utils/inventory";

const store = useInventoryStore();
// 团队缓存要就绪，页头的切换器才有选项（未登录时它自己整块不渲染）
const team = useTeamStore();

const showSheet = ref(false);
// 展开状态是本页内存态：用数组而不是 Set，改一次就是新数组，模板自然重渲染
const expanded = ref<string[]>([]);
const pendingDelete = ref<BatchStock | null>(null);
const deleteError = ref("");

const today = localToday(new Date());
const rows = computed(() => sortStockRows(groupStockRows(store.batches)));

onMounted(async () => {
  // 冷启动：先恢复团队缓存与上次选中的范围，再按范围查库存
  if (team.teams.length === 0) await team.load().catch(() => {});
  await team.restoreCurrentTeam();
  await store.fetchAll();
});

function toggle(ingredientId: string): void {
  expanded.value = expanded.value.includes(ingredientId)
    ? expanded.value.filter((id) => id !== ingredientId)
    : [...expanded.value, ingredientId];
}

function batchesOf(ingredientId: string): BatchStock[] {
  return store.batches.filter((item) => item.batch.ingredient_id === ingredientId);
}

/** 0.1 + 0.2 这类浮点尾巴不显示出来 */
function trimNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

function amountText(row: IngredientStock): string {
  return row.parts
    .map((part) => `${trimNumber(part.remaining)}${part.unit_name ? ` ${part.unit_name}` : ""}`)
    .join("、");
}

function badgeOf(row: IngredientStock): "expired" | "soon" | "none" {
  return row.usedUp ? "none" : expiryState(row.soonest_expires_at, today);
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  pendingDelete.value = null;
  if (!target) return;
  deleteError.value = "";
  try {
    await store.removeBatch(target.batch.id);
  } catch (error: unknown) {
    deleteError.value =
      error instanceof Error && error.message ? error.message : "删除失败，请重试";
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="食材库存">
      <template #action>
        <button
          type="button"
          data-test="inventory-add"
          aria-label="录入批次"
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="showSheet = true"
        >
          <Plus :size="20" class="text-text" />
        </button>
      </template>
    </AppHeader>

    <!-- 范围切换器：库存是一本按范围分开的账（spec §10.2） -->
    <div class="flex shrink-0 items-center border-b border-gray-100 bg-surface px-4 py-2">
      <TeamSwitcher />
    </div>

    <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
      <p
        v-if="deleteError"
        data-test="inventory-error"
        class="mb-2 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger"
      >
        {{ deleteError }}
      </p>

      <p v-if="rows.length === 0" class="text-sm text-text-secondary">
        还没有库存，点右上角加号记一批
      </p>

      <ul v-else class="flex flex-col gap-2">
        <li v-for="row in rows" :key="row.ingredient_id">
          <button
            type="button"
            data-test="stock-row"
            class="flex w-full items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 text-left transition-colors hover:bg-gray-50"
            @click="toggle(row.ingredient_id)"
          >
            <span class="flex min-w-0 flex-1 items-center gap-2">
              <span data-test="stock-name" class="truncate text-sm text-text">
                {{ row.ingredient_name }}
              </span>
              <span
                v-if="badgeOf(row) === 'expired'"
                data-test="stock-expired"
                class="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger"
              >
                已过期
              </span>
              <span
                v-else-if="badgeOf(row) === 'soon'"
                data-test="stock-expiring"
                class="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger"
              >
                快过期
              </span>
            </span>
            <span class="shrink-0 text-xs text-text-secondary">
              <span v-if="row.usedUp" data-test="stock-used-up">已用完</span>
              <span v-else data-test="stock-amount">{{ amountText(row) }}</span>
            </span>
          </button>

          <ul
            v-if="expanded.includes(row.ingredient_id)"
            class="mt-1 ml-2 flex flex-col border-l border-gray-100 pl-3"
          >
            <li
              v-for="item in batchesOf(row.ingredient_id)"
              :key="item.batch.id"
              data-test="stock-batch"
              class="flex items-center justify-between gap-3 py-2"
            >
              <div class="min-w-0 flex-1 text-xs text-text-secondary">
                <p class="text-text">
                  {{ trimNumber(item.remaining) }} {{ item.unit_name ?? ""
                  }}<span class="text-text-secondary"> / 共 {{ trimNumber(item.batch.amount) }}</span>
                </p>
                <p>
                  生产 {{ item.batch.produced_at ?? "没记" }} · 过期
                  {{ item.batch.expires_at ?? "没记" }}
                </p>
              </div>
              <button
                type="button"
                data-test="stock-batch-delete"
                aria-label="删除这一批"
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-gray-100"
                @click="pendingDelete = item"
              >
                <Trash2 :size="16" class="text-danger" />
              </button>
            </li>
          </ul>
        </li>
      </ul>
    </div>

    <BatchSheet :visible="showSheet" @close="showSheet = false" @saved="store.fetchAll()" />

    <ConfirmDialog
      :visible="pendingDelete !== null"
      title="删除这一批？"
      description="删掉这一批后，它不再计入库存。已经用掉的记录会保留。"
      confirm-text="删除"
      danger
      @cancel="pendingDelete = null"
      @confirm="confirmDelete"
    />
  </div>
</template>
