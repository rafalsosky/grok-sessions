/* global grokSessions, renderMarkdown, appendStreamChunk, workSummary, chatScroll */

(() => {
  /**
   * tr() zamiast t(): w tym pliku „t” jest zajęte przez zmienne pętli po
   * narzędziach. Brak i18n = angielski, czyli tekst źródłowy.
   */
  const tr = (window.tr || ((s) => s));
  const chatHistory = window.chatHistory || {};
  const i18n = window.i18n || {
    setLang: () => "en",
    resolveLang: () => "en",
    applyDomTranslations: () => {},
  };

  const api = window.grokSessions;
  if (!api) {
    document.body.innerHTML =
      "<p style='padding:24px;color:#fff'>Missing bridge API (preload).</p>";
    return;
  }

  /** @type {'home'|'grok'} */
  let mode = "home";
  /** @type {any[]} */
  let codeRows = [];
  /** @type {any[]} */
  let homeRows = [];
  let filter = "";
  let defaultCwd = "";
  let homeModelId = "grok-4.6";
  let codeModelId = "grok-4.6";
  let homeModels = [];
  let ctxTargetId = null;
  let drainingQueue = false;
  const PAGE = 60;
  let bootDone = false;
  /** Home: chat | image | video */
  let homeKind = "chat";
  let effortLevel = "high";
  /** "auto" = agent bez pytania, "ask" = zatwierdzam każde narzędzie */
  let permMode = "auto";
  /** Sesje Build, które teraz mają własny proces. Nie jedna na całą apkę. */
  const busySessionIds = new Set();
  let busySessionId = null;
  function isSessionBusy(sid) {
    return Boolean(sid && busySessionIds.has(sid));
  }
  function setSessionBusy(sid, on) {
    if (!sid) return;
    if (on) busySessionIds.add(sid);
    else busySessionIds.delete(sid);
    busySessionId = busySessionIds.values().next().value || null;
  }
  /** New session: nie wciągaj Thinking ze starej tury, dopóki nie wyślesz. */
  let detachedBuild = false;
  /** New Build chat: session id still unknown — keep stream on this view. */
  let pendingNewSession = false;
  /** { [sessionId]: { unread, pinned } } */
  let sessionFlagMap = {};
  /**
   * Live stream per Build session — gdy user przełącza listę, stream NIE trafia do innej sesji.
   * { [sessionId]: { allMessages, streamingAssistant, liveTools, messageQueue, statusPhase, statusDetail } }
   */
  const streamBySession = Object.create(null);

  /** Osobny stan UI dla Home i Code — zero mieszania. */
  function emptyBag() {
    return {
      selectedId: null,
      liveSessionId: null,
      allMessages: [],
      messages: [],
      streamingAssistant: null,
      liveTools: [],
      livePlan: [],
      attachments: [],
      messageQueue: [],
      busy: false,
      visibleCount: PAGE,
      showActivity: false,
      wsTitle: "New chat",
      cwd: "",
      statusPhase: "",
      statusDetail: "",
    };
  }
  const bags = { home: emptyBag(), grok: emptyBag() };
  function bag(m) {
    return bags[m || mode];
  }

  // Lokalne aliasy aktywnego worka — pullBag/pushBag przy switchu
  let selectedId = null;
  let liveSessionId = null;
  let allMessages = [];
  let messages = [];
  let streamingAssistant = null;
  let liveTools = [];
  let livePlan = [];
  let attachments = [];
  let messageQueue = [];
  let busy = false;
  let visibleCount = PAGE;
  let showActivity = false;

  function pullBag() {
    const b = bag();
    selectedId = b.selectedId;
    liveSessionId = b.liveSessionId;
    allMessages = b.allMessages;
    messages = b.messages;
    streamingAssistant = b.streamingAssistant;
    liveTools = b.liveTools;
    livePlan = b.livePlan || [];
    attachments = b.attachments;
    messageQueue = b.messageQueue;
    busy = b.busy;
    visibleCount = b.visibleCount;
    showActivity = b.showActivity;
  }

  function pushBag() {
    const b = bag();
    b.selectedId = selectedId;
    b.liveSessionId = liveSessionId;
    b.allMessages = allMessages;
    b.messages = messages;
    b.streamingAssistant = streamingAssistant;
    b.liveTools = liveTools;
    b.livePlan = livePlan;
    b.attachments = attachments;
    b.messageQueue = messageQueue;
    b.busy = busy;
    b.visibleCount = visibleCount;
    b.showActivity = showActivity;
    b.wsTitle = el.wsTitle ? el.wsTitle.textContent : b.wsTitle;
  }

  function persistNav() {
    const payload = {
      lastMode: mode,
      lastHomeSessionId: bags.home.liveSessionId || bags.home.selectedId || "",
      lastCodeSessionId: bags.grok.liveSessionId || bags.grok.selectedId || "",
    };
    api.setNav(payload).catch(() => {});
  }

  const el = {
    app: document.getElementById("app"),
    list: document.getElementById("session-list"),
    filter: document.getElementById("filter"),
    banner: document.getElementById("banner"),
    messages: document.getElementById("messages"),
    chatScroll: document.getElementById("chat-scroll"),
    homeHero: document.getElementById("home-hero"),
    input: document.getElementById("input"),
    form: document.getElementById("composer"),
    btnSend: document.getElementById("btn-send"),
    btnStop: document.getElementById("btn-stop"),
    btnNew: document.getElementById("btn-new"),
    btnNewLabel: document.getElementById("btn-new-label"),
    modelSelect: document.getElementById("model-select"),
    cwdChip: document.getElementById("cwd-chip"),
    busyChip: document.getElementById("busy-chip"),
    wsTitle: document.getElementById("ws-title"),
    wsCwd: document.getElementById("ws-cwd"),
    wsModeBadge: document.getElementById("ws-mode-badge"),
    toast: document.getElementById("toast"),
    modal: document.getElementById("modal"),
    modalTitle: document.getElementById("modal-title"),
    modalBody: document.getElementById("modal-body"),
    modalInput: document.getElementById("modal-input"),
    modalOk: document.getElementById("modal-ok"),
    modalCancel: document.getElementById("modal-cancel"),
    settingsModal: document.getElementById("settings-modal"),
    accountModal: document.getElementById("account-modal"),
    accountDetail: document.getElementById("account-detail"),
    tabHome: document.getElementById("tab-home"),
    tabGrok: document.getElementById("tab-grok"),
    accountName: document.getElementById("account-name"),
    accountSub: document.getElementById("account-sub"),
    accountAvatar: document.getElementById("account-avatar"),
    ctxMenu: document.getElementById("ctx-menu"),
    btnExpand: document.getElementById("btn-expand"),
    attachChips: document.getElementById("attach-chips"),
    statusBar: document.getElementById("status-bar"),
    statusText: document.getElementById("status-text"),
    statusSub: document.getElementById("status-sub"),
    activityPanel: document.getElementById("activity-panel"),
    btnToggleActivity: document.getElementById("btn-toggle-activity"),
    dropOverlay: document.getElementById("drop-overlay"),
    recentsLabel: document.getElementById("recents-label"),
    finePrint: document.getElementById("fine-print"),
  };

  function rowsForMode() {
    return mode === "home" ? homeRows : codeRows;
  }

  function selectedRow() {
    return rowsForMode().find((r) => r.id === selectedId) || null;
  }

  function basenameCwd(cwd) {
    if (!cwd) return mode === "home" ? "chat" : "sosky";
    const parts = cwd.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || cwd;
  }

  function relativeTime(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (!t) return "";
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m`;
    const h = Math.round(min / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  }

  function dayBucket(iso) {
    if (!iso) return tr("Earlier");
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return tr("Earlier");
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = (startToday - startThat) / 86400000;
    if (diff === 0) return tr("Today");
    if (diff === 1) return tr("Yesterday");
    if (diff < 7) return tr("Previous 7 days");
    return tr("Earlier");
  }

  function showToast(msg, kind = "") {
    el.toast.textContent = msg;
    el.toast.classList.remove("hidden", "error", "ok");
    if (kind) el.toast.classList.add(kind);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.add("hidden"), 4000);
  }

  function setBanner(msg, isError = false) {
    if (!msg) {
      el.banner.classList.add("hidden");
      el.banner.textContent = "";
      return;
    }
    el.banner.textContent = msg;
    el.banner.classList.remove("hidden");
    el.banner.classList.toggle("error", isError);
  }

  /**
   * Tytuły tooli z ACP to często "Execute `python3 ...`" albo cała komenda.
   * Do UI idzie TYLKO krótka ludzka etykieta — nigdy surowy kod.
   */
  function humanizeToolTitle(raw) {
    const s = String(raw || "").trim();
    if (!s) return tr("Tool");
    // Read `/path…` / Write / Edit — nigdy surowa ścieżka w statusie
    if (/^(read|write|edit|search|grep|bash|execute)\b/i.test(s) || s.length > 48) {
      const low = s.toLowerCase();
      if (/\b(python3?|node|bash|zsh|sh|curl|ffmpeg|osascript)\b/.test(low))
        return "Terminal";
      if (/^read\b|\bread_file\b|\bcat\b|\bhead\b|\btail\b/.test(low))
        return tr("Reading file");
      if (/\b(write|edit|patch|search_replace|sed)\b/.test(low)) return tr("Editing file");
      if (/\b(grep|rg|find|search_tool|web_search)\b/.test(low)) return "Szukam";
      if (/\b(web_search|browse|http|open_page)\b/.test(low)) return tr("Network");
      if (/^Execute\b/i.test(s)) return "Terminal";
      if (/\/|\\/.test(s)) return tr("File");
      return tr("Tool");
    }
    if (/^\/Users\//.test(s) || /^[A-Za-z]:\\/.test(s)) return tr("File");
    const one = s.replace(/\s+/g, " ").slice(0, 40);
    return one.length < s.replace(/\s+/g, " ").length ? one + "…" : one;
  }

  /* ===== Stoper tury: „Myślę… 0:42” ===== */
  let turnStartedAt = 0;
  let turnTimer = 0;
  let lastStatusLabel = "";

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
  }

  function currentWorkStatus() {
    const ws = window.workSummary;
    if (!ws || typeof ws.buildWorkStatus !== "function") return null;
    const active = liveTools.filter(
      (t) => t.status !== "completed" && t.status !== "failed"
    );
    return ws.buildWorkStatus({
      tools: liveTools,
      planEntries: livePlan,
      phase: bag().statusPhase,
      currentTool: active[0] ? humanizeToolTitle(active[0].title) : lastStatusLabel,
      elapsed: turnStartedAt ? fmtElapsed(Date.now() - turnStartedAt) : "",
    });
  }

  function paintStatusText() {
    if (!el.statusText) return;
    const work = currentWorkStatus();
    if (work && (work.headline || work.now) && (liveTools.length || livePlan.length)) {
      const line = [work.headline, work.footer].filter(Boolean).join(" · ");
      el.statusText.textContent = line || lastStatusLabel || tr("Working…");
      if (el.statusSub) {
        const sub = work.now
          ? `${tr("Now")}: ${work.now}${
              work.plan && work.plan.next ? ` · ${tr("Next")}: ${work.plan.next}` : ""
            }`
          : "";
        el.statusSub.textContent = sub;
        el.statusSub.classList.toggle("hidden", !sub);
      }
      return;
    }
    const base = lastStatusLabel || tr("Thinking…");
    el.statusText.textContent = turnStartedAt
      ? `${base} · ${fmtElapsed(Date.now() - turnStartedAt)}`
      : base;
    if (el.statusSub) {
      el.statusSub.textContent = "";
      el.statusSub.classList.add("hidden");
    }
  }

  function startTurnTimer() {
    if (turnTimer) return;
    turnStartedAt = Date.now();
    paintStatusText();
    turnTimer = setInterval(paintStatusText, 1000);
  }

  function stopTurnTimer() {
    if (turnTimer) clearInterval(turnTimer);
    turnTimer = 0;
    turnStartedAt = 0;
  }

  function setStatus(phase, detail, forMode, opts = {}) {
    const target = forMode || mode;
    const b = bags[target];
    const streamPhases = [
      "thinking",
      "tool",
      "responding",
      "session",
      "starting",
      "queued",
    ];
    const sid = opts.sessionId || null;
    if (
      sid &&
      mode === "grok" &&
      streamPhases.includes(phase) &&
      !isViewingSession(sid)
    ) {
      const buf = ensureSessionStream(sid);
      if (buf) {
        buf.statusPhase = phase;
        buf.statusDetail = detail || "";
      }
      return;
    }
    if (
      sid &&
      streamPhases.includes(phase) &&
      mode === "grok" &&
      selectedId &&
      selectedId !== sid
    ) {
      const buf = ensureSessionStream(sid);
      if (buf) {
        buf.statusPhase = phase;
        buf.statusDetail = detail || "";
      }
      return;
    }
    // Zawsze humanizuj detail (tool titles = kody)
    let safeDetail = detail || "";
    if (phase === "tool" || /^Execute\b/i.test(safeDetail) || safeDetail.length > 100) {
      safeDetail = humanizeToolTitle(safeDetail);
      if (phase === "tool" && (!safeDetail || safeDetail === tr("Tool"))) {
        safeDetail = tr("Working in the background…");
      }
    }
    b.statusPhase = phase || "";
    b.statusDetail = safeDetail;
    // Status UI tylko dla AKTYWNEGO trybu
    if (target !== mode) return;

    const map = {
      queued: "Start…",
      starting: "Uruchamiam agenta…",
      session: tr("Loading session…"),
      thinking: tr("Thinking…"),
      generating_image: tr("Generating image…"),
      responding: tr("Writing…"),
      tool: tr("Working in the background…"),
      done: "Gotowe",
      stopped: "Przerwano",
      error: tr("Error"),
    };
    // Dla tool/thinking: preferuj krótką etykietę, nie surowy detail z ACP
    let label;
    if (phase === "tool") {
      label = safeDetail && safeDetail !== tr("Tool") ? safeDetail : map.tool;
    } else if (phase === "thinking" || phase === "responding") {
      label = map[phase] || safeDetail;
    } else {
      label = safeDetail || map[phase] || phase || "";
    }
    // Ostateczna blokada: nigdy nie wklejaj Execute / ścieżek w status
    if (/^Execute\b/i.test(label) || /GROK_SESSIONS_ATTACHMENTS/i.test(label)) {
      label = map[phase] || tr("Working…");
    }
    if (label.length > 60) label = humanizeToolTitle(label);

    if (!label || phase === "done") {
      if (!busy) {
        el.statusBar.classList.add("hidden");
      } else {
        lastStatusLabel = label || tr("Thinking…");
        paintStatusText();
        el.statusBar.classList.remove("hidden");
      }
      return;
    }
    lastStatusLabel = label;
    paintStatusText();
    el.statusBar.classList.remove("hidden");
  }

  function renderActivity() {
    const active = liveTools.filter((t) => t.status !== "completed" && t.status !== "failed");
    const done = liveTools.filter((t) => t.status === "completed" || t.status === "failed");
    const work = currentWorkStatus();
    const countLabel = work && work.headline
      ? work.headline
      : `${tr("Steps")} (${liveTools.length})`;
    el.btnToggleActivity.classList.toggle(
      "hidden",
      liveTools.length === 0 && livePlan.length === 0
    );
    el.btnToggleActivity.textContent = showActivity ? tr("Hide steps") : countLabel;

    if (!showActivity || (!liveTools.length && !livePlan.length)) {
      el.activityPanel.classList.add("hidden");
      el.activityPanel.innerHTML = "";
      return;
    }
    el.activityPanel.classList.remove("hidden");
    el.activityPanel.innerHTML = "";
    if (work && work.plan && work.plan.total) {
      const h = document.createElement("div");
      h.className = "activity-group";
      h.textContent = `${tr("Now")} · ${work.plan.done}/${work.plan.total}`;
      el.activityPanel.appendChild(h);
      if (work.plan.current) {
        const row = document.createElement("div");
        row.className = "activity-row live";
        row.textContent = work.plan.current;
        el.activityPanel.appendChild(row);
      }
      if (work.plan.next) {
        const row = document.createElement("div");
        row.className = "activity-row";
        row.textContent = `${tr("Next")}: ${work.plan.next}`;
        el.activityPanel.appendChild(row);
      }
    }
    if (active.length) {
      const h = document.createElement("div");
      h.className = "activity-group";
      h.textContent = `${tr("In progress")} · ${active.length}`;
      el.activityPanel.appendChild(h);
      for (const t of active) {
        const row = document.createElement("div");
        row.className = "activity-row live";
        row.textContent = humanizeToolTitle(t.title);
        el.activityPanel.appendChild(row);
      }
    }
    if (done.length) {
      const det = document.createElement("details");
      det.className = "activity-done";
      const sum = document.createElement("summary");
      sum.textContent = work && work.headline
        ? work.headline
        : `${tr("Show")} ${done.length} ${tr("completed")}`;
      det.appendChild(sum);
      for (const t of done) {
        const row = document.createElement("div");
        row.className = "activity-row done";
        row.textContent = humanizeToolTitle(t.title);
        det.appendChild(row);
      }
      el.activityPanel.appendChild(det);
    }
  }

  function setMode(next, { restoreSession = true } = {}) {
    if (next !== "home" && next !== "grok") return;
    // Zapisz stan aktualnego trybu PRZED przełączeniem
    pushBag();
    mode = next;
    pullBag();

    el.tabHome.classList.toggle("active", mode === "home");
    el.tabGrok.classList.toggle("active", mode === "grok");
    el.wsModeBadge.textContent = mode === "home" ? "Home" : "Build";
    el.btnNewLabel.textContent = mode === "home" ? tr("New chat") : tr("New session");
    el.recentsLabel.textContent =
      mode === "home" ? tr("Recents · Home") : tr("Recents · Build");
    el.finePrint.textContent =
      mode === "home"
        ? tr("Home · chat and graphics (/image …) · drop files or paste a screenshot")
        : tr("Build · agent with tools · attachments as paths on disk");
    document.getElementById("hero-title").textContent =
      mode === "home" ? tr("How can I help you today?") : tr("What should we build?");
    document.getElementById("hero-sub").textContent =
      mode === "home"
        ? tr("Like Grok in the browser: chat, ideas, /image for graphics. Not a coding agent.")
        : tr("Build: files, shell, edits. Attachments go to the agent as paths.");

    el.wsTitle.textContent = bag().wsTitle || "New chat";
    updatePathChips(mode === "home" ? "" : selectedRow()?.cwd || defaultCwd);
    applyModelsForMode();
    // Paski trybu
    const mediaBar = document.getElementById("home-media-bar");
    const effortWrap = document.getElementById("effort-wrap");
    const ratioWrap = document.getElementById("ratio-wrap");
    if (mediaBar) mediaBar.classList.toggle("hidden", mode !== "home");
    if (effortWrap) effortWrap.classList.toggle("hidden", mode !== "grok");
    if (ratioWrap) {
      ratioWrap.classList.toggle(
        "hidden",
        mode !== "home" || homeKind === "chat"
      );
    }
    setBusy(busy); // odśwież UI busy dla TEGO trybu
    if (bag().statusDetail || bag().statusPhase) {
      setStatus(bag().statusPhase, bag().statusDetail);
    } else if (!busy) {
      el.statusBar.classList.add("hidden");
    }
    renderList();
    renderAttachChips();
    renderMessages({ forceScroll: true });
    renderActivity();
    persistNav();

    // Przywróć ostatnią sesję tego trybu (nie wracaj zawsze na hero)
    if (restoreSession) {
      const wantId = liveSessionId || selectedId;
      if (wantId) {
        const row = rowsForMode().find((r) => r.id === wantId);
        if (row) {
          // Jeśli wiadomości już w worku — tylko UI; inaczej dociągnij transcript
          if (!allMessages.length) openSession(row, { fromSwitch: true });
          else {
            selectedId = row.id;
            liveSessionId = row.id;
            el.wsTitle.textContent = row.title;
            renderList();
          }
        }
      }
    }
    el.input.focus();
  }

  /**
   * W trybie prywatności katalog domowy → „~”. Bez tego chip ścieżki
   * pokazywał pełne /Users/<login> i nazwa konta lądowała na każdym
   * zrzucie ekranu z trybu Build.
   */
  function maskPath(p) {
    const s = String(p || "");
    if (!privacyMode || !homeDirPath) return s;
    return s.startsWith(homeDirPath) ? "~" + s.slice(homeDirPath.length) : s;
  }

  function updatePathChips(cwd) {
    if (mode === "home") {
      el.cwdChip.textContent = tr("Home chat");
      el.wsCwd.textContent = tr("browser-style");
    } else {
      el.cwdChip.textContent = maskPath(cwd || defaultCwd);
      el.wsCwd.textContent = basenameCwd(cwd || defaultCwd);
    }
  }

  function filteredRows() {
    let list = rowsForMode().slice();
    list.sort((a, b) => {
      const fa = sessionFlagMap[a.id] || {};
      const fb = sessionFlagMap[b.id] || {};
      const pa = fa.pinned ? 1 : 0;
      const pb = fb.pinned ? 1 : 0;
      if (pb !== pa) return pb - pa;
      const ua = fa.unread ? 1 : 0;
      const ub = fb.unread ? 1 : 0;
      if (ub !== ua) return ub - ua;
      return 0;
    });
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (r) =>
        (r.title || "").toLowerCase().includes(q) ||
        (r.id || "").toLowerCase().includes(q) ||
        (r.cwd || "").toLowerCase().includes(q)
    );
  }

  async function markSessionFlag(id, partial) {
    if (!id || typeof api.setSessionFlag !== "function") return;
    const res = await api.setSessionFlag({ id, ...partial });
    if (res && res.ok) {
      sessionFlagMap[id] = { ...(sessionFlagMap[id] || {}), ...res.flag };
      renderList();
    }
  }

  function renderList() {
    const list = filteredRows();
    el.list.innerHTML = "";
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "session-item";
      li.style.cursor = "default";
      li.innerHTML = `<div><div class="title" style="color:var(--faint)">${
        mode === "home" ? tr("No Home chats yet — write below") : tr("No Build sessions")
      }</div></div>`;
      el.list.appendChild(li);
      return;
    }
    const groups = new Map();
    for (const r of list) {
      const g =
        mode === "grok"
          ? basenameCwd(r.cwd) || tr("Build")
          : dayBucket(r.lastActiveAt || r.updatedAt);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    for (const [group, items] of groups) {
      const lab = document.createElement("li");
      lab.className = "session-group-label";
      lab.textContent = group;
      el.list.appendChild(lab);
      for (const r of items) {
        const li = document.createElement("li");
        const isWorking = mode === "grok" && isSessionBusy(r.id);
        const isTerminalLive = Boolean(r.isActive) && !isWorking;
        const fl = sessionFlagMap[r.id] || {};
        li.className =
          "session-item" +
          (r.id === selectedId || r.id === liveSessionId ? " selected" : "") +
          (isWorking ? " working" : "") +
          (fl.unread ? " unread" : "") +
          (fl.pinned ? " pinned" : "");
        li.innerHTML = `
          <span class="session-dot" aria-hidden="true"></span>
          <div class="session-main">
            <div class="title"></div>
          </div>
          <div class="session-badges">
            ${fl.pinned ? '<span class="pin-mark" title="Pinned">📌</span>' : ""}
            ${fl.unread ? '<span class="unread-dot" title="Unread"></span>' : ""}
            <span class="session-time"></span>
            ${
              isWorking
                ? '<span class="live-dot working"></span>'
                : isTerminalLive
                  ? '<span class="live-dot"></span>'
                  : ""
            }
          </div>`;
        li.querySelector(".title").textContent = displayTitle(r);
        const liveDot = li.querySelector(".live-dot");
        if (liveDot) {
          liveDot.title = isWorking
            ? tr("Working in this session")
            : tr("Active in terminal");
        }
        const timeEl = li.querySelector(".session-time");
        if (timeEl) {
          timeEl.textContent = isWorking
            ? tr("working…")
            : relativeTime(r.lastActiveAt || r.updatedAt);
        }
        li.addEventListener("click", () => {
          // otwarcie = przeczytane
          if (fl.unread) markSessionFlag(r.id, { unread: false });
          openSession(r);
        });
        li.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showCtx(e.clientX, e.clientY, r.id);
        });
        el.list.appendChild(li);
      }
    }
  }

  function syncVisibleMessages() {
    messages =
      allMessages.length <= visibleCount
        ? allMessages.slice()
        : allMessages.slice(allMessages.length - visibleCount);
  }

  function toolIcon(title) {
    const t = (title || "").toLowerCase();
    if (t.includes("bash") || t.includes("shell")) return ">_";
    if (t.includes("read")) return "📄";
    if (t.includes("edit") || t.includes("write")) return "✎";
    if (t.includes("search") || t.includes("grep")) return "⌕";
    if (t.includes("web")) return "🌐";
    return "⚙";
  }

  const scroller = (window.chatScroll && window.chatScroll.createChatScroll)
    ? window.chatScroll.createChatScroll({ nearBottomPx: 80 })
    : {
        shouldFollow: () => true,
        pin() {},
        release() {},
        onUserScroll() { return true; },
        withProgrammatic(fn) { return fn(); },
        applyBottom(box) {
          if (!box) return false;
          box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
          return true;
        },
        isProgrammatic: () => false,
      };
  let stickToBottom = true;
  let scrollingProgrammatically = false;
  let scrollBottomTimer = 0;

  function syncStickFlag() {
    stickToBottom = scroller.shouldFollow();
  }

  function holdStick() {
    /* user scroll always wins — nie blokuj czytania od góry */
    scroller.pin();
    stickToBottom = true;
  }

  function nearBottom(threshold = 80) {
    const box = el.chatScroll;
    if (!box) return true;
    if (window.chatScroll && window.chatScroll.isNearBottom) {
      return window.chatScroll.isNearBottom(box, threshold);
    }
    return box.scrollHeight - box.scrollTop - box.clientHeight < threshold;
  }

  function shouldStickBottom(force) {
    if (force) return true;
    return scroller.shouldFollow();
  }

  /**
   * @param {boolean} [force] — true = Enter / nowa tura (pin + dół)
   * Chunk streamu woła bez force. Jak user czyta od góry, nic nie ruszamy.
   */
  function scrollChatToBottom(force) {
    const box = el.chatScroll;
    if (!box) return;
    if (force) scroller.pin();
    if (!force && !scroller.shouldFollow()) return;

    const go = () => {
      const b = el.chatScroll;
      if (!b || !scroller.shouldFollow()) return;
      scrollingProgrammatically = true;
      scroller.withProgrammatic(() => {
        const max = Math.max(0, b.scrollHeight - b.clientHeight);
        b.scrollTop = max > 0 ? max : b.scrollHeight;
      });
      scrollingProgrammatically = false;
    };
    go();
    requestAnimationFrame(() => {
      go();
      requestAnimationFrame(go);
    });
    if (scrollBottomTimer) clearTimeout(scrollBottomTimer);
    scrollBottomTimer = setTimeout(() => {
      scrollBottomTimer = 0;
      if (!scroller.shouldFollow()) return;
      go();
    }, 50);
  }

  /**
   * Dociąga dół dopóki wysokość treści rośnie (max ~1.2 s).
   * Pojedynczy scroll po renderze nie wystarczał: tabele, obrazy i fonty
   * dochodzą później i widok zostawał w połowie historii.
   */
  let settleTimer = 0;
  function settleScrollToBottom() {
    if (settleTimer) clearInterval(settleTimer);
    let lastH = -1;
    let stable = 0;
    let ticks = 0;
    settleTimer = setInterval(() => {
      const msgs = el.messages;
      const box = el.chatScroll;
      if (!msgs || !box) {
        clearInterval(settleTimer);
        settleTimer = 0;
        return;
      }
      const h = msgs.scrollHeight;
      if (h === lastH) stable++;
      else stable = 0;
      lastH = h;
      if (scroller.shouldFollow()) {
        layoutChatBottom();
        scrollingProgrammatically = true;
        scroller.applyBottom(box);
        scrollingProgrammatically = false;
      }
      if (++ticks > 20 || stable >= 3) {
        clearInterval(settleTimer);
        settleTimer = 0;
      }
    }, 60);
  }

  function bindChatScrollWatcher() {
    const box = el.chatScroll;
    if (!box || box._stickWatch) return;
    box._stickWatch = true;
    box.addEventListener(
      "scroll",
      () => {
        if (scrollingProgrammatically || scroller.isProgrammatic?.()) return;
        scroller.onUserScroll(box);
        syncStickFlag();
      },
      { passive: true }
    );
    // Gest użytkownika jest jednoznaczny — puszczamy dół NATYCHMIAST, bez
    // oglądania się na flagę „to my scrollujemy”. Podczas streamu ResizeObserver
    // trzymał tę flagę prawie bez przerwy, więc event `scroll` od kółka był
    // zjadany i widok wracał na dół: nie dało się czytać od góry, gdy Grok pisze.
    const releaseOnGesture = (e) => {
      if (e.type === "keydown") {
        const k = e.key;
        const nav =
          k === "PageUp" || k === "PageDown" || k === "Home" || k === "End" ||
          k === "ArrowUp" || k === "ArrowDown";
        if (!nav || e.target === el.input) return;
        if (k === "End" || k === "PageDown" || k === "ArrowDown") {
          if (isNearBottomNow()) return;
        }
      }
      if (e.type !== "keydown" && e.type !== "touchmove") {
        // kółko/gładzik w dół przy samym dole = user chce zostać przy dole
        if (e.deltaY > 0 && isNearBottomNow()) return;
      }
      scrollingProgrammatically = false;
      scroller.release();
      stickToBottom = false;
    };
    const isNearBottomNow = () => {
      const b = el.chatScroll;
      return b ? b.scrollHeight - b.scrollTop - b.clientHeight < 40 : true;
    };
    box.addEventListener("wheel", releaseOnGesture, { passive: true });
    box.addEventListener("touchmove", releaseOnGesture, { passive: true });
    box.addEventListener("keydown", releaseOnGesture);
    document.addEventListener("keydown", releaseOnGesture);
    // BUG (naprawiony): obserwowany był #chat-scroll, czyli kontener o stałej
    // wysokości. Gdy rosła TREŚĆ (markdown, tabele, obrazy z readPreview,
    // fonty), nic się nie przeliczało i widok zostawał w połowie historii,
    // dopóki użytkownik nie ruszył scrolla ręcznie. Obserwujemy #messages.
    if (typeof ResizeObserver !== "undefined" && !box._layoutRo) {
      box._layoutRo = new ResizeObserver(() => {
        if (!allMessages.length) return;
        layoutChatBottom();
        // treść urosła, a user trzymał dół → dociągnij
        if (scroller.shouldFollow()) {
          scrollingProgrammatically = true;
          scroller.applyBottom(el.chatScroll);
          requestAnimationFrame(() => {
            scrollingProgrammatically = false;
          });
        }
      });
      box._layoutRo.observe(box);
      if (el.messages) box._layoutRo.observe(el.messages);
    }
  }

  /**
   * Obrazy dochodzą asynchronicznie (IPC + base64) i rosną PO ustawieniu
   * scrollTop. Bez tego widok zostawał nad ostatnią wiadomością.
   */
  function stickAfterImage(el) {
    const onReady = () => {
      layoutChatBottom();
      if (stickToBottom) scrollChatToBottom(false);
    };
    el.addEventListener("load", onReady, { once: true });
    // <video> nie emituje "load" — dopiero metadane znają wysokość
    el.addEventListener("loadedmetadata", onReady, { once: true });
  }

  /** Zachowaj pozycję scrolla (composer autosize). */
  function preserveChatScroll(fn) {
    const box = el.chatScroll;
    if (!box) {
      fn();
      return;
    }
    const prevTop = box.scrollTop;
    const follow = stickToBottom && nearBottom(120);
    fn();
    const restore = () => {
      if (!el.chatScroll) return;
      if (follow) {
        el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
      } else {
        el.chatScroll.scrollTop = prevTop;
      }
    };
    restore();
    requestAnimationFrame(restore);
  }

  function findLastAssistantRow() {
    const nodes = el.messages.querySelectorAll(".msg.assistant");
    return nodes[nodes.length - 1] || null;
  }

  function cssAttr(v) {
    return String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /** Bańka asystenta po ostatniej wiadomości usera — nigdy wcześniejsza tura. */
  function findAssistantRowFor(m) {
    if (m && m.id) {
      const hit = el.messages.querySelector(
        `.msg.assistant[data-msg-id="${cssAttr(m.id)}"]`
      );
      if (hit) return hit;
    }
    const lastA = findLastAssistantRow();
    if (!lastA) return null;
    const users = el.messages.querySelectorAll(".msg.user");
    const lastU = users[users.length - 1] || null;
    if (
      lastU &&
      lastA.compareDocumentPosition(lastU) & Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      return null;
    }
    return lastA;
  }

  /** Aktualizuj ostatnią odpowiedź bez full re-render (bez skoku scrolla). */
  function patchLastAssistantBubble(m) {
    if (!m) return;
    let last = findAssistantRowFor(m);
    if (!last) {
      // NIGDY full renderMessages w trakcie tury — tylko doklej
      appendMessageRows([m], { stick: false });
      return;
    }
    let content = last.querySelector(".msg-content");
    const safe = cleanAssistantText(m.text || "");
    if (!safe) {
      if (content) content.textContent = "";
      return;
    }
    if (!content) {
      content = document.createElement("div");
      content.className = "msg-content";
      last.querySelector(".msg-body")?.appendChild(content);
    }
    if (typeof renderMarkdown === "function") {
      content.innerHTML = renderMarkdown(safe);
    } else {
      content.textContent = safe;
    }
    const typing = last.querySelector(".typing");
    if (typing && safe) typing.remove();
    // wysokość bańki rośnie → przelicz padding krótkiego czatu
    if (allMessages.length && allMessages.length <= 4) layoutChatBottom();
    // tylko gdy user trzyma dół
    if (stickToBottom && nearBottom(160)) {
      scrollChatToBottom(true);
    }
  }


  /** Jedna bańka DOM — używane do full render i do append bez wipe. */
  function buildMessageRow(m) {
    const row = document.createElement("div");
    row.className = `msg ${m.role}`;
    if (m.id) row.dataset.msgId = m.id;
    const av = document.createElement("div");
    av.className = "msg-avatar";
    av.textContent = m.role === "user" ? "Y" : "✦";
    row.appendChild(av);

    const body = document.createElement("div");
    body.className = "msg-body";
    const label = document.createElement("div");
    label.className = "msg-label";
    label.textContent = m.role === "user" ? "You" : "Grok";
    body.appendChild(label);

    // JEDEN chip nad bańką. Na skończonej turze pokazuje CO agent zrobił
    // („Read 11 files, ran 12 commands”), jak u Claude — nie „Thinking”.
    if (mode === "grok" && ((m.tools && m.tools.length) || m.thinking)) {
      const tools = m.tools || [];
      const active = tools.filter(
        (t) => t.status !== "completed" && t.status !== "failed"
      );
      const pill = document.createElement("div");
      pill.className = "agent-work-summary" + (active.length ? " live" : "");
      if (active.length) {
        const ht = humanizeToolTitle(active[0].title);
        pill.textContent = `Pracuję: ${ht}${
          active.length > 1 ? ` +${active.length - 1}` : ""
        }`;
      } else {
        const sum =
          (window.workSummary && window.workSummary.summarizeTools(tools)) || "";
        // sama warstwa myślenia bez narzędzi → pusty chip, nie „Thinking”
        pill.textContent = sum || (m._streaming && busy ? "Thinking…" : "");
      }
      if (pill.textContent) body.appendChild(pill);
    }

    if (m.attachments && m.attachments.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-atts";
      for (const a of m.attachments) {
        const chip = document.createElement("span");
        chip.className = "msg-att";
        chip.textContent = a.name || a.path || "file";
        wrap.appendChild(chip);
      }
      body.appendChild(wrap);
    }

    if (m.images && m.images.length) {
      const gal = document.createElement("div");
      gal.className = "msg-images";
      for (const img of m.images) {
        const im = document.createElement("img");
        im.className = "msg-image";
        im.loading = "lazy";
        stickAfterImage(im);
        if (img.b64) {
          im.src = `data:${img.mimeType || "image/png"};base64,${img.b64}`;
        } else if (img.path) {
          im.alt = img.name || "obraz";
          api.readPreview(img.path).then((r) => {
            if (r.ok) im.src = r.dataUrl;
          });
        }
        gal.appendChild(im);
      }
      body.appendChild(gal);
    }

    if (m.videos && m.videos.length) {
      const gal = document.createElement("div");
      gal.className = "msg-images";
      for (const v of m.videos) {
        const vid = document.createElement("video");
        vid.className = "msg-video";
        vid.controls = true;
        vid.preload = "metadata";
        // Plik prosto z dysku (file://), NIE przez readPreview: kilkumegabajtowe
        // wideo szłoby przez IPC jako base64 (+33% i cały plik w pamięci),
        // a przeglądarka i tak nie może przewijać data: URL-a.
        if (v.path) vid.src = "file://" + encodeURI(v.path).replace(/#/g, "%23");
        stickAfterImage(vid);
        gal.appendChild(vid);
      }
      body.appendChild(gal);
    }

    const displayText =
      m.role === "user"
        ? cleanUserText(m.text)
        : cleanAssistantText(m.text || "");
    if (displayText) {
      const content = document.createElement("div");
      content.className = "msg-content";
      if (m.role === "assistant" && typeof renderMarkdown === "function") {
        content.innerHTML = renderMarkdown(displayText);
      } else {
        content.textContent = displayText;
      }
      body.appendChild(content);
    }
    if (m._queued) {
      const q = document.createElement("div");
      q.className = "queued-actions";
      const badge = document.createElement("span");
      badge.className = "queued-badge";
      badge.textContent = tr("queued");
      const inject = document.createElement("button");
      inject.type = "button";
      inject.className = "queued-inject";
      inject.title = tr("Send now — interrupt and fold into current work");
      inject.textContent = tr("↩ Send now");
      inject.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        injectQueuedNow(m);
      };
      q.appendChild(badge);
      q.appendChild(inject);
      body.appendChild(q);
    }
    // JEDEN indicator „…” (wcześniej było podwójne)
    if (
      m.role === "assistant" &&
      m._streaming &&
      !displayText &&
      !(m.tools && m.tools.length)
    ) {
      const wait = document.createElement("div");
      wait.className = "typing";
      wait.textContent = "…";
      body.appendChild(wait);
    }

    const actions = document.createElement("div");
    actions.className = "msg-actions";

    const mkBtn = (label, title, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.onclick = fn;
      actions.appendChild(b);
      return b;
    };

    mkBtn("Copy", tr("Copy message text"), async () => {
      try {
        const clean =
          m.role === "user"
            ? cleanUserText(m.text || "")
            : cleanAssistantText(m.text || "");
        await navigator.clipboard.writeText(clean || m.text || "");
        showToast(tr("Copied"), "ok");
      } catch {
        showToast(tr("Copy failed"), "error");
      }
    });

    if (!m._queued) {
      if (m.role === "user") {
        mkBtn(tr("Edit"), tr("Go back to this message and send a corrected version"), () =>
          editMessage(m)
        );
      }
      mkBtn(
        tr("Retry"),
        m.role === "user"
          ? tr("Send this message again")
          : tr("Generate the answer again"),
        () => retryFrom(m)
      );
      mkBtn(
        tr("Delete"),
        mode === "grok"
          ? tr("Removes from view. The agent still remembers this turn in its session.")
          : "Usuwa z widoku czatu",
        () => deleteMessage(m)
      );
    }

    body.appendChild(actions);
    row.appendChild(body);
    return row;
  }

  /**
   * Krótki czat: padding-top = wolne px w #chat-scroll → bańki przy composerze.
   * Bez min-height:100% (to dawało scrollbar przy 1 wiadomości).
   */
  function layoutChatBottom() {
    const box = el.chatScroll;
    const msgs = el.messages;
    if (!box || !msgs) return;
    if (!allMessages.length) {
      msgs.style.paddingTop = "";
      return;
    }
    const currentPad = parseFloat(msgs.style.paddingTop) || 0;
    const cs = getComputedStyle(box);
    const padY =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const available = Math.max(0, box.clientHeight - padY);
    const measure = chatHistory.contentHeightWithoutPad || ((h, p) => h - p);
    const nextPadFn = chatHistory.nextChatPadding || ((a, c) => (a - c > 1 ? a - c : 0));
    const contentH = measure(msgs.scrollHeight, currentPad);
    const nextPad = nextPadFn(available, contentH);
    if (Math.abs(nextPad - currentPad) > 1) {
      msgs.style.paddingTop = nextPad ? `${nextPad}px` : "0px";
    }
    if (stickToBottom) {
      box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
    }
  }

  function pinMessagesBottom(on) {
    if (!on) {
      el.messages.style.paddingTop = "";
      return;
    }
    layoutChatBottom();
  }

  /** Doklej bańki na KONIEC .messages. */
  function appendMessageRows(msgs, { stick = false } = {}) {
    if (!msgs || !msgs.length) return;
    el.homeHero.classList.add("hidden");
    if (stick) stickToBottom = true;
    for (const m of msgs) {
      // po id — nigdy nie blokuj drugiego „dzień dobry” w tej samej sesji
      if (m.id) {
        const sel = `[data-msg-id="${String(m.id).replace(/"/g, "")}"]`;
        if (el.messages.querySelector(sel)) continue;
      }
      // echo ACP (bez _local): nie doklejaj tego samego tekstu usera drugi raz
      if (m.role === "user" && !m._local && hasUserTextAlready(m.text)) continue;
      // zawsze na koniec DOM = dół listy
      el.messages.appendChild(buildMessageRow(m));
    }
    layoutChatBottom();
    if (stick || stickToBottom) scrollChatToBottom(!!stick);
  }

  function renderMessages(opts = {}) {
    if (busy && !opts.force && !opts.forceScroll) {
      if (streamingAssistant) patchLastAssistantBubble(streamingAssistant);
      return;
    }
    const forceScroll = Boolean(opts.forceScroll);
    if (forceScroll) stickToBottom = true;
    const box = el.chatScroll;
    const prevTop = box ? box.scrollTop : 0;
    const stickBottom = forceScroll || stickToBottom;

    // NIE chowaj visibility — to dawało skok na górę (scrollHeight=0)
    const frag = document.createDocumentFragment();
    const hasMsgs = allMessages.length > 0;
    el.homeHero.classList.toggle("hidden", hasMsgs);

    if (allMessages.length > messages.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "load-more";
      more.textContent = `Load earlier (${allMessages.length - messages.length})`;
      more.onclick = () => {
        const box2 = el.chatScroll;
        const oldH = box2 ? box2.scrollHeight : 0;
        const oldT = box2 ? box2.scrollTop : 0;
        visibleCount = Math.min(allMessages.length, visibleCount + PAGE);
        syncVisibleMessages();
        stickToBottom = false;
        renderMessages({ force: true });
        // zachowaj miejsce czytania po dołożeniu starszych
        if (box2) {
          const d = box2.scrollHeight - oldH;
          box2.scrollTop = oldT + d;
        }
      };
      frag.appendChild(more);
    }

    for (const m of messages) {
      frag.appendChild(buildMessageRow(m));
    }

    // programowy scroll: nie pozwól watcherowi zgasić stick w trakcie wipe
    scrollingProgrammatically = true;
    el.messages.replaceChildren(frag);
    // krótki czat: padding-top zamiast min-height (bez fałszywego scrollbara)
    layoutChatBottom();
    if (box) {
      if (stickBottom) {
        // natychmiast — zanim browser zostawi scrollTop=0
        const max = Math.max(0, box.scrollHeight - box.clientHeight);
        box.scrollTop = max > 0 ? max : box.scrollHeight;
        scrollChatToBottom(true);
      } else {
        box.scrollTop = prevTop;
        scrollingProgrammatically = false;
      }
    } else {
      scrollingProgrammatically = false;
    }
  }


  function renderAttachChips() {
    if (!attachments.length) {
      el.attachChips.classList.add("hidden");
      el.attachChips.innerHTML = "";
      return;
    }
    el.attachChips.classList.remove("hidden");
    el.attachChips.innerHTML = "";
    attachments.forEach((a, i) => {
      const chip = document.createElement("div");
      chip.className = "attach-chip";
      const label = document.createElement("span");
      label.textContent =
        (a.kind === "image" ? "🖼 " : a.kind === "folder" ? "📁 " : "📄 ") +
        (a.name || "file");
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.onclick = () => {
        attachments.splice(i, 1);
        renderAttachChips();
      };
      chip.appendChild(label);
      chip.appendChild(x);
      if (a.kind === "image" && a.path) {
        api.readPreview(a.path).then((r) => {
          if (!r.ok) return;
          const img = document.createElement("img");
          img.src = r.dataUrl;
          img.className = "attach-thumb";
          chip.insertBefore(img, label);
        });
      }
      el.attachChips.appendChild(chip);
    });
  }

  /**
   * Tryb prywatności: chowa imię i adres e-mail wszędzie, gdzie są widoczne.
   * Do zrzutów ekranu, nagrań i pokazywania aplikacji na żywo — żeby nie
   * trzeba było potem zamazywać stopki na obrazku.
   */
  let privacyMode = false;
  let lastAccount = null;
  let homeDirPath = "";
  let lastSystemLocale = "en";

  /**
   * Przycisk logowania mówił „Log in” także wtedy, gdy użytkownik był
   * zalogowany. `grok login` służy wtedy do przelogowania, więc etykieta
   * ma to odzwierciedlać zamiast sugerować, że sesji nie ma.
   */
  function paintLoginButtons(loggedIn) {
    const label = loggedIn ? tr("Switch account") : tr("Log in");
    for (const id of ["account-login", "set-login"]) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.textContent = label;
      b.title = loggedIn
        ? tr("Sign in again, e.g. with a different account")
        : tr("Sign in with: grok login");
    }
  }

  function applyAccount(account) {
    if (account) lastAccount = account;
    const acc = lastAccount;
    if (!acc) return;

    if (privacyMode) {
      paintLoginButtons(acc.loggedIn);
      el.accountName.textContent = acc.loggedIn ? tr("Signed in") : tr("Not signed in");
      el.accountSub.textContent = acc.loggedIn ? tr("account hidden") : "—";
      el.accountAvatar.textContent = "•";
      el.accountDetail.textContent = acc.loggedIn
        ? tr("Account details hidden (privacy mode)")
        : tr("Not signed in. Use „Log in”.");
      return;
    }

    paintLoginButtons(acc.loggedIn);
    el.accountName.textContent = acc.name || acc.label || "—";
    el.accountSub.textContent = acc.loggedIn
      ? acc.email || tr("signed in")
      : tr("Not signed in");
    el.accountAvatar.textContent = (acc.name || acc.email || "?")
      .trim()
      .charAt(0)
      .toUpperCase();
    el.accountDetail.textContent = acc.loggedIn
      ? `${acc.name || ""}\n${acc.email || ""}\n${tr("SuperGrok / xAI session")}`
      : tr("Not signed in. Use „Log in”.");
  }

  /**
   * Ustawia język i odświeża wszystko, co już jest na ekranie.
   * Domyślnie angielski — „auto” trzeba wybrać świadomie.
   */
  function applyLanguage(setting, systemLocale) {
    const lang = i18n.resolveLang(setting || "en", systemLocale);
    i18n.setLang(lang);
    document.documentElement.setAttribute("lang", lang);
    i18n.applyDomTranslations(document);
    // teksty budowane w JS (zależne od trybu) trzeba przemalować ręcznie
    if (bootDone) {
      setMode(mode, { restoreSession: false });
      renderList();
      renderMessages({ force: true });
      renderActivity();
    }
  }

  function setPrivacyMode(on) {
    privacyMode = Boolean(on);
    document.documentElement.classList.toggle("privacy", privacyMode);
    applyAccount(null);
    updatePathChips(mode === "home" ? "" : selectedRow()?.cwd || defaultCwd);
    if (typeof refreshUsage === "function") refreshUsage();
  }

  function applyModelsForMode() {
    const select = el.modelSelect;
    select.innerHTML = "";
    if (mode === "home") {
      const opts = homeModels.length
        ? homeModels
        : [
            { modelId: "grok-4.6", name: "Grok 4.6" },
            { modelId: "grok-4.5", name: "Grok 4.5" },
            { modelId: "grok-4.3", name: "Grok 4.3" },
            { modelId: "grok-imagine-image", name: "Imagine · image" },
          ];
      for (const m of opts) {
        const o = document.createElement("option");
        o.value = m.modelId;
        o.textContent = m.name;
        select.appendChild(o);
      }
      select.value = homeModelId;
    } else {
      const o = document.createElement("option");
      o.value = codeModelId || "grok-4.6";
      o.textContent = codeModelId || "Grok 4.6";
      select.appendChild(o);
      select.value = codeModelId || "grok-4.6";
    }
  }

  function applyPayload(payload) {
    codeRows = (payload.rows || []).filter((r) => r.kind !== "home");
    homeRows = payload.homeRows || [];
    defaultCwd = payload.settings?.defaultCwd || defaultCwd;
    homeDirPath = payload.settings?.homeDir || homeDirPath;
    lastSystemLocale = payload.settings?.systemLocale || lastSystemLocale;
    homeModelId = payload.settings?.homeModelId || homeModelId;
    codeModelId = payload.settings?.modelId || codeModelId;
    if (payload.homeModels && payload.homeModels.length) {
      homeModels = payload.homeModels;
    }
    if (Array.isArray(payload.busySessionIds)) {
      busySessionIds.clear();
      for (const id of payload.busySessionIds) {
        if (id) busySessionIds.add(id);
      }
      busySessionId = busySessionIds.values().next().value || null;
    } else if (payload.busySessionId) {
      setSessionBusy(payload.busySessionId, true);
    }
    if (!selectedId) updatePathChips(mode === "home" ? "" : defaultCwd);

    applyAccount(payload.account);
    if (mode === "grok" && payload.models?.availableModels?.length) {
      const select = el.modelSelect;
      const cur = payload.models.currentModelId || codeModelId;
      select.innerHTML = "";
      for (const m of payload.models.availableModels) {
        const o = document.createElement("option");
        o.value = m.modelId;
        o.textContent = m.name || m.modelId;
        select.appendChild(o);
      }
      select.value = cur;
      codeModelId = cur;
    } else if (mode === "home") {
      applyModelsForMode();
    }

    const parts = [];
    if (payload.error) parts.push(payload.error);
    if (payload.grokBinary && !payload.grokBinary.ok && mode === "grok") {
      parts.push(payload.grokBinary.reason);
    }
    if (payload.authOk === false) parts.push("Not signed in — Settings → Log in");
    setBanner(parts.join(" · "), parts.length > 0);

    renderList();
    if (selectedRow()) {
      el.wsTitle.textContent = displayTitle(selectedRow());
      updatePathChips(selectedRow().cwd);
    }
  }

  async function refresh() {
    applyPayload(await api.list());
  }

  function ensureSessionStream(sid) {
    if (!sid) return null;
    if (!streamBySession[sid]) {
      streamBySession[sid] = {
        allMessages: [],
        streamingAssistant: null,
        liveTools: [],
        livePlan: [],
        messageQueue: [],
        statusPhase: "",
        statusDetail: "",
      };
    }
    return streamBySession[sid];
  }

  /** Zapisz live stan Build sesji przed przełączeniem. */
  function snapshotCurrentBuildSession() {
    if (mode !== "grok" || !liveSessionId) return;
    const sid = liveSessionId;
    streamBySession[sid] = {
      allMessages: allMessages.slice(),
      streamingAssistant,
      liveTools: (liveTools || []).slice(),
      livePlan: (livePlan || []).slice(),
      messageQueue: (messageQueue || []).slice(),
      attachments: (attachments || []).slice(),
      statusPhase: bag().statusPhase || "",
      statusDetail: bag().statusDetail || "",
    };
  }

  /**
   * Tytuł z pierwszej wiadomości usera, trzymany w oknie.
   * Skan dysku bierze go z updates.jsonl, ale agent zapisuje ten plik
   * z opóźnieniem — przez kilka sekund świeża karta stała jako „01a00f2c”.
   */
  const localTitles = Object.create(null);

  /**
   * Numer wersji widoku. Rośnie przy KAŻDEJ zmianie tego, co jest otwarte.
   * Wyścig, który to łapie: nowa sesja A wysłana, po sekundzie New session i
   * nowa sesja B. Sid dla A przychodzi DOPIERO teraz — a stary kod widział
   * tylko globalne `pendingNewSession` i przygarniał sidem A widok, w którym
   * siedzi już bańka usera z B. Pytanie z B lądowało w czacie A.
   */
  let viewEpoch = 0;
  let pendingNewEpoch = -1;

  function bumpViewEpoch() {
    viewEpoch++;
  }

  /** Czy ten widok wciąż czeka na sid SWOJEJ nowej sesji. */
  function awaitingOwnNewSession() {
    return pendingNewSession && pendingNewEpoch === viewEpoch;
  }

  function rememberLocalTitle(sid) {
    if (!sid || localTitles[sid]) return;
    const first = allMessages.find(
      (m) => m && m.role === "user" && String(m.text || "").trim()
    );
    if (!first) return;
    const t = String(first.text).replace(/\s+/g, " ").trim();
    if (t.length < 2) return;
    localTitles[sid] = t.length > 48 ? t.slice(0, 47).trimEnd() + "…" : t;
  }

  /** Skan oddał sam skrót uuid — użyj tego, co user właśnie napisał. */
  function displayTitle(row) {
    if (!row) return "";
    if (localTitles[row.id] && /^[0-9a-f]{8}$/i.test(String(row.title))) {
      return localTitles[row.id];
    }
    return row.title;
  }

  /**
   * Koniec tury = zero baniek z flagą _streaming w TEJ sesji.
   * `streamingAssistant` w trakcie tury bywa podmieniany (follow-up, pusta
   * skorupa), więc czyszczenie samego śledzonego obiektu zostawiało w tablicy
   * bańkę z flagą. Po powrocie do sesji merge dokładał ją obok tej samej
   * treści z transkryptu — dwie identyczne odpowiedzi.
   */
  function clearStreamingFlags(sid) {
    if (!sid) return;
    const buf = streamBySession[sid];
    if (buf) {
      for (const m of buf.allMessages || []) if (m) m._streaming = false;
      if (buf.streamingAssistant) buf.streamingAssistant._streaming = false;
      buf.streamingAssistant = null;
    }
    if (isViewingSession(sid)) {
      for (const m of allMessages) if (m) m._streaming = false;
      streamingAssistant = null;
    }
  }

  function stampSessionId(sid) {
    if (!sid) return;
    for (const m of allMessages) {
      if (!m._sid) m._sid = sid;
    }
    if (streamingAssistant && !streamingAssistant._sid) {
      streamingAssistant._sid = sid;
    }
  }

  /** New chat gets a real session id mid-turn — stay on this view. */
  function adoptBuildSession(sid) {
    if (!sid || mode !== "grok") return;
    if (selectedId === sid || liveSessionId === sid) {
      stampSessionId(sid);
      return;
    }
    if (!awaitingOwnNewSession()) return;
    if (selectedId && selectedId !== sid) return;
    if (streamBySession[sid] && liveSessionId !== sid) return;
    selectedId = sid;
    liveSessionId = sid;
    pendingNewSession = false;
    stampSessionId(sid);
    rememberLocalTitle(sid);
    snapshotCurrentBuildSession();
    persistNav();
    renderList();
  }

  function isViewingSession(sid) {
    if (!sid) return false;
    if (detachedBuild) return false;
    if (mode !== "grok") return false;
    if (selectedId === sid || liveSessionId === sid) return true;
    // Nowy czat: bierzemy tylko sid, którego jeszcze nie ma inna karta
    if (awaitingOwnNewSession() && !selectedId && !streamBySession[sid]) return true;
    return false;
  }

  /** Wyczyść chrome UI (status, kroki, załączniki) — obca sesja. */
  function clearForeignSessionChrome() {
    liveTools = [];
    livePlan = [];
    renderActivity();
    attachments = [];
    renderAttachChips();
    el.statusBar.classList.add("hidden");
    el.statusText.textContent = "";
    bag().statusPhase = "";
    bag().statusDetail = "";
    showActivity = false;
  }

  async function openSession(row, opts = {}) {
    bumpViewEpoch();
    detachedBuild = false;
    if (mode === "grok" && liveSessionId && liveSessionId !== row.id) {
      snapshotCurrentBuildSession();
    }

    selectedId = row.id;
    liveSessionId = row.id;
    // Kliknięcie w istniejącą kartę kończy stan „czekam na sid nowego czatu”.
    // Zawieszona flaga pozwalała później przygarnąć cudzy sid.
    pendingNewSession = false;
    el.wsTitle.textContent = displayTitle(row);
    bag().wsTitle = displayTitle(row);
    updatePathChips(row.cwd);
    renderList();

    const live = streamBySession[row.id];
    const hasOwnStream = Boolean(
      live &&
        (live.streamingAssistant ||
          (live.allMessages || []).some((m) => m && m._streaming))
    );
    const hasLiveWork = Boolean(live && isSessionBusy(row.id) && hasOwnStream);

    if (hasLiveWork) {
      const loadView =
        chatHistory.loadSessionView ||
        ((a) => (a || []).slice());
      allMessages = loadView(live.allMessages || [], allMessages, row.id);
      streamingAssistant =
        live.streamingAssistant ||
        allMessages.find((m) => m.role === "assistant" && m._streaming) ||
        null;
      liveTools = (live.liveTools || []).slice();
      livePlan = (live.livePlan || []).slice();
      messageQueue = (live.messageQueue || []).slice();
      attachments = (live.attachments || []).slice();
      visibleCount = Math.max(PAGE, allMessages.length);
      syncVisibleMessages();
      renderMessages({ forceScroll: true });
      renderActivity();
      renderAttachChips();
      updateQueueChip();
      setBusy(true, mode);
      if (live.statusPhase) {
        setStatus(live.statusPhase, live.statusDetail, mode, {
          sessionId: row.id,
        });
      }
      pushBag();
      persistNav();
      try {
        el.input.focus({ preventScroll: true });
      } catch {
        el.input.focus();
      }
      return;
    }

    // Obca sesja (albo bez pracy) — transkrypt bez wipe przed await
    streamingAssistant = null;
    liveTools = [];
    livePlan = [];
    // Kolejka należy do SESJI, nie do okna. Zerowanie jej tutaj kasowało
    // dopowiedzenia napisane w A, gdy user zajrzał do B i wrócił.
    messageQueue = (
      (streamBySession[row.id] && streamBySession[row.id].messageQueue) ||
      []
    ).slice();
    clearForeignSessionChrome();
    visibleCount = PAGE;
    renderActivity();

    const tr = await api.transcript({
      id: row.id,
      dirPath: row.dirPath,
      mode: mode === "home" ? "home" : "grok",
    });
    // race: user could have switched again
    if (selectedId !== row.id) return;

    if (tr.error) showToast(tr.error, "error");
    const mapped = (tr.messages || [])
      .map((m, i) => {
        const raw = m.text || m.content || "";
        let text =
          m.role === "user"
            ? cleanUserText(raw)
            : cleanAssistantText(raw);
        const tools = (m.tools || []).map((t) => ({
          ...t,
          title: t.title || "tool",
        }));
        return {
          ...m,
          id: m.id || `m-${i}`,
          text:
            text ||
            (m.role === "user" && (m.attachments || []).length ? "" : text),
          tools,
        };
      })
      .filter((m) => {
        if (
          m.role === "user" &&
          !m.text &&
          !(m.attachments && m.attachments.length) &&
          !(m.images && m.images.length)
        ) {
          return false;
        }
        if (
          m.role === "assistant" &&
          !m.text &&
          !(m.tools && m.tools.length) &&
          !m.thinking &&
          !(m.images && m.images.length)
        ) {
          return false;
        }
        return true;
      });
    // odfiltruj „żywe” śmieci z cudzego streamu (gdyby transcript miał puste thinking shells)
    const cleaned = mapped.filter(
      (m) => !(m._streaming && m.role === "assistant" && !m.text)
    );
    const merge =
      chatHistory.mergeTranscriptWithLocals || ((a, b) => a.concat(b || []));
    const extras = allMessages.filter(
      (m) => m && (m._local || m._streaming) && m._sid === row.id
    );
    const fromBuf = ((streamBySession[row.id] &&
      streamBySession[row.id].allMessages) ||
      []).filter((m) => m && (m._local || m._streaming) && m._sid === row.id);
    allMessages = merge(cleaned, extras.concat(fromBuf));
    for (const m of allMessages) {
      if (!m._sid) m._sid = row.id;
    }
    holdStick(1200);
    syncVisibleMessages();
    renderMessages({ forceScroll: true });
    // Wznowiona sesja: markdown i obrazy dorastają jeszcze przez chwilę po
    // pierwszym renderze. Dociągnij dół, aż wysokość się ustabilizuje.
    settleScrollToBottom();

    pushBag();
    persistNav();

    updateQueueChip();
    if (isSessionBusy(row.id)) {
      setBusy(true, mode);
    } else {
      setBusy(false, mode);
      el.statusBar.classList.add("hidden");
    }
    el.input.focus();
    if (typeof refreshUsage === "function") refreshUsage();
  }

  /** Indeks wiadomości w allMessages po id. */
  function indexOfMsg(m) {
    if (!m) return -1;
    return allMessages.findIndex((x) => x === m || (m.id && x.id === m.id));
  }

  /** Ostatnia wiadomość użytkownika przed indeksem i. */
  function lastUserBefore(i) {
    for (let k = i; k >= 0; k--) {
      if (allMessages[k].role === "user") return allMessages[k];
    }
    return null;
  }

  /**
   * Usuwa z WIDOKU. W trybie Build sesja agenta nadal pamięta tę turę —
   * mówimy to wprost zamiast udawać cofnięcie.
   */
  async function deleteMessage(m) {
    const i = indexOfMsg(m);
    if (i < 0) return;
    allMessages.splice(i, 1);
    syncVisibleMessages();
    renderMessages({ force: true });
    pushBag();
    await persistHomeView();
    showToast(
      mode === "grok"
        ? tr("Removed from view (the agent still remembers it)")
        : tr("Removed from view"),
      ""
    );
  }

  /** Wstaw treść do composera i odetnij historię od tego miejsca (widok). */
  async function editMessage(m) {
    if (busy) {
      showToast(tr("Stop the current turn first (■)"), "");
      return;
    }
    const i = indexOfMsg(m);
    if (i < 0) return;
    el.input.value = cleanUserText(m.text || "");
    autosize();
    allMessages = allMessages.slice(0, i);
    syncVisibleMessages();
    renderMessages({ force: true });
    pushBag();
    await persistHomeView();
    el.input.focus();
    showToast(
      mode === "grok"
        ? tr("Edit and send. Note: the agent remembers the previous version.")
        : tr("Edit and send"),
      "ok"
    );
  }

  /** Wyślij ponownie: z bańki usera tę samą, z bańki asystenta poprzedni prompt. */
  async function retryFrom(m) {
    if (busy) {
      showToast(tr("Stop the current turn first (■)"), "");
      return;
    }
    const i = indexOfMsg(m);
    if (i < 0) return;
    const src = m.role === "user" ? m : lastUserBefore(i);
    if (!src) {
      showToast(tr("Nothing to retry"), "error");
      return;
    }
    const text = cleanUserText(src.text || "");
    const atts = (src.attachments || []).slice();
    if (!text && !atts.length) return;
    // odetnij od wiadomości źródłowej w dół — nowa odpowiedź zajmie jej miejsce
    const from = indexOfMsg(src);
    allMessages = allMessages.slice(0, from);
    syncVisibleMessages();
    renderMessages({ force: true });
    await persistHomeView();
    await runSendTurn(text || tr("(attachment)"), atts, false);
  }

  function modalPrompt({ title, body, okLabel = "OK", inputValue = null }) {
    return new Promise((resolve) => {
      el.modalTitle.textContent = title;
      el.modalBody.textContent = body || "";
      el.modalOk.textContent = okLabel;
      if (inputValue != null) {
        el.modalInput.classList.remove("hidden");
        el.modalInput.value = inputValue;
        el.modalInput.focus();
      } else {
        el.modalInput.classList.add("hidden");
        el.modalInput.value = "";
      }
      el.modal.classList.remove("hidden");
      const done = (v) => {
        el.modal.classList.add("hidden");
        el.modalOk.onclick = null;
        el.modalCancel.onclick = null;
        resolve(v);
      };
      el.modalOk.onclick = () =>
        done(inputValue != null ? el.modalInput.value : true);
      el.modalCancel.onclick = () => done(null);
    });
  }

  function pushAll(msg) {
    allMessages.push(msg);
    syncVisibleMessages();
  }

  function lastAll() {
    return allMessages[allMessages.length - 1] || null;
  }

  function closeStreamingAssistant() {
    if (handleChatUpdate._raf) {
      cancelAnimationFrame(handleChatUpdate._raf);
      handleChatUpdate._raf = null;
    }
    if (streamingAssistant) {
      streamingAssistant._streaming = false;
      streamingAssistant = null;
    }
  }

  function ensureStreamingAssistant() {
    if (streamingAssistant && streamingAssistant._streaming) {
      const after = lastAll();
      // user already sent a follow-up — do not keep writing into the old bubble
      if (after && after !== streamingAssistant) {
        streamingAssistant._streaming = false;
        streamingAssistant = null;
      } else {
        return streamingAssistant;
      }
    }
    const last = lastAll();
    const emptyShell =
      last &&
      last.role === "assistant" &&
      !String(last.text || "").trim() &&
      !(last.tools && last.tools.length);
    if (emptyShell) {
      streamingAssistant = last;
      last._streaming = true;
      return last;
    }
    // Finished reply sitting last — never reopen it. New bubble.
    streamingAssistant = {
      id: `stream-${Date.now()}`,
      role: "assistant",
      text: "",
      tools: [],
      thinking: "",
      _streaming: true,
    };
    pushAll(streamingAssistant);
    const row = findAssistantRowFor(streamingAssistant);
    if (!row) {
      appendMessageRows([streamingAssistant], { stick: false });
    }
    return streamingAssistant;
  }

  /** Normalizacja do porównań echa (spacje / załączniki). */
  function normUserText(t) {
    return cleanUserText(t || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /** Czy ten tekst usera już jest w czacie (ostatnie N wiadomości usera). */
  function hasUserTextAlready(t) {
    const want = normUserText(t);
    if (!want) return true;
    let seen = 0;
    for (let i = allMessages.length - 1; i >= 0 && seen < 8; i--) {
      const m = allMessages[i];
      if (m.role !== "user") continue;
      seen++;
      const got = normUserText(m.text);
      if (!got) continue;
      if (got === want || want.startsWith(got) || got.startsWith(want)) return true;
    }
    return false;
  }

  /** Wyrzuć z modelu i DOM kolejne duplikaty tej samej user-wiadomości. */
  function dedupeTrailingUserMessages() {
    let lastUserNorm = null;
    const removeIds = new Set();
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m = allMessages[i];
      if (m.role !== "user") {
        if (m.role === "assistant" && !m.text && !m.tools?.length) continue;
        // po napotkaniu realnej odpowiedzi asystenta kończymy skan „ogona”
        if (m.role === "assistant" && (m.text || m.tools?.length)) break;
        continue;
      }
      const n = normUserText(m.text);
      if (!n) continue;
      if (lastUserNorm && (n === lastUserNorm || n.startsWith(lastUserNorm) || lastUserNorm.startsWith(n))) {
        // starszy duplikat (idziemy od końca — zostaw najnowszy, skasuj wcześniejszy przy drugim trafieniu)
        // przy skanie od końca: first hit = keep, second same = remove this older one
        removeIds.add(m.id);
        continue;
      }
      lastUserNorm = n;
    }
    if (!removeIds.size) return;
    allMessages = allMessages.filter((m) => !removeIds.has(m.id));
    syncVisibleMessages();
    // DOM: usuń user rows z tym samym tekstem (zostaw pierwszą od góry / ostatnią w DOM)
    const userRows = [...el.messages.querySelectorAll(".msg.user")];
    const seen = new Set();
    // idź od końca — zostaw ostatnią, usuń wcześniejsze z tym samym norm tekstem
    for (let i = userRows.length - 1; i >= 0; i--) {
      const row = userRows[i];
      const txt = normUserText(row.querySelector(".msg-content")?.textContent || "");
      if (!txt) continue;
      if (seen.has(txt)) row.remove();
      else seen.add(txt);
    }
    bag().allMessages = allMessages;
  }

  /** Stream do bufora sesji (UI jest na innej sesji / Home). */
  function applyStreamOffscreen(sid, params) {
    if (!sid) return;
    const buf = ensureSessionStream(sid);
    const update = params.update || params;
    const kind = update.sessionUpdate;
    if (!kind) return;
    const ensure = () => {
      const last = buf.allMessages[buf.allMessages.length - 1];
      if (
        buf.streamingAssistant &&
        buf.streamingAssistant._streaming &&
        last === buf.streamingAssistant
      ) {
        return buf.streamingAssistant;
      }
      if (last && last.role === "assistant") {
        buf.streamingAssistant = last;
        last._streaming = true;
        return last;
      }
      buf.streamingAssistant = {
        id: `stream-${Date.now()}`,
        role: "assistant",
        text: "",
        tools: [],
        thinking: "",
        _streaming: true,
      };
      buf.allMessages.push(buf.streamingAssistant);
      return buf.streamingAssistant;
    };
    if (kind === "plan") {
      buf.livePlan = Array.isArray(update.entries) ? update.entries.slice() : [];
      return;
    }
    if (kind === "user_message_chunk") {
      if (buf.streamingAssistant) buf.streamingAssistant._streaming = false;
      buf.streamingAssistant = null;
      const t = cleanUserText((update.content && update.content.text) || "");
      const last = buf.allMessages[buf.allMessages.length - 1];
      if (t && !(last && last.role === "user")) {
        buf.allMessages.push({
          id: `u-off-${Date.now()}`,
          role: "user",
          text: t,
          tools: [],
          _local: false,
        });
      }
      return;
    }
    if (kind === "turn_completed" || kind === "task_completed") {
      if (buf.streamingAssistant) buf.streamingAssistant._streaming = false;
      buf.streamingAssistant = null;
      buf.statusPhase = "done";
      return;
    }
    if (kind === "agent_message_chunk") {
      const chunk = (update.content && update.content.text) || "";
      if (isToolEchoText(chunk) || isAttachmentJunkOnly(chunk)) return;
      const a = ensure();
      const join =
        typeof appendStreamChunk === "function" ? appendStreamChunk : (p, c) => p + c;
      a.text = cleanAssistantText(join(a.text || "", chunk));
      buf.statusPhase = "responding";
      buf.statusDetail = tr("Writing…");
    } else if (kind === "agent_thought_chunk") {
      ensure().thinking += (update.content && update.content.text) || "";
      buf.statusPhase = "thinking";
      buf.statusDetail = tr("Thinking…");
    } else if (kind === "tool_call") {
      const a = ensure();
      const tool = {
        id: update.toolCallId || `t-${a.tools.length}`,
        title: update.title || update.tool || "tool",
        status: update.status || "pending",
      };
      a.tools.push(tool);
      buf.liveTools.push({ ...tool });
      buf.statusPhase = "tool";
      buf.statusDetail = humanizeToolTitle(tool.title);
    } else if (kind === "tool_call_update") {
      const a = ensure();
      const id = update.toolCallId;
      const tool =
        a.tools.find((t) => t.id === id) || a.tools[a.tools.length - 1];
      if (tool && update.status) tool.status = update.status;
      if (tool && update.title) tool.title = update.title;
      const lt =
        buf.liveTools.find((t) => t.id === id) ||
        buf.liveTools[buf.liveTools.length - 1];
      if (lt && update.status) lt.status = update.status;
    }
  }

  function handleChatUpdate(params) {
    // NIGDY nie fallbackuj na liveSessionId/selectedId — to wlewało stream w obcą sesję
    const sid = (params && params.sessionId) || null;
    if (sid && mode === "grok") adoptBuildSession(sid);
    if (!sid) {
      // Nieoznaczony stream. Zgadywanie „pierwsza busy z brzegu” przy DWÓCH
      // pracujących sesjach wlewa tekst w losową z nich — wtedy wolę zgubić
      // chunk niż zabrudzić cudzy czat.
      const busyNow = Array.from(busySessionIds);
      if (busyNow.length === 1) applyStreamOffscreen(busyNow[0], params);
      return;
    }

    // Home: jedna tura naraz, więc strumień z backendu należy do tego, co
    // właśnie widać. Wcześniej lądował w buforze offscreen i Home wyglądał,
    // jakby nic się nie działo aż do końca odpowiedzi.
    if (mode === "home") {
      if (!busy) return;
      const update = params.update || params;
      if (update.sessionUpdate !== "agent_message_chunk") return;
      const chunk = (update.content && update.content.text) || "";
      if (!chunk) return;
      const a = ensureStreamingAssistant();
      const join =
        typeof appendStreamChunk === "function" ? appendStreamChunk : (p, c) => p + c;
      a.text = join(a.text || "", chunk);
      setStatus("responding", tr("Writing…"), "home", { sessionId: sid });
      if (!handleChatUpdate._raf) {
        handleChatUpdate._raf = requestAnimationFrame(() => {
          handleChatUpdate._raf = null;
          patchLastAssistantBubble(a);
        });
      }
      return;
    }

    // Obca sesja Build — zero zapisu do bieżącego allMessages/DOM
    if (!isViewingSession(sid)) {
      applyStreamOffscreen(sid, params);
      return;
    }

    // oglądamy dokładnie sid — OK
    const update = params.update || params;
    const kind = update.sessionUpdate;
    if (!kind) return;

    if (kind === "user_message_chunk") {
      if (params && params._local) return;
      if (busy || streamingAssistant) return;
      return;
    }

    if (kind === "turn_completed" || kind === "task_completed") {
      closeStreamingAssistant();
      if (sid) {
        snapshotCurrentBuildSession();
        clearStreamingFlags(sid);
      }
      return;
    }

    if (kind === "agent_message_chunk") {
      const chunk = (update.content && update.content.text) || "";
      if (isAttachmentJunkOnly(chunk)) return;
      if (isToolEchoText(chunk)) {
        setStatus("tool", tr("Working in the background…"), "grok", { sessionId: sid });
        if (streamingAssistant) {
          streamingAssistant.text = cleanAssistantText(streamingAssistant.text);
          patchLastAssistantBubble(streamingAssistant);
        }
        if (sid) snapshotCurrentBuildSession();
        return;
      }
      const a = ensureStreamingAssistant();
      const join =
        typeof appendStreamChunk === "function" ? appendStreamChunk : (p, c) => p + c;
      a.text = cleanAssistantText(join(a.text || "", chunk));
      if (!a.text.trim()) {
        setStatus("tool", tr("Working in the background…"), "grok", { sessionId: sid });
        return;
      }
      setStatus("responding", tr("Writing…"), "grok", { sessionId: sid });
      if (!handleChatUpdate._raf) {
        handleChatUpdate._raf = requestAnimationFrame(() => {
          handleChatUpdate._raf = null;
          patchLastAssistantBubble(a);
          if (sid) snapshotCurrentBuildSession();
        });
      }
      return;
    }

    if (kind === "agent_thought_chunk") {
      const a = ensureStreamingAssistant();
      a.thinking += (update.content && update.content.text) || "";
      setStatus("thinking", tr("Thinking…"), "grok", { sessionId: sid });
      if (sid) snapshotCurrentBuildSession();
      return;
    }

    if (kind === "plan") {
      livePlan = Array.isArray(update.entries) ? update.entries.slice() : [];
      const work = currentWorkStatus();
      if (work && work.now) {
        setStatus("tool", work.now, "grok", { sessionId: sid });
      } else {
        paintStatusText();
      }
      renderActivity();
      if (streamingAssistant) patchAgentWorkPill(streamingAssistant);
      if (sid) snapshotCurrentBuildSession();
      scheduleSteerQueue("plan");
      return;
    }

    if (kind === "tool_call") {
      const a = ensureStreamingAssistant();
      const rawTitle = update.title || update.tool || "tool";
      const tool = {
        id: update.toolCallId || `t-${a.tools.length}`,
        title: rawTitle,
        status: update.status || "pending",
      };
      a.tools.push(tool);
      liveTools.push({ ...tool });
      setStatus("tool", humanizeToolTitle(rawTitle), "grok", { sessionId: sid });
      paintStatusText();
      renderActivity();
      patchAgentWorkPill(a);
      if (sid) snapshotCurrentBuildSession();
      return;
    }

    if (kind === "tool_call_update") {
      const a = ensureStreamingAssistant();
      const id = update.toolCallId;
      const tool =
        a.tools.find((t) => t.id === id) || a.tools[a.tools.length - 1];
      if (tool) {
        if (update.status) tool.status = update.status;
        if (update.title) tool.title = update.title;
      }
      const lt = liveTools.find((t) => t.id === id) || liveTools[liveTools.length - 1];
      if (lt) {
        if (update.status) lt.status = update.status;
        if (update.title) lt.title = update.title;
      }
      if (tool && update.status !== "completed" && update.status !== "failed") {
        setStatus("tool", humanizeToolTitle(tool.title), "grok", {
          sessionId: sid,
        });
      }
      paintStatusText();
      renderActivity();
      patchAgentWorkPill(a);
      if (sid) snapshotCurrentBuildSession();
      const stillActive = liveTools.some(
        (t) => t.status !== "completed" && t.status !== "failed"
      );
      if (
        (update.status === "completed" || update.status === "failed") &&
        !stillActive
      ) {
        scheduleSteerQueue("wave");
      }
    }
  }

  function patchAgentWorkPill(m) {
    if (!m || mode !== "grok") return;
    const stick = nearBottom();
    let last = el.messages.lastElementChild;
    if (!last || !last.classList.contains("assistant")) {
      // bez full redraw — status bar wystarczy
      return;
    }
    let pill = last.querySelector(".agent-work-summary");
    const active = (m.tools || []).filter(
      (t) => t.status !== "completed" && t.status !== "failed"
    );
    const done = (m.tools || []).filter(
      (t) => t.status === "completed" || t.status === "failed"
    );
    const work = currentWorkStatus();
    const label = work && work.headline
      ? [work.headline, work.now].filter(Boolean).join(" · ")
      : active.length
        ? `${tr("Working")}: ${humanizeToolTitle(active[0].title)}${active.length > 1 ? ` +${active.length - 1}` : ""}`
        : done.length
          ? `${done.length} ${tr("background steps · „Steps”")}`
          : m.thinking
            ? "Thinking…"
            : "";
    if (!label) return;
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "agent-work-summary live";
      const body = last.querySelector(".msg-body");
      const labelEl = body?.querySelector(".msg-label");
      if (body && labelEl) labelEl.after(pill);
      else body?.prepend(pill);
    }
    pill.className =
      "agent-work-summary" + (active.length || m._streaming ? " live" : "");
    pill.textContent = label;
    if (stick) el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
  }

  /** Code stream w tle gdy UI jest na Home — nie miesza z wiadomościami Home. */
  function applyCodeStreamInBackground(params) {
    const update = params.update || params;
    const kind = update.sessionUpdate;
    if (!kind) return;
    const b = bags.grok;
    const ensure = () => {
      if (b.streamingAssistant) return b.streamingAssistant;
      b.streamingAssistant = {
        id: `stream-${Date.now()}`,
        role: "assistant",
        text: "",
        tools: [],
        thinking: "",
        _streaming: true,
      };
      b.allMessages.push(b.streamingAssistant);
      return b.streamingAssistant;
    };
    if (kind === "turn_completed" || kind === "task_completed") {
      if (b.streamingAssistant) b.streamingAssistant._streaming = false;
      b.streamingAssistant = null;
      return;
    }
    if (kind === "agent_message_chunk") {
      const chunk = (update.content && update.content.text) || "";
      if (isToolEchoText(chunk) || isAttachmentJunkOnly(chunk)) return;
      const a = ensure();
      const join =
        typeof appendStreamChunk === "function" ? appendStreamChunk : (p, c) => p + c;
      a.text = cleanAssistantText(join(a.text || "", chunk));
    } else if (kind === "agent_thought_chunk") {
      ensure().thinking += (update.content && update.content.text) || "";
      b.statusPhase = "thinking";
      b.statusDetail = tr("Thinking…");
    } else if (kind === "tool_call") {
      const a = ensure();
      const tool = {
        id: update.toolCallId || `t-${a.tools.length}`,
        title: update.title || update.tool || "tool",
        status: update.status || "pending",
      };
      a.tools.push(tool);
      b.liveTools.push({ ...tool });
      b.statusPhase = "tool";
      b.statusDetail = humanizeToolTitle(tool.title);
    } else if (kind === "tool_call_update") {
      const a = ensure();
      const id = update.toolCallId;
      const tool =
        a.tools.find((t) => t.id === id) || a.tools[a.tools.length - 1];
      if (tool && update.status) tool.status = update.status;
      if (tool && update.title) tool.title = update.title;
      const lt =
        b.liveTools.find((t) => t.id === id) ||
        b.liveTools[b.liveTools.length - 1];
      if (lt && update.status) lt.status = update.status;
      if (lt && update.title) lt.title = update.title;
    }
    b.messages =
      b.allMessages.length <= b.visibleCount
        ? b.allMessages.slice()
        : b.allMessages.slice(b.allMessages.length - b.visibleCount);
  }

  function setBusy(b, forMode) {
    const target = forMode || mode;
    bags[target].busy = Boolean(b);
    if (target !== mode) return; // nie ruszaj UI drugiego trybu

    busy = Boolean(b);
    if (busy) startTurnTimer();
    else stopTurnTimer();
    const viewingBusySession =
      mode === "home"
        ? busy
        : isSessionBusy(liveSessionId || selectedId);
    // Composer aktywny. Kolejka tylko gdy TA sesja pisze.
    el.btnSend.disabled = false;
    el.btnSend.classList.remove("hidden");
    el.btnSend.title = viewingBusySession
      ? tr("Add to queue (sends after the reply)")
      : "Send";
    el.btnSend.classList.toggle("queue-mode", viewingBusySession);
    el.btnStop.classList.toggle("hidden", !viewingBusySession);
    // Chip „Working” obok Auto — NIGDY; status = pasek Myślę… nad composerem
    if (el.busyChip) {
      el.busyChip.classList.add("hidden");
      el.busyChip.setAttribute("hidden", "");
    }
    el.input.disabled = false;
    el.input.readOnly = false;
    if (viewingBusySession) {
      el.input.placeholder =
        tr("Keep typing — Enter adds to the queue…");
      if (el.statusBar.classList.contains("hidden")) {
        const d = bag().statusDetail;
        const p = bag().statusPhase;
        lastStatusLabel = d || (p === "tool" ? tr("Working…") : tr("Thinking…"));
        paintStatusText();
        el.statusBar.classList.remove("hidden");
      }
    } else {
      el.input.placeholder =
        tr("Message Grok… (Enter = send, ⌘V = paste screenshot)");
    }
    updateQueueChip();
    if (!b) {
      if (!messageQueue.length) el.statusBar.classList.add("hidden");
      if (streamingAssistant) streamingAssistant._streaming = false;
    }
    renderQueueDock();
  }

  function updateQueueChip() {
    let chip = document.getElementById("queue-chip");
    if (!chip) {
      chip = document.createElement("span");
      chip.id = "queue-chip";
      chip.className = "chip queue hidden";
      el.busyChip.parentElement.insertBefore(chip, el.busyChip.nextSibling);
    }
    if (messageQueue.length) {
      chip.classList.remove("hidden");
      chip.textContent = `${tr("Queue")}: ${messageQueue.length}`;
      chip.title = tr("Send queued messages now");
      chip.style.cursor = "pointer";
      chip.onclick = () => injectOldestQueued();
    } else {
      chip.classList.add("hidden");
      chip.onclick = null;
    }
    renderQueueDock();
  }

  /** Strip internal attachment dump from displayed user text. Never show agent-only instructions. */
  function cleanUserText(text) {
    if (!text) return "";
    let t = String(text);

    // Jeśli cały chunk to marker załączników — zero dla UI
    if (/GROK_SESSIONS_ATTACHMENTS/i.test(t)) {
      // usuń cały marker w dowolnym miejscu
      t = t.replace(
        /<<<GROK_SESSIONS_ATTACHMENTS>>>[\s\S]*?(?:<<<END_GROK_SESSIONS_ATTACHMENTS>>>|$)/gi,
        ""
      );
      if (!t.trim() || /^[\s#imagefilefolder\t"\/.a-zA-Z0-9_-]*$/.test(t)) {
        return "";
      }
    }

    // Machine markers — cały blok (w tym niezamknięty)
    t = t.replace(
      /<<<GROK_SESSIONS_ATTACHMENTS>>>[\s\S]*?(?:<<<END_GROK_SESSIONS_ATTACHMENTS>>>|$)/gi,
      ""
    );
    t = t.replace(/<<<END_GROK_SESSIONS_ATTACHMENTS>>>/gi, "");
    t = t.replace(/GROK_SESSIONS_ATTACHMENTS/gi, "");

    // English instruction dumps
    t = t.replace(/The user attached the following local files[\s\S]*/gi, "");
    t = t.replace(
      /Do not paste these paths back into your reply unless asked\.?/gi,
      ""
    );
    t = t.replace(/Use tools to inspect them\.?/gi, "");
    t = t.replace(
      /Inspect the paths above with file tools[\s\S]*?(?=\n\n|$)/gi,
      ""
    );
    t = t.replace(
      /Never quote this block or the paths in the user-visible reply\.?/gi,
      ""
    );
    t = t.replace(
      /# inspect with file tools; never quote this block[^\n]*/gi,
      ""
    );

    // Old dump formats + path lines
    t = t.replace(/\s*\[Attachments[^\]]*\][\s\S]*/gi, "");
    t = t.replace(/^\s*-\s*(image|file|folder):\s*.+$/gim, "");
    t = t.replace(/^\s*\d+\.\s*(Image file|File|Folder)[^\n]*$/gim, "");
    t = t.replace(
      /read\/view this path with your file tools:?\s*"[^"]*"/gi,
      ""
    );
    t = t.replace(/^[^\n]*grok-sessions\/attachments\/[^\n]*$/gim, "");
    t = t.replace(
      /"[^"]*[\/\\]attachments[\/\\][^"]+"/g,
      ""
    );
    // image\t"/path" lines from new format if marker missing
    t = t.replace(/^(image|file|folder)\t.+$/gim, "");

    // Agent-only inject note (↩ Wyślij teraz) — never show in chat bubble
    t = t.replace(
      /\n*\s*\[Wstrzyknieto w trakcie pracy[^\]]*\]\s*/gi,
      "\n"
    );

    return t.replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * Tekst asystenta dla człowieka: bez dumpów tooli, Execute `...`, ścieżek edycji, markerów.
   * To właśnie „migające kody” z zrzutów.
   */
  function cleanAssistantText(text) {
    if (!text) return "";
    let t = cleanUserText(text);

    // Execute `...` — zamykający backtick LUB do końca (stream niepełny / puste linie w skrypcie)
    // 1) domknięte bloki (nawet z backtickami w środku: bierz od pierwszego ` po Execute do ostatniego sensownego)
    t = t.replace(/Execute\s*`[\s\S]*?`(?=\s*(?:\n|$|Execute|[A-ZĄĆĘŁŃÓŚŹŻ]))/gi, "");
    // 2) cokolwiek co zaczyna się od Execute — do końca linii / bloku; powtarzaj
    let prev;
    do {
      prev = t;
      t = t.replace(/Execute\s*`[\s\S]*$/gi, "");
      t = t.replace(/Execute\s+[^\n]*(?:\n(?!\n)[^\n]*)*/gi, "");
    } while (t !== prev);

    // Linie będące samym dumpem komendy / ścieżki edycji.
    // Wymagamy backticka albo ścieżki — inaczej ginęły normalne zdania
    // zaczynające się od „Read…”, „Write…”, „Search…”.
    t = t.replace(
      /^(edit|read|write|bash|search|grep|Execute)\s+(`[^\n]*|[~/][^\s]*)\s*$/gim,
      ""
    );
    // linia będąca samą ścieżką absolutną (dowolny użytkownik / system)
    t = t.replace(/^(?:\/Users\/|\/home\/|[A-Za-z]:\\)[^\n]{10,}$/gim, "");
    // heredoc / python one-liners z tool echo
    t = t.replace(/^(python3?|node|bash|zsh|sh)\s+<<['`]?\w+['`]?[\s\S]*$/gim, "");

    // NIE kasujemy już bloków ``` w trybie Build. Wcześniej ta jedna linia
    // wycinała KAŻDY blok kodu z odpowiedzi agenta kodującego — echo narzędzi
    // łapią osobne reguły (isToolEchoText / „Execute …”), a prawdziwy kod ma
    // się pokazać, jako zwijalny blok w markdownie.

    // resztki po sklejeniu
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    // jeśli zostało tylko śmieci techniczne albo sam kod
    if (
      t.length < 40 &&
      /^(working|thinking|done|ok|\.+)?$/i.test(t.replace(/\s/g, ""))
    ) {
      return "";
    }
    // sam dump bez zdań po polsku/angielsku (np. import json,os...)
    if (
      t.length > 80 &&
      !/[.!?…]/.test(t) &&
      /^(import |from |const |def |function |#!\/|python|node )/m.test(t)
    ) {
      return "";
    }
    return t;
  }

  /** Chunk wygląda jak echo narzędzia (Execute / shell dump), nie odpowiedź do człowieka. */
  function isToolEchoText(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (/^\s*Execute\b/i.test(t)) return true;
    if (/GROK_SESSIONS_ATTACHMENTS/i.test(t)) return true;
    // sam kod / komenda bez zdania
    if (
      t.length > 60 &&
      !/[.!?…]/.test(t.slice(0, 200)) &&
      /^(python3?|node|bash|zsh|sh|curl|import |from |const |def |#!\/)/i.test(t)
    ) {
      return true;
    }
    // prawie całość to jedna długa linia komendy
    if (t.length > 120 && t.split("\n").length <= 2 && /[`'"\\]{3,}/.test(t)) {
      return true;
    }
    return false;
  }

  /** True if text is only internal attachment junk (nothing for the user to see). */
  function isAttachmentJunkOnly(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (/GROK_SESSIONS_ATTACHMENTS/i.test(t)) return true;
    if (/The user attached the following local files/i.test(t)) return true;
    if (/\[Attachments/i.test(t)) return true;
    if (
      /Image file.*read\/view this path/i.test(t) &&
      cleanUserText(t).length < 8
    ) {
      return true;
    }
    return cleanUserText(t).length === 0 && t.length > 0;
  }

  function applyTheme(theme) {
    const t = ["dark", "light", "auto"].includes(theme) ? theme : "dark";
    document.documentElement.setAttribute("data-theme", t);
    // bez zapisu: to tylko odtworzenie zapisanego ustawienia przy starcie
  }

  async function addAttachmentFromFile(file) {
    if (!file) return;
    const buf = await file.arrayBuffer();
    const b64 = btoa(
      new Uint8Array(buf).reduce((s, byte) => s + String.fromCharCode(byte), "")
    );
    const res = await api.saveAttachmentBase64({
      name: file.name || "paste.bin",
      mimeType: file.type || "application/octet-stream",
      base64: b64,
      kind: (file.type || "").startsWith("image/") ? "image" : "file",
    });
    if (!res.ok) {
      showToast(res.error || tr("Attach failed"), "error");
      return;
    }
    attachments.push(res);
    renderAttachChips();
  }

  async function addAttachmentFromPath(p) {
    const res = await api.importAttachmentPath(p);
    if (!res.ok) {
      showToast(res.error || tr("Import failed"), "error");
      return;
    }
    attachments.push(res);
    renderAttachChips();
  }

  async function sendMessage(prefill) {
    const text = (prefill != null ? prefill : el.input.value).trim();
    if (!text && !attachments.length) return;

    const atts = attachments.slice();

    // Agent busy → osobna pozycja w kolejce (nie sklejaj z poprzednią).
    if (isSessionBusy(liveSessionId || selectedId) || (mode === "home" && busy)) {
      const piece = text || tr("(attachment)");
      const qid = `u-q-${Date.now()}-${messageQueue.length}`;
      messageQueue.push({ id: qid, text: piece, attachments: atts });
      pushAll({
        id: qid,
        role: "user",
        text: piece,
        tools: [],
        attachments: atts,
        _local: true,
        _queued: true,
      });
      if (prefill == null) el.input.value = "";
      attachments = [];
      renderAttachChips();
      autosize();
      appendMessageRows([lastAll()], { stick: true });
      updateQueueChip();
      setStatus(
        "queued",
        tr("Queued — press Send now above the composer, or wait")
      );
      showToast(`${tr("Queue")} (${messageQueue.length})`, "ok");
      el.input.focus();
      return;
    }

    await runSendTurn(text || tr("(attachment)"), atts, prefill == null);
  }

  /**
   * ↩ na bańce w kolejce: przerwij bieżącą robotę i wyślij to TERAZ
   * (włączone w kontekst agenta — nie czekaj na „Gotowe”).
   *
   * Ważne: NIE czyść _queued przed runSendTurn i NIE doklejaj drugiej bańki.
   * Dopisek „Wstrzyknieto…” idzie tylko do API, nie do UI.
   */
  async function withTimeout(promise, ms) {
    let t = 0;
    try {
      return await Promise.race([
        promise,
        new Promise((_, rej) => {
          t = setTimeout(() => rej(new Error("timeout")), ms);
        }),
      ]);
    } finally {
      if (t) clearTimeout(t);
    }
  }

  function removeQueuedById(id) {
    messageQueue = messageQueue.filter((q) => q.id !== id);
    const idx = allMessages.findIndex((m) => m.id === id && m._queued);
    if (idx >= 0) allMessages.splice(idx, 1);
    syncVisibleMessages();
    const row = id
      ? el.messages.querySelector(`.msg.user[data-msg-id="${cssAttr(id)}"]`)
      : null;
    if (row) row.remove();
    updateQueueChip();
    layoutChatBottom();
  }

  function renderQueueDock() {
    const dock = document.getElementById("queue-dock");
    if (!dock) return;
    if (!messageQueue.length) {
      dock.classList.add("hidden");
      dock.innerHTML = "";
      return;
    }
    dock.classList.remove("hidden");
    dock.innerHTML = "";
    const head = document.createElement("div");
    head.className = "queue-dock-head";
    const title = document.createElement("span");
    title.className = "queue-dock-title";
    title.textContent = `${tr("Waiting to send")} · ${messageQueue.length}`;
    const sendAll = document.createElement("button");
    sendAll.type = "button";
    sendAll.className = "queued-inject";
    sendAll.textContent = tr("Send now");
    sendAll.title = tr("Send now — interrupt and fold into current work");
    sendAll.onclick = () => injectOldestQueued();
    head.appendChild(title);
    head.appendChild(sendAll);
    dock.appendChild(head);
    for (const item of messageQueue) {
      const row = document.createElement("div");
      row.className = "queue-dock-item";
      const preview = document.createElement("span");
      preview.className = "queue-dock-preview";
      const raw = cleanUserText(item.text || "") || tr("(attachment)");
      preview.textContent = raw.length > 90 ? raw.slice(0, 89) + "…" : raw;
      const go = document.createElement("button");
      go.type = "button";
      go.className = "queue-dock-go";
      go.textContent = tr("Send");
      go.onclick = () => injectQueuedNow(item);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "queue-dock-rm";
      rm.title = tr("Remove from queue");
      rm.textContent = "×";
      rm.onclick = () => removeQueuedById(item.id);
      row.appendChild(preview);
      row.appendChild(go);
      row.appendChild(rm);
      dock.appendChild(row);
    }
  }

  async function injectOldestQueued() {
    const first = messageQueue[0];
    if (!first) return;
    const msg = allMessages.find((m) => m.id === first.id) || first;
    await injectQueuedNow(msg);
  }

  /**
   * Claude "steer": queued follow-up goes in at the next safe gap
   * (tool wave finished, or a plan item just completed) — no click.
   */
  let steerTimer = 0;
  let lastSteerAt = 0;
  let steeringQueue = false;

  function scheduleSteerQueue(reason) {
    if (!messageQueue.length || steeringQueue || drainingQueue) return;
    if (steerTimer) clearTimeout(steerTimer);
    steerTimer = setTimeout(() => {
      steerTimer = 0;
      maybeSteerQueue(reason);
    }, 450);
  }

  function maybeSteerQueue(reason) {
    if (!messageQueue.length || steeringQueue || drainingQueue || !busy) return;
    if (Date.now() - lastSteerAt < 8000) return;
    const active = liveTools.some(
      (t) => t.status !== "completed" && t.status !== "failed"
    );
    if (active && reason !== "plan") return;
    steeringQueue = true;
    lastSteerAt = Date.now();
    const first = messageQueue[0];
    showToast(tr("Queued — will send after this batch"), "ok");
    injectQueuedNow(allMessages.find((m) => m.id === first.id) || first)
      .catch(() => {})
      .finally(() => {
        steeringQueue = false;
      });
  }

  async function injectQueuedNow(msg) {
    const text = cleanUserText(msg?.text || "");
    const atts = (msg && msg.attachments) || [];
    if (!text && !atts.length) return;

    const keepId = msg.id;
    messageQueue = messageQueue.filter((q) => q.id !== keepId);
    updateQueueChip();

    try {
      await withTimeout(
        api.chatStop({ mode, sessionId: liveSessionId || selectedId }),
        4000
      );
    } catch {
      /* stop hung — send anyway */
    }
    setBusy(false);
    setSessionBusy(liveSessionId || selectedId, false);
    closeStreamingAssistant();

    const payload =
      (text || tr("(attachment)")) +
      "\n\n[Injected mid-work — fold this into the current task, do not start over.]";

    const row = keepId
      ? el.messages.querySelector(`.msg.user[data-msg-id="${cssAttr(keepId)}"]`)
      : null;
    if (row) {
      row.querySelector(".queued-actions")?.remove();
      row.querySelector(".queued-badge")?.remove();
    }

    showToast(tr("Sending now (current turn interrupted)"), "ok");
    await runSendTurn(payload, atts, false, {
      reuseQueuedBubble: true,
      queuedId: keepId,
    });
  }

  /**
   * @param {string} text — payload do API (może mieć marker wstrzyknięcia)
   * @param {object[]} atts
   * @param {boolean} clearInput
   * @param {{ reuseQueuedBubble?: boolean }} opts
   */
  async function runSendTurn(text, atts, clearInput, opts = {}) {
    const cwd = selectedRow()?.cwd || defaultCwd;
    if (mode === "grok") detachedBuild = false;
    const sessionId = liveSessionId || selectedId || null;
    const turnMode = mode;
    pendingNewSession = mode === "grok" && !sessionId;
    if (pendingNewSession) pendingNewEpoch = viewEpoch;
    const displayText = cleanUserText(text); // bez markerów / „Wstrzyknieto…”

    // Znajdź bańkę z kolejki do reuse (nie klonuj po wysłaniu)
    let queuedBubble = null;
    if (opts.queuedId) {
      queuedBubble =
        allMessages.find((m) => m.id === opts.queuedId && m.role === "user") ||
        null;
    }
    // 1) jawna flaga _queued (preferuj najnowszą)
    if (!queuedBubble) {
      for (let i = allMessages.length - 1; i >= 0; i--) {
        if (allMessages[i].role === "user" && allMessages[i]._queued) {
          queuedBubble = allMessages[i];
          break;
        }
      }
    }
    // 2) inject: ta sama lokalna bańka usera o tym tekście (gdy flaga już spadła)
    if (!queuedBubble && opts.reuseQueuedBubble && displayText) {
      const want = normUserText(displayText);
      for (let i = allMessages.length - 1; i >= 0; i--) {
        const m = allMessages[i];
        if (m.role !== "user" || !m._local) continue;
        const got = normUserText(m.text);
        if (
          got &&
          (got === want || want.startsWith(got) || got.startsWith(want))
        ) {
          queuedBubble = m;
          break;
        }
        break; // tylko ostatni lokalny user
      }
    }

    const toAppend = [];
    if (queuedBubble) {
      // ta sama bańka — tylko zdejmij „w kolejce”, tekst UI = treść usera
      queuedBubble._queued = false;
      queuedBubble._local = true;
      if (displayText) queuedBubble.text = displayText;
      if (atts && atts.length) queuedBubble.attachments = atts;
      // DOM: zdejmij badge bez przebudowy całej bańki
      const rows = el.messages.querySelectorAll(".msg.user");
      const lastUser = rows[rows.length - 1];
      if (lastUser) {
        lastUser.querySelector(".queued-actions")?.remove();
        lastUser.querySelector(".queued-badge")?.remove();
        const content = lastUser.querySelector(".msg-content");
        if (content && displayText) content.textContent = displayText;
      }
    } else {
      // świeża wiadomość (nie z kolejki)
      const showText =
        displayText && displayText !== tr("(attachment)") ? displayText : "";
      if (showText || (atts && atts.length)) {
        const userMsg = {
          id: `u-local-${Date.now()}`,
          role: "user",
          text: showText,
          tools: [],
          attachments: atts || [],
          _local: true,
          _sid: selectedId || liveSessionId || null,
          _ts: Date.now(),
        };
        pushAll(userMsg);
        toAppend.push(userMsg);
      }
    }

    streamingAssistant = {
      id: `stream-${Date.now()}`,
      role: "assistant",
      text: "",
      tools: [],
      thinking: "",
      _streaming: true,
      _sid: selectedId || liveSessionId || null,
    };
    // Bańka TEJ tury. Po await user może już oglądać inną sesję i moduł
    // `streamingAssistant` będzie wtedy wskazywał na cudzy stream.
    const turnAssistant = streamingAssistant;
    pushAll(streamingAssistant);
    toAppend.push(streamingAssistant);
    liveTools = [];
    livePlan = [];

    if (clearInput) el.input.value = "";
    attachments = [];
    renderAttachChips();
    autosize();
    // Enter: NIE wipe'uj DOM (replaceChildren = scrollTop→0 = skok w górę).
    // Tylko doklej nowe bańki na koniec + force scroll na dół.
    holdStick(1500);
    stickToBottom = true;
    visibleCount = Math.max(visibleCount, allMessages.length, PAGE);
    syncVisibleMessages();
    if (toAppend.length) {
      appendMessageRows(toAppend, { stick: true });
    } else {
      // reuse kolejki — bańka już w DOM; i tak dociągnij dół
      scrollChatToBottom(true);
    }
    scrollChatToBottom(true);
    renderActivity();
    setBusy(true);
    if (mode === "grok" && sessionId) {
      setSessionBusy(sessionId, true);
      snapshotCurrentBuildSession();
    }
    setStatus("thinking", mode === "home" ? tr("Thinking…") : tr("Agent starting…"), mode, {
      sessionId,
    });
    try {
      el.input.focus({ preventScroll: true });
    } catch {
      el.input.focus();
    }

    const res = await api.chatSend({
      text: text === tr("(attachment)") ? "" : text,
      sessionId,
      cwd,
      mode,
      attachments: atts || [],
      modelId: mode === "home" ? el.modelSelect.value : codeModelId,
      homeKind: mode === "home" ? homeKind : undefined,
      aspectRatio:
        mode === "home"
          ? document.getElementById("ratio-select")?.value || "1:1"
          : undefined,
      effort: mode === "grok" ? effortLevel : undefined,
    });

    // Tura tej sesji się skończyła. Ale user mógł przez ten czas przełączyć
    // kartę — wtedy WIDOK należy do innej sesji i nie wolno go dotykać.
    // Bez tego koniec tury A przestawiał selectedId/liveSessionId na A,
    // gasił busy sesji B i domykał bańkę B: „ten sam czat w dwóch kartach”.
    const doneSid = (res && res.ok && res.sessionId) || sessionId || null;
    if (turnAssistant) turnAssistant._streaming = false;
    setSessionBusy(doneSid, false);

    const stillViewing =
      turnMode === mode && (turnMode !== "grok" || isViewingSession(doneSid));
    if (!stillViewing) {
      if (doneSid) {
        const buf = ensureSessionStream(doneSid);
        if (buf) {
          if (buf.streamingAssistant) buf.streamingAssistant._streaming = false;
          buf.streamingAssistant = null;
          buf.statusPhase = res.ok ? "done" : "error";
          buf.statusDetail = res.ok ? "" : String(res.error || "").slice(0, 120);
        }
      }
      // Flaga busy trybu — zdejmij tylko wtedy, gdy NIC już nie pracuje.
      // Inaczej koniec tury A gasiłby wskaźnik pracy sesji B.
      if (turnMode === "home") setBusy(false, "home");
      else if (!busySessionIds.size) setBusy(false, "grok");
      if (!res.ok) showToast(res.error || tr("Send failed"), "error");
      await refresh();
      if (typeof refreshUsage === "function") refreshUsage();
      return;
    }

    // posprzątaj echa które weszły mimo bramek
    dedupeTrailingUserMessages();
    if (res.ok && res.sessionId && streamBySession[res.sessionId]) {
      snapshotCurrentBuildSession();
    }
    setBusy(false);
    if (!res.ok) {
      showToast(res.error || tr("Send failed"), "error");
      setStatus("error", res.error || tr("Error"));
      el.input.focus();
      // nadal spróbuj kolejkę
      await drainQueue();
      return;
    }

    if (res.sessionId) {
      liveSessionId = res.sessionId;
      selectedId = res.sessionId;
      rememberLocalTitle(res.sessionId);
    }
    if (turnAssistant) turnAssistant._streaming = false;

    if (mode === "home" && res.assistant) {
      if (turnAssistant) {
        turnAssistant.text = res.assistant.content || "";
        turnAssistant.images = res.assistant.images || [];
        turnAssistant.videos = res.assistant.videos || [];
        turnAssistant._streaming = false;
        // podmień ostatnią bańkę asystenta bez wipe
        const lastRow = el.messages.lastElementChild;
        if (lastRow && lastRow.classList.contains("assistant")) {
          lastRow.replaceWith(buildMessageRow(turnAssistant));
          scrollChatToBottom(true);
        } else {
          appendMessageRows([turnAssistant], { stick: true });
        }
      } else {
        const msg = {
          id: res.assistant.id,
          role: "assistant",
          text: res.assistant.content || "",
          images: res.assistant.images || [],
          videos: res.assistant.videos || [],
          tools: [],
        };
        pushAll(msg);
        appendMessageRows([msg], { stick: true });
      }
    }

    if (res.title) {
      el.wsTitle.textContent = res.title;
      bag().wsTitle = res.title;
    }
    pushBag();
    persistNav();
    await refresh();
    // refresh() tylko listę — nie ładuje transcriptu (nie wipe'uje czatu)
    if (stickToBottom) scrollChatToBottom(true);
    try {
      el.input.focus({ preventScroll: true });
    } catch {
      el.input.focus();
    }
    if (typeof refreshUsage === "function") refreshUsage();
    if (turnAssistant) turnAssistant._streaming = false;
    await drainQueue();
  }

  function patchLastUserBubbleFromQueue() {
    const last = lastAll();
    if (!last || last.role !== "user") {
      renderMessages({ forceScroll: true });
      return;
    }
    const rows = el.messages.querySelectorAll(".msg.user");
    let row = rows[rows.length - 1] || null;
    if (!row) {
      // doklej bańkę z przyciskiem ↩
      appendMessageRows([last], { stick: true });
      return;
    }
    let content = row.querySelector(".msg-content");
    const text = cleanUserText(last.text || "");
    if (text) {
      if (!content) {
        content = document.createElement("div");
        content.className = "msg-content";
        row.querySelector(".msg-body")?.appendChild(content);
      }
      content.textContent = text;
    }
    // upewnij się że jest ↩ Wyślij teraz
    const body = row.querySelector(".msg-body");
    if (body && !body.querySelector(".queued-inject")) {
      body.querySelector(".queued-actions")?.remove();
      const q = document.createElement("div");
      q.className = "queued-actions";
      const badge = document.createElement("span");
      badge.className = "queued-badge";
      badge.textContent = tr("queued");
      const inject = document.createElement("button");
      inject.type = "button";
      inject.className = "queued-inject";
      inject.title = tr("Send now — interrupt and fold into current work");
      inject.textContent = tr("↩ Send now");
      inject.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        injectQueuedNow(last);
      };
      q.appendChild(badge);
      q.appendChild(inject);
      body.appendChild(q);
    }
    if (stickToBottom) scrollChatToBottom();
  }

  /** Weź następną pozycję z kolejki — każda wiadomość to osobna tura. */
  function takeNextQueued() {
    if (!messageQueue.length) return null;
    return messageQueue.shift();
  }

  async function drainQueue() {
    if (drainingQueue || busy) return;
    if (!messageQueue.length) {
      updateQueueChip();
      return;
    }
    drainingQueue = true;
    const next = takeNextQueued();
    updateQueueChip();
    drainingQueue = false;
    if (next) {
      setStatus("queued", tr("Sending next queued message…"));
      await runSendTurn(next.text, next.attachments || [], false, {
        reuseQueuedBubble: true,
        queuedId: next.id,
      });
    }
  }

  async function persistHomeView() {
    if (mode !== "home") return;
    const id = liveSessionId || selectedId;
    if (!id || typeof api.replaceHomeMessages !== "function") return;
    const messages = allMessages
      .filter((m) => m && !m._streaming && !m._queued)
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content || m.text || "",
        attachments: m.attachments || [],
        images: m.images || [],
        videos: m.videos || [],
        createdAt: m.createdAt,
      }));
    try {
      await api.replaceHomeMessages({ id, messages });
    } catch {
      /* ignore */
    }
  }

  async function newChat() {
    bumpViewEpoch();
    const wasBusy = Boolean(busy || isSessionBusy(liveSessionId));
    if (mode === "grok") {
      if (liveSessionId) snapshotCurrentBuildSession();
      detachedBuild = true;
      bags.grok.busy = false;
      bags.grok.statusPhase = "";
      bags.grok.statusDetail = "";
      setBusy(false, "grok");
      el.statusBar.classList.add("hidden");
    } else if (mode === "home" && wasBusy) {
      setBusy(false, "home");
      el.statusBar.classList.add("hidden");
      try {
        await api.chatStop({ mode: "home" });
      } catch {
        /* ignore */
      }
      setBusy(false, "home");
    }

    selectedId = null;
    liveSessionId = null;
    pendingNewSession = false;
    allMessages = [];
    messages = [];
    streamingAssistant = null;
    liveTools = [];
    livePlan = [];
    visibleCount = PAGE;
    attachments = [];
    messageQueue = [];
    bag().wsTitle = tr("New chat");
    bag().busy = false;
    bag().statusPhase = "";
    bag().statusDetail = "";
    renderAttachChips();
    el.wsTitle.textContent = tr("New chat");
    updatePathChips(mode === "home" ? "" : defaultCwd);
    pinMessagesBottom(false);
    renderMessages({ forceScroll: true });
    renderList();
    renderActivity();
    updateQueueChip();
    el.input.focus();

    pushBag();
    persistNav();
    showToast(mode === "home" ? tr("New Home chat") : tr("New Build session — write below"), "ok");
  }

  function autosize() {
    const ta = el.input;
    preserveChatScroll(() => {
      ta.style.height = "auto";
      ta.style.height = Math.min(200, ta.scrollHeight) + "px";
    });
  }

  function showCtx(x, y, id) {
    ctxTargetId = id;
    el.ctxMenu.classList.remove("hidden");
    el.ctxMenu.style.left = Math.min(x, window.innerWidth - 200) + "px";
    el.ctxMenu.style.top = Math.min(y, window.innerHeight - 160) + "px";
  }

  function hideCtx() {
    el.ctxMenu.classList.add("hidden");
    ctxTargetId = null;
  }

  async function ctxAction(act) {
    const id = ctxTargetId || selectedId;
    hideCtx();

    if (act === "new") {
      await newChat();
      return;
    }
    if (!id) {
      showToast(tr("Pick a chat from the list (or New chat)"), "");
      return;
    }
    const row = rowsForMode().find((r) => r.id === id);
    if (!row && act !== "copy") {
      showToast(tr("Session not found"), "error");
      return;
    }

    if (act === "copy") {
      await navigator.clipboard.writeText(id);
      showToast(tr("Session ID copied"), "ok");
      return;
    }
    if (act === "unread") {
      await markSessionFlag(id, { unread: true });
      showToast(tr("Marked unread"), "ok");
      return;
    }
    if (act === "read") {
      await markSessionFlag(id, { unread: false });
      showToast(tr("Marked read"), "ok");
      return;
    }
    if (act === "pin") {
      const cur = sessionFlagMap[id] || {};
      await markSessionFlag(id, { pinned: !cur.pinned });
      showToast(cur.pinned ? tr("Unpinned") : tr("Pinned"), "ok");
      return;
    }
    if (act === "reveal") {
      if (mode === "home") {
        showToast(tr("Home chats are stored in the app data folder"), "");
        return;
      }
      const res = await api.revealSession(row.dirPath);
      if (!res.ok) showToast(res.error, "error");
      return;
    }
    if (act === "delete") {
      const ok = await modalPrompt({
        title: tr("Delete chat?"),
        body: `${row.title}\n\n${tr("Permanent")}`,
        okLabel: tr("Delete"),
      });
      if (!ok) return;
      const res = await api.deleteSession({ id, mode });
      if (!res.ok) showToast(res.error, "error");
      else {
        if (selectedId === id) {
          selectedId = null;
          liveSessionId = null;
          allMessages = [];
          messages = [];
          el.wsTitle.textContent = tr("New chat");
          renderMessages({ forceScroll: true });
        }
        pushBag();
        persistNav();
        await refresh();
      }
      return;
    }
    if (act === "rename") {
      const name = await modalPrompt({
        title: tr("Rename"),
        body: tr("Title in the list"),
        okLabel: tr("Save"),
        inputValue: row.title,
      });
      if (name == null || !String(name).trim()) return;
      const res = await api.renameSession({
        id,
        title: String(name).trim(),
        mode,
      });
      if (!res.ok) showToast(res.error || tr("Rename failed"), "error");
      else {
        if (selectedId === id) el.wsTitle.textContent = String(name).trim();
        await refresh();
      }
    }
  }

  // ===== Events =====
  el.tabHome.onclick = () => setMode("home");
  el.tabGrok.onclick = () => setMode("grok");
  el.btnNew.onclick = () => newChat();

  // Home Chat / Image / Video
  document.getElementById("home-kind")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    homeKind = btn.dataset.kind || "chat";
    document
      .querySelectorAll("#home-kind .seg-btn")
      .forEach((b) => b.classList.toggle("active", b === btn));
    const ratioWrap = document.getElementById("ratio-wrap");
    if (ratioWrap) {
      ratioWrap.classList.toggle("hidden", homeKind === "chat");
    }
    if (homeKind === "image") {
      el.input.placeholder = tr("Describe the image… (aspect ratio on the right)");
    } else if (homeKind === "video") {
      el.input.placeholder = tr("Describe the video… (takes about a minute)");
    } else {
      el.input.placeholder =
        tr("Message Grok… (Enter = send, ⌘V = paste screenshot)");
    }
  });

  document.getElementById("effort-select")?.addEventListener("change", async (e) => {
    effortLevel = e.target.value || "high";
    const res = await api.chatSetEffort({
      effort: effortLevel,
      cwd: selectedRow()?.cwd || defaultCwd,
    });
    if (!res.ok) showToast(res.error || tr("Effort change failed"), "error");
    else showToast(`Effort: ${effortLevel}`, "ok");
  });
  el.form.onsubmit = (e) => {
    e.preventDefault();
    const empty = !el.input.value.trim() && !attachments.length;
    if (empty && messageQueue.length) {
      injectOldestQueued();
      return;
    }
    sendMessage();
  };
  el.input.addEventListener("input", autosize);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const empty = !el.input.value.trim() && !attachments.length;
      if (empty && messageQueue.length) {
        injectOldestQueued();
        return;
      }
      sendMessage();
    }
  });
  el.filter.addEventListener("input", (e) => {
    filter = e.target.value || "";
    renderList();
  });
  el.btnStop.onclick = async () => {
    // przekaż tryb — w Home trzeba przerwać żądanie HTTP, nie proces agenta
    const res = await api.chatStop({
      mode,
      sessionId: liveSessionId || selectedId,
    });
    setBusy(false);
    if (!res.ok) showToast(res.error || tr("Stop failed"), "error");
    else showToast(tr("Stopped"), "ok");
  };
  el.modelSelect.addEventListener("change", async () => {
    const id = el.modelSelect.value;
    if (mode === "home") homeModelId = id;
    else codeModelId = id;
    const res = await api.chatSetModel({
      modelId: id,
      mode,
      sessionId: liveSessionId || selectedId,
    });
    if (!res.ok) showToast(res.error || tr("Model change failed"), "error");
  });
  el.btnToggleActivity.onclick = () => {
    showActivity = !showActivity;
    renderActivity();
  };

  document.getElementById("suggestions").onclick = (e) => {
    const btn = e.target.closest(".suggest");
    if (!btn) return;
    sendMessage(btn.dataset.text);
  };

  document.getElementById("btn-collapse").onclick = () => {
    // Tylko lewy panel — workspace/czat ZOSTAJE
    el.app.classList.add("rail-collapsed");
    el.btnExpand.classList.remove("hidden");
  };
  el.btnExpand.onclick = () => {
    el.app.classList.remove("rail-collapsed");
    el.btnExpand.classList.add("hidden");
  };

  document.getElementById("btn-session-menu").onclick = (e) => {
    e.stopPropagation();
    // Menu ⋯ działa zawsze (temat, new chat, settings) — nawet bez wybranej sesji
    const r = e.currentTarget.getBoundingClientRect();
    showCtx(r.left, r.bottom + 4, selectedId || liveSessionId || null);
  };

  el.ctxMenu.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) ctxAction(btn.dataset.act);
  };
  document.addEventListener("click", (e) => {
    if (!el.ctxMenu.contains(e.target) && e.target.id !== "btn-session-menu") {
      hideCtx();
    }
  });

  document.getElementById("btn-attach").onclick = async () => {
    const files = await api.pickFiles();
    for (const f of files) {
      if (f.ok) attachments.push(f);
    }
    renderAttachChips();
    el.input.focus();
  };

  // Paste images
  el.input.addEventListener("paste", async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        await addAttachmentFromFile(file);
      }
    }
  });

  // Drag & drop
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    el.dropOverlay.classList.remove("hidden");
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) el.dropOverlay.classList.add("hidden");
  });
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.dropOverlay.classList.add("hidden");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      for (const f of files) {
        // Electron may expose path
        if (f.path) await addAttachmentFromPath(f.path);
        else await addAttachmentFromFile(f);
      }
    }
  });

  document.getElementById("btn-settings").onclick = async () => {
    const s = await api.getSettings();
    document.getElementById("set-grok-path").value = s.grokPath || "";
    document.getElementById("set-cwd").value = s.defaultCwd || "";
    document.getElementById("set-subagents").checked = Boolean(s.showSubagents);
    document.getElementById("set-theme").value = s.theme || "dark";
    document.getElementById("set-permission").value = s.permissionMode || "auto";
    document.getElementById("set-max-tokens").value = s.homeMaxTokens || 8192;
    document.getElementById("set-cookies").checked = Boolean(s.readBrowserCookies);
    document.getElementById("set-python").value = s.pythonPath || "";
    document.getElementById("set-privacy").checked = Boolean(s.privacyMode);
    document.getElementById("set-always-latest").checked =
      s.alwaysLatestModel !== false;
    document.getElementById("set-language").value = s.language || "en";
    el.settingsModal.classList.remove("hidden");
  };
  document.getElementById("set-cancel").onclick = () =>
    el.settingsModal.classList.add("hidden");

  // Ścieżka do Pythona ma sens tylko przy włączonym czytaniu ciasteczek
  const cookiesBox = document.getElementById("set-cookies");
  const pythonField = document.getElementById("python-field");
  const syncPythonField = () => {
    if (pythonField && cookiesBox) {
      pythonField.classList.toggle("disabled", !cookiesBox.checked);
    }
  };
  if (cookiesBox) {
    cookiesBox.addEventListener("change", syncPythonField);
    syncPythonField();
  }

  // Podgląd motywu od razu, bez czekania na Zapisz
  document.getElementById("set-theme")?.addEventListener("change", (e) => {
    document.documentElement.setAttribute("data-theme", e.target.value);
  });
  document.getElementById("set-pick-grok").onclick = async () => {
    const p = await api.pickGrokBinary();
    if (p) document.getElementById("set-grok-path").value = p;
  };
  document.getElementById("set-login").onclick = async () => {
    const res = await api.login();
    if (!res.ok) showToast(res.error || tr("Log in did not start"), "error");
    else showToast(tr("Log in opened in Terminal"), "ok");
  };
  document.getElementById("set-save").onclick = async () => {
    const theme = document.getElementById("set-theme").value;
    const permissionMode = document.getElementById("set-permission").value;
    const wantPrivacy = document.getElementById("set-privacy").checked;
    const wantLang = document.getElementById("set-language").value;
    await api.setSettings({
      privacyMode: wantPrivacy,
      alwaysLatestModel: document.getElementById("set-always-latest").checked,
      language: wantLang,
      grokPath: document.getElementById("set-grok-path").value.trim(),
      defaultCwd: document.getElementById("set-cwd").value.trim(),
      showSubagents: document.getElementById("set-subagents").checked,
      theme,
      permissionMode,
      homeMaxTokens: Number(document.getElementById("set-max-tokens").value) || 8192,
      readBrowserCookies: document.getElementById("set-cookies").checked,
      pythonPath: document.getElementById("set-python").value.trim(),
    });
    document.documentElement.setAttribute("data-theme", theme);
    permMode = permissionMode;
    paintPermChip();
    setPrivacyMode(wantPrivacy);
    applyLanguage(wantLang, lastSystemLocale);
    el.settingsModal.classList.add("hidden");
    showToast(tr("Saved"), "ok");
    await refresh();
  };

  document.getElementById("btn-account").onclick = async () => {
    const acc = await api.getAccount();
    applyAccount(acc);
    el.accountModal.classList.remove("hidden");
  };
  document.getElementById("account-close").onclick = () =>
    el.accountModal.classList.add("hidden");
  document.getElementById("account-login").onclick = async () => {
    const res = await api.login();
    if (!res.ok) showToast(res.error || tr("Log in did not start"), "error");
    else showToast(tr("Log in opened"), "ok");
  };

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && !e.shiftKey) {
      e.preventDefault();
      newChat();
    }
    // ⌘⇧P — tryb prywatności przed zrzutem ekranu
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      setPrivacyMode(!privacyMode);
      api.setSettings({ privacyMode }).catch(() => {});
      showToast(
        privacyMode
          ? tr("Privacy mode on — account details hidden")
          : tr("Privacy mode off"),
        "ok"
      );
    }
  });

  api.onUpdated(applyPayload);
  api.onChatUpdate(handleChatUpdate);
  api.onChatBusy(({ busy: b, sessionId, mode: evMode }) => {
    if (evMode === "home") {
      bags.home.busy = Boolean(b);
      if (mode === "home") setBusy(Boolean(b), "home");
      return;
    }
    if (sessionId) setSessionBusy(sessionId, b);
    if (sessionId && b) adoptBuildSession(sessionId);
    if (sessionId && !b) clearStreamingFlags(sessionId);
    const viewingThis =
      sessionId && isViewingSession(sessionId);
    if (mode === "home") {
      renderList();
      return;
    }
    if (viewingThis) {
      setBusy(Boolean(b), mode);
      if (b) snapshotCurrentBuildSession();
    } else if (!sessionId && isViewingSession(liveSessionId || selectedId)) {
      setBusy(Boolean(b), mode);
    }
    renderList();
  });
  api.onChatError(({ message, sessionId }) => {
    const msg = cleanUserText(message || "Error") || "Error";
    if (/\[Attachments/i.test(message || "")) return;
    const sid = sessionId || busySessionId;
    if (mode === "home" || (sid && !isViewingSession(sid))) {
      if (sid) {
        const buf = ensureSessionStream(sid);
        if (buf) {
          buf.statusPhase = "error";
          buf.statusDetail = msg.slice(0, 120);
        }
      }
      return;
    }
    showToast(msg.slice(0, 200), "error");
    setStatus("error", msg.slice(0, 120), mode, { sessionId: sid });
  });
  api.onChatModels(() => {
    if (mode === "grok") refresh();
  });
  api.onChatStatus(({ phase, detail, sessionId }) => {
    const sid = sessionId || null;
    if (sid && mode === "grok" && !isViewingSession(sid)) {
      const buf = ensureSessionStream(sid);
      if (buf) {
        buf.statusPhase = phase;
        buf.statusDetail = detail || "";
      }
      return;
    }
    setStatus(phase, detail, mode, { sessionId: sid });
  });

  async function boot() {
    const data = await api.list();
    applyPayload(data);
    if (data.settings?.theme) applyTheme(data.settings.theme);
    if (data.settings?.effort) {
      effortLevel = data.settings.effort;
      const es = document.getElementById("effort-select");
      if (es) es.value = effortLevel;
    }
    // Język PRZED pierwszym renderem, żeby nie mrugnąć angielskim w PL
    applyLanguage(data.settings?.language, data.settings?.systemLocale);
    permMode = data.settings?.permissionMode || "auto";
    paintPermChip();
    if (data.settings?.privacyMode) setPrivacyMode(true);
    if (typeof api.getSessionFlags === "function") {
      try {
        const fr = await api.getSessionFlags();
        if (fr && fr.ok) sessionFlagMap = fr.flags || {};
      } catch {
        /* ignore */
      }
    }

    const lastMode =
      data.settings?.lastMode === "grok" ? "grok" : "home";
    const lastHome = data.settings?.lastHomeSessionId || "";
    const lastCode = data.settings?.lastCodeSessionId || "";

    bags.home.selectedId = lastHome || null;
    bags.home.liveSessionId = lastHome || null;
    bags.grok.selectedId = lastCode || null;
    bags.grok.liveSessionId = lastCode || null;

    setMode(lastMode, { restoreSession: false });
    pullBag();

    const wantId = mode === "home" ? lastHome : lastCode;
    if (wantId) {
      const row = rowsForMode().find((r) => r.id === wantId);
      if (row) await openSession(row);
    }
    bootDone = true;
    el.input.focus();
  }

  /* ===== Usage panel (context % like Claude) ===== */
  const usageEls = {
    btn: document.getElementById("btn-usage"),
    pct: document.getElementById("usage-btn-pct"),
    pop: document.getElementById("usage-popover"),
    weeklyLabel: document.getElementById("usage-weekly-label"),
    weeklyMeta: document.getElementById("usage-weekly-meta"),
    weeklyBar: document.getElementById("usage-weekly-bar"),
    weeklyDetail: document.getElementById("usage-weekly-detail"),
    ctxMeta: document.getElementById("usage-ctx-meta"),
    ctxBar: document.getElementById("usage-ctx-bar"),
    ctxTokens: document.getElementById("usage-ctx-tokens"),
    account: document.getElementById("usage-account"),
  };
  let usageTimer = null;
  let usageOpen = false;

  function fmtTokens(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    return Number(n).toLocaleString("pl-PL");
  }

  function setBar(el, pct) {
    if (!el) return;
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    el.style.width = p + "%";
    el.classList.toggle("warn", p >= 70 && p < 90);
    el.classList.toggle("hot", p >= 90);
  }

  async function refreshUsage() {
    if (!usageEls.btn || typeof api.getUsage !== "function") return;
    const sid =
      mode === "grok"
        ? liveSessionId || selectedId || null
        : null;
    try {
      const u = await api.getUsage({ sessionId: sid });
      if (!u || !u.ok) {
        usageEls.pct.textContent = "—";
        return;
      }
      // Weekly SuperGrok (plan) — preferred on the button like Claude
      const plan = u.plan || null;
      const weekly = plan?.weekly || null;
      if (usageEls.weeklyLabel) {
        usageEls.weeklyLabel.textContent = plan?.tierLabel
          ? `Tygodniowy · ${plan.tierLabel}`
          : "Tygodniowy limit SuperGrok";
      }
      if (weekly && weekly.percent != null) {
        usageEls.pct.textContent = Math.round(weekly.percent) + "%";
        usageEls.btn.classList.toggle("warn", weekly.percent >= 70 && weekly.percent < 90);
        usageEls.btn.classList.toggle("hot", weekly.percent >= 90);
        if (usageEls.weeklyMeta)
          usageEls.weeklyMeta.textContent = Math.round(weekly.percent) + tr("% used");
        setBar(usageEls.weeklyBar, weekly.percent);
        if (usageEls.weeklyDetail) {
          const reset = weekly.resetsAt
            ? `Reset: ${new Date(weekly.resetsAt).toLocaleString("pl-PL")}`
            : "";
          const products = Array.isArray(weekly.products)
            ? weekly.products
                .filter((p) => p && p.percent > 0)
                .map((p) => `${p.label} ${Math.round(p.percent)}%`)
                .join(" · ")
            : "";
          usageEls.weeklyDetail.textContent = [
            weekly.label || "Grok Build",
            products && products !== (weekly.label || "Grok Build") + ` ${Math.round(weekly.percent)}%`
              ? products
              : "",
            reset,
          ]
            .filter(Boolean)
            .join(" · ");
        }
      } else {
        // fallback: show context % on button, weekly detail = error / plan
        if (usageEls.weeklyMeta)
          usageEls.weeklyMeta.textContent = plan?.tierLabel || "plan";
        setBar(usageEls.weeklyBar, 0);
        if (usageEls.weeklyDetail) {
          usageEls.weeklyDetail.textContent =
            plan?.weeklyError ||
            t(
              "Weekly %: Settings → „Read grok.com cookies”. xAI does not expose this limit to the grok login token."
            );
        }
      }

      const pct = u.context?.percent;
      if (pct != null) {
        if (!(weekly && weekly.percent != null)) {
          usageEls.pct.textContent = Math.round(pct) + "%";
          usageEls.btn.classList.toggle("warn", pct >= 70 && pct < 90);
          usageEls.btn.classList.toggle("hot", pct >= 90);
        }
        usageEls.ctxMeta.textContent = Math.round(pct) + "%";
        setBar(usageEls.ctxBar, pct);
      } else {
        if (!(weekly && weekly.percent != null)) {
          usageEls.pct.textContent = mode === "home" ? "H" : "—";
          usageEls.btn.classList.remove("warn", "hot");
        }
        usageEls.ctxMeta.textContent =
          mode === "home" ? tr("Home (no signals)") : "—";
        setBar(usageEls.ctxBar, 0);
      }
      const used = u.context?.tokensUsed;
      const total = u.context?.tokensTotal;
      if (usageEls.ctxTokens) {
        usageEls.ctxTokens.textContent =
          used != null && total != null
            ? `${fmtTokens(used)} / ${fmtTokens(total)} · tury ${u.context?.turns ?? "—"} · tool ${u.context?.tools ?? "—"}`
            : mode === "home"
              ? tr("Home does not track a context window like Build")
              : tr("No signals.json — open a Build session");
      }
      const planBit = plan?.tierLabel ? ` · ${plan.tierLabel}` : "";
      if (usageEls.account) {
        usageEls.account.textContent = privacyMode
          ? `konto ukryte${planBit}`.trim()
          : u.account?.email
            ? `${u.account.name || ""} · ${u.account.email}${planBit}`.trim()
            : `konto: —${planBit}`;
      }
    } catch (err) {
      usageEls.pct.textContent = "!";
    }
  }

  if (usageEls.btn) {
    usageEls.btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      usageOpen = !usageOpen;
      usageEls.pop.classList.toggle("hidden", !usageOpen);
      if (usageOpen) await refreshUsage();
    });
    document.addEventListener("click", (e) => {
      if (!usageOpen) return;
      const corner = document.querySelector(".usage-corner");
      if (corner && !corner.contains(e.target)) {
        usageOpen = false;
        usageEls.pop.classList.add("hidden");
      }
    });
    // Co 60 s i tylko przy widocznym oknie: dane po stronie serwera i tak
    // są cache'owane, a odpytywanie co 15 s w tle było czystym marnotrawstwem.
    usageTimer = setInterval(() => {
      if (document.visibilityState === "visible") refreshUsage();
    }, 60000);
    refreshUsage();
  }

  /* ===== Tryb uprawnień: Auto / Pytaj (jak w Claude Code) ===== */
  const permBtn = document.getElementById("perm-mode-btn");

  function paintPermChip() {
    if (!permBtn) return;
    const ask = permMode === "ask";
    permBtn.textContent = ask ? "Pytaj" : "Auto";
    permBtn.classList.toggle("mode-ask", ask);
    permBtn.classList.toggle("mode-auto", !ask);
    permBtn.title = ask
      ? tr("The agent asks before every tool. Click to switch to Auto.")
      : tr("The agent uses tools without asking. Click to switch to Ask.");
  }

  if (permBtn) {
    permBtn.onclick = async () => {
      permMode = permMode === "ask" ? "auto" : "ask";
      paintPermChip();
      const res = await api.setSettings({ permissionMode: permMode });
      if (res && res.permissionMode) {
        permMode = res.permissionMode;
        paintPermChip();
      }
      showToast(
        permMode === "ask"
          ? tr("Ask: the agent will request approval for every tool")
          : tr("Auto: the agent works without asking"),
        "ok"
      );
    };
  }

  /* ===== Modal zgody na narzędzie ===== */
  const permModal = document.getElementById("perm-modal");
  const permQueue = [];
  let permShowing = false;

  function toolLabel(toolCall) {
    if (!toolCall) return tr("Tool");
    return (
      toolCall.title ||
      toolCall.kind ||
      toolCall.name ||
      toolCall.toolName ||
      tr("Tool")
    );
  }

  function toolDetail(toolCall) {
    if (!toolCall) return "";
    const bits = [];
    if (Array.isArray(toolCall.locations)) {
      bits.push(toolCall.locations.map((l) => l.path || "").filter(Boolean).join("\n"));
    }
    const raw = toolCall.rawInput ?? toolCall.input;
    if (raw != null) {
      try {
        bits.push(typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
      } catch {
        /* pomiń */
      }
    }
    return bits.filter(Boolean).join("\n\n").slice(0, 2000);
  }

  function showNextPermission() {
    if (permShowing || !permQueue.length || !permModal) return;
    const req = permQueue.shift();
    permShowing = true;

    document.getElementById("perm-tool").textContent = toolLabel(req.toolCall);
    const detailEl = document.getElementById("perm-detail");
    const detail = toolDetail(req.toolCall);
    detailEl.textContent = detail;
    detailEl.classList.toggle("hidden", !detail);

    const actions = document.getElementById("perm-actions");
    actions.innerHTML = "";
    const answer = async (optionId) => {
      permModal.classList.add("hidden");
      permShowing = false;
      await api.permissionReply({ id: req.id, optionId });
      showNextPermission();
    };

    const options = Array.isArray(req.options) ? req.options : [];
    if (options.length) {
      for (const o of options) {
        const b = document.createElement("button");
        b.type = "button";
        b.className =
          "btn" + (/allow|approve/i.test(o.kind || o.optionId || "") ? " primary" : "");
        b.textContent = o.name || o.optionId;
        b.onclick = () => answer(o.optionId);
        actions.appendChild(b);
      }
    }
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "btn";
    deny.textContent = tr("Deny");
    deny.onclick = () => answer(null);
    actions.appendChild(deny);

    permModal.classList.remove("hidden");
  }

  if (typeof api.onChatPermission === "function") {
    api.onChatPermission((req) => {
      permQueue.push(req || {});
      showNextPermission();
    });
  }

  /* ===== Copy przy blokach kodu ===== */
  el.messages.addEventListener("click", async (e) => {
    const btn = e.target.closest(".md-copy");
    if (!btn) return;
    const code = btn.closest(".md-code-wrap")?.querySelector("code");
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent || "");
      const prev = btn.textContent;
      btn.textContent = tr("Copied");
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    } catch {
      showToast(tr("Copy failed"), "error");
    }
  });

  bindChatScrollWatcher();

  boot().catch((err) => {
    console.error("boot failed", err);
    setMode("home");
    refresh();
  });
})();
