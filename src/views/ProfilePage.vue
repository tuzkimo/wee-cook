<script setup lang="ts">
// 资料编辑页：头像（拍照/相册裁剪 + emoji 备选）与昵称。
// 所有改动都留在本地态，点「保存」才提交——上传一张图就立刻提交会让「无改动」判定失效。
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Camera } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import AvatarCropper from "@/components/AvatarCropper.vue";
import UserAvatar from "@/components/UserAvatar.vue";
import { useAuthStore } from "@/stores/auth";

// 不想传照片时的零成本出口；再点已选中的那个 = 取消选择 = 无头像
const AVATAR_EMOJIS = [
  "😀", "🐱", "🐶", "🦊", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷",
  "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦄", "🐌", "🐛", "🦋",
];

const router = useRouter();
const auth = useAuthStore();

// 基准是 auth.avatarUrl（唯一真相源）。冷启动时 auth.serverUser 可能还是 null，拿它当基准会误判「无改动」。
const nickname = ref(auth.nickname ?? "");
const selectedAvatar = ref<string | null>(auth.avatarUrl);
const cropperFile = ref<File | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const saving = ref(false);
const error = ref("");

const hasChanges = computed(
  () => nickname.value.trim() !== (auth.nickname ?? "") || selectedAvatar.value !== auth.avatarUrl,
);

onMounted(async () => {
  await auth.restoreSession();
  // 保存资料需要 token，未登录留在这一页只会必然失败
  if (!auth.isOnline) {
    router.replace("/me/login");
    return;
  }
  // 冷启动时会话是异步恢复的，setup 阶段 auth.nickname / avatarUrl 还是 null，恢复完再对齐基准
  nickname.value = auth.nickname ?? "";
  selectedAvatar.value = auth.avatarUrl;
});

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) cropperFile.value = file;
  // 不清空的话，同一张图选第二次不会再触发 change
  input.value = "";
}

function onCropped(dataUrl: string): void {
  selectedAvatar.value = dataUrl;
  cropperFile.value = null;
}

function onCropError(): void {
  cropperFile.value = null;
  error.value = "图片无法读取，请换一张";
}

function toggleEmoji(emoji: string): void {
  selectedAvatar.value = selectedAvatar.value === emoji ? null : emoji;
}

function onNicknameInput(e: Event): void {
  // maxlength 能被粘贴 / 输入法 / 部分 webview 绕过，服务端 >50 直接 400，这里按码点再截一次
  nickname.value = Array.from((e.target as HTMLInputElement).value).slice(0, 50).join("");
}

async function save(): Promise<void> {
  const trimmed = nickname.value.trim();
  if (!trimmed) {
    error.value = "昵称不能为空";
    return;
  }
  error.value = "";
  saving.value = true;
  try {
    // 清头像必须发空串：服务端的 avatar_url 是 *string，发 null 那段 UPDATE 根本不执行
    await auth.updateProfile({ nickname: trimmed, avatar_url: selectedAvatar.value ?? "" });
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "保存失败，检查网络后重试";
    return;
  } finally {
    saving.value = false;
  }
  router.back();
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="个人信息" show-back @back="router.back()" />
    <div class="flex flex-1 min-h-0 flex-col gap-6 overflow-auto px-4 py-4">
      <!-- 头像：不接 capture，让安卓自己弹「相机 / 相册」选择 -->
      <section class="flex flex-col items-center gap-2">
        <button
          type="button"
          data-test="me-profile-avatar"
          aria-label="更换头像"
          class="relative h-24 w-24 rounded-full"
          @click="fileInput?.click()"
        >
          <UserAvatar
            :url="selectedAvatar"
            :name="nickname || auth.serverUser?.username || ''"
            text-class="text-2xl"
            class="pointer-events-none h-24 w-24 rounded-full"
          />
          <span class="absolute bottom-0 right-0 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white">
            <Camera :size="16" />
          </span>
        </button>
        <p class="text-xs text-text-secondary">点击更换头像，或选择下方 emoji</p>
        <input
          ref="fileInput"
          data-test="me-avatar-input"
          type="file"
          accept="image/*"
          class="hidden"
          @change="onFileChange"
        />
      </section>

      <section class="flex flex-wrap justify-center gap-2">
        <button
          v-for="emoji in AVATAR_EMOJIS"
          :key="emoji"
          type="button"
          :data-test="`me-emoji-${emoji}`"
          :class="[
            'flex h-10 w-10 items-center justify-center rounded-full border text-xl transition-colors',
            selectedAvatar === emoji ? 'border-primary bg-primary/10' : 'border-gray-200 bg-surface hover:bg-gray-50',
          ]"
          @click="toggleEmoji(emoji)"
        >
          {{ emoji }}
        </button>
      </section>

      <label class="block">
        <span class="mb-1 block text-xs text-text-secondary">昵称</span>
        <input
          :value="nickname"
          data-test="me-nickname"
          type="text"
          maxlength="50"
          placeholder="昵称"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          @input="onNicknameInput"
        />
      </label>

      <div v-if="auth.serverUser?.username" class="rounded-lg bg-gray-100 px-3 py-2.5 text-sm">
        <span class="text-xs text-text-secondary">账号</span>
        <p class="text-text">{{ auth.serverUser.username }}</p>
      </div>

      <p v-if="error" data-test="me-error" class="text-sm text-danger">{{ error }}</p>

      <button
        type="button"
        data-test="me-save"
        :disabled="saving || !hasChanges"
        class="rounded-xl bg-primary py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
        @click="save"
      >
        保存
      </button>
    </div>

    <AvatarCropper
      v-if="cropperFile"
      :file="cropperFile"
      @confirm="onCropped"
      @cancel="cropperFile = null"
      @error="onCropError"
    />
  </div>
</template>
