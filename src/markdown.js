"use strict";

/**
 * Minimal markdown → HTML for chat (no deps).
 * Escapes HTML first, then applies a small subset.
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(src) {
  if (!src) return "";
  let text = String(src);

  // Extract fenced code blocks
  const blocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    blocks.push(
      `<pre class="md-code"><code class="lang-${escapeHtml(
        lang || "text"
      )}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`
    );
    return `\u0000BLOCK${i}\u0000`;
  });

  // Inline code
  text = escapeHtml(text);
  text = text.replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>');

  // Bold / italic (bez lookbehind — kompatybilność silników)
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

  // Links [t](u)
  text = text.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );

  // Headings
  text = text.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  text = text.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/^# (.+)$/gm, "<h3>$1</h3>");

  // Lists
  text = text.replace(/^(?:- |\* )(.+)$/gm, "<li>$1</li>");
  text = text.replace(/(<li>[\s\S]*?<\/li>)(?:\n(?=<li>)|(?!\n<li>))/g, (m) => m);
  text = text.replace(/(?:<li>.*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);

  // Paragraphs
  const parts = text.split(/\n{2,}/).map((p) => {
    if (
      p.startsWith("<h") ||
      p.startsWith("<ul") ||
      p.startsWith("<pre") ||
      p.startsWith("\u0000BLOCK")
    ) {
      return p;
    }
    return `<p>${p.replace(/\n/g, "<br>")}</p>`;
  });
  text = parts.join("");

  // Restore code blocks
  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[Number(i)] || "");

  return text;
}

// browser global
if (typeof window !== "undefined") {
  window.renderMarkdown = renderMarkdown;
}

// node export if required
if (typeof module !== "undefined") {
  module.exports = { renderMarkdown, escapeHtml };
}
