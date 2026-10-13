import { createRouter, createWebHistory } from "vue-router";
import RecipeList from "@/views/RecipeList.vue";
import RecipeEdit from "@/views/RecipeEdit.vue";
import RecipeDetail from "@/views/RecipeDetail.vue";

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "recipe-list", component: RecipeList },
    { path: "/recipe/new", name: "recipe-new", component: RecipeEdit },
    { path: "/recipe/:id/edit", name: "recipe-edit", component: RecipeEdit },
    { path: "/recipe/:id", name: "recipe-detail", component: RecipeDetail },
  ],
});
