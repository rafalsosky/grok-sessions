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
  transcript: (payload) => ipcRenderer.invoke("session:transcript", payload),
  chatNew: (payload) => ipcRenderer.invoke("chat:new", payload),
  chatOpen: (payload) => ipcRenderer.invoke("chat:open", payload),
  chatSend: (payload) => ipcRenderer.invoke("chat:send", payload),
  chatSetModel: (payload) => ipcRenderer.invoke("chat:set-model", payload),
  chatSetEffort: (effort) => ipcRenderer.invoke("chat:set-effort", effort),
  chatStop: () => ipcRenderer.invoke("chat:stop"),
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
});
