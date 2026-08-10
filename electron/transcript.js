"use strict";

const fs = require("fs");
const path = require("path");
const { stripAttachmentAppendix } = require("./attachments");

/**
 * Build a chat-friendly message list from updates.jsonl (ACP stream log).
 */
function loadTranscript(sessionDir) {
  const updatesPath = path.join(sessionDir, "updates.jsonl");
  if (!fs.existsSync(updatesPath)) {
    return { messages: [], error: null, path: updatesPath };
  }

  const messages = [];
  let current = null;

  const pushUser = (text) => {
    if (!text) return;
    if (current && current.role === "user") {
      current.text += text;
      return;
    }
    current = {
      id: `u-${messages.length}`,
      role: "user",
      text,
      tools: [],
      thinking: "",
    };
    messages.push(current);
  };

  const pushAssistant = () => {
    if (current && current.role === "assistant") return current;
    current = {
      id: `a-${messages.length}`,
      role: "assistant",
      text: "",
      tools: [],
      thinking: "",
    };
    messages.push(current);
    return current;
  };

  try {
    const raw = fs.readFileSync(updatesPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.method !== "session/update") continue;
      const u = (o.params && o.params.update) || {};
      const kind = u.sessionUpdate;

      if (kind === "user_message_chunk") {
        const t = stripAttachmentAppendix((u.content && u.content.text) || "");
        if (!t) continue;
        // drugi pas: gdy marker w środku / bez END
        if (/GROK_SESSIONS_ATTACHMENTS/i.test(t) && t.replace(/<<<[^>]+>>>/g, "").trim().length < 8) {
          continue;
        }
        pushUser(t);
      } else if (kind === "agent_message_chunk") {
        const chunk = (u.content && u.content.text) || "";
        // nie ładuj do UI dumpów Execute / attachment markers / shell
        if (/GROK_SESSIONS_ATTACHMENTS|The user attached/i.test(chunk)) continue;
        if (/^\s*Execute\b/i.test(chunk)) continue;
        if (
          chunk.length > 60 &&
          !/[.!?…]/.test(chunk.slice(0, 200)) &&
          /^(python3?|node|bash|zsh|sh|import |from |const |def |#!\/)/i.test(
            chunk.trim()
          )
        ) {
          continue;
        }
        const a = pushAssistant();
        a.text += chunk;
        // po doklejeniu wytnij Execute bloki (split across chunks)
        a.text = a.text
          .replace(/Execute\s*`[\s\S]*?`(?=\s*(?:\n|$|Execute|[A-Z]))/gi, "")
          .replace(/Execute\s*`[\s\S]*$/gi, "")
          .replace(/Execute\s+[^\n]*(?:\n(?!\n)[^\n]*)*/gi, "");
      } else if (kind === "agent_thought_chunk") {
        // thinking nie ląduje w tekście — tylko licznik w UI
        const a = pushAssistant();
        a.thinking += (u.content && u.content.text) || "";
      } else if (kind === "tool_call") {
        const a = pushAssistant();
        a.tools.push({
          id: u.toolCallId || u.tool_call_id || `t-${a.tools.length}`,
          title: u.title || u.tool || u.kind || "tool",
          kind: u.kind || null,
          status: u.status || "pending",
          // raw NIE — to powodowało ściany kodu w czacie
          raw: "",
        });
      } else if (kind === "tool_call_update") {
        const a = pushAssistant();
        const id = u.toolCallId || u.tool_call_id;
        const tool = a.tools.find((t) => t.id === id) || a.tools[a.tools.length - 1];
        if (tool) {
          if (u.status) tool.status = u.status;
          if (u.title) tool.title = u.title;
        }
      }
    }
  } catch (err) {
    return { messages: [], error: err.message, path: updatesPath };
  }

  // Final pass: strip residual Execute / attachment junk from message texts
  for (const m of messages) {
    if (!m.text) continue;
    if (m.role === "user") {
      m.text = stripAttachmentAppendix(m.text);
    } else {
      m.text = m.text
        .replace(/Execute\s*`[\s\S]*?`/gi, "")
        .replace(/Execute\s*`[\s\S]*$/gi, "")
        .replace(/Execute\s+[^\n]*(?:\n(?!\n)[^\n]*)*/gi, "")
        .replace(/<<<GROK_SESSIONS_ATTACHMENTS>>>[\s\S]*/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
  }

  // Drop pure system noise / empty shells after cleaning
  const cleaned = messages.filter(
    (m) =>
      (m.text && m.text.trim()) ||
      (m.tools && m.tools.length) ||
      (m.thinking && m.thinking.trim())
  );

  return { messages: cleaned, error: null, path: updatesPath };
}

function summarizeTool(u) {
  const parts = [];
  if (u.path) parts.push(String(u.path));
  if (u.locations && Array.isArray(u.locations)) {
    parts.push(u.locations.map((l) => l.path || JSON.stringify(l)).join(", "));
  }
  if (u.content && typeof u.content === "object") {
    if (u.content.text) parts.push(String(u.content.text).slice(0, 200));
  }
  if (u.rawInput) {
    try {
      const s =
        typeof u.rawInput === "string" ? u.rawInput : JSON.stringify(u.rawInput);
      parts.push(s.slice(0, 240));
    } catch {
      /* ignore */
    }
  }
  return parts.filter(Boolean).join(" · ").slice(0, 400);
}

module.exports = { loadTranscript };
