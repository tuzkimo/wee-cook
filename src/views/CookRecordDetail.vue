<script setup lang="ts">
// 制作详情（spec §6.5）：从「按菜谱看」和「按食材看」两个入口进来，内容一致。
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import UserAvatar from "@/components/UserAvatar.vue";
import { useInventoryStore } from "@/stores/inventory";
import type { CookRecordDetail } from "@/types";
import { formatLocalDateTime } from "@/utils/time";

const route = useRoute();
const router = useRouter();
const store = useInventoryStore();

const cookId = computed(() => (typeof route.params.cookId === "string" ? route.params.cookId : ""));
const detail = ref<CookRecordDetail | null>(null);
const loaded = ref(false);

onMounted(async () => {
  detail.value = await store.fetchCookRecord(cookId.value);
  loaded.value = true;
});

/** 0.1 + 0.2 这类浮点尾巴不显示出来（与库存页同一口径） */
function trimNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="制作记录" show-back @back="router.back()" />

    <div class="flex-1 min-h-0 overflow-auto px-4 py-4">
      <p
        v-if="loaded && !detail"
        data-test="cook-record-missing"
        class="text-sm text-text-secondary"
      >
        记录不存在，可能已被别的设备清空
      </p>

      <template v-else-if="detail">
        <p data-test="cook-record-recipe" class="text-lg font-semibold text-text">
          {{ detail.recipe_name ?? "已删除的菜谱" }}
        </p>

        <div class="mt-2 flex items-center gap-2 text-xs text-text-secondary">
          <template v-if="detail.author.name">
            <UserAvatar
              :url="detail.author.avatar_url"
              :name="detail.author.name"
              class="h-6 w-6 shrink-0 rounded-full"
              text-class="text-xs"
            />
            <span data-test="cook-record-author">{{ detail.author.name }}</span>
          </template>
          <span>{{ formatLocalDateTime(detail.record.created_at) }}</span>
        </div>

        <ul v-if="detail.lines.length > 0" class="mt-4 flex flex-col gap-2">
          <li
            v-for="(line, index) in detail.lines"
            :key="index"
            data-test="cook-record-line"
            class="flex items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 text-sm text-text"
          >
            <span class="truncate">{{ line.ingredient_name }}</span>
            <span class="shrink-0 text-text-secondary">
              {{ trimNumber(line.amount) }}{{ line.unit_name ? ` ${line.unit_name}` : "" }}
            </span>
          </li>
        </ul>

        <p v-else data-test="cook-record-empty" class="mt-4 text-sm text-text-secondary">
          这次没有扣任何库存
        </p>
      </template>
    </div>
  </div>
</template>
