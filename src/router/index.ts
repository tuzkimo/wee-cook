import { createRouter, createWebHistory } from "vue-router";
import RecipeList from "@/views/RecipeList.vue";
import RecipeEdit from "@/views/RecipeEdit.vue";
import RecipeDetail from "@/views/RecipeDetail.vue";
import FilterPage from "@/views/FilterPage.vue";
import AiPage from "@/views/AiPage.vue";
import MePage from "@/views/MePage.vue";
import ServerConfig from "@/views/ServerConfig.vue";
import LoginPage from "@/views/LoginPage.vue";
import ProfilePage from "@/views/ProfilePage.vue";
import UserPage from "@/views/UserPage.vue";

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "recipe-list", component: RecipeList },
    { path: "/recipe/new", name: "recipe-new", component: RecipeEdit, meta: { hideTab: true } },
    // 静态段排在参数段之前：不依赖 vue-router 的打分规则更稳
    { path: "/recipe/filter", name: "recipe-filter", component: FilterPage, meta: { hideTab: true } },
    { path: "/recipe/:id/edit", name: "recipe-edit", component: RecipeEdit, meta: { hideTab: true } },
    { path: "/recipe/:id", name: "recipe-detail", component: RecipeDetail, meta: { hideTab: true } },
    { path: "/ai", name: "ai", component: AiPage },
    { path: "/me", name: "me", component: MePage },
    { path: "/me/server", name: "me-server", component: ServerConfig, meta: { hideTab: true } },
    { path: "/me/login", name: "me-login", component: LoginPage, meta: { hideTab: true } },
    { path: "/me/profile", name: "me-profile", component: ProfilePage, meta: { hideTab: true } },
    { path: "/user/:id", name: "user", component: UserPage, meta: { hideTab: true } },
  ],
});
