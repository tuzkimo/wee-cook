import { defineStore } from "pinia";
import { createRefStore } from "./refStore";

export const useIngredientStore = defineStore("ingredient", () =>
  createRefStore({ table: "ingredients", label: "食材" }),
);

export const useUnitStore = defineStore("unit", () =>
  createRefStore({ table: "units", label: "单位" }),
);
