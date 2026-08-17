"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grokSessions", {
  list: () => ipcRenderer.invoke("sessions:list"),
  onUpdated: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("sessions:updated", handler);
    return () => ipcRenderer.removeListener("sessions:updated", handler);
  },
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (partial) => ipcRenderer.invoke("settings:set", partial),
  setNav: (partial) => ipcRenderer.invoke("nav:set", partial),
  replaceHomeMessages: (payload) =>
    ipcRenderer.invoke("home:replace-messages", payload),
  transcript: (payload) => ipcRenderer.invoke("session:transcript", payload),
  chatSend: (payload) => ipcRenderer.invoke("chat:send", payload),
  chatSetModel: (payload) => ipcRenderer.invoke("chat:set-model", payload),
  chatSetEffort: (effort) => ipcRenderer.invoke("chat:set-effort", effort),
  chatStop: (payload) => ipcRenderer.invoke("chat:stop", payload || {}),
  permissionReply: (payload) =>
    ipcRenderer.invoke("chat:permission-reply", payload),
  renameSession: (payload) => ipcRenderer.invoke("session:rename", payload),
  deleteSession: (payload) => ipcRenderer.invoke("session:delete", payload),
  revealSession: (dirPath) => ipcRenderer.invoke("session:reveal", dirPath),
  login: () => ipcRenderer.invoke("session:login"),
  pickGrokBinary: () => ipcRenderer.invoke("app:pickGrokBinary"),
  pickFiles: () => ipcRenderer.invoke("app:pickFiles"),
  saveAttachmentBase64: (payload) =>
    ipcRenderer.invoke("attachments:save-base64", payload),
  importAttachmentPath: (p) => ipcRenderer.invoke("attachments:import-path", p),
  readPreview: (p) => ipcRenderer.invoke("attachments:read-preview", p),
  getAccount: () => ipcRenderer.invoke("account:get"),
  getUsage: (payload) => ipcRenderer.invoke("usage:get", payload || {}),
  getSessionFlags: () => ipcRenderer.invoke("session-flags:get-all"),
  setSessionFlag: (payload) => ipcRenderer.invoke("session-flags:set", payload),
  onChatUpdate: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("chat:update", handler);
    return () => ipcRenderer.removeListener("chat:update", handler);
  },
  onChatBusy: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("chat:busy", handler);
    return () => ipcRenderer.removeListener("chat:busy", handler);
  },
  onChatError: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("chat:error", handler);
    return () => ipcRenderer.removeListener("chat:error", handler);
  },
  onChatModels: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("chat:models", handler);
    return () => ipcRenderer.removeListener("chat:models", handler);
  },
  onChatStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("chat:status", handler);
    return () => ipcRenderer.removeListener("chat:status", handler);
  },
  /** Proces agenta padl (crash / brak binarki). Bez tego kanal szedl w prozne. */
  /** Nowa sesja Build dostala sid — z tokenem tury, ktora ja utworzyla. */
  onChatSessionStarted: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("chat:session-started", handler);
    return () => ipcRenderer.removeListener("chat:session-started", handler);
  },
  onChatAgentExit: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("chat:agent-exit", handler);
    return () => ipcRenderer.removeListener("chat:agent-exit", handler);
  },
  onChatPermission: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on("chat:permission", handler);
    return () => ipcRenderer.removeListener("chat:permission", handler);
  },
});
