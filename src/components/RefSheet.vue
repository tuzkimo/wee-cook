<script setup lang="ts">
import { computed, ref, toValue, watch } from "vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import { useKeyboardInset } from "@/composables/useKeyboardInset";
import type { RefRow, RefStore } from "@/stores/refStore";
import type { WithUsage } from "@/types";

const props = defineProps<{
  visible: boolean;
  title: string;
  store: RefStore;
  mode: "single" | "multiple";
  selectedIds: string[];
  emptyHint: string;
}>();

const emit = defineEmits<{ close: []; select: [string[]] }>();

type Row = WithUsage<RefRow>;

// 软键盘高度：键盘弹出时给面板底部留出空间，确定按钮不被遮挡
const keyboardInset = useKeyboardInset();
const panelPadBottom = computed(() => `calc(${keyboardInset.value}px + 2rem)`);

// ---- 列表模式 ----
// 选中态是本地状态，每次打开从 selectedIds 重新播种；关窗由父组件决定，这里从不自己关
const selected = ref<string[]>([]);
const keyword = ref("");

// 只按名称「包含」过滤，不重排：顺序由 store 的 ORDER BY usage_count DESC 决定
const filtered = computed<Row[]>(() => {
  const kw = keyword.value.trim();
  // toValue：items 可能是 Ref、裸数组（Pinia 解包）或 getter
  const items = toValue(props.store.items);
  if (!kw) return items;
  return items.filter((item) => item.name.includes(kw));
});

const emptyText = computed(() => (keyword.value.trim() ? "没有匹配的条目" : props.emptyHint));

// ---- 表单模式 ----
const showForm = ref(false);
const editingId = ref<string | null>(null);
const formName = ref("");
const formError = ref("");

// ---- 删除 ----
const deleteTarget = ref<Row | null>(null);
const deleteError = ref("");

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    selected.value = [...props.selectedIds];
    keyword.value = "";
    showForm.value = false;
    editingId.value = null;
    formName.value = "";
    formError.value = "";
    deleteError.value = "";
    void props.store.fetchAll();
  },
  { immediate: true },
);

function isSelected(id: string): boolean {
  return selected.value.includes(id);
}

function handleRowClick(item: Row): void {
  if (props.mode === "single") {
    selected.value = [item.id];
    emit("select", [item.id]);
    return;
  }
  selected.value = isSelected(item.id)
    ? selected.value.filter((id) => id !== item.id)
    : [...selected.value, item.id];
}

function openNew(): void {
  editingId.value = null;
  formName.value = "";
  formError.value = "";
  showForm.value = true;
}

function openEdit(item: Row): void {
  editingId.value = item.id;
  formName.value = item.name;
  formError.value = "";
  showForm.value = true;
}

async function handleSubmit(): Promise<void> {
  const name = formName.value.trim();
  if (!name) {
    formError.value = "请输入名称";
    return;
  }
  formError.value = "";
  try {
    if (editingId.value) {
      await props.store.update(editingId.value, name);
    } else {
      const created = await props.store.add(name);
      selected.value = [...selected.value, created.id];
      // 仅单选模式：新建后立刻回报，多选模式等用户点「确定」
      if (props.mode === "single") emit("select", [created.id]);
    }
    showForm.value = false;
  } catch (error: unknown) {
    formError.value = error instanceof Error ? error.message : "操作失败";
  }
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deleteTarget.value = null;
  try {
    await props.store.remove(target.id);
    selected.value = selected.value.filter((id) => id !== target.id);
  } catch (error: unknown) {
    deleteError.value = error instanceof Error ? error.message : "删除失败";
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-fade">
      <div v-if="visible" class="fixed inset-0 z-40 bg-black/40" @click="emit('close')" />
    </Transition>

    <Transition name="sheet-slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-2xl bg-white px-4 pt-4 shadow-xl"
        :style="{ paddingBottom: panelPadBottom }"
      >
        <!-- ========== 列表模式 ========== -->
        <template v-if="!showForm">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-slate-900">{{ title }}</h2>
            <button
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-gray-100"
              aria-label="关闭"
              @click="emit('close')"
            >
              ✕
            </button>
          </div>

          <input
            v-model="keyword"
            data-test="ref-filter"
            type="text"
            placeholder="搜索名称"
            aria-label="搜索名称"
            class="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600"
          />

          <div class="flex-1 overflow-auto">
            <div v-if="filtered.length === 0" class="py-8 text-center text-sm text-slate-500">
              {{ emptyText }}
            </div>
            <div
              v-for="item in filtered"
              :key="item.id"
              data-test="ref-row"
              class="flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm transition-colors hover:bg-gray-50"
              @click="handleRowClick(item)"
            >
              <span
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs"
                :class="
                  isSelected(item.id)
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-gray-300'
                "
              >
                <span v-if="isSelected(item.id)" data-test="ref-check">✓</span>
              </span>
              <span data-test="ref-name" class="min-w-0 flex-1 truncate text-slate-900">
                {{ item.name }}
              </span>
              <button
                data-test="ref-edit"
                class="shrink-0 rounded px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-gray-200"
                @click.stop="openEdit(item)"
              >
                编辑
              </button>
              <button
                data-test="ref-delete"
                class="shrink-0 rounded px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-50"
                @click.stop="deleteTarget = item"
              >
                删除
              </button>
            </div>
          </div>

          <div class="mt-4 flex gap-3">
            <button
              data-test="ref-new"
              class="flex-1 rounded-xl border border-gray-200 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-gray-50"
              @click="openNew"
            >
              新建
            </button>
            <button
              v-if="mode === 'multiple'"
              data-test="ref-confirm"
              class="flex-1 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              @click="emit('select', [...selected])"
            >
              确定
            </button>
          </div>
        </template>

        <!-- ========== 表单模式 ========== -->
        <template v-else>
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-slate-900">
              {{ editingId ? "编辑" : "新建" }}
            </h2>
            <button
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-gray-100"
              aria-label="返回列表"
              @click="showForm = false"
            >
              ✕
            </button>
          </div>

          <div class="flex-1 overflow-auto">
            <label class="block text-sm font-medium text-slate-700">
              名称
              <input
                v-model="formName"
                data-test="ref-form-name"
                type="text"
                class="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600"
              />
            </label>
            <p v-if="formError" data-test="ref-form-error" class="mt-2 text-sm text-red-600">
              {{ formError }}
            </p>
          </div>

          <button
            data-test="ref-form-save"
            class="mt-4 w-full rounded-xl bg-blue-600 py-3 text-center text-base font-semibold text-white transition-colors hover:bg-blue-700"
            @click="handleSubmit"
          >
            {{ editingId ? "保存" : "创建" }}
          </button>
        </template>
      </div>
    </Transition>

    <!-- 删除确认 -->
    <ConfirmDialog
      :visible="deleteTarget !== null"
      title="删除"
      :description="`确定要删除「${deleteTarget?.name ?? ''}」吗？`"
      confirm-text="确认删除"
      danger
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />

    <!-- 删除失败提示 -->
    <ConfirmDialog
      :visible="deleteError !== ''"
      title="删除失败"
      :description="deleteError"
      confirm-text="知道了"
      hide-cancel
      @confirm="deleteError = ''"
      @cancel="deleteError = ''"
    />
  </Teleport>
</template>
