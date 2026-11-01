<script setup lang="ts">
// 制作流水（spec §6.4）：某道菜历次制作，点右上角加号才进表单。
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Plus } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import UserAvatar from "@/components/UserAvatar.vue";
import { useInventoryStore } from "@/stores/inventory";
import type { CookRecordDetail } from "@/types";
import { formatLocalDateTime } from "@/utils/time";

const route = useRoute();
const router = useRouter();
const store = useInventoryStore();

const recipeId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));
const records = ref<CookRecordDetail[]>([]);

onMounted(async () => {
  records.value = await store.fetchCookRecords(recipeId.value);
});

function open(item: CookRecordDetail): void {
  void router.push(`/recipe/${recipeId.value}/cook/${item.record.id}`);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="制作记录" show-back @back="router.back()">
      <template #action>
        <button
          type="button"
          data-test="cook-record-add"
          aria-label="新增制作记录"
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="router.push(`/recipe/${recipeId}/cook/new`)"
        >
          <Plus :size="20" class="text-text" />
        </button>
      </template>
    </AppHeader>

    <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
      <p v-if="records.length === 0" data-test="cook-records-empty" class="text-sm text-text-secondary">
        还没有制作记录，点右上角加号记一次
      </p>

      <ul v-else class="flex flex-col gap-2">
        <li v-for="item in records" :key="item.record.id">
          <button
            type="button"
            data-test="cook-record"
            class="flex w-full items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 text-left transition-colors hover:bg-gray-50"
            @click="open(item)"
          >
            <span class="flex min-w-0 flex-1 flex-col gap-1">
              <span v-if="item.author.name" class="flex min-w-0 items-center gap-2">
                <UserAvatar
                  :url="item.author.avatar_url"
                  :name="item.author.name"
                  class="h-6 w-6 shrink-0 rounded-full"
                  text-class="text-xs"
                />
                <span data-test="cook-record-author" class="truncate text-sm text-text">
                  {{ item.author.name }}
                </span>
              </span>
              <span class="text-xs text-text-secondary">
                {{ formatLocalDateTime(item.record.created_at) }}
              </span>
            </span>
            <span class="shrink-0 text-xs text-text-secondary">
              {{ item.lines.length === 0 ? "没有扣库存" : `扣了 ${item.lines.length} 项食材` }}
            </span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>
