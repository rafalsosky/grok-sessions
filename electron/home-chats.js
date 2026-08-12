"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function homeDir(userDataDir) {
  return path.join(userDataDir, "home-chats");
}

function ensureDir(userDataDir) {
  const d = homeDir(userDataDir);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function chatPath(userDataDir, id) {
  return path.join(homeDir(userDataDir), `${id}.json`);
}

function newId() {
  // uuid-ish
  if (crypto.randomUUID) return crypto.randomUUID();
  return "home-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2);
}

function listHomeChats(userDataDir) {
  const d = ensureDir(userDataDir);
  const rows = [];
  for (const name of fs.readdirSync(d)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(d, name), "utf8"));
      rows.push({
        id: raw.id,
        title: raw.title || "New chat",
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        messageCount: (raw.messages || []).length,
        kind: "home",
      });
    } catch {
      /* skip */
    }
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
  fs.writeFileSync(p, JSON.stringify(chat, null, 2), "utf8");
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
  homeDir,
};
