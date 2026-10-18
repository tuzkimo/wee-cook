// 渲染结果直接进 v-html，所以「不受控输入不能当 HTML」是本文件的核心断言：
// 模型可能把截图里的文字原样吐回来（提示注入），那部分是纯文本，不是标记。
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/utils/markdown";

describe("renderMarkdown", () => {
  it("渲染常用样式，不把标记原样留给用户看", () => {
    const html = renderMarkdown("**重点** 和 `代码`\n\n- 一\n- 二");

    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<code>代码</code>");
    expect(html).not.toContain("- 一");
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
  });

  it("单个换行就断行（聊天里换行应该看得见）", () => {
    expect(renderMarkdown("第一行\n第二行")).toContain("<br>");
  });

  it("原文里的 HTML 被转义，不会变成标签", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("javascript: 链接不生成 href", () => {
    const html = renderMarkdown("[点我](javascript:alert(1))");

    expect(html).not.toContain('href="javascript');
  });

  it("普通链接交给外部浏览器打开，不把 webview 导航走", () => {
    const html = renderMarkdown("[点我](https://example.com)");

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
