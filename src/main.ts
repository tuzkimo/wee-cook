import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import router from "@/router";
import { appDataDir } from "@tauri-apps/api/path";
import { initDb } from "@/db";
import { setImageBaseDir } from "@/services/imageStore";
import "@/assets/main.css";

const app = createApp(App).use(router).use(createPinia());

try {
  // 先建库再 mount，首屏组件挂载时数据库已就绪
  await initDb();
  // 图片落盘/读取的根目录：必须在任何 <img> 渲染之前定下来，imageSrc() 拿它拼 asset 地址
  setImageBaseDir(await appDataDir());
  app.mount("#app");
} catch (startupError: unknown) {
  // 顶层 await 一旦抛错就中止模块求值、不 mount，整屏空白且无从上报；至少把原因写在页面上
  const message = startupError instanceof Error ? startupError.message : String(startupError);
  const root = document.getElementById("app");
  if (root) root.textContent = `启动失败：${message}`;
}
