<script setup lang="ts">
import { computed, ref, toValue, watch } from "vue";
import { Pencil, Trash2 } from "lucide-vue-next";
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
// 键盘高度 + 常规内边距 + 手势导航条的安全区，底不贴系统栏
const panelPadBottom = computed(
  () => `calc(${keyboardInset.value}px + 2rem + env(safe-area-inset-bottom))`,
);

// 面板自身的两个模式，与 props.mode（single | multiple）无关，切勿同名
const panelMode = ref<"select" | "manage">("select");
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

// 创建入口只由搜索词决定：非空且没有完全同名（忽略大小写）才出现，前缀命中不影响创建（§8.3）
const showCreate = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return (
    kw.length > 0 && !toValue(props.store.items).some((item) => item.name.toLowerCase() === kw)
  );
});

const emptyText = computed(() => (keyword.value.trim() ? "没有匹配的条目" : props.emptyHint));

// ---- 内联改名 ----
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
    panelMode.value = "select";
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
  // 管理模式的行只读，点不动
  if (panelMode.value !== "select") return;
  if (props.mode === "single") {
    selected.value = [item.id];
    emit("select", [item.id]);
    return;
  }
  selected.value = isSelected(item.id)
    ? selected.value.filter((id) => id !== item.id)
    : [...selected.value, item.id];
}

/** 管理 / 完成：只换渲染，选中的条目留着（Review Focus 3）。 */
function toggleMode(): void {
  panelMode.value = panelMode.value === "select" ? "manage" : "select";
  keyword.value = "";
  formError.value = "";
  deleteError.value = "";
}

async function createAndSelect(): Promise<void> {
  const name = keyword.value.trim();
  if (!name) return;
  formError.value = "";
  try {
    const created = await props.store.add(name);
    selected.value = [...selected.value, created.id];
    keyword.value = "";
    // 仅单选模式：新建后立刻回报，父组件据此进下一步；关窗由父组件决定（R3）
    if (props.mode === "single") emit("select", [created.id]);
  } catch (error: unknown) {
    // 失败绝不 emit select：否则父组件会拿着空 id 进下一步（Review Focus 5）
    formError.value = error instanceof Error ? error.message : "创建失败";
  }
}

function openEdit(item: Row): void {
  editingId.value = item.id;
  formName.value = item.name;
  formError.value = "";
}

function cancelEdit(): void {
  editingId.value = null;
  formError.value = "";
}

async function saveEdit(): Promise<void> {
  const id = editingId.value;
  if (!id) return;
  const name = formName.value.trim();
  if (!name) {
    formError.value = "请输入名称";
    return;
  }
  formError.value = "";
  try {
    await props.store.update(id, name);
    // 保存成功回到管理模式，改名时把搜索词与错误清掉
    editingId.value = null;
    formName.value = "";
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
        class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-2xl bg-surface px-4 pt-4 shadow-xl"
        :style="{ paddingBottom: panelPadBottom }"
      >
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">{{ editingId ? "重命名" : title }}</h2>
          <div class="flex items-center gap-1">
            <!-- 正在改单条时「管理」让位：此刻模板已是改名表单 -->
            <button
              v-if="editingId === null"
              data-test="ref-manage"
              class="shrink-0 rounded px-2 py-1 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-100"
              @click="toggleMode"
            >
              {{ panelMode === "manage" ? "完成" : "管理" }}
            </button>
            <button
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-gray-100"
              aria-label="关闭"
              @click="emit('close')"
            >
              ✕
            </button>
          </div>
        </div>

        <!-- ========== 内联改名：列表与创建行都让位 ========== -->
        <template v-if="editingId !== null">
          <div class="flex-1 overflow-auto">
            <input
              v-model="formName"
              data-test="ref-form-name"
              type="text"
              aria-label="名称"
              class="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
            />
            <p v-if="formError" data-test="ref-form-error" class="mt-2 text-sm text-danger">
              {{ formError }}
            </p>
          </div>

          <div class="mt-4 flex gap-3">
            <button
              class="flex-1 rounded-xl border border-gray-200 py-3 text-sm font-semibold text-text-secondary transition-colors hover:bg-gray-50"
              @click="cancelEdit"
            >
              取消
            </button>
            <button
              data-test="ref-form-save"
              class="flex-1 rounded-xl bg-primary py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
              @click="saveEdit"
            >
              保存
            </button>
          </div>
        </template>

        <!-- ========== 搜索选择态 / 管理模式 ========== -->
        <template v-else>
          <input
            v-model="keyword"
            data-test="ref-filter"
            type="text"
            placeholder="搜索名称"
            aria-label="搜索名称"
            class="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />

          <div class="flex-1 overflow-auto">
            <!-- 有创建行时不显示空态：「还没有」和「创建它」不能并列（Review Focus 1） -->
            <div
              v-if="filtered.length === 0 && !showCreate"
              class="py-8 text-center text-sm text-text-secondary"
            >
              {{ emptyText }}
            </div>

            <div
              v-for="item in filtered"
              :key="item.id"
              data-test="ref-row"
              class="flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm transition-colors"
              :class="panelMode === 'select' ? 'cursor-pointer hover:bg-gray-50' : ''"
              @click="handleRowClick(item)"
            >
              <!-- 选择态：multiple 画勾选框，single 不画（§4.5） -->
              <span
                v-if="panelMode === 'select' && mode === 'multiple'"
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs"
                :class="
                  isSelected(item.id) ? 'border-primary bg-primary text-white' : 'border-gray-300'
                "
              >
                <span v-if="isSelected(item.id)" data-test="ref-check">✓</span>
              </span>
              <span data-test="ref-name" class="min-w-0 flex-1 truncate text-text">
                {{ item.name }}
              </span>

              <!-- 管理模式：用量 + 改名 + 删除，整块换掉选择态的渲染 -->
              <template v-if="panelMode === 'manage'">
                <span data-test="ref-usage" class="shrink-0 text-xs text-text-secondary">
                  {{ item.usage_count }} 道菜谱在用
                </span>
                <button
                  data-test="ref-edit"
                  class="shrink-0 rounded p-1 text-text-secondary transition-colors hover:bg-gray-200"
                  aria-label="重命名"
                  @click.stop="openEdit(item)"
                >
                  <Pencil :size="16" />
                </button>
                <button
                  data-test="ref-delete"
                  class="shrink-0 rounded p-1 transition-colors"
                  :class="
                    item.usage_count > 0
                      ? 'cursor-not-allowed text-gray-300'
                      : 'text-danger hover:bg-danger/10'
                  "
                  :disabled="item.usage_count > 0"
                  aria-label="删除"
                  @click.stop="deleteTarget = item"
                >
                  <Trash2 :size="16" />
                </button>
              </template>
            </div>

            <!-- 搜索词非空且无同名 → 行内直接创建，不走整页表单 -->
            <button
              v-if="showCreate"
              data-test="ref-create"
              class="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-left text-sm text-primary transition-colors hover:bg-gray-50"
              @click="createAndSelect"
            >
              + 创建「{{ keyword.trim() }}」
            </button>
          </div>

          <p v-if="formError" data-test="ref-form-error" class="mt-2 text-sm text-danger">
            {{ formError }}
          </p>

          <button
            v-if="panelMode === 'select' && mode === 'multiple'"
            data-test="ref-confirm"
            class="mt-4 w-full rounded-xl bg-primary py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
            @click="emit('select', [...selected])"
          >
            确定
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
