"use strict";

/**
 * Claude-style live work line: "Read 7 files, ran 5 commands"
 * plus the current plan item. Pure — no DOM.
 */

function classifyTool(title) {
  const s = String(title || "").toLowerCase();
  if (!s) return "other";
  if (
    /^(read_file|read|cat|head|tail)\b/.test(s) ||
    /\bread_file\b/.test(s)
  ) {
    return "read";
  }
  if (
    /^(write|edit|search_replace|str_replace|apply_patch)\b/.test(s) ||
    /\b(search_replace|write_file)\b/.test(s)
  ) {
    return "edit";
  }
  if (
    /^(run_terminal_command|bash|execute|terminal)\b/.test(s) ||
    /\brun_terminal_command\b/.test(s)
  ) {
    return "command";
  }
  if (
    /^(grep|search|web_search|list_dir|glob|find)\b/.test(s) ||
    /\b(web_search|list_dir)\b/.test(s)
  ) {
    return "search";
  }
  if (/^todo_write\b/.test(s)) return "plan";
  return "other";
}

function summarizeTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const n = { read: 0, edit: 0, command: 0, search: 0, other: 0 };
  for (const t of list) {
    const k = classifyTool(t && (t.title || t.tool || t.name));
    if (k === "plan") continue;
    n[k] = (n[k] || 0) + 1;
  }
  const parts = [];
  if (n.read) parts.push(n.read === 1 ? "Read 1 file" : `Read ${n.read} files`);
  if (n.command) {
    parts.push(n.command === 1 ? "ran 1 command" : `ran ${n.command} commands`);
  }
  if (n.edit) {
    parts.push(n.edit === 1 ? "edited 1 file" : `edited ${n.edit} files`);
  }
  if (n.search) {
    parts.push(n.search === 1 ? "searched once" : `searched ${n.search} times`);
  }
  if (!parts.length && n.other) {
    parts.push(n.other === 1 ? "1 step" : `${n.other} steps`);
  }
  return parts.join(", ");
}

function planProgress(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const done = list.filter((e) => e && e.status === "completed").length;
  const current = list.find((e) => e && e.status === "in_progress") || null;
  const next = list.find((e) => e && e.status === "pending") || null;
  return {
    done,
    total: list.length,
    remaining: Math.max(0, list.length - done),
    current: current ? String(current.content || "").trim() : "",
    next: next ? String(next.content || "").trim() : "",
  };
}

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function almostDone({ plan, phase, tools }) {
  if (phase === "responding") return true;
  if (plan && plan.total && plan.remaining <= 1 && plan.done > 0) return true;
  const list = Array.isArray(tools) ? tools : [];
  if (list.length >= 8) {
    const active = list.filter(
      (t) => t && t.status !== "completed" && t.status !== "failed"
    );
    if (!active.length && phase === "thinking") return true;
  }
  return false;
}

function buildWorkStatus({ tools, planEntries, phase, currentTool, elapsed }) {
  const summary = summarizeTools(tools);
  const plan = planProgress(planEntries);
  const active = (tools || []).filter(
    (t) => t && t.status !== "completed" && t.status !== "failed"
  );
  const headline =
    summary ||
    (phase === "responding" ? "Writing" : phase === "queued" ? "Queued" : "Working");
  const now =
    clip(plan.current, 64) ||
    clip(currentTool, 48) ||
    (active.length ? `${active.length} running` : "");
  const bits = [];
  if (elapsed) bits.push(elapsed);
  if (plan.total) bits.push(`${plan.done}/${plan.total}`);
  if (almostDone({ plan, phase, tools })) bits.push("almost done");
  return {
    headline,
    now,
    footer: bits.join(" · "),
    plan,
    active: active.length,
    done: (tools || []).length - active.length,
  };
}

const api = {
  classifyTool,
  summarizeTools,
  planProgress,
  almostDone,
  buildWorkStatus,
};

if (typeof window !== "undefined") window.workSummary = api;
if (typeof module !== "undefined") module.exports = api;
