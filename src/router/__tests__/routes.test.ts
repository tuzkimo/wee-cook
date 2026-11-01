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

  it("四个 tab 页不隐藏 tab 栏", () => {
    for (const path of ["/", "/inventory", "/ai", "/me"]) {
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

describe("团队路由", () => {
  it("两条团队路由存在且隐藏 tab 栏", () => {
    for (const path of ["/me/teams", "/me/teams/:id"]) {
      const route = router.getRoutes().find((r) => r.path === path);
      expect(route, path).toBeDefined();
      expect(route?.meta.hideTab, path).toBe(true);
    }
  });
});

describe("库存路由", () => {
  it("/inventory 是一级 tab 页（不再隐藏 tab 栏）", () => {
    const route = router.getRoutes().find((r) => r.path === "/inventory");
    expect(route).toBeDefined();
    expect(route?.meta.hideTab).toBeUndefined();
  });

  it("制作三条路由存在且隐藏 tab 栏，new 不被 :cookId 抢走", () => {
    const paths = ["/recipe/:id/cook", "/recipe/:id/cook/new", "/recipe/:id/cook/:cookId"];
    for (const path of paths) {
      expect(router.getRoutes().find((r) => r.path === path)?.meta.hideTab, path).toBe(true);
    }
    expect(router.resolve("/recipe/r1/cook").name).toBe("recipe-cook-records");
    expect(router.resolve("/recipe/r1/cook/new").name).toBe("recipe-cook");
    expect(router.resolve("/recipe/r1/cook/cr1").name).toBe("recipe-cook-record");
  });
});
