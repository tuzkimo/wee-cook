// AI 回复是 markdown，气泡里要渲染成样式，不能把 `**` `-` 原样显示给用户。
// html: false 是关键：模型会把截图里的文字原样吐回来，那是不受控输入，必须当纯文本。
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: false, breaks: true });

// 应用内直接打开链接会把 webview 导航走且回不来，一律甩给外部浏览器
const renderLinkOpen = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]?.attrSet("target", "_blank");
  tokens[idx]?.attrSet("rel", "noopener noreferrer");
  return renderLinkOpen !== undefined
    ? renderLinkOpen(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

export function renderMarkdown(text: string): string {
  return md.render(text);
}
