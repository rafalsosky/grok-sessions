"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { attachRoot, isAllowedPreviewPath } = require("./attachments");

function homeDir(userDataDir) {
  return path.join(userDataDir, "home-chats");
}

function ensureDir(userDataDir) {
  const d = homeDir(userDataDir);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function chatPath(userDataDir, id) {
  // Id przychodzi z renderera. Bez tej bramki "../../.." zapisywalo
  // i kasowalo pliki poza katalogiem danych aplikacji.
  if (!/^[\w-]{1,128}$/.test(String(id))) throw new Error("bad chat id");
  return path.join(homeDir(userDataDir), `${id}.json`);
}

function newId() {
  // uuid-ish
  if (crypto.randomUUID) return crypto.randomUUID();
  return "home-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2);
}

function pruneEmptyHomeChats(userDataDir) {
  const d = ensureDir(userDataDir);
  let removed = 0;
  const zostaly = [];
  for (const name of fs.readdirSync(d)) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(d, name);
    try {
      const raw = JSON.parse(fs.readFileSync(full, "utf8"));
      const empty = !raw.messages || raw.messages.length === 0;
      const untitled = !raw.title || raw.title === "New chat";
      if (empty && untitled) {
        fs.unlinkSync(full);
        removed += 1;
      } else {
        zostaly.push(raw);
      }
    } catch {
      /* skip broken */
    }
  }
  return { removed, zostaly };
}

function listHomeChats(userDataDir) {
  // Kazde odswiezenie listy parsowalo WSZYSTKIE pliki czatow dwa razy:
  // raz w prune, raz tutaj. Prune oddaje teraz to, co przezylo.
  const { zostaly } = pruneEmptyHomeChats(userDataDir);
  const rows = [];
  for (const raw of zostaly) {
    if (!raw || !raw.id) continue;
    rows.push({
      id: raw.id,
      title: raw.title || "New chat",
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      messageCount: (raw.messages || []).length,
      kind: "home",
    });
  }
  rows.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  return rows;
}

function loadHomeChat(userDataDir, id) {
  const p = chatPath(userDataDir, id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveHomeChat(userDataDir, chat) {
  ensureDir(userDataDir);
  const p = chatPath(userDataDir, chat.id);
  // Zapis w miejscu: przerwanie w polowie zostawialo ucięty JSON i czat
  // znikal bez sladu. rename na tym samym wolumenie jest atomowy.
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(chat, null, 2), "utf8");
  fs.renameSync(tmp, p);
  return chat;
}

function createHomeChat(userDataDir, title = "New chat") {
  const now = new Date().toISOString();
  const chat = {
    id: newId(),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  return saveHomeChat(userDataDir, chat);
}

function deleteHomeChat(userDataDir, id) {
  const p = chatPath(userDataDir, id);
  // Pliki zalacznikow zostawaly na dysku po skasowaniu czatu — audyt zmierzyl
  // 37 MB przy jednej rozmowie. Kasujemy TYLKO to, co lezy w naszym katalogu.
  try {
    const chat = loadHomeChat(userDataDir, id);
    const root = attachRoot(userDataDir);
    const sciezki = [];
    for (const m of (chat && chat.messages) || []) {
      for (const grupa of [m.attachments, m.images, m.videos]) {
        for (const a of grupa || []) if (a && a.path) sciezki.push(a.path);
      }
    }
    for (const f of sciezki) {
      if (isAllowedPreviewPath(root, f)) fs.rmSync(f, { force: true });
    }
  } catch {
    /* uszkodzony plik czatu nie ma blokowac kasowania */
  }
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { ok: true };
}

function renameHomeChat(userDataDir, id, title) {
  const chat = loadHomeChat(userDataDir, id);
  if (!chat) return { ok: false, error: "Not found" };
  chat.title = title;
  chat.updatedAt = new Date().toISOString();
  saveHomeChat(userDataDir, chat);
  return { ok: true, chat };
}

function toDiskMessage(m) {
  if (!m || typeof m !== "object") {
    return {
      id: "",
      role: "user",
      content: "",
      createdAt: new Date().toISOString(),
    };
  }
  return {
    id: m.id || "",
    role: m.role === "assistant" ? "assistant" : "user",
    content:
      m.content != null && String(m.content) !== ""
        ? String(m.content)
        : String(m.text || ""),
    attachments: m.attachments || [],
    images: m.images || [],
    videos: m.videos || [],
    createdAt: m.createdAt || new Date().toISOString(),
  };
}

function replaceMessages(userDataDir, id, messages) {
  const chat = loadHomeChat(userDataDir, id);
  if (!chat) return { ok: false, error: "Not found" };
  chat.messages = (messages || []).map(toDiskMessage);
  chat.updatedAt = new Date().toISOString();
  saveHomeChat(userDataDir, chat);
  return { ok: true, chat };
}

function appendHomeMessage(userDataDir, id, message) {
  let chat = loadHomeChat(userDataDir, id);
  if (!chat) {
    // Nie przez createHomeChat: to zapisywało plik pod nowym UUID, a potem
    // drugi pod żądanym id — pusta sierota zostawała na dysku.
    const now = new Date().toISOString();
    chat = {
      id: id || newId(),
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }
  chat.messages.push(message);
  chat.updatedAt = new Date().toISOString();
  if (
    (!chat.title || chat.title === "New chat") &&
    message.role === "user" &&
    message.content
  ) {
    chat.title = String(message.content).replace(/\s+/g, " ").slice(0, 60);
  }
  saveHomeChat(userDataDir, chat);
  return chat;
}

module.exports = {
  listHomeChats,
  loadHomeChat,
  saveHomeChat,
  createHomeChat,
  deleteHomeChat,
  renameHomeChat,
  appendHomeMessage,
  replaceMessages,
  toDiskMessage,
  pruneEmptyHomeChats,
  homeDir,
};
