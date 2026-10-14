<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import { useKeyboardInset } from "@/composables/useKeyboardInset";
import { useRecipeStore } from "@/stores/recipe";
import { useRecipeFilterStore } from "@/stores/recipeFilter";
import { cloneFilter, emptyFilter } from "@/utils/recipeFilter";

/** 候选列表里的一项 */
interface Option {
  id: string;
  name: string;
}

const router = useRouter();
const store = useRecipeStore();
const filterStore = useRecipeFilterStore();

// 本页勾选只改草稿；数组必须复制，否则会直接改到已生效的筛选
const draft = reactive(cloneFilter(filterStore.filter));
const tagSearch = ref("");
const ingredientSearch = ref("");
const keyboardInset = useKeyboardInset();

/** 名称升序；字符串比较，不依赖 Node 与 Android WebView 的 ICU 数据 */
function byName(a: Option, b: Option): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/** 名称相同时用 id 兜底，保证顺序确定 */
function byId(a: Option, b: Option): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function sorted(names: Map<string, string>): Option[] {
  return [...names]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => byName(a, b) || byId(a, b));
}

// 三个候选都从已加载的菜谱推导，只列真的有菜谱在用的条目：筛不出死选项，也不用再拉别的 store
const categories = computed<Option[]>(() => {
  const names = new Map<string, string>();
  for (const item of store.recipes) names.set(item.category.id, item.category.name);
  return sorted(names);
});

const tags = computed<Option[]>(() => {
  const names = new Map<string, string>();
  for (const item of store.recipes) {
    for (const tag of item.tags) names.set(tag.id, tag.name);
  }
  return sorted(names);
});

// 常用的排前面：按用了它的菜谱数降序
const ingredients = computed<(Option & { count: number })[]>(() => {
  const counts = new Map<string, { name: string; count: number }>();
  for (const item of store.recipes) {
    for (const line of item.ingredients) {
      const entry = counts.get(line.id);
      if (entry) entry.count += 1;
      else counts.set(line.id, { name: line.name, count: 1 });
    }
  }
  return [...counts]
    .map(([id, entry]) => ({ id, name: entry.name, count: entry.count }))
    .sort((a, b) => b.count - a.count || byName(a, b) || byId(a, b));
});

/** 已选中的置顶保留，即使不命中搜索词——否则被搜掉的选项就再也取消不掉了 */
const visibleTags = computed<Option[]>(() => {
  const keyword = tagSearch.value.trim().toLowerCase();
  const selected = tags.value.filter((tag) => draft.tagIds.includes(tag.id));
  const rest = tags.value.filter(
    (tag) => !draft.tagIds.includes(tag.id) && tag.name.toLowerCase().includes(keyword),
  );
  return [...selected, ...rest];
});

const visibleIngredients = computed<Option[]>(() => {
  const keyword = ingredientSearch.value.trim().toLowerCase();
  return ingredients.value.filter((line) => line.name.toLowerCase().includes(keyword));
});

/** 就地增删：重新赋值数组会丢掉草稿与模板的响应式关联 */
function toggle(list: string[], id: string): void {
  const index = list.indexOf(id);
  if (index === -1) list.push(id);
  else list.splice(index, 1);
}

function confirm(): void {
  // push 而不是 back：从筛选页回列表页是唯一去向，直接打开筛选页时 back 会出界
  filterStore.apply(draft);
  void router.push("/");
}

function goBack(): void {
  router.back();
}

function reset(): void {
  // 只清本页草稿，已生效的筛选不动
  Object.assign(draft, emptyFilter());
}

onMounted(() => {
  void store.fetchAll();
});
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="筛选" :show-back="true" @back="goBack" />

    <div class="flex-1 min-h-0 space-y-5 overflow-auto px-4 py-3">
      <section>
        <p class="mb-2 text-xs text-text-secondary">分类</p>
        <div v-if="categories.length === 0" class="text-xs text-text-secondary">还没有分类</div>
        <div v-else class="flex flex-wrap gap-2">
          <button
            v-for="category in categories"
            :key="category.id"
            type="button"
            data-test="filter-category-chip"
            class="rounded-full px-3 py-1.5 text-xs transition-colors"
            :class="
              draft.categoryIds.includes(category.id)
                ? 'bg-primary text-white'
                : 'bg-gray-100 text-text-secondary'
            "
            @click="toggle(draft.categoryIds, category.id)"
          >
            {{ category.name }}
          </button>
        </div>
      </section>

      <section>
        <p class="mb-2 text-xs text-text-secondary">标签</p>
        <input
          v-model="tagSearch"
          data-test="filter-tag-search"
          type="text"
          placeholder="搜索标签"
          aria-label="搜索标签"
          class="mb-2 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
        <div v-if="tags.length === 0" class="text-xs text-text-secondary">还没有标签</div>
        <div v-else class="flex flex-wrap gap-2">
          <button
            v-for="tag in visibleTags"
            :key="tag.id"
            type="button"
            data-test="filter-tag-chip"
            class="rounded-full px-3 py-1.5 text-xs transition-colors"
            :class="
              draft.tagIds.includes(tag.id)
                ? 'bg-primary text-white'
                : 'bg-gray-100 text-text-secondary'
            "
            @click="toggle(draft.tagIds, tag.id)"
          >
            {{ tag.name }}
          </button>
        </div>
      </section>

      <section>
        <p class="mb-2 text-xs text-text-secondary">食材</p>
        <input
          v-model="ingredientSearch"
          data-test="filter-ingredient-search"
          type="text"
          placeholder="搜索食材"
          aria-label="搜索食材"
          class="mb-2 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
        <div v-if="ingredients.length === 0" class="text-xs text-text-secondary">还没有食材</div>
        <div v-else>
          <div
            v-for="ingredient in visibleIngredients"
            :key="ingredient.id"
            data-test="filter-ingredient-row"
            class="flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm transition-colors hover:bg-gray-50"
            @click="toggle(draft.ingredientIds, ingredient.id)"
          >
            <span
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs"
              :class="
                draft.ingredientIds.includes(ingredient.id)
                  ? 'border-primary bg-primary text-white'
                  : 'border-gray-300'
              "
            >
              <span v-if="draft.ingredientIds.includes(ingredient.id)">✓</span>
            </span>
            <span data-test="filter-ingredient-name" class="min-w-0 flex-1 truncate text-text">
              {{ ingredient.name }}
            </span>
          </div>
        </div>
      </section>
    </div>

    <!-- 键盘弹出时把按钮栏顶起来；外壳已补过安全区，这里不再叠 env(safe-area-inset-bottom) -->
    <div
      class="flex shrink-0 gap-3 px-4 py-3"
      :style="keyboardInset > 0 ? { paddingBottom: `${keyboardInset + 12}px` } : undefined"
    >
      <button
        type="button"
        data-test="filter-reset"
        class="flex-1 rounded-xl border border-gray-200 py-3 text-sm font-semibold text-text-secondary transition-colors hover:bg-gray-50"
        @click="reset"
      >
        重置
      </button>
      <button
        type="button"
        data-test="filter-confirm"
        class="flex-1 rounded-xl bg-primary py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
        @click="confirm"
      >
        确定
      </button>
    </div>
  </div>
</template>
