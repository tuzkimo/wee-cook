<script setup lang="ts">
// 详情页骨架：路由先要一个组件，内容由详情页的测试驱动补齐。
import AppHeader from "@/components/AppHeader.vue";
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader title="制作记录" show-back />
  </div>
</template>
