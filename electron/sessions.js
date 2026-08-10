"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveGrokHome(override) {
  if (override) return expandHome(override);
  if (process.env.GROK_HOME) return expandHome(process.env.GROK_HOME);
  return path.join(os.homedir(), ".grok");
}

function defaultGrokPath(grokHome) {
  return path.join(grokHome, "bin", "grok");
}

function pidAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadActiveMap(grokHome) {
  const file = path.join(grokHome, "active_sessions.json");
  const data = readJsonSafe(file, []);
  const map = new Map();
  if (!Array.isArray(data)) return map;
  for (const entry of data) {
    if (!entry || !entry.session_id) continue;
    const pid = Number(entry.pid);
    const alive = pidAlive(pid);
    map.set(entry.session_id, {
      pid: alive ? pid : null,
      cwd: entry.cwd || null,
      openedAt: entry.opened_at || null,
      isActive: alive,
    });
  }
  return map;
}

function titleFromSummary(summary) {
  const t =
    (summary.session_summary && String(summary.session_summary).trim()) ||
    (summary.generated_title && String(summary.generated_title).trim()) ||
    "";
  if (t) return t;
  const id = summary?.info?.id || "";
  return id ? id.slice(0, 8) : "(bez tytułu)";
}

function kindFromSummary(summary) {
  return summary.session_kind === "subagent" ? "subagent" : "top";
}

/** Scan all session summary.json files under grok sessions root. */
function scanSessions(options = {}) {
  const grokHome = resolveGrokHome(options.grokHome);
  const sessionsRoot = path.join(grokHome, "sessions");
  const showSubagents = Boolean(options.showSubagents);
  const activeMap = loadActiveMap(grokHome);
  const rows = [];

  if (!fs.existsSync(sessionsRoot)) {
    return {
      grokHome,
      sessionsRoot,
      rows: [],
      error: `Brak katalogu sesji: ${sessionsRoot}`,
    };
  }

  let cwdDirs = [];
  try {
    cwdDirs = fs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    return {
      grokHome,
      sessionsRoot,
      rows: [],
      error: `Nie mogę czytać ${sessionsRoot}: ${err.message}`,
    };
  }

  for (const cwdEnc of cwdDirs) {
    const cwdPath = path.join(sessionsRoot, cwdEnc);
    let sessionDirs = [];
    try {
      sessionDirs = fs
        .readdirSync(cwdPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const sessionId of sessionDirs) {
      if (!UUID_RE.test(sessionId)) continue;
      const dirPath = path.join(cwdPath, sessionId);
      const summaryPath = path.join(dirPath, "summary.json");
      if (!fs.existsSync(summaryPath)) continue;

      const summary = readJsonSafe(summaryPath, null);
      if (!summary || !summary.info || !summary.info.id) continue;

      const kind = kindFromSummary(summary);
      if (kind === "subagent" && !showSubagents) continue;

      const id = summary.info.id;
      const active = activeMap.get(id);

      rows.push({
        id,
        cwd: summary.info.cwd || "",
        title: titleFromSummary(summary),
        modelId: summary.current_model_id || null,
        createdAt: summary.created_at || null,
        updatedAt: summary.updated_at || null,
        lastActiveAt: summary.last_active_at || summary.updated_at || null,
        numMessages: summary.num_messages ?? 0,
        numChatMessages: summary.num_chat_messages ?? 0,
        kind,
        agentName: summary.agent_name || null,
        isActive: Boolean(active?.isActive),
        activePid: active?.isActive ? active.pid : null,
        dirPath,
        lastTurnSummary: summary.last_turn_summary || null,
      });
    }
  }

  rows.sort((a, b) => {
    const ta = Date.parse(a.lastActiveAt || a.updatedAt || 0) || 0;
    const tb = Date.parse(b.lastActiveAt || b.updatedAt || 0) || 0;
    return tb - ta;
  });

  return { grokHome, sessionsRoot, rows, error: null };
}

function checkGrokBinary(grokPath) {
  const p = expandHome(grokPath);
  if (!p) return { ok: false, path: p, reason: "Brak ścieżki do grok" };
  if (!fs.existsSync(p)) {
    return { ok: false, path: p, reason: `Nie ma pliku: ${p}` };
  }
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return { ok: true, path: p, reason: null };
  } catch {
    return { ok: false, path: p, reason: `Brak prawa uruchomienia: ${p}` };
  }
}

function authPresent(grokHome) {
  const auth = path.join(grokHome, "auth.json");
  return fs.existsSync(auth);
}

module.exports = {
  UUID_RE,
  expandHome,
  resolveGrokHome,
  defaultGrokPath,
  pidAlive,
  readJsonSafe,
  scanSessions,
  checkGrokBinary,
  authPresent,
  loadActiveMap,
};
