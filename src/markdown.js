"use strict";

/**
 * Markdown → HTML for SuperGrok Desktop SoskyApp chat.
 * Handles glued walls of text (missing newlines after stream).
 */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Stream often delivers "VPS." + "Praca siedzi" as two chunks with no
 * space. Join them so the next sentence starts on a new paragraph.
 */
function appendStreamChunk(prev, chunk) {
  const a = String(prev || "");
  const b = String(chunk || "");
  if (!b) return a;
  if (!a) return b;
  const aEnd = a.replace(/\s+$/, "");
  const bStart = b.replace(/^\s+/, "");
  if (!bStart) return a;
  if (/[.!?…]["”')\]]?$/.test(aEnd) && /^[A-ZĄĆĘŁŃÓŚŹŻ]/.test(bStart)) {
    return aEnd + "\n\n" + bStart;
  }
  if (/[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż0-9]$/.test(aEnd) && /^[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(bStart)) {
    return aEnd + " " + bStart;
  }
  return a + b;
}

/**
 * When the model dumps markdown without newlines, recover structure.
 */
function normalizeMarkdown(src) {
  let t = String(src || "").replace(/\r\n/g, "\n");

  // Heading glued after text: "…id .## Title" or "…id## Title"
  t = t.replace(/([^\n#])\s*\.?(\s*)(#{1,4})\s+/g, "$1\n\n$3 ");
  // Heading then immediate table on same line: "## Title| A | B |"
  t = t.replace(/^(#{1,4}\s+[^|\n]+)\|/gm, "$1\n\n|");

  // Double-pipe row breaks (common in glued tables): ||---| or || cell
  t = t.replace(/\|\|/g, "|\n|");

  // Wiersz separatora (|---|---|) na własną linię, ale TYLKO gdy jest
  // sklejony z czymś innym. Poprzednia wersja dopisywała \n także wtedy,
  // gdy separator już stał osobno — powstawały puste linie, które dzieliły
  // poprawną tabelę na trzy bloki i „|---|---|” lądowało w czacie jako tekst.
  const SEP = /\|(?:\s*:?-{3,}:?\s*\|)+/;
  t = t.replace(new RegExp(`([^\\n])(${SEP.source})`, "g"), "$1\n$2");
  t = t.replace(new RegExp(`(${SEP.source})([^\\n])`, "g"), "$1\n$2");

  // Ensure each table row on own line when multiple | segments
  // (already partly handled by ||)

  // List items glued after text
  t = t.replace(/([^\n])\s+([-*]\s+\S)/g, "$1\n$2");
  t = t.replace(/([^\n])\s+(\d+\.\s+\S)/g, "$1\n$2");

  // HR
  t = t.replace(/([^\n|-])\s*(---)\s*([^\n|-])/g, "$1\n\n$2\n\n$3");

  // Bold section labels after sentence
  t = t.replace(/([.!?])\s*(\*\*[^*\n]{2,50}\*\*)/g, "$1\n\n$2");

  // Numbered steps "1. Foo 2. Bar"
  t = t.replace(/(\S)\s+(\d+\.\s+[A-ZĄĆĘŁŃÓŚŹŻ])/g, "$1\n$2");

  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

function renderTable(block) {
  const rows = block
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean)
    .filter((r) => r.includes("|"));
  if (rows.length < 1) return null;

  const parseRow = (row) =>
    row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  // skip separator rows |---|---|
  const isSep = (cells) => cells.every((c) => /^:?-+:?$/.test(c) || c === "");

  const bodyRows = [];
  let headerCells = null;
  for (const row of rows) {
    const cells = parseRow(row);
    if (isSep(cells)) continue;
    if (!headerCells) headerCells = cells;
    else bodyRows.push(cells);
  }
  if (!headerCells) return null;
  // single row → treat as body without header
  if (!bodyRows.length) {
    return (
      '<table class="md-table"><tbody><tr>' +
      headerCells.map((c) => `<td>${inlineFormat(c)}</td>`).join("") +
      "</tr></tbody></table>"
    );
  }
  return (
    '<table class="md-table"><thead><tr>' +
    headerCells.map((c) => `<th>${inlineFormat(c)}</th>`).join("") +
    "</tr></thead><tbody>" +
    bodyRows
      .map(
        (cells) =>
          "<tr>" + cells.map((c) => `<td>${inlineFormat(c)}</td>`).join("") + "</tr>"
      )
      .join("") +
    "</tbody></table>"
  );
}

function inlineFormat(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>');
  // Bold only for short spans. A 200-char **...** is a glued heading, not emphasis.
  t = t.replace(/\*\*([^*]{1,80})\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^\*])\*([^*\n]{1,80})\*(?!\*)/g, "$1<em>$2</em>");
  t = t.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );
  return t;
}

/** Split stream-glued sentences. Run AFTER fences are cut out. */
function unglueSentences(t) {
  // "siedzi.Jest" — 4+ letters, no space. Skip foo.Bar / i.e.
  t = t.replace(
    /([a-ząćęłńóśźż]{4,})\.([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]{2,})/g,
    "$1.\n\n$2"
  );
  // "VPS.Praca"
  t = t.replace(/([A-Z]{2,})\.([A-Z][a-ząćęłńóśźż]{2,})/g, "$1.\n\n$2");
  // "zmieniłemKolejka" — Polish word glued to a title. Skip openSession.
  t = t.replace(
    /([a-z]*[ąćęłńóśźż][a-ząćęłńóśźż]*)([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]{3,})/g,
    "$1\n\n$2"
  );
  // **Title**GluedNext
  t = t.replace(
    /(\*\*[^*]{2,60}\*\*)([A-ZĄĆĘŁŃÓŚŹŻ])/g,
    "$1\n\n$2"
  );
  return t;
}

function renderMarkdown(src) {
  if (!src) return "";
  let text = normalizeMarkdown(src);

  // Niedomknięty fence w trakcie streamu: domknij, żeby kod nie wyciekał
  // do tekstu jako ściana backticków.
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) text += "\n```";

  // Fenced code
  const blocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    const label = escapeHtml(lang || "text");
    blocks.push(
      `<div class="md-code-wrap"><div class="md-code-head">` +
        `<span class="md-code-lang">${label}</span>` +
        `<button type="button" class="md-copy">Copy</button>` +
        `</div><pre class="md-code"><code class="lang-${label}">${escapeHtml(
          code.replace(/\n$/, "")
        )}</code></pre></div>`
    );
    return `\n\n\u0000BLOCK${i}\u0000\n\n`;
  });

  text = unglueSentences(text);

  // Split into blocks by blank lines, but keep table/list clusters
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Code placeholder
    if (/^\u0000BLOCK\d+\u0000$/.test(trimmed)) {
      out.push(trimmed);
      i++;
      continue;
    }

    // Heading
    const h = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const level = Math.min(h[1].length + 2, 5); // ## → h4 visually
      out.push(`<h${level} class="md-h">${inlineFormat(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // **Kolejka.** rest of the sentence → title + body, not one bold wall
    const boldHead = trimmed.match(/^\*\*([^*]{2,60})\*\*\s*(.*)$/);
    if (boldHead && /^[A-ZĄĆĘŁŃÓŚŹŻ]/.test(boldHead[1])) {
      out.push(`<h4 class="md-h">${inlineFormat(boldHead[1])}</h4>`);
      if (boldHead[2]) out.push(`<p>${inlineFormat(boldHead[2])}</p>`);
      i++;
      continue;
    }

    // HR
    if (/^---+$/.test(trimmed)) {
      out.push('<hr class="md-hr" />');
      i++;
      continue;
    }

    // Table block
    if (trimmed.includes("|") && trimmed.indexOf("|") !== trimmed.lastIndexOf("|")) {
      const tableLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        lines[i].includes("|")
      ) {
        tableLines.push(lines[i]);
        i++;
      }
      const tableHtml = renderTable(tableLines.join("\n"));
      if (tableHtml) out.push(tableHtml);
      else out.push(`<p>${inlineFormat(tableLines.join(" "))}</p>`);
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      out.push(
        "<ul class=\"md-ul\">" +
          items.map((it) => `<li>${inlineFormat(it)}</li>`).join("") +
          "</ul>"
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push(
        "<ol class=\"md-ol\">" +
          items.map((it) => `<li>${inlineFormat(it)}</li>`).join("") +
          "</ol>"
      );
      continue;
    }

    // Paragraph (collect until blank / special)
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,4}\s/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^\u0000BLOCK/.test(lines[i].trim()) &&
      !(
        lines[i].includes("|") &&
        lines[i].indexOf("|") !== lines[i].lastIndexOf("|")
      )
    ) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) {
      out.push(`<p>${inlineFormat(para.join(" "))}</p>`);
    }
  }

  let html = out.join("\n");
  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, n) => blocks[Number(n)] || "");
  return html;
}

if (typeof window !== "undefined") {
  window.renderMarkdown = renderMarkdown;
  window.normalizeMarkdown = normalizeMarkdown;
  window.appendStreamChunk = appendStreamChunk;
}

if (typeof module !== "undefined") {
  module.exports = {
    renderMarkdown,
    escapeHtml,
    normalizeMarkdown,
    appendStreamChunk,
  };
}
