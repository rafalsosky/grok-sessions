"use strict";

const fs = require("fs");
const path = require("path");

function flagsPath(userDataDir) {
  return path.join(userDataDir, "session-flags.json");
}

function loadFlags(userDataDir) {
  try {
    const raw = fs.readFileSync(flagsPath(userDataDir), "utf8");
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function saveFlags(userDataDir, flags) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(flagsPath(userDataDir), JSON.stringify(flags, null, 2));
  return flags;
}

function getFlag(userDataDir, id) {
  const all = loadFlags(userDataDir);
  return all[id] || { unread: false, pinned: false };
}

function setFlag(userDataDir, id, partial) {
  const all = loadFlags(userDataDir);
  const prev = all[id] || { unread: false, pinned: false };
  all[id] = { ...prev, ...partial, updatedAt: Date.now() };
  saveFlags(userDataDir, all);
  return all[id];
}

module.exports = { loadFlags, saveFlags, getFlag, setFlag };
