"use strict";

/**
 * Czysta logika historii czatu — bez DOM.
 * Otwarcie długiej sesji zerowało padding i gubiło lokalnie wysłaną bańkę.
 */

function contentHeightWithoutPad(scrollHeight, paddingTop) {
  const h = Number(scrollHeight) || 0;
  const pad = Number(paddingTop) || 0;
  return Math.max(0, h - pad);
}

function nextChatPadding(available, contentH) {
  const gap = Math.floor((Number(available) || 0) - (Number(contentH) || 0));
  return gap > 1 ? gap : 0;
}

function mergeTranscriptWithLocals(mapped, current) {
  const base = Array.isArray(mapped) ? mapped.slice() : [];
  const extras = (current || []).filter((m) => m && (m._local || m._streaming));
  if (!extras.length) return base;
  const seen = new Set(
    base
      .map((m) => String((m && (m.text || m.content)) || "").trim())
      .filter(Boolean)
  );
  for (const m of extras) {
    const t = String((m.text || m.content || "").trim());
    if (m._streaming || !t || !seen.has(t)) {
      base.push(m);
      if (t) seen.add(t);
    }
  }
  return base;
}

const api = {
  contentHeightWithoutPad,
  nextChatPadding,
  mergeTranscriptWithLocals,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
if (typeof window !== "undefined") {
  window.chatHistory = api;
}
