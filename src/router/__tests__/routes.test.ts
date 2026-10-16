import { describe, expect, it } from "vitest";
import router from "@/router";

describe("路由表", () => {
  it("有 /ai 与 /me", () => {
    const paths = router.getRoutes().map((r) => r.path);
    expect(paths).toContain("/ai");
    expect(paths).toContain("/me");
  });

  it("三个菜谱页面都隐藏 tab 栏", () => {
    for (const path of ["/recipe/new", "/recipe/:id", "/recipe/:id/edit"]) {
      const route = router.getRoutes().find((r) => r.path === path);
      expect(route?.meta.hideTab, path).toBe(true);
    }
  });

  it("三个 tab 页不隐藏 tab 栏", () => {
    for (const path of ["/", "/ai", "/me"]) {
      const route = router.getRoutes().find((r) => r.path === path);
      expect(route, path).toBeDefined();
      expect(route?.meta.hideTab, path).toBeUndefined();
    }
  });

  it("有 /recipe/filter，而且不会被 /recipe/:id 抢走", () => {
    const route = router.getRoutes().find((r) => r.path === "/recipe/filter");

    expect(route).toBeDefined();
    expect(route?.meta.hideTab).toBe(true);
    expect(router.resolve("/recipe/filter").name).toBe("recipe-filter");
  });

  it("/me/profile 隐藏 tab 栏", () => {
    const route = router.getRoutes().find((r) => r.path === "/me/profile");

    expect(route).toBeDefined();
    expect(route?.meta.hideTab).toBe(true);
  });
});
