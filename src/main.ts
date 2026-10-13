import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import router from "@/router";
import { initDb } from "@/db";
import "@/assets/main.css";

const app = createApp(App).use(router).use(createPinia());

// 先建库再 mount，首屏组件挂载时数据库已就绪
await initDb();

app.mount("#app");
