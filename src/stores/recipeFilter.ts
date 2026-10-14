import { defineStore } from "pinia";
import { reactive } from "vue";
import { cloneFilter, emptyFilter, type RecipeFilter } from "@/utils/recipeFilter";

export interface RecipeFilterStore {
  filter: RecipeFilter;
  apply(next: RecipeFilter): void;
  clear(): void;
}

export const useRecipeFilterStore = defineStore("recipeFilter", (): RecipeFilterStore => {
  // reactive 而不是 ref：组件里直接 v-model 到 filter.keyword，页面测试里 mock 的同形状对象也对得上
  const filter = reactive<RecipeFilter>(emptyFilter());

  /** 整体替换（筛选页点确定） */
  function apply(next: RecipeFilter): void {
    Object.assign(filter, cloneFilter(next));
  }

  /** 四项全清（列表页点清除筛选） */
  function clear(): void {
    Object.assign(filter, emptyFilter());
  }

  return { filter, apply, clear };
});
