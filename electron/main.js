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
const { createAgentPool } = require("./agent-pool");
const homeChats = require("./home-chats");
const xai = require("./xai-api");
const modelsLib = require("./models");
const {
  saveBase64,
  importPath,
  formatAttachmentsForPrompt,
  extFromMime,
  attachRoot,
  isAllowedPreviewPath,
} = require("./attachments");
const { getUsage } = require("./usage");
const sessionFlags = require("./session-flags");
const { normalizeEffort } = modelsLib;

const execFileAsync = promisify(execFile);

let mainWindow = null;
let watchers = [];
let pollTimer = null;
/** Jeden proces grok na sesję Build. Nie współdziel. */
const pool = createAgentPool();
/**
 * Osobne flagi: Home to HTTP do api.x.ai, Build to proces agenta.
 * Build nie ma już jednej globalnej flagi — busy siedzi w puli per sesja.
 */
const promptBusy = { home: false };
/** Przerwanie żądania Home (Stop działa też poza trybem Build). */
let homeAbort = null;
/**
 * Oczekujące prośby o zgodę na narzędzie: klucz "sid#id" → { client, rawId }.
 * Samo `id` nie wystarczy: każdy proces grok numeruje własne żądania od 1,
 * więc przy dwóch sesjach Build id=1 z sesji B nadpisywało id=1 z sesji A
 * i odpowiedź szła do złego procesu.
 */
const pendingPermissions = new Map();
/** Żywa lista Home z api.x.ai; zanim przyjdzie odpowiedź — fallback. */
let homeModelsLive = modelsLib.FALLBACK_HOME_MODELS.slice();

function userDataDir() {
  return app.getPath("userData");
}

function getSettings() {
  return loadSettings(userDataDir());
}

function effectiveHomeModelId(settings, modelId) {
  return modelsLib.resolveChatModelId({
    alwaysLatest: settings.alwaysLatestModel,
    savedId: modelId || settings.homeModelId,
    models: homeModelsLive,
  });
}

function firstLiveClient() {
  return pool.all().find((c) => c && c.ready) || pool.all()[0] || null;
}

function liveBuildModels() {
  const client = firstLiveClient();
  return client && client.models && client.models.length
    ? client.models
    : modelsLib.FALLBACK_BUILD_MODELS;
}

function effectiveBuildModelId(settings) {
  return modelsLib.resolveChatModelId({
    alwaysLatest: settings.alwaysLatestModel,
    savedId: settings.modelId,
    models: liveBuildModels(),
  });
}

async function refreshHomeModels() {
  const settings = getSettings();
  const token = xai.getAccessToken(settings.grokHome);
  if (!token) return;
  try {
    const raw = await xai.listModels(token);
    const next = modelsLib.homeModelsFromApi(raw);
    if (!next.length) return;
    homeModelsLive = next;
    if (settings.alwaysLatestModel) {
      const high = modelsLib.highestChatModelId(next);
      // Home API must not overwrite the Build model. The two lists differ.
      if (high && settings.homeModelId !== high) {
        saveSettings(userDataDir(), { homeModelId: high });
      }
    }
    pushSessions(true);
  } catch {
    /* zostaje fallback albo poprzednia lista */
  }
}

function pinLatestAfterManualPick(modelId, mode) {
  const settings = getSettings();
  if (!modelsLib.isPublicChatModel(modelId)) {
    return { alwaysLatestModel: settings.alwaysLatestModel };
  }
  const modelPool =
    mode === "home"
      ? homeModelsLive
      : liveBuildModels();
  const highest = modelsLib.highestChatModelId(modelPool);
  if (modelId === highest) return { alwaysLatestModel: settings.alwaysLatestModel };
  return { alwaysLatestModel: false };
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function appIconPaths() {
  const base = path.join(__dirname, "..", "assets");
  return {
    // PNG is reliable for dock.setIcon on macOS; icns for window / packaging
    png: path.join(base, "supergrok-dock.png"),
    icns: path.join(base, "GrokSessions.icns"),
  };
}

function applyDockIcon() {
  if (process.platform !== "darwin" || !app.dock) return;
  const { png, icns } = appIconPaths();
  const pick = fs.existsSync(png) ? png : fs.existsSync(icns) ? icns : null;
  if (!pick) return;
  try {
    const img = nativeImage.createFromPath(pick);
    if (!img.isEmpty()) app.dock.setIcon(img);
  } catch (err) {
    console.warn("dock icon:", err.message);
  }
}

/** Otwórz w przeglądarce, ale tylko http/https (nigdy file:, smb:, itd.). */
function openExternalSafe(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    if (u.protocol === "http:" || u.protocol === "https:") {
      shell.openExternal(u.toString());
    }
  } catch {
    /* nie URL — ignoruj */
  }
}

function createWindow() {
  const { icns, png } = appIconPaths();
  const iconPath = fs.existsSync(icns) ? icns : png;
  const winOpts = {
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "SuperGrok Desktop SoskyApp",
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
  if (iconPath && fs.existsSync(iconPath)) {
    winOpts.icon = iconPath;
  }
  mainWindow = new BrowserWindow(winOpts);

  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));

  // BEZPIECZEŃSTWO: bez tego link z odpowiedzi modelu (target="_blank")
  // otwierał obcą stronę WEWNĄTRZ aplikacji, w oknie dziedziczącym
  // ustawienia rodzica. Linki idą do przeglądarki systemowej, i tylko http(s).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });

  // Nawigacja poza własny plik = zawsze do przeglądarki, nigdy w oknie apki.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      openExternalSafe(url);
    }
  });

  // Żadnych <webview> — nie używamy ich, a to kolejny wektor.
  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

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
    models: {
      currentModelId: settings.alwaysLatestModel
        ? effectiveBuildModelId(settings)
        : (firstLiveClient() && firstLiveClient().currentModelId) ||
          effectiveBuildModelId(settings),
      availableModels: liveBuildModels(),
    },
    homeModels: homeModelsLive,
    settings: {
      grokPath: settings.grokPath,
      grokHome: settings.grokHome,
      defaultCwd: settings.defaultCwd,
      showSubagents: settings.showSubagents,
      alwaysOpenActive: settings.alwaysOpenActive,
      pollMs: settings.pollMs,
      modelId: effectiveBuildModelId(settings),
      homeModelId: effectiveHomeModelId(settings),
      alwaysLatestModel: settings.alwaysLatestModel !== false,
      lastMode: settings.lastMode || "home",
      lastHomeSessionId: settings.lastHomeSessionId || "",
      lastCodeSessionId: settings.lastCodeSessionId || "",
      theme: settings.theme || "dark",
      effort: normalizeEffort(settings.effort),
      permissionMode: settings.permissionMode || "auto",
      readBrowserCookies: Boolean(settings.readBrowserCookies),
      pythonPath: settings.pythonPath || "",
      homeMaxTokens: settings.homeMaxTokens || 8192,
      privacyMode: Boolean(settings.privacyMode),
      language: settings.language || "en",
      systemLocale: app.getLocale(),
      // do maskowania ścieżek w trybie prywatności (/Users/ktoś → ~)
      homeDir: app.getPath("home"),
    },
    agentReady: pool.all().some((c) => c && c.ready),
    promptBusy: pool.anyBusy(),
    homeBusy: promptBusy.home,
    activeSessionId: pool.busyIds()[0] || null,
    busySessionId: pool.busyIds()[0] || null,
    busySessionIds: pool.busyIds(),
  };
}

let lastListSignature = "";

/**
 * Wysyłaj listę tylko gdy naprawdę się zmieniła. Wcześniej co tick pollingu
 * (co 3 s) renderer przebudowywał całą listę sesji w DOM bez powodu.
 */
function pushSessions(force = false) {
  const payload = buildListPayload();
  const sig = JSON.stringify([
    payload.rows.map((r) => [r.id, r.title, r.lastActiveAt, r.isActive, r.numMessages]),
    payload.homeRows.map((r) => [r.id, r.title, r.updatedAt, r.numMessages]),
    payload.busySessionIds,
    payload.busySessionId,
    payload.promptBusy,
    payload.homeBusy,
    payload.authOk,
    payload.agentReady,
    payload.error,
  ]);
  if (!force && sig === lastListSignature) return;
  lastListSignature = sig;
  send("sessions:updated", payload);
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

  // fs.watch łapie zmiany od razu; polling to tylko siatka bezpieczeństwa,
  // więc może być rzadki. Pomijamy tick, gdy okno jest schowane.
  const pollMs = Math.max(5000, Number(settings.pollMs) || 10000);
  pollTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
    pushSessions();
  }, pollMs);
}

function wireClient(client) {
  client.on("permission", ({ id, params }) => {
    const sid =
      (params && (params.sessionId || params.session_id)) ||
      client.sessionId ||
      pool.findByClient(client);
    const key = `${sid || "?"}#${id}`;
    pendingPermissions.set(key, { client, rawId: id });
    send("chat:permission", {
      id: key,
      sessionId: sid,
      toolCall: (params && params.toolCall) || null,
      options: (params && params.options) || [],
    });
  });
  client.on("update", (params) => {
    // session/load replays history — UI already has the transcript from disk.
    if (client._loading) return;
    const sid =
      (params && (params.sessionId || params.session_id)) ||
      client.sessionId ||
      pool.findByClient(client) ||
      null;
    send("chat:update", Object.assign({}, params, { sessionId: sid }));
  });
  client.on("error", (err) => {
    send("chat:error", {
      message: err.message,
      sessionId: client.sessionId || pool.findByClient(client),
    });
  });
  client.on("exit", (code) => {
    const sid = client.sessionId || pool.findByClient(client);
    if (sid) {
      pool.forget(sid);
      pool.markBusy(sid, false);
    }
    send("chat:agent-exit", { code, sessionId: sid });
    send("chat:busy", { busy: false, sessionId: sid, mode: "grok" });
    pushSessions();
  });
  client.on("models", async (m) => {
    send("chat:models", m);
    const settings = getSettings();
    const sid = client.sessionId || pool.findByClient(client);
    if (!settings.alwaysLatestModel || (sid && pool.isBusy(sid))) {
      pushSessions();
      return;
    }
    const high = modelsLib.highestChatModelId(
      m.availableModels || client.models
    );
    // NIGDY na zywej sesji. ensureSession samo emituje "models", wiec ten
    // handler wchodzil W TRAKCIE zakladania sesji i probowal przestawic model
    // dwoma zapytaniami, ktorych agent nie obsluguje (po 120 s timeoutu kazde),
    // a potem restartowal proces. To byly te 42 s na „New Build session…".
    // Proces i tak startuje z `--model`, wiec nowa sesja dostanie wlasciwy.
    if (sid || client.sessionId) {
      pushSessions();
      return;
    }
    if (high && client.currentModelId !== high && !client._switchingLatest) {
      client._switchingLatest = true;
      try {
        await client.setModel(high);
      } catch {
        /* lista i tak poleci do UI */
      } finally {
        client._switchingLatest = false;
      }
    }
    pushSessions();
  });
}

async function spawnClient(cwd) {
  const settings = getSettings();
  const bin = checkGrokBinary(settings.grokPath);
  if (!bin.ok) throw new Error(bin.reason || "grok binary not found");
  const client = new AcpClient({
    grokPath: settings.grokPath,
    model: effectiveBuildModelId(settings),
    alwaysApprove: settings.permissionMode !== "ask",
    reasoningEffort: normalizeEffort(settings.effort),
  });
  client.cwd = expandHome(cwd || settings.defaultCwd);
  wireClient(client);
  await client.start();
  return client;
}

/** Proces grok podgrzany z góry — pierwsza wiadomość Build nie czeka na spawn. */
let warmClient = null;
let warming = false;

async function discardWarmClient() {
  const c = warmClient;
  warmClient = null;
  if (c) {
    try {
      await c.stop();
    } catch {
      /* martwy */
    }
  }
}

async function ensureWarmClient() {
  if (warmClient && warmClient.ready) return;
  if (warming) return;
  const settings = getSettings();
  const bin = checkGrokBinary(settings.grokPath);
  if (!bin.ok) return;
  warming = true;
  try {
    warmClient = await spawnClient();
  } catch {
    warmClient = null;
  } finally {
    warming = false;
  }
}

function takeWarmClient() {
  const settings = getSettings();
  const wantModel = effectiveBuildModelId(settings);
  const wantEffort = normalizeEffort(settings.effort);
  if (
    !warmClient ||
    !warmClient.ready ||
    warmClient.model !== wantModel ||
    warmClient.reasoningEffort !== wantEffort
  ) {
    if (warmClient) discardWarmClient().catch(() => {});
    setTimeout(() => ensureWarmClient().catch(() => {}), 100);
    return null;
  }
  const c = warmClient;
  warmClient = null;
  setTimeout(() => ensureWarmClient().catch(() => {}), 100);
  return c;
}

/**
 * Klient TYLKO dla tej sesji. Nigdy session/load na procesie innej karty.
 */
async function clientForSession(sessionId, cwd) {
  if (sessionId && pool.has(sessionId)) {
    return pool.get(sessionId);
  }
  const client = takeWarmClient() || (await spawnClient());
  if (sessionId) {
    await client.ensureSession({ sessionId, cwd });
    pool.put(sessionId, client);
  }
  return client;
}

function status(phase, detail, sessionId) {
  send("chat:status", {
    phase,
    detail: detail || "",
    at: Date.now(),
    sessionId: sessionId || null,
  });
}

async function sendHomeChat({
  text,
  sessionId,
  attachments,
  modelId,
  homeKind,
  aspectRatio,
  effort,
  turnToken,
}) {
  const settings = getSettings();
  const token = xai.getAccessToken(settings.grokHome || resolveGrokHome());
  if (!token) throw new Error("No xAI token — sign in with: grok login");
  homeAbort = new AbortController();
  const signal = homeAbort.signal;

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
  send("chat:session-started", {
    sessionId: chat.id,
    turnToken: turnToken || null,
    mode: "home",
  });

  const persistFail = (err) => {
    try {
      homeChats.appendHomeMessage(userDataDir(), chat.id, {
        id: `a-err-${Date.now()}`,
        role: "assistant",
        content: String((err && err.message) || "Error"),
        createdAt: new Date().toISOString(),
      });
    } catch {
      /* nie blokuj oryginalnego błędu */
    }
  };

  try {
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
    status("generating_image", "Generating video…", chat.id);
    const prompt = String(text || "")
      .replace(/^\/video\s+/i, "")
      .trim();
    const vid = await xai.generateVideo(token, {
      prompt,
      aspect_ratio: aspectRatio || "16:9",
      signal,
      onProgress: (p) =>
        status("generating_image", `Generating video… ${p}%`, chat.id),
    });
    // b64 NIE ląduje w wiadomości: plik ma kilka MB, a historia czatu
    // trzymana jest w JSON-ie. W UI odtwarzamy ze ścieżki.
    const saved = saveBase64(userDataDir(), {
      name: "video.mp4",
      mimeType: vid.mimeType,
      base64: vid.b64,
      kind: "video",
    });
    if (!saved.ok) throw new Error(saved.error || "Could not save video");
    const assistantMsg = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: `Generated video (${aspectRatio || "16:9"}${
        vid.duration ? `, ${vid.duration} s` : ""
      }) for: “${prompt.slice(0, 120)}”`,
      videos: [{ path: saved.path, mimeType: saved.mimeType }],
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

  if (wantImage) {
    status("generating_image", "Generating image…", chat.id);
    const prompt = xai.stripImageCommand(text) || text;
    const img = await xai.generateImage(token, {
      prompt,
      model: "grok-imagine-image",
      aspect_ratio: aspectRatio || "1:1",
      signal,
    });
    const saved = saveBase64(userDataDir(), {
      // API oddaje JPEG, nie PNG — rozszerzenie z mime, bo readPreview
      // wnioskuje typ z nazwy pliku przy odtwarzaniu historii.
      name: `generated${extFromMime(img.mimeType)}`,
      mimeType: img.mimeType,
      base64: img.b64,
      kind: "image",
    });
    if (!saved.ok) throw new Error(saved.error || "Could not save image");
    const assistantMsg = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: `Generated image (${aspectRatio || "1:1"}) for: “${prompt.slice(0, 120)}”`,
      // BEZ b64: kilkumegabajtowy base64 ladowal w JSON-ie czatu przy kazdym
      // wygenerowanym obrazie. Renderer i tak dociaga plik przez readPreview.
      images: [
        {
          path: saved.path,
          mimeType: saved.mimeType,
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

  status("thinking", "Thinking…", chat.id);
  const model = effectiveHomeModelId(settings, modelId);
  const reasoningEffort = normalizeEffort(effort || settings.effort);

  // Build OpenAI-style messages from history.
  // Obrazy jako base64 dołączamy TYLKO do ostatniej wiadomości użytkownika.
  // Wcześniej każdy obraz z całego czatu leciał w każdym kolejnym żądaniu,
  // więc koszt i czas rosły z każdą turą.
  const lastUserIdx = (() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === "user") return i;
    }
    return -1;
  })();

  const apiMessages = [];
  chat.messages.forEach((m, idx) => {
    if (m.role === "user") {
      let content = m.content || "";
      if (m.attachments && m.attachments.length) {
        content +=
          "\n\n[Attachments: " +
          m.attachments.map((a) => a.name || a.path).join(", ") +
          "]";
      }
      const withImages =
        idx === lastUserIdx &&
        m.attachments &&
        m.attachments.some((a) => a.kind === "image" && a.path);
      if (withImages) {
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
  });

  // Zostajemy na „Thinking…”, aż poleci pierwszy token treści.
  // Wcześniej od razu skakaliśmy na „Writing…”, choć model jeszcze myślał.
  const chatModel = model.includes("imagine")
    ? modelsLib.highestChatModelId(homeModelsLive)
    : model;
  let reply = "";
  try {
    const streamed = await xai.chatCompletionsStream(
      token,
      {
        model: chatModel,
        messages: apiMessages,
        max_tokens: settings.homeMaxTokens || 8192,
        signal,
        reasoning_effort: reasoningEffort,
      },
      (delta, kind) => {
        const isThink = kind === "reasoning";
        if (!isThink) {
          if (!reply) status("responding", "Writing…", chat.id);
          reply += delta;
        }
        send("chat:update", {
          sessionId: chat.id,
          update: {
            sessionUpdate: isThink
              ? "agent_thought_chunk"
              : "agent_message_chunk",
            content: { text: delta },
          },
        });
      }
    );
    if (streamed && streamed.length > reply.length) reply = streamed;
  } catch (err) {
    if (signal.aborted) throw new Error("Stopped");
    if (!reply) {
      const msg = String((err && err.message) || "");
      if (/^HTTP 4|unauthorized|forbidden|invalid|Aborted|Stopped/i.test(msg)) {
        throw err;
      }
      // Awaryjnie bez streamu tylko gdy SSE padło, a treści jeszcze nie ma
      const res = await xai.chatCompletions(token, {
        model: chatModel,
        messages: apiMessages,
        max_tokens: settings.homeMaxTokens || 8192,
        signal,
        reasoning_effort: reasoningEffort,
      });
      reply =
        (res.choices &&
          res.choices[0] &&
          res.choices[0].message &&
          res.choices[0].message.content) ||
        "";
    }
  }

  if (!String(reply || "").trim()) {
    throw new Error("Empty reply from model");
  }

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
  } catch (err) {
    persistFail(err);
    throw err;
  }
}

async function sendCodeChat({ text, sessionId, cwd, attachments, turnToken }) {
  const settings = getSettings();
  const workCwd = expandHome(cwd || settings.defaultCwd);
  let sid = sessionId || null;
  status("starting", "Starting agent…", sid);

  let client;
  if (sid && pool.has(sid)) {
    client = pool.get(sid);
  } else {
    client = takeWarmClient() || (await spawnClient());
    if (sid) {
      status("session", "Loading session…", sid);
      await client.ensureSession({ sessionId: sid, cwd: workCwd });
      pool.put(sid, client);
    } else {
      status("session", "New Build session…", null);
      const created = await client.ensureSession({ cwd: workCwd });
      sid = created.sessionId;
      pool.put(sid, client);
      // Nowa sesja poznaje swoje sid DOPIERO tutaj. Bez tego sygnału lista
      // dostawała „pracuje” z sid=null i świeża karta przez całą pierwszą turę
      // stała bez wskaźnika pracy — nie było widać, która sesja liczy.
      pool.markBusy(sid, true);
      // Token TEJ tury wraca razem z sid. Renderer nie musi zgadywac, do
      // ktorego nowego czatu nalezy swiezo powstala sesja — przy dwoch
      // nowych czatach naraz zgadywanie wkladalo pytanie z B do czatu A.
      send("chat:session-started", { sessionId: sid, turnToken: turnToken || null });
      send("chat:busy", { busy: true, sessionId: sid, mode: "grok" });
      pushSessions();
    }
  }

  const promptText = String(text || "") + formatAttachmentsForPrompt(attachments);

  status("thinking", "Agent is working…", sid);
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
        readBrowserCookies: settings.readBrowserCookies,
        pythonPath: settings.pythonPath,
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

  ipcMain.handle("nav:set", async (_e, partial) => {
    const p = partial || {};
    saveSettings(userDataDir(), {
      lastMode: p.lastMode,
      lastHomeSessionId: p.lastHomeSessionId,
      lastCodeSessionId: p.lastCodeSessionId,
    });
    return { ok: true };
  });

  ipcMain.handle("home:replace-messages", async (_e, payload) => {
    const { id, messages } = payload || {};
    if (!id) return { ok: false, error: "no id" };
    return homeChats.replaceMessages(userDataDir(), id, messages || []);
  });

  ipcMain.handle("settings:get", async () => getSettings());

  ipcMain.handle("settings:set", async (_e, partial) => {
    const before = getSettings();
    const next = saveSettings(userDataDir(), partial || {});
    if (partial && partial.modelId) {
      for (const client of pool.all()) {
        const sid = client.sessionId || pool.findByClient(client);
        if (sid && pool.isBusy(sid)) continue;
        try {
          await client.setModel(partial.modelId);
        } catch (err) {
          send("chat:error", { message: err.message, sessionId: sid });
        }
      }
    }
    // Tryb uprawnień to flaga CLI — restart TYLKO bezczynnych procesów
    if (
      partial &&
      partial.permissionMode &&
      partial.permissionMode !== before.permissionMode
    ) {
      for (const client of pool.all()) {
        const sid = client.sessionId || pool.findByClient(client);
        if (sid && pool.isBusy(sid)) continue;
        try {
          await client.setPermissionMode(partial.permissionMode, {
            cwd: next.defaultCwd,
          });
        } catch (err) {
          send("chat:error", { message: err.message, sessionId: sid });
        }
      }
    }
    if (
      partial &&
      partial.alwaysLatestModel === true &&
      before.alwaysLatestModel !== true
    ) {
      const highHome = modelsLib.highestChatModelId(homeModelsLive);
      const highBuild = effectiveBuildModelId(next);
      const patch = {};
      if (highHome) patch.homeModelId = highHome;
      if (highBuild) patch.modelId = highBuild;
      if (Object.keys(patch).length) {
        saveSettings(userDataDir(), patch);
      }
      if (highBuild) {
        for (const client of pool.all()) {
          const sid = client.sessionId || pool.findByClient(client);
          if (sid && pool.isBusy(sid)) continue;
          if (client.currentModelId === highBuild) continue;
          try {
            await client.setModel(highBuild);
          } catch (err) {
            send("chat:error", { message: err.message, sessionId: sid });
          }
        }
      }
    }
    if (
      partial &&
      (partial.modelId ||
        partial.effort ||
        partial.permissionMode ||
        partial.grokPath)
    ) {
      discardWarmClient().catch(() => {});
      setTimeout(() => ensureWarmClient().catch(() => {}), 200);
    }
    startWatchers();
    pushSessions(true);
    refreshHomeModels().catch(() => {});
    return getSettings();
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
        videos: m.videos || [],
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
      if (!row) return { messages: [], error: "Session not found" };
      return loadTranscript(row.dirPath);
    }
    return loadTranscript(dirPath);
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
      return { ok: false, error: "Empty message" };
    }
    const lane = mode === "home" ? "home" : "grok";
    if (lane === "home" && promptBusy.home) {
      return { ok: false, error: "Home is still answering" };
    }
    if (lane === "grok" && sessionId && pool.isBusy(sessionId)) {
      return { ok: false, error: "This session is still working" };
    }

    let outSid = sessionId || null;
    if (lane === "home") promptBusy.home = true;
    if (lane === "grok" && outSid) pool.markBusy(outSid, true);
    send("chat:busy", {
      busy: true,
      sessionId: outSid,
      mode: mode || "home",
    });
    status("queued", "Starting…", outSid);
    let out;
    try {
      if (mode === "home") {
        out = await sendHomeChat({
          text: hasText ? String(text) : "(attachment)",
          sessionId,
          attachments: attachments || [],
          modelId,
          homeKind,
          aspectRatio,
          effort,
          turnToken: payload && payload.turnToken,
        });
        if (out && out.sessionId) outSid = out.sessionId;
      } else {
        if (effort) saveSettings(userDataDir(), { effort });
        out = await sendCodeChat({
          text: hasText ? String(text) : "Analyze the attachments.",
          sessionId,
          cwd,
          attachments: attachments || [],
          turnToken: payload && payload.turnToken,
        });
        if (out && out.sessionId) {
          outSid = out.sessionId;
          pool.markBusy(outSid, true);
          send("chat:busy", {
            busy: true,
            sessionId: outSid,
            mode: "grok",
          });
        }
      }
      pushSessions();
      status("done", "Done", outSid);
      return out;
    } catch (err) {
      status("error", err.message, outSid);
      return { ok: false, error: err.message };
    } finally {
      if (lane === "home") {
        promptBusy.home = false;
        homeAbort = null;
      } else if (outSid) {
        pool.markBusy(outSid, false);
      }
      send("chat:busy", { busy: false, sessionId: outSid, mode: lane });
    }
  });

  ipcMain.handle("chat:permission-reply", async (_e, payload) => {
    const { id, optionId } = payload || {};
    if (id == null) return { ok: false, error: "No agent" };
    const entry = pendingPermissions.get(id);
    if (!entry) return { ok: false, error: "Permission request expired" };
    const ok = entry.client.respondPermission(entry.rawId, optionId || null);
    pendingPermissions.delete(id);
    return { ok };
  });

  ipcMain.handle("chat:set-effort", async (_e, payload) => {
    const effort = typeof payload === "string" ? payload : payload && payload.effort;
    const cwd = typeof payload === "object" && payload ? payload.cwd : null;
    const level = normalizeEffort(effort);
    saveSettings(userDataDir(), { effort: level });
    discardWarmClient().catch(() => {});
    setTimeout(() => ensureWarmClient().catch(() => {}), 200);
    const sid =
      typeof payload === "object" && payload ? payload.sessionId : null;
    // Zmiana efortu restartuje proces agenta, wiec w srodku tury sie nie da.
    // Wczesniej handler i tak oddawal {ok:true} i UI meldował sukces.
    if (sid && pool.isBusy(sid)) {
      return { ok: false, error: "This session is still working", effort: level };
    }
    try {
      const client = sid ? pool.get(sid) : null;
      if (client) await client.setEffort(level, { cwd });
      return { ok: true, effort: level, applied: Boolean(client) };
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

    const sid =
      typeof payload === "object" && payload ? payload.sessionId : null;
    if (mode !== "home" && sid && pool.isBusy(sid)) {
      return { ok: false, error: "This session is still working" };
    }
    const pin = pinLatestAfterManualPick(modelId, mode);
    if (mode === "home") {
      saveSettings(userDataDir(), { homeModelId: modelId, ...pin });
      pushSessions(true);
      return { ok: true, mode: "home", modelId };
    }
    saveSettings(userDataDir(), { modelId, ...pin });
    try {
      const client = sid ? pool.get(sid) : null;
      if (client && !pool.isBusy(sid)) {
        const res = await client.setModel(modelId);
        pushSessions();
        return { ok: true, mode: "grok", ...res };
      }
      pushSessions();
      return { ok: true, mode: "grok", deferred: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("chat:stop", async (_e, payload) => {
    const mode = (payload && payload.mode) || null;
    const sessionId = (payload && payload.sessionId) || null;

    // Home: przerwij żądanie HTTP. Wcześniej Stop nic tu nie robił, więc
    // odpowiedź i tak dochodziła i dopisywała się do czatu.
    if (mode === "home") {
      const had = Boolean(homeAbort);
      if (homeAbort) homeAbort.abort();
      homeAbort = null;
      promptBusy.home = false;
      send("chat:busy", { busy: false, mode: "home", sessionId });
      status("stopped", "Stopped", sessionId);
      return { ok: true, stopped: had, mode: "home" };
    }

    try {
      if (!sessionId) {
        return { ok: false, error: "No sessionId — refusing to kill other sessions" };
      }
      const client = pool.get(sessionId);
      if (!client) {
        send("chat:busy", { busy: false, mode: "grok", sessionId });
        status("stopped", "Stopped", sessionId);
        return { ok: true, stopped: false, sessionId };
      }
      // Cancel the turn. Killing the process threw away MCP handshake
      // and the next send paid the full initialize cost again.
      const cancelled = await client.cancel(sessionId);
      pool.markBusy(sessionId, false);
      send("chat:busy", { busy: false, mode: "grok", sessionId });
      status("stopped", "Stopped", sessionId);
      pushSessions();
      return { ok: true, cancelled, sessionId };
    } catch (err) {
      if (sessionId) pool.markBusy(sessionId, false);
      send("chat:busy", { busy: false, mode: "grok", sessionId });
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
      return { ok: false, error: "Invalid session id" };
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
      if (pool.has(id)) await pool.stop(id);
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
      return { ok: false, error: "Session directory does not exist" };
    }
    const settings = getSettings();
    const root = path.resolve(
      path.join(settings.grokHome || resolveGrokHome(), "sessions")
    );
    const resolved = path.resolve(dirPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { ok: false, error: "not a session folder" };
    }
    shell.showItemInFolder(resolved);
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
      title: "Select the grok binary",
      properties: ["openFile"],
      defaultPath: getSettings().grokPath,
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle("app:pickFiles", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Add files / folders",
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
      if (!isAllowedPreviewPath(attachRoot(userDataDir()), filePath)) {
        return { ok: false, error: "not allowed" };
      }
      const ext = path.extname(filePath).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4"].includes(ext)) {
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
              : ext === ".mp4"
                ? "video/mp4"
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

// Before ready: name in menu / Dock label (not "Electron")
try {
  app.setName("SuperGrok Desktop SoskyApp");
} catch (_) {
  /* ignore */
}

// Stały katalog danych — nie rozjeżdżaj się między "Electron" a nazwą produktu.
// Ścieżka „Library/Application Support” istnieje tylko na macOS; poza nim
// zostawiamy domyślną lokalizację Electrona (AppData na Windows, ~/.config
// na Linuksie), inaczej powstawał katalog o nazwie ze ścieżki macOS.
try {
  if (process.platform === "darwin") {
    app.setPath(
      "userData",
      path.join(
        app.getPath("home"),
        "Library/Application Support/SuperGrok Desktop SoskyApp"
      )
    );
  }
} catch (_) {
  /* ignore */
}

// Preferuj arm64 (Apple Silicon) — mniej ostrzeżeń „Intel / future macOS”
try {
  if (app.commandLine && process.arch === "arm64") {
    app.commandLine.appendSwitch("enable-features", "ScreenCaptureKitPickerScreen");
  }
} catch (_) {
  /* ignore */
}

// Jedna instancja: drugie kliknięcie = fokus, nie drugi zombie + „Wymuś zakończenie”
// Furtka dla testu E2E: wlasna nazwa i wlasny katalog danych, wiec harness
// odpala SWOJA instancje obok tej, ktorej uzywa czlowiek. Bez tego blokada
// pojedynczej instancji (po NAZWIE aplikacji, nie po katalogu) konczyla kazdy
// automatyczny test natychmiastowym app.exit(0) — i dlatego przez caly dzien
// weryfikowalem poprawki wyrywkowo zamiast od zera.
if (process.env.GROK_SESSIONS_E2E) {
  app.setName("SuperGrok E2E");
  app.setPath("userData", process.env.GROK_SESSIONS_E2E);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    applyDockIcon();
    registerIpc();
    createWindow();
    // re-apply after window (some Electron builds reset dock icon)
    applyDockIcon();
    startWatchers();
    setTimeout(pushSessions, 200);
    refreshHomeModels().catch(() => {});
    setTimeout(() => ensureWarmClient().catch(() => {}), 400);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        // window-all-closed zdjelo watchery i pollTimer. Bez tego lista sesji
        // po powrocie z Docka stala martwa az do restartu apki.
        startWatchers();
        setTimeout(pushSessions, 200);
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  });
}

app.on("window-all-closed", () => {
  clearWatchers();
  // macOS: zamkniecie okna to NIE wyjscie z aplikacji. Wczesniej Cmd+W
  // w srodku tury SIGTERM-owalo wszystkie procesy grok. Sprzatanie nalezy
  // do before-quit.
  if (process.platform !== "darwin") {
    pool.stopAll().finally(() => app.quit());
  }
});

// Electron ignoruje Promise zwrocony z handlera, wiec `async` konczylo sie
// dla niego na pierwszym awaicie i awaryjny SIGKILL po 3 s nie mial kiedy
// zadzialac. Blokujemy wyjscie i wychodzimy sami, gdy pula jest posprzatana.
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  clearWatchers();
  Promise.all([pool.stopAll(), discardWarmClient()]).finally(() => app.exit(0));
});
