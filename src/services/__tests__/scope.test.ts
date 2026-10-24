import { describe, expect, it } from "vitest";
import { LOCAL_SCOPE, personalScope, scopeFor, teamScope } from "@/services/scope";

// 范围键只有三种形状：团队 / 个人 / 未登录的本机范围。字符串本身就是服务端认的那个形状。
describe("范围键", () => {
  it("未登录时是本机范围", () => {
    expect(scopeFor(null, null)).toBe(LOCAL_SCOPE);
    expect(LOCAL_SCOPE).toBe("p:local");
  });

  it("登录但没选团队时是个人范围", () => {
    expect(scopeFor("u1", null)).toBe("p:u1");
    expect(personalScope("u1")).toBe("p:u1");
  });

  it("选了团队就是团队范围（团队优先于个人）", () => {
    expect(scopeFor("u1", "t1")).toBe("t:t1");
    expect(teamScope("t1")).toBe("t:t1");
    expect(scopeFor(null, "t1")).toBe("t:t1");
  });
});
