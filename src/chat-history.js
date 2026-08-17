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
  const out = base.slice();
  for (const m of extras) {
    const t = String((m.text || m.content || "").trim());
    if (m._streaming || !t || !seen.has(t)) {
      // First user bubble belongs at the start, not after the reply.
      if (m.role === "user" && m._local && !out.some((x) => x.role === "user")) {
        out.unshift(m);
      } else {
        out.push(m);
      }
      if (t) seen.add(t);
    }
  }
  return out;
}

/**
 * Live buffer of a brand-new session often has only the assistant
 * (stream went offscreen before the session id existed). Put local
 * user bubbles back, including those still missing _sid.
 */
function mergeLiveBufferWithLocals(liveMsgs, current, sid) {
  const extras = (current || []).filter((m) => {
    if (!m || !(m._local || m._streaming)) return false;
    if (m._sid && sid && m._sid !== sid) return false;
    return true;
  });
  return mergeTranscriptWithLocals(liveMsgs || [], extras);
}

function isOrphanLocalForSession(m, sid) {
  if (!m || !(m._local || m._streaming)) return false;
  return !m._sid || m._sid === sid;
}

const api = {
  contentHeightWithoutPad,
  nextChatPadding,
  mergeTranscriptWithLocals,
  mergeLiveBufferWithLocals,
  isOrphanLocalForSession,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
if (typeof window !== "undefined") {
  window.chatHistory = api;
}
