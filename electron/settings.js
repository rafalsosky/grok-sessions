"use strict";

const fs = require("fs");
const path = require("path");
const {
  resolveGrokHome,
  defaultGrokPath,
  expandHome,
} = require("./sessions");

const DEFAULTS = {
  grokHome: "",
  grokPath: "",
  defaultCwd: require("os").homedir(),
  showSubagents: false,
  alwaysOpenActive: false,
  pollMs: 2000,
  modelId: "grok-4.5",
  homeModelId: "grok-4.5",
  lastMode: "home",
  lastHomeSessionId: "",
  lastCodeSessionId: "",
  theme: "dark",
  effort: "high",
  /** "auto" = --always-approve (agent działa bez pytania), "ask" = agent pyta */
  permissionMode: "auto",
  /** Czytanie ciasteczek grok.com z Arc/Chrome pod tygodniowy %. Opt-in. */
  readBrowserCookies: false,
  /** Python z rookiepy (puste = szukaj w PATH) */
  pythonPath: "",
  /** Limit odpowiedzi w trybie Home */
  homeMaxTokens: 8192,
};

const PERMISSION_MODES = ["auto", "ask"];

function clampTokens(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.homeMaxTokens;
  return Math.max(1024, Math.min(32768, Math.round(n)));
}

function settingsPath(userDataDir) {
  return path.join(userDataDir, "settings.json");
}

function loadSettings(userDataDir) {
  const file = settingsPath(userDataDir);
  let raw = {};
  try {
    if (fs.existsSync(file)) {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    raw = {};
  }
  const merged = { ...DEFAULTS, ...raw };
  const grokHome = resolveGrokHome(merged.grokHome || undefined);
  if (!merged.grokPath) {
    merged.grokPath = defaultGrokPath(grokHome);
  } else {
    merged.grokPath = expandHome(merged.grokPath);
  }
  if (!merged.defaultCwd) merged.defaultCwd = require("os").homedir();
  if (!merged.modelId) merged.modelId = "grok-4.5";
  if (!merged.homeModelId) merged.homeModelId = "grok-4.5";
  if (!merged.lastMode) merged.lastMode = "home";
  if (merged.lastHomeSessionId == null) merged.lastHomeSessionId = "";
  if (merged.lastCodeSessionId == null) merged.lastCodeSessionId = "";
  if (!["dark", "light", "auto"].includes(merged.theme)) merged.theme = "dark";
  if (!["low", "medium", "high", "xhigh"].includes(merged.effort)) {
    merged.effort = "high";
  }
  if (!PERMISSION_MODES.includes(merged.permissionMode)) {
    merged.permissionMode = "auto";
  }
  merged.readBrowserCookies = Boolean(merged.readBrowserCookies);
  merged.pythonPath = merged.pythonPath ? expandHome(merged.pythonPath) : "";
  merged.homeMaxTokens = clampTokens(merged.homeMaxTokens);
  merged.grokHome = grokHome;
  return merged;
}

function saveSettings(userDataDir, partial) {
  const current = loadSettings(userDataDir);
  const next = { ...current, ...partial };
  const toWrite = {
    grokHome:
      partial.grokHome !== undefined
        ? partial.grokHome
        : current.grokHome === resolveGrokHome()
          ? ""
          : current.grokHome,
    grokPath: next.grokPath,
    defaultCwd: next.defaultCwd,
    showSubagents: Boolean(next.showSubagents),
    alwaysOpenActive: Boolean(next.alwaysOpenActive),
    pollMs: Number(next.pollMs) || 2000,
    modelId: next.modelId || "grok-4.5",
    homeModelId: next.homeModelId || "grok-4.5",
    lastMode: next.lastMode === "grok" ? "grok" : "home",
    lastHomeSessionId: next.lastHomeSessionId || "",
    lastCodeSessionId: next.lastCodeSessionId || "",
    theme: ["dark", "light", "auto"].includes(next.theme) ? next.theme : "dark",
    effort: ["low", "medium", "high", "xhigh"].includes(next.effort)
      ? next.effort
      : "high",
    permissionMode: PERMISSION_MODES.includes(next.permissionMode)
      ? next.permissionMode
      : "auto",
    readBrowserCookies: Boolean(next.readBrowserCookies),
    pythonPath: next.pythonPath || "",
    homeMaxTokens: clampTokens(next.homeMaxTokens),
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    settingsPath(userDataDir),
    JSON.stringify(toWrite, null, 2),
    "utf8"
  );
  return loadSettings(userDataDir);
}

module.exports = {
  DEFAULTS,
  loadSettings,
  saveSettings,
  settingsPath,
};
