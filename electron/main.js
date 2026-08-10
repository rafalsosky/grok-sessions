"use strict";

const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const {
  scanSessions,
  checkGrokBinary,
  authPresent,
  UUID_RE,
  expandHome,
  resolveGrokHome,
} = require("./sessions");
const { loadSettings, saveSettings } = require("./settings");
const { loadTranscript } = require("./transcript");
const { loadAccount } = require("./account");
const { AcpClient } = require("./acp-client");
const homeChats = require("./home-chats");
const xai = require("./xai-api");
const {
  saveBase64,
  importPath,
  formatAttachmentsForPrompt,
} = require("./attachments");
const { getUsage } = require("./usage");
const sessionFlags = require("./session-flags");

const execFileAsync = promisify(execFile);

let mainWindow = null;
let watchers = [];
let pollTimer = null;
/** @type {AcpClient|null} */
let acp = null;
let promptBusy = false;

function userDataDir() {
  return app.getPath("userData");
}

function getSettings() {
  return loadSettings(userDataDir());
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, "..", "assets", "GrokSessions.icns");
  const winOpts = {
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "Grok Sessions",
    backgroundColor: "#262624",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  };
  if (fs.existsSync(iconPath)) {
    winOpts.icon = iconPath;
  }
  mainWindow = new BrowserWindow(winOpts);

  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env.GROK_SESSIONS_DEBUG === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function buildListPayload() {
  const settings = getSettings();
  const result = scanSessions({
    grokHome: settings.grokHome,
    showSubagents: settings.showSubagents,
  });
  const bin = checkGrokBinary(settings.grokPath);
  const account = loadAccount(result.grokHome || settings.grokHome);
  const homeRows = homeChats.listHomeChats(userDataDir()).map((r) => ({
    id: r.id,
    cwd: "",
    title: r.title,
    modelId: "home",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastActiveAt: r.updatedAt,
    numMessages: r.messageCount,
    numChatMessages: r.messageCount,
    kind: "home",
    agentName: "home",
    isActive: false,
    activePid: null,
    dirPath: null,
    lastTurnSummary: null,
  }));

  return {
    ...result,
    homeRows,
    grokBinary: bin,
    authOk: authPresent(result.grokHome),
    account,
    models: acp
      ? {
          currentModelId: acp.currentModelId,
          availableModels: acp.models,
        }
      : {
          currentModelId: settings.modelId || "grok-4.5",
          availableModels: [
            { modelId: "grok-4.5", name: "Grok 4.5" },
            { modelId: "grok-imagine-image", name: "Imagine (image)" },
          ],
        },
    homeModels: [
      { modelId: "grok-4.5", name: "Grok 4.5" },
      { modelId: "grok-4.3", name: "Grok 4.3" },
      { modelId: "grok-imagine-image", name: "Imagine · image" },
    ],
    settings: {
      grokPath: settings.grokPath,
      grokHome: settings.grokHome,
      defaultCwd: settings.defaultCwd,
      showSubagents: settings.showSubagents,
      alwaysOpenActive: settings.alwaysOpenActive,
      pollMs: settings.pollMs,
      modelId: settings.modelId || "grok-4.5",
      homeModelId: settings.homeModelId || "grok-4.5",
      lastMode: settings.lastMode || "home",
      lastHomeSessionId: settings.lastHomeSessionId || "",
      lastCodeSessionId: settings.lastCodeSessionId || "",
    },
    agentReady: Boolean(acp && acp.ready),
    promptBusy,
    /** Tylko ta sesja Build ma „pracuje” — nie cała lista */
    activeSessionId: acp ? acp.sessionId : null,
    busySessionId: promptBusy && acp && acp.sessionId ? acp.sessionId : null,
  };
}

function pushSessions() {
  send("sessions:updated", buildListPayload());
}

function clearWatchers() {
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  watchers = [];
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startWatchers() {
  clearWatchers();
  const settings = getSettings();
  const grokHome = settings.grokHome;
  const sessionsRoot = path.join(grokHome, "sessions");
  const activeFile = path.join(grokHome, "active_sessions.json");

  let debounce = null;
  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => pushSessions(), 400);
  };

  const tryWatch = (target, opts) => {
    try {
      if (!fs.existsSync(target)) return;
      watchers.push(fs.watch(target, opts || {}, schedule));
    } catch {
      /* poll */
    }
  };

  tryWatch(sessionsRoot, { recursive: true });
  tryWatch(activeFile);
  tryWatch(homeChats.homeDir(userDataDir()));

  const pollMs = Math.max(3000, Number(settings.pollMs) || 5000);
  pollTimer = setInterval(pushSessions, pollMs);
}

async function ensureAcp() {
  const settings = getSettings();
  const bin = checkGrokBinary(settings.grokPath);
  if (!bin.ok) throw new Error(bin.reason || "Brak grok");

  if (!acp) {
    acp = new AcpClient({
      grokPath: settings.grokPath,
      model: settings.modelId || "grok-4.5",
      alwaysApprove: true,
      reasoningEffort: settings.effort || "high",
    });
    acp.on("update", (params) => {
      send("chat:update", params);
    });
    acp.on("error", (err) => {
      send("chat:error", { message: err.message });
    });
    acp.on("exit", (code) => {
      send("chat:agent-exit", { code });
      pushSessions();
    });
    acp.on("models", (m) => {
      send("chat:models", m);
    });
  }
  await acp.start();
  return acp;
}

function status(phase, detail) {
  send("chat:status", { phase, detail: detail || "", at: Date.now() });
}

async function sendHomeChat({
  text,
  sessionId,
  attachments,
  modelId,
  homeKind,
  aspectRatio,
}) {
  const settings = getSettings();
  const token = xai.getAccessToken(settings.grokHome || resolveGrokHome());
  if (!token) throw new Error("Brak tokenu xAI — zaloguj się (grok login)");

  let chat = sessionId ? homeChats.loadHomeChat(userDataDir(), sessionId) : null;
  if (!chat) chat = homeChats.createHomeChat(userDataDir());

  const userMsg = {
    id: `u-${Date.now()}`,
    role: "user",
    content: text,
    attachments: (attachments || []).map((a) => ({
      name: a.name,
      path: a.path,
      kind: a.kind,
      mimeType: a.mimeType,
    })),
    createdAt: new Date().toISOString(),
  };
  chat = homeChats.appendHomeMessage(userDataDir(), chat.id, userMsg);

  const kind = homeKind || "chat";
  const wantImage =
    kind === "image" ||
    xai.looksLikeImagePrompt(text) ||
    (modelId && String(modelId).includes("imagine-image"));
  const wantVideo =
    kind === "video" ||
    /^\/video\b/i.test(String(text || "")) ||
    /wygeneruj wideo|generate video|zrób film/i.test(String(text || ""));

  if (wantVideo) {
    status("generating_image", "Generuję wideo / klatkę…");
    const prompt = String(text || "")
      .replace(/^\/video\s+/i, "")
      .trim();
    const vid = await xai.generateVideo(token, {
      prompt,
      aspect_ratio: aspectRatio || "16:9",
    });
    let assistantMsg;
    if (vid.kind === "storyboard" || vid.b64) {
      const saved = saveBase64(userDataDir(), {
        name: "video-frame.png",
        mimeType: vid.mimeType || "image/png",
        base64: vid.b64,
        kind: "image",
      });
      assistantMsg = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: vid.note || "Klatka wideo / storyboard.",
        images: [
          { path: saved.path, mimeType: saved.mimeType, b64: vid.b64 },
        ],
        createdAt: new Date().toISOString(),
      };
    } else {
      assistantMsg = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: vid.url
          ? `Wideo: ${vid.url}`
          : "Wideo wygenerowane (brak podglądu w UI).",
        createdAt: new Date().toISOString(),
      };
    }
    chat = homeChats.appendHomeMessage(userDataDir(), chat.id, assistantMsg);
    return {
      ok: true,
      mode: "home",
      sessionId: chat.id,
      title: chat.title,
      assistant: assistantMsg,
    };
  }

  if (wantImage) {
    status("generating_image", "Generuję grafikę…");
    const prompt = xai.stripImageCommand(text) || text;
    const img = await xai.generateImage(token, {
      prompt,
      model: "grok-imagine-image",
      aspect_ratio: aspectRatio || "1:1",
    });
    const saved = saveBase64(userDataDir(), {
      name: "generated.png",
      mimeType: img.mimeType,
      base64: img.b64,
      kind: "image",
    });
    const assistantMsg = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: `Wygenerowano grafikę (${aspectRatio || "1:1"}) dla: „${prompt.slice(0, 120)}"`,
      images: [
        {
          path: saved.path,
          mimeType: saved.mimeType,
          b64: img.b64,
        },
      ],
      createdAt: new Date().toISOString(),
    };
    chat = homeChats.appendHomeMessage(userDataDir(), chat.id, assistantMsg);
    return {
      ok: true,
      mode: "home",
      sessionId: chat.id,
      title: chat.title,
      assistant: assistantMsg,
    };
  }

  status("thinking", "Myślę…");
  const model = modelId || settings.homeModelId || "grok-4.5";

  // Build OpenAI-style messages from history
  const apiMessages = [];
  for (const m of chat.messages) {
    if (m.role === "user") {
      let content = m.content || "";
      if (m.attachments && m.attachments.length) {
        content +=
          "\n\n[Załączniki: " +
          m.attachments.map((a) => a.path || a.name).join(", ") +
          "]";
      }
      // Multimodal: include last user images as data URLs when present on THIS message
      if (m.attachments && m.attachments.some((a) => a.kind === "image" && a.path)) {
        const parts = [{ type: "text", text: content || " " }];
        for (const a of m.attachments) {
          if (a.kind === "image" && a.path && fs.existsSync(a.path)) {
            try {
              const b64 = fs.readFileSync(a.path).toString("base64");
              const mime = a.mimeType || "image/png";
              parts.push({
                type: "image_url",
                image_url: { url: `data:${mime};base64,${b64}` },
              });
            } catch {
              /* skip */
            }
          }
        }
        apiMessages.push({ role: "user", content: parts });
      } else {
        apiMessages.push({ role: "user", content });
      }
    } else if (m.role === "assistant") {
      apiMessages.push({ role: "assistant", content: m.content || "" });
    }
  }

  // If current attachments have images, ensure current user turn includes them
  // (already in chat.messages via append)

  status("responding", "Piszę odpowiedź…");
  const res = await xai.chatCompletions(token, {
    model: model.includes("imagine") ? "grok-4.5" : model,
    messages: apiMessages,
    max_tokens: 4096,
  });
  const reply =
    (res.choices &&
      res.choices[0] &&
      res.choices[0].message &&
      res.choices[0].message.content) ||
    "";

  const assistantMsg = {
    id: `a-${Date.now()}`,
    role: "assistant",
    content: reply,
    createdAt: new Date().toISOString(),
  };
  chat = homeChats.appendHomeMessage(userDataDir(), chat.id, assistantMsg);

  return {
    ok: true,
    mode: "home",
    sessionId: chat.id,
    title: chat.title,
    assistant: assistantMsg,
  };
}

async function sendCodeChat({ text, sessionId, cwd, attachments }) {
  status("starting", "Uruchamiam agenta…");
  const client = await ensureAcp();
  const settings = getSettings();
  const workCwd = expandHome(cwd || settings.defaultCwd);

  let sid = sessionId;
  if (!sid) {
    status("session", "Nowa sesja Code…");
    client.sessionId = null;
    const created = await client.ensureSession({ cwd: workCwd });
    sid = created.sessionId;
  } else {
    status("session", "Ładuję sesję…");
    await client.ensureSession({ sessionId: sid, cwd: workCwd });
  }

  const promptText = String(text || "") + formatAttachmentsForPrompt(attachments);

  // NIE wysyłaj user_message_chunk do UI — renderer już dodał bańkę lokalnie.
  // Echo stąd + echo z ACP = podwójna wiadomość i skok scrolla.

  status("thinking", "Agent pracuje…");
  // Do agenta: tekst + ścieżki załączników
  const result = await client.prompt(promptText, {
    sessionId: sid,
    cwd: workCwd,
  });

  return {
    ok: true,
    mode: "grok",
    sessionId: sid,
    result,
  };
}

function registerIpc() {
  ipcMain.handle("sessions:list", async () => buildListPayload());

  ipcMain.handle("usage:get", async (_e, payload) => {
    try {
      const settings = getSettings();
      return await getUsage({
        sessionId: (payload && payload.sessionId) || null,
        grokHome: settings.grokHome,
        includeRate: payload ? payload.includeRate !== false : true,
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("session-flags:get-all", async () => {
    return { ok: true, flags: sessionFlags.loadFlags(userDataDir()) };
  });

  ipcMain.handle("session-flags:set", async (_e, payload) => {
    const { id, unread, pinned } = payload || {};
    if (!id) return { ok: false, error: "no id" };
    const partial = {};
    if (typeof unread === "boolean") partial.unread = unread;
    if (typeof pinned === "boolean") partial.pinned = pinned;
    const flag = sessionFlags.setFlag(userDataDir(), id, partial);
    return { ok: true, flag };
  });

  ipcMain.handle("settings:get", async () => getSettings());

  ipcMain.handle("settings:set", async (_e, partial) => {
    const next = saveSettings(userDataDir(), partial || {});
    if (partial && partial.modelId && acp) {
      try {
        await acp.setModel(partial.modelId);
      } catch (err) {
        send("chat:error", { message: err.message });
      }
    }
    startWatchers();
    pushSessions();
    return next;
  });

  ipcMain.handle("session:transcript", async (_e, payload) => {
    const { id, dirPath, mode } = payload || {};
    if (mode === "home" || (id && String(id).startsWith("home-")) || (id && !UUID_RE.test(id) && !dirPath)) {
      const chat = homeChats.loadHomeChat(userDataDir(), id);
      if (!chat) return { messages: [], error: "Home chat not found" };
      const messages = (chat.messages || []).map((m) => ({
        id: m.id,
        role: m.role,
        text: m.content || "",
        tools: [],
        thinking: "",
        images: m.images || [],
        attachments: m.attachments || [],
      }));
      return { messages, error: null, kind: "home", title: chat.title };
    }
    if (!dirPath || !fs.existsSync(dirPath)) {
      const settings = getSettings();
      const scan = scanSessions({
        grokHome: settings.grokHome,
        showSubagents: true,
      });
      const row = scan.rows.find((r) => r.id === id);
      if (!row) return { messages: [], error: "Sesja nie znaleziona" };
      return loadTranscript(row.dirPath);
    }
    return loadTranscript(dirPath);
  });

  ipcMain.handle("chat:new", async (_e, payload) => {
    const mode = (payload && payload.mode) || "home";
    if (mode === "home") {
      const chat = homeChats.createHomeChat(userDataDir());
      pushSessions();
      return { ok: true, sessionId: chat.id, mode: "home", title: chat.title };
    }
    // Code: lazy — no agent yet
    return { ok: true, sessionId: null, mode: "grok", lazy: true };
  });

  ipcMain.handle("chat:open", async (_e, payload) => {
    const { id, cwd, mode } = payload || {};
    if (mode === "home") {
      const chat = homeChats.loadHomeChat(userDataDir(), id);
      if (!chat) return { ok: false, error: "Not found" };
      return { ok: true, sessionId: id, mode: "home", title: chat.title };
    }
    if (!UUID_RE.test(id || "")) {
      return { ok: false, error: "Zły session id" };
    }
    try {
      const client = await ensureAcp();
      await client.ensureSession({
        sessionId: id,
        cwd: expandHome(cwd || getSettings().defaultCwd),
      });
      return { ok: true, sessionId: id, mode: "grok" };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("chat:send", async (_e, payload) => {
    const {
      text,
      sessionId,
      cwd,
      mode,
      attachments,
      modelId,
      homeKind,
      aspectRatio,
      effort,
    } = payload || {};
    const hasText = text && String(text).trim();
    const hasAtt = attachments && attachments.length;
    if (!hasText && !hasAtt) {
      return { ok: false, error: "Pusta wiadomość" };
    }
    if (promptBusy) return { ok: false, error: "Agent jeszcze pracuje" };

    promptBusy = true;
    send("chat:busy", {
      busy: true,
      sessionId: sessionId || null,
      mode: mode || "home",
    });
    status("queued", "Start…");
    try {
      let out;
      if (mode === "home") {
        out = await sendHomeChat({
          text: hasText ? String(text) : "(załącznik)",
          sessionId,
          attachments: attachments || [],
          modelId,
          homeKind,
          aspectRatio,
        });
      } else {
        if (effort && acp && acp.reasoningEffort !== effort) {
          saveSettings(userDataDir(), { effort });
          await acp.setEffort(effort);
        } else if (effort) {
          saveSettings(userDataDir(), { effort });
        }
        out = await sendCodeChat({
          text: hasText ? String(text) : "Przeanalizuj załączniki.",
          sessionId,
          cwd,
          attachments: attachments || [],
        });
        // po starcie sesji ACP znamy finalne ID
        if (out && out.sessionId) {
          send("chat:busy", {
            busy: true,
            sessionId: out.sessionId,
            mode: "grok",
          });
        }
      }
      pushSessions();
      status("done", "Gotowe");
      return out;
    } catch (err) {
      status("error", err.message);
      return { ok: false, error: err.message };
    } finally {
      promptBusy = false;
      send("chat:busy", { busy: false, sessionId: null });
    }
  });

  ipcMain.handle("chat:set-effort", async (_e, effort) => {
    const level = ["low", "medium", "high", "xhigh"].includes(effort)
      ? effort
      : "high";
    saveSettings(userDataDir(), { effort: level });
    try {
      if (acp) await acp.setEffort(level);
      else {
        // next ensureAcp will pick settings.effort
      }
      return { ok: true, effort: level };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("chat:set-model", async (_e, payload) => {
    // payload may be string (legacy) or { modelId, mode }
    const modelId =
      typeof payload === "string" ? payload : payload && payload.modelId;
    const mode = typeof payload === "object" && payload ? payload.mode : "grok";
    if (!modelId) return { ok: false, error: "No model" };

    if (mode === "home") {
      saveSettings(userDataDir(), { homeModelId: modelId });
      return { ok: true, mode: "home", modelId };
    }
    saveSettings(userDataDir(), { modelId });
    try {
      const client = await ensureAcp();
      const res = await client.setModel(modelId);
      pushSessions();
      return { ok: true, mode: "grok", ...res };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("chat:stop", async () => {
    try {
      if (!acp) {
        promptBusy = false;
        send("chat:busy", { busy: false });
        return { ok: true, stopped: false };
      }
      const sid = acp.sessionId;
      await acp.stop();
      acp = null;
      promptBusy = false;
      send("chat:busy", { busy: false });
      status("stopped", "Przerwano");
      ensureAcp().catch(() => {});
      return { ok: true, stopped: true, sessionId: sid };
    } catch (err) {
      promptBusy = false;
      send("chat:busy", { busy: false });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("session:rename", async (_e, payload) => {
    const { id, title, mode } = payload || {};
    const name = String(title || "").trim();
    if (!name) return { ok: false, error: "Empty title" };

    if (mode === "home" || (id && !UUID_RE.test(id))) {
      const res = homeChats.renameHomeChat(userDataDir(), id, name);
      pushSessions();
      return res;
    }
    if (!UUID_RE.test(id || "")) return { ok: false, error: "Bad session id" };

    const settings = getSettings();
    const scan = scanSessions({
      grokHome: settings.grokHome,
      showSubagents: true,
    });
    const row = scan.rows.find((r) => r.id === id);
    if (!row || !row.dirPath) return { ok: false, error: "Session not found" };
    const summaryPath = path.join(row.dirPath, "summary.json");
    try {
      const raw = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      raw.session_summary = name;
      raw.generated_title = name;
      fs.writeFileSync(summaryPath, JSON.stringify(raw, null, 2), "utf8");
      pushSessions();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("session:delete", async (_e, payload) => {
    const id = typeof payload === "string" ? payload : payload && payload.id;
    const mode = typeof payload === "object" && payload ? payload.mode : null;
    if (mode === "home" || (id && !UUID_RE.test(id))) {
      homeChats.deleteHomeChat(userDataDir(), id);
      pushSessions();
      return { ok: true };
    }
    if (!UUID_RE.test(id || "")) {
      return { ok: false, error: "Nieprawidłowy session id" };
    }
    const settings = getSettings();
    const bin = checkGrokBinary(settings.grokPath);
    if (!bin.ok) return { ok: false, error: bin.reason };
    try {
      const { stdout, stderr } = await execFileAsync(
        settings.grokPath,
        ["sessions", "delete", id],
        { timeout: 30000 }
      );
      if (acp && acp.sessionId === id) acp.sessionId = null;
      pushSessions();
      return {
        ok: true,
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
      };
    } catch (err) {
      return { ok: false, error: err.stderr || err.message || String(err) };
    }
  });

  ipcMain.handle("session:reveal", async (_e, dirPath) => {
    if (!dirPath || !fs.existsSync(dirPath)) {
      return { ok: false, error: "Katalog sesji nie istnieje" };
    }
    shell.showItemInFolder(dirPath);
    return { ok: true };
  });

  ipcMain.handle("session:login", async () => {
    const settings = getSettings();
    const bin = checkGrokBinary(settings.grokPath);
    if (!bin.ok) return { ok: false, error: bin.reason };
    const { launchInTerminal } = require("./launch");
    return launchInTerminal({
      grokPath: settings.grokPath,
      cwd: settings.defaultCwd,
      mode: "login",
    });
  });

  ipcMain.handle("app:pickGrokBinary", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Wskaż binarkę grok",
      properties: ["openFile"],
      defaultPath: getSettings().grokPath,
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle("app:pickFiles", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Dodaj pliki / foldery",
      properties: ["openFile", "openDirectory", "multiSelections"],
    });
    if (res.canceled) return [];
    const out = [];
    for (const p of res.filePaths) {
      out.push(importPath(userDataDir(), p));
    }
    return out.filter((x) => x.ok);
  });

  ipcMain.handle("attachments:save-base64", async (_e, payload) => {
    try {
      return saveBase64(userDataDir(), payload || {});
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("attachments:import-path", async (_e, srcPath) => {
    try {
      return importPath(userDataDir(), srcPath);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("attachments:read-preview", async (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: "missing" };
      }
      const ext = path.extname(filePath).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
        return { ok: false, error: "not image" };
      }
      const buf = fs.readFileSync(filePath);
      const mime =
        ext === ".png"
          ? "image/png"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".gif"
              ? "image/gif"
              : "image/jpeg";
      return {
        ok: true,
        dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("account:get", async () => {
    const settings = getSettings();
    return loadAccount(settings.grokHome || resolveGrokHome());
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  startWatchers();
  setTimeout(pushSessions, 200);
  ensureAcp().catch((err) => {
    send("chat:error", { message: `Agent: ${err.message}` });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  clearWatchers();
  if (acp) await acp.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  clearWatchers();
  if (acp) await acp.stop();
});
