import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import router from "@/router";
import { appDataDir } from "@tauri-apps/api/path";
import { initDb } from "@/db";
import { setImageBaseDir } from "@/services/imageStore";
import { useAuthStore } from "@/stores/auth";
import "@/assets/main.css";

const app = createApp(App).use(router).use(createPinia());

try {
  // 先建库再 mount，首屏组件挂载时数据库已就绪
  await initDb();
  // 图片落盘/读取的根目录：必须在任何 <img> 渲染之前定下来，imageSrc() 拿它拼 asset 地址
  setImageBaseDir(await appDataDir());
  app.mount("#app");
  // spec §9.5：启动后恢复会话成功即同步一次。必须放在 initDb() 之后（同步要查库）；
  // 不 await：恢复会话与同步会发网络请求，不能拖住首屏。
  // 读设置失败等会让 restoreSession reject，必须收尾，否则成 unhandled rejection（页面已经挂载，
  // 顶层 catch 覆盖不到）。
  void useAuthStore().restoreSession().catch((err: unknown) => {
    console.warn("[main] 恢复会话失败:", err);
  });
} catch (startupError: unknown) {
  // 顶层 await 一旦抛错就中止模块求值、不 mount，整屏空白且无从上报；至少把原因写在页面上
  const message = startupError instanceof Error ? startupError.message : String(startupError);
  const root = document.getElementById("app");
  if (root) root.textContent = `启动失败：${message}`;
}
