"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Finder / Dock nie ładuje login-shell PATH. Electron dziedziczy
 * `/usr/bin:/bin:/usr/sbin:/sbin`, więc `npx` i `node` z /usr/local/bin
 * nie istnieją i MCP (fathom, hostinger, thunderbird) pada na starcie.
 */
const LOGIN_PATH_DIRS = [
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/opt/homebrew/opt/node/bin",
];

function extraHomeBins(home) {
  const root = home || os.homedir();
  return [
    path.join(root, ".local", "bin"),
    path.join(root, ".grok", "bin"),
  ];
}

function loginPath(baseEnv) {
  const env = baseEnv || process.env || {};
  const seen = new Set();
  const out = [];
  const push = (dir) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    out.push(dir);
  };
  for (const dir of LOGIN_PATH_DIRS) push(dir);
  for (const dir of extraHomeBins(env.HOME)) {
    if (fs.existsSync(dir)) push(dir);
  }
  const existing = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of existing) push(dir);
  return out.join(path.delimiter);
}

function spawnEnv(baseEnv) {
  const env = { ...(baseEnv || process.env || {}) };
  if (!env.HOME) env.HOME = os.homedir();
  env.PATH = loginPath(env);
  return env;
}

function spawnCwd(cwd) {
  const raw = cwd || os.homedir();
  try {
    if (raw && fs.existsSync(raw) && fs.statSync(raw).isDirectory()) return raw;
  } catch {
    /* ignore */
  }
  return os.homedir();
}

module.exports = { LOGIN_PATH_DIRS, loginPath, spawnEnv, spawnCwd };
