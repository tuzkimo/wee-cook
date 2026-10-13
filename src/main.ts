import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import router from "@/router";
import { appDataDir } from "@tauri-apps/api/path";
import { initDb } from "@/db";
import { setImageBaseDir } from "@/services/imageStore";
import "@/assets/main.css";

const app = createApp(App).use(router).use(createPinia());

// 先建库再 mount，首屏组件挂载时数据库已就绪
await initDb();
// 图片落盘/读取的根目录：必须在任何 <img> 渲染之前定下来，imageSrc() 拿它拼 asset 地址
setImageBaseDir(await appDataDir());

app.mount("#app");
