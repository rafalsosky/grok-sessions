/* global grokSessions, renderMarkdown */

(() => {
  const api = window.grokSessions;
  if (!api) {
    document.body.innerHTML =
      "<p style='padding:24px;color:#fff'>Brak bridge API (preload).</p>";
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
  let homeModelId = "grok-4.5";
  let codeModelId = "grok-4.5";
  let ctxTargetId = null;
  let drainingQueue = false;
  const PAGE = 60;
  let bootDone = false;
  /** Home: chat | image | video */
  let homeKind = "chat";
  let effortLevel = "high";
  /** "auto" = agent bez pytania, "ask" = zatwierdzam każde narzędzie */
  let permMode = "auto";
  /** Session ID where agent is currently working (only that row shows „pracuje”) */
  let busySessionId = null;
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
    api.setSettings(payload).catch(() => {});
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
    if (!iso) return "Earlier";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Earlier";
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = (startToday - startThat) / 86400000;
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    if (diff < 7) return "Previous 7 days";
    return "Earlier";
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
    if (!s) return "Narzędzie";
    // Read `/path…` / Write / Edit — nigdy surowa ścieżka w statusie
    if (/^(read|write|edit|search|grep|bash|execute)\b/i.test(s) || s.length > 48) {
      const low = s.toLowerCase();
      if (/\b(python3?|node|bash|zsh|sh|curl|ffmpeg|osascript)\b/.test(low))
        return "Terminal";
      if (/^read\b|\bread_file\b|\bcat\b|\bhead\b|\btail\b/.test(low))
        return "Czytam plik";
      if (/\b(write|edit|patch|search_replace|sed)\b/.test(low)) return "Edytuję plik";
      if (/\b(grep|rg|find|search_tool|web_search)\b/.test(low)) return "Szukam";
      if (/\b(web_search|browse|http|open_page)\b/.test(low)) return "Sieć";
      if (/^Execute\b/i.test(s)) return "Terminal";
      if (/\/|\\/.test(s)) return "Plik";
      return "Narzędzie";
    }
    if (/^\/Users\//.test(s) || /^[A-Za-z]:\\/.test(s)) return "Plik";
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

  function paintStatusText() {
    if (!el.statusText) return;
    const base = lastStatusLabel || "Myślę…";
    el.statusText.textContent = turnStartedAt
      ? `${base} · ${fmtElapsed(Date.now() - turnStartedAt)}`
      : base;
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
    const sid = opts.sessionId || busySessionId || null;
    // TWARDY GATE: status streamu NIGDY na obcej sesji
    if (
      mode === "grok" &&
      streamPhases.includes(phase) &&
      busySessionId &&
      selectedId &&
      selectedId !== busySessionId
    ) {
      const buf = ensureSessionStream(busySessionId);
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
      if (phase === "tool" && (!safeDetail || safeDetail === "Narzędzie")) {
        safeDetail = "Pracuję w tle…";
      }
    }
    b.statusPhase = phase || "";
    b.statusDetail = safeDetail;
    // Status UI tylko dla AKTYWNEGO trybu
    if (target !== mode) return;

    const map = {
      queued: "Start…",
      starting: "Uruchamiam agenta…",
      session: "Ładuję sesję…",
      thinking: "Myślę…",
      generating_image: "Generuję grafikę…",
      responding: "Piszę…",
      tool: "Pracuję w tle…",
      done: "Gotowe",
      stopped: "Przerwano",
      error: "Błąd",
    };
    // Dla tool/thinking: preferuj krótką etykietę, nie surowy detail z ACP
    let label;
    if (phase === "tool") {
      label = safeDetail && safeDetail !== "Narzędzie" ? safeDetail : map.tool;
    } else if (phase === "thinking" || phase === "responding") {
      label = map[phase] || safeDetail;
    } else {
      label = safeDetail || map[phase] || phase || "";
    }
    // Ostateczna blokada: nigdy nie wklejaj Execute / ścieżek w status
    if (/^Execute\b/i.test(label) || /GROK_SESSIONS_ATTACHMENTS/i.test(label)) {
      label = map[phase] || "Pracuję…";
    }
    if (label.length > 60) label = humanizeToolTitle(label);

    if (!label || phase === "done") {
      if (!busy) {
        el.statusBar.classList.add("hidden");
      } else {
        lastStatusLabel = label || "Myślę…";
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
    el.btnToggleActivity.classList.toggle("hidden", liveTools.length === 0);
    el.btnToggleActivity.textContent = showActivity
      ? "Ukryj kroki"
      : `Kroki (${liveTools.length})`;

    if (!showActivity || !liveTools.length) {
      el.activityPanel.classList.add("hidden");
      el.activityPanel.innerHTML = "";
      return;
    }
    el.activityPanel.classList.remove("hidden");
    el.activityPanel.innerHTML = "";
    if (active.length) {
      const h = document.createElement("div");
      h.className = "activity-group";
      h.textContent = "W toku";
      el.activityPanel.appendChild(h);
      for (const t of active) {
        const row = document.createElement("div");
        row.className = "activity-row live";
        row.textContent = `${humanizeToolTitle(t.title)} · ${t.status || "…"}`;
        el.activityPanel.appendChild(row);
      }
    }
    if (done.length) {
      const h = document.createElement("div");
      h.className = "activity-group";
      h.textContent = `Ukończone (${done.length}) — zwinięte domyślnie`;
      el.activityPanel.appendChild(h);
      const det = document.createElement("details");
      det.className = "activity-done";
      const sum = document.createElement("summary");
      sum.textContent = `Pokaż ${done.length} completed`;
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
    el.btnNewLabel.textContent = mode === "home" ? "New chat" : "New session";
    el.recentsLabel.textContent =
      mode === "home" ? "Recents · Home" : "Recents · Build";
    el.finePrint.textContent =
      mode === "home"
        ? "Home · czat i grafiki (/image …) · przeciągnij pliki lub wklej screenshot"
        : "Build · agent z narzędziami · załączniki jako ścieżki na dysku";
    document.getElementById("hero-title").textContent =
      mode === "home" ? "How can I help you today?" : "What should we build?";
    document.getElementById("hero-sub").textContent =
      mode === "home"
        ? "Jak Grok w przeglądarce: rozmowa, pomysły, /image do grafik. Nie agent kodujący."
        : "Build: pliki, shell, edycje. Załączniki idą do agenta jako ścieżki.";

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

  function updatePathChips(cwd) {
    if (mode === "home") {
      el.cwdChip.textContent = "Home chat";
      el.wsCwd.textContent = "browser-style";
    } else {
      el.cwdChip.textContent = cwd || defaultCwd;
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
        mode === "home" ? "Brak czatów Home — napisz poniżej" : "Brak sesji Build"
      }</div></div>`;
      el.list.appendChild(li);
      return;
    }
    const groups = new Map();
    for (const r of list) {
      const g = dayBucket(r.lastActiveAt || r.updatedAt);
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
        const isWorking =
          mode === "grok" && busySessionId && r.id === busySessionId;
        const isTerminalLive = Boolean(r.isActive) && !isWorking;
        const fl = sessionFlagMap[r.id] || {};
        li.className =
          "session-item" +
          (r.id === selectedId || r.id === liveSessionId ? " selected" : "") +
          (isWorking ? " working" : "") +
          (fl.unread ? " unread" : "") +
          (fl.pinned ? " pinned" : "");
        li.innerHTML = `
          <div style="min-width:0">
            <div class="title"></div>
            <div class="meta"></div>
          </div>
          <div class="session-badges">
            ${fl.pinned ? '<span class="pin-mark" title="Pinned">📌</span>' : ""}
            ${fl.unread ? '<span class="unread-dot" title="Unread"></span>' : ""}
            ${
              isWorking
                ? '<span class="live-dot working" title="Pracuje w tej sesji"></span>'
                : isTerminalLive
                  ? '<span class="live-dot" title="Aktywna w terminalu"></span>'
                  : ""
            }
          </div>`;
        li.querySelector(".title").textContent = r.title;
        li.querySelector(".meta").textContent = [
          mode === "home" ? "Home" : basenameCwd(r.cwd),
          isWorking
            ? "pracuje…"
            : relativeTime(r.lastActiveAt || r.updatedAt),
        ]
          .filter(Boolean)
          .join(" · ");
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

  /** User scrolled up while agent works → nie ciągnij na dół. */
  let stickToBottom = true;
  /** True podczas programowego scrolla — handler nie gasi stickToBottom. */
  let scrollingProgrammatically = false;
  let scrollBottomTimer = 0;

  function nearBottom(threshold = 120) {
    const box = el.chatScroll;
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < threshold;
  }

  /**
   * Stick tylko gdy user jest na dole (albo właśnie wysłał).
   * NIGDY „bo busy” — to powodowało przelot przez całą sesję.
   */
  function shouldStickBottom(force) {
    if (force) return true;
    if (!stickToBottom) return false;
    return nearBottom(120);
  }

  /**
   * @param {boolean} [force] — true = Enter / nowa tura (zawsze na dół)
   * NIE używamy scrollIntoView — potrafi scrollować zły kontener i skakać na górę.
   * Tylko scrollTop na #chat-scroll.
   */
  function scrollChatToBottom(force) {
    const box = el.chatScroll;
    if (!box) return;
    if (!force && !stickToBottom) return;
    if (force) stickToBottom = true;

    scrollingProgrammatically = true;
    const go = () => {
      const b = el.chatScroll;
      if (!b) return;
      // max scroll — nie polegaj na scrollHeight w trakcie flex layout
      const max = Math.max(0, b.scrollHeight - b.clientHeight);
      b.scrollTop = max > 0 ? max : b.scrollHeight;
    };
    go();
    // layout po replaceChildren bywa o 1–2 klatki opóźniony
    requestAnimationFrame(() => {
      go();
      requestAnimationFrame(() => {
        go();
        scrollingProgrammatically = false;
        stickToBottom = true;
      });
    });
    // belka: po fontach / markdown height może urosnąć później
    if (scrollBottomTimer) clearTimeout(scrollBottomTimer);
    scrollBottomTimer = setTimeout(() => {
      scrollBottomTimer = 0;
      if (!force && !stickToBottom) return;
      scrollingProgrammatically = true;
      go();
      scrollingProgrammatically = false;
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
      if (stickToBottom) {
        layoutChatBottom();
        scrollingProgrammatically = true;
        box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
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
        if (scrollingProgrammatically) return;
        // blisko dołu → znowu follow; wyżej → nie ruszaj
        stickToBottom = nearBottom(80);
      },
      { passive: true }
    );
    // BUG (naprawiony): obserwowany był #chat-scroll, czyli kontener o stałej
    // wysokości. Gdy rosła TREŚĆ (markdown, tabele, obrazy z readPreview,
    // fonty), nic się nie przeliczało i widok zostawał w połowie historii,
    // dopóki użytkownik nie ruszył scrolla ręcznie. Obserwujemy #messages.
    if (typeof ResizeObserver !== "undefined" && !box._layoutRo) {
      box._layoutRo = new ResizeObserver(() => {
        if (!allMessages.length) return;
        layoutChatBottom();
        // treść urosła, a user trzymał dół → dociągnij
        if (stickToBottom) {
          scrollingProgrammatically = true;
          const b = el.chatScroll;
          if (b) b.scrollTop = Math.max(0, b.scrollHeight - b.clientHeight);
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
  function stickAfterImage(img) {
    img.addEventListener(
      "load",
      () => {
        layoutChatBottom();
        if (stickToBottom) scrollChatToBottom(false);
      },
      { once: true }
    );
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

  /** Aktualizuj ostatnią odpowiedź bez full re-render (bez skoku scrolla). */
  function patchLastAssistantBubble(m) {
    if (!m) return;
    let last = findLastAssistantRow();
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

    if (m.thinking && mode === "grok") {
      const pill = document.createElement("div");
      pill.className =
        "agent-work-summary" + (m._streaming && busy ? " live" : "");
      pill.textContent =
        m._streaming && busy ? "Thinking…" : "Thinking (ukryte w czacie)";
      body.appendChild(pill);
    }

    if (mode === "grok" && m.tools && m.tools.length) {
      const active = m.tools.filter(
        (t) => t.status !== "completed" && t.status !== "failed"
      );
      const done = m.tools.filter(
        (t) => t.status === "completed" || t.status === "failed"
      );
      const pill = document.createElement("div");
      pill.className = "agent-work-summary" + (active.length ? " live" : "");
      if (active.length) {
        const ht = humanizeToolTitle(active[0].title);
        pill.textContent = `Pracuję: ${ht}${
          active.length > 1 ? ` +${active.length - 1}` : ""
        }`;
      } else {
        pill.textContent = `${done.length} kroków w tle (ukryte) · patrz „Kroki”`;
      }
      body.appendChild(pill);
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
      badge.textContent = "w kolejce";
      const inject = document.createElement("button");
      inject.type = "button";
      inject.className = "queued-inject";
      inject.title = "Wyślij teraz — przerwij i dołącz do bieżącej roboty (↩)";
      inject.textContent = "↩ Wyślij teraz";
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

    mkBtn("Copy", "Skopiuj treść wiadomości", async () => {
      try {
        const clean =
          m.role === "user"
            ? cleanUserText(m.text || "")
            : cleanAssistantText(m.text || "");
        await navigator.clipboard.writeText(clean || m.text || "");
        showToast("Skopiowane", "ok");
      } catch {
        showToast("Nie udało się skopiować", "error");
      }
    });

    if (!m._queued) {
      if (m.role === "user") {
        mkBtn("Edytuj", "Wróć do tej wiadomości i wyślij poprawioną", () =>
          editMessage(m)
        );
      }
      mkBtn(
        "Ponów",
        m.role === "user"
          ? "Wyślij tę wiadomość jeszcze raz"
          : "Wygeneruj odpowiedź jeszcze raz",
        () => retryFrom(m)
      );
      mkBtn(
        "Usuń",
        mode === "grok"
          ? "Usuwa z widoku. Agent nadal pamięta tę turę w swojej sesji."
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
    // zmierz treść bez sztucznego paddingu
    msgs.style.paddingTop = "0px";
    const cs = getComputedStyle(box);
    const padY =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const available = Math.max(0, box.clientHeight - padY);
    const contentH = msgs.scrollHeight;
    const gap = Math.floor(available - contentH);
    msgs.style.paddingTop = gap > 1 ? `${gap}px` : "0px";
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

  function applyAccount(account) {
    if (!account) return;
    el.accountName.textContent = account.name || account.label || "—";
    el.accountSub.textContent = account.loggedIn
      ? account.email || "signed in"
      : "Not signed in";
    el.accountAvatar.textContent = (
      account.name ||
      account.email ||
      "?"
    )
      .trim()
      .charAt(0)
      .toUpperCase();
    el.accountDetail.textContent = account.loggedIn
      ? `${account.name || ""}\n${account.email || ""}\nSuperGrok / xAI session`
      : "Nie zalogowano. Użyj Log in.";
  }

  function applyModelsForMode() {
    const select = el.modelSelect;
    select.innerHTML = "";
    if (mode === "home") {
      const opts = [
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
      o.value = codeModelId || "grok-4.5";
      o.textContent = codeModelId || "Grok 4.5";
      select.appendChild(o);
      select.value = codeModelId || "grok-4.5";
    }
  }

  function applyPayload(payload) {
    codeRows = (payload.rows || []).filter((r) => r.kind !== "home");
    homeRows = payload.homeRows || [];
    defaultCwd = payload.settings?.defaultCwd || defaultCwd;
    homeModelId = payload.settings?.homeModelId || homeModelId;
    codeModelId = payload.settings?.modelId || codeModelId;
    // busy tylko na jednej sesji Build
    if (payload.busySessionId !== undefined) {
      busySessionId = payload.busySessionId || null;
    } else if (payload.promptBusy && payload.activeSessionId) {
      busySessionId = payload.activeSessionId;
    } else if (payload.promptBusy === false) {
      busySessionId = null;
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
      el.wsTitle.textContent = selectedRow().title;
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
    // Snapshot TYLKO sesji, którą oglądamy — i tylko jeśli to ona pracuje
    // albo ma własny bufor (nie nadpisuj bufora pracującej A danymi z B)
    const sid = liveSessionId;
    if (busySessionId && busySessionId !== sid) {
      // oglądamy B, pracuje A — nie ruszaj bufora A; B bez live streamu
      return;
    }
    streamBySession[sid] = {
      allMessages: allMessages.slice(),
      streamingAssistant,
      liveTools: (liveTools || []).slice(),
      messageQueue: (messageQueue || []).slice(),
      attachments: (attachments || []).slice(),
      statusPhase: bag().statusPhase || "",
      statusDetail: bag().statusDetail || "",
    };
  }

  function isViewingSession(sid) {
    if (!sid) return false;
    // wyłącznie selectedId — liveSessionId bywa mylące przy race
    return mode === "grok" && selectedId === sid;
  }

  /** Wyczyść chrome UI (status, kroki, załączniki) — obca sesja. */
  function clearForeignSessionChrome() {
    liveTools = [];
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
    // Przed zmianą — odłóż stream TYLKO jeśli odchodzimy z pracującej sesji
    if (
      mode === "grok" &&
      liveSessionId &&
      liveSessionId !== row.id &&
      busySessionId === liveSessionId
    ) {
      snapshotCurrentBuildSession();
    }

    selectedId = row.id;
    liveSessionId = row.id;
    el.wsTitle.textContent = row.title;
    bag().wsTitle = row.title;
    updatePathChips(row.cwd);
    renderList();

    // Live TYLKO gdy TA sesja jest busySessionId (agent realnie tu pracuje)
    const live = streamBySession[row.id];
    const hasLiveWork = Boolean(live && busySessionId === row.id);

    if (hasLiveWork) {
      allMessages = (live.allMessages || []).slice();
      streamingAssistant = live.streamingAssistant || null;
      liveTools = (live.liveTools || []).slice();
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

    // Obca sesja (albo bez pracy) — ZAWSZE czysty chrome + transcript
    streamingAssistant = null;
    liveTools = [];
    messageQueue = [];
    clearForeignSessionChrome();
    visibleCount = PAGE;

    allMessages = [];
    messages = [];
    renderMessages({ forceScroll: true });
    renderActivity();

    const tr = await api.transcript({
      id: row.id,
      dirPath: row.dirPath,
      mode: mode === "home" ? "home" : "grok",
    });
    // race: user could have switched again
    if (selectedId !== row.id) return;

    if (tr.error) showToast(tr.error, "error");
    allMessages = (tr.messages || [])
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
    allMessages = allMessages.filter(
      (m) => !(m._streaming && m.role === "assistant" && !m.text)
    );
    syncVisibleMessages();
    renderMessages({ forceScroll: true });
    // Wznowiona sesja: markdown i obrazy dorastają jeszcze przez chwilę po
    // pierwszym renderze. Dociągnij dół, aż wysokość się ustabilizuje.
    settleScrollToBottom();

    pushBag();
    persistNav();

    // Busy globalnie (kolejka) ale UI bez „Myślę” / Working na tej sesji
    if (busySessionId && busySessionId !== row.id && bags.grok.busy) {
      busy = true; // kolejka działa
      bags.grok.busy = true;
      el.busyChip.classList.add("hidden");
      el.btnStop.classList.remove("hidden");
      el.btnSend.classList.add("queue-mode");
      el.input.placeholder = "Agent pracuje w innej sesji Build…";
      el.statusBar.classList.add("hidden");
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
  function deleteMessage(m) {
    const i = indexOfMsg(m);
    if (i < 0) return;
    allMessages.splice(i, 1);
    syncVisibleMessages();
    renderMessages({ force: true });
    pushBag();
    showToast(
      mode === "grok"
        ? "Usunięte z widoku (agent nadal to pamięta)"
        : "Usunięte z widoku",
      ""
    );
  }

  /** Wstaw treść do composera i odetnij historię od tego miejsca (widok). */
  function editMessage(m) {
    if (busy) {
      showToast("Najpierw zatrzymaj bieżącą turę (■)", "");
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
    el.input.focus();
    showToast(
      mode === "grok"
        ? "Popraw i wyślij. Uwaga: agent pamięta poprzednią wersję."
        : "Popraw i wyślij",
      "ok"
    );
  }

  /** Wyślij ponownie: z bańki usera tę samą, z bańki asystenta poprzedni prompt. */
  async function retryFrom(m) {
    if (busy) {
      showToast("Najpierw zatrzymaj bieżącą turę (■)", "");
      return;
    }
    const i = indexOfMsg(m);
    if (i < 0) return;
    const src = m.role === "user" ? m : lastUserBefore(i);
    if (!src) {
      showToast("Nie ma czego ponowić", "error");
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
    await runSendTurn(text || "(załącznik)", atts, false);
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

  function ensureStreamingAssistant() {
    if (streamingAssistant) return streamingAssistant;
    // reuse empty streaming shell already in history (po Enter)
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const m = allMessages[i];
      if (m.role === "assistant" && m._streaming) {
        streamingAssistant = m;
        return m;
      }
    }
    streamingAssistant = {
      id: `stream-${Date.now()}`,
      role: "assistant",
      text: "",
      tools: [],
      thinking: "",
      _streaming: true,
    };
    pushAll(streamingAssistant);
    // tylko jeśli nie ma w DOM
    const last = el.messages.lastElementChild;
    if (!last || !last.classList.contains("assistant")) {
      // nie wymuszaj stick — nie skacz na dół / górę
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
    // nie pisz do bufora obcej sesji niż busy
    if (busySessionId && sid !== busySessionId) return;
    const buf = ensureSessionStream(sid);
    const update = params.update || params;
    const kind = update.sessionUpdate;
    if (!kind) return;
    const ensure = () => {
      if (buf.streamingAssistant && buf.streamingAssistant._streaming) {
        return buf.streamingAssistant;
      }
      // reuse last streaming shell in buffer messages
      for (let i = buf.allMessages.length - 1; i >= 0; i--) {
        const m = buf.allMessages[i];
        if (m.role === "assistant" && m._streaming) {
          buf.streamingAssistant = m;
          return m;
        }
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
    if (kind === "user_message_chunk") return;
    if (kind === "agent_message_chunk") {
      const chunk = (update.content && update.content.text) || "";
      if (isToolEchoText(chunk) || isAttachmentJunkOnly(chunk)) return;
      const a = ensure();
      a.text += chunk;
      a.text = cleanAssistantText(a.text);
      buf.statusPhase = "responding";
      buf.statusDetail = "Piszę…";
    } else if (kind === "agent_thought_chunk") {
      ensure().thinking += (update.content && update.content.text) || "";
      buf.statusPhase = "thinking";
      buf.statusDetail = "Myślę…";
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
    const sid = (params && params.sessionId) || busySessionId || null;
    if (!sid) {
      // nieoznaczony stream — tylko do offscreen busySession jeśli znamy
      if (busySessionId) applyStreamOffscreen(busySessionId, params);
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
      a.text += chunk;
      setStatus("responding", "Piszę…", "home", { sessionId: sid });
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

    if (kind === "agent_message_chunk") {
      const chunk = (update.content && update.content.text) || "";
      if (isAttachmentJunkOnly(chunk)) return;
      if (isToolEchoText(chunk)) {
        setStatus("tool", "Pracuję w tle…", "grok", { sessionId: sid });
        if (streamingAssistant) {
          streamingAssistant.text = cleanAssistantText(streamingAssistant.text);
          patchLastAssistantBubble(streamingAssistant);
        }
        if (sid) snapshotCurrentBuildSession();
        return;
      }
      const a = ensureStreamingAssistant();
      a.text += chunk;
      a.text = cleanAssistantText(a.text);
      if (!a.text.trim()) {
        setStatus("tool", "Pracuję w tle…", "grok", { sessionId: sid });
        return;
      }
      setStatus("responding", "Piszę…", "grok", { sessionId: sid });
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
      setStatus("thinking", "Myślę…", "grok", { sessionId: sid });
      if (sid) snapshotCurrentBuildSession();
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
      renderActivity();
      patchAgentWorkPill(a);
      if (sid) snapshotCurrentBuildSession();
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
    const label = active.length
      ? `Pracuję: ${humanizeToolTitle(active[0].title)}${active.length > 1 ? ` +${active.length - 1}` : ""}`
      : done.length
        ? `${done.length} kroków w tle · „Kroki”`
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
    if (kind === "agent_message_chunk") {
      const chunk = (update.content && update.content.text) || "";
      if (isToolEchoText(chunk) || isAttachmentJunkOnly(chunk)) return;
      const a = ensure();
      a.text += chunk;
      a.text = cleanAssistantText(a.text);
    } else if (kind === "agent_thought_chunk") {
      ensure().thinking += (update.content && update.content.text) || "";
      b.statusPhase = "thinking";
      b.statusDetail = "Myślę…";
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
        : !busy
          ? false
          : !busySessionId ||
            busySessionId === liveSessionId ||
            busySessionId === selectedId;
    // Composer ZAWSZE aktywny — w trakcie myślenia da się pisać i kolejkować.
    el.btnSend.disabled = false;
    el.btnSend.classList.remove("hidden");
    el.btnSend.title = busy
      ? viewingBusySession
        ? "Dodaj do kolejki (wyśle po odpowiedzi)"
        : "Agent w innej sesji Build — Enter doda do kolejki"
      : "Send";
    el.btnSend.classList.toggle("queue-mode", busy);
    el.btnStop.classList.toggle("hidden", !busy);
    // Chip „Working” obok Auto — NIGDY; status = pasek Myślę… nad composerem
    if (el.busyChip) {
      el.busyChip.classList.add("hidden");
      el.busyChip.setAttribute("hidden", "");
    }
    el.input.disabled = false;
    el.input.readOnly = false;
    if (busy && viewingBusySession) {
      el.input.placeholder =
        "Pisz dalej — Enter doda do kolejki…";
      // trzymaj „Myślę…” widoczne przez całą pracę, nawet bez nowego setStatus
      if (el.statusBar.classList.contains("hidden")) {
        const d = bag().statusDetail;
        const p = bag().statusPhase;
        lastStatusLabel = d || (p === "tool" ? "Pracuję…" : "Myślę…");
        paintStatusText();
        el.statusBar.classList.remove("hidden");
      }
    } else if (busy && !viewingBusySession) {
      el.input.placeholder =
        "Agent pracuje w innej sesji Build…";
    } else {
      el.input.placeholder =
        "Message Grok… (Enter = send, ⌘V = wklej screenshot)";
    }
    updateQueueChip();
    if (!b) {
      if (!messageQueue.length) el.statusBar.classList.add("hidden");
      if (streamingAssistant) streamingAssistant._streaming = false;
    }
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
      chip.textContent = `Kolejka: ${messageQueue.length}`;
    } else {
      chip.classList.add("hidden");
    }
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
      showToast(res.error || "Nie udało się dodać pliku", "error");
      return;
    }
    attachments.push(res);
    renderAttachChips();
  }

  async function addAttachmentFromPath(p) {
    const res = await api.importAttachmentPath(p);
    if (!res.ok) {
      showToast(res.error || "Nie udało się zaimportować", "error");
      return;
    }
    attachments.push(res);
    renderAttachChips();
  }

  async function sendMessage(prefill) {
    const text = (prefill != null ? prefill : el.input.value).trim();
    if (!text && !attachments.length) return;

    const atts = attachments.slice();

    // Agent busy → kolejka. Dopowiedzenie = doklej do tej samej pozycji (nie nowa tura).
    if (busy) {
      const piece = text || "(załącznik)";
      const lastQ = messageQueue[messageQueue.length - 1];
      const lastMsg = lastAll();
      if (lastQ && (!atts.length || !(lastQ.attachments || []).length)) {
        // scal tekst + ewent. załączniki
        if (piece && piece !== "(załącznik)") {
          lastQ.text =
            lastQ.text && lastQ.text !== "(załącznik)"
              ? `${lastQ.text}\n${piece}`
              : piece;
        }
        if (atts.length) {
          lastQ.attachments = (lastQ.attachments || []).concat(atts);
        }
        if (lastMsg && lastMsg.role === "user" && lastMsg._queued) {
          lastMsg.text = lastQ.text;
          lastMsg.attachments = lastQ.attachments || [];
        }
        showToast("Doklejone do kolejki (1 wiadomość)", "ok");
      } else {
        messageQueue.push({ text: piece, attachments: atts });
        pushAll({
          id: `u-q-${Date.now()}`,
          role: "user",
          text: piece,
          tools: [],
          attachments: atts,
          _local: true,
          _queued: true,
        });
        showToast(`W kolejce (${messageQueue.length})`, "ok");
      }
      if (prefill == null) el.input.value = "";
      attachments = [];
      renderAttachChips();
      autosize();
      // nie full re-render przy busy — tylko ostatnia bańka (zero skoku scrolla)
      patchLastUserBubbleFromQueue();
      updateQueueChip();
      setStatus(
        "queued",
        "W kolejce — kliknij ↩ Wyślij teraz, albo poczekaj na koniec tury"
      );
      el.input.focus();
      return;
    }

    await runSendTurn(text || "(załącznik)", atts, prefill == null);
  }

  /**
   * ↩ na bańce w kolejce: przerwij bieżącą robotę i wyślij to TERAZ
   * (włączone w kontekst agenta — nie czekaj na „Gotowe”).
   *
   * Ważne: NIE czyść _queued przed runSendTurn i NIE doklejaj drugiej bańki.
   * Dopisek „Wstrzyknieto…” idzie tylko do API, nie do UI.
   */
  async function injectQueuedNow(msg) {
    const text = cleanUserText(msg?.text || "");
    const atts = (msg && msg.attachments) || [];
    if (!text && !atts.length) return;

    // zdejmij z kolejki (treść jest w bańce / msg)
    messageQueue = [];
    updateQueueChip();

    // stop bieżącej tury
    try {
      await api.chatStop({ mode });
    } catch {
      /* ignore */
    }
    setBusy(false);
    busySessionId = null;
    if (streamingAssistant) streamingAssistant._streaming = false;
    streamingAssistant = null;

    // Zostaw _queued na bańce — runSendTurn ma ją ZREUSE'ować, nie sklonować.
    // Dopisek tylko w payloadzie do agenta.
    const payload =
      (text || "(załącznik)") +
      "\n\n[Wstrzyknieto w trakcie pracy — włącz to w bieżące zadanie, nie zaczynaj od zera.]";

    // zdejmij badge „w kolejce” z DOM (tekst bańki bez zmian)
    const rows = el.messages.querySelectorAll(".msg.user");
    const lastUser = rows[rows.length - 1];
    if (lastUser) {
      lastUser.querySelector(".queued-actions")?.remove();
      lastUser.querySelector(".queued-badge")?.remove();
    }

    showToast("Wysyłam teraz (przerwano bieżącą turę)", "ok");
    await runSendTurn(payload, atts, false, { reuseQueuedBubble: true });
  }

  /**
   * @param {string} text — payload do API (może mieć marker wstrzyknięcia)
   * @param {object[]} atts
   * @param {boolean} clearInput
   * @param {{ reuseQueuedBubble?: boolean }} opts
   */
  async function runSendTurn(text, atts, clearInput, opts = {}) {
    const cwd = selectedRow()?.cwd || defaultCwd;
    const sessionId = liveSessionId || selectedId || null;
    const displayText = cleanUserText(text); // bez markerów / „Wstrzyknieto…”

    // Znajdź bańkę z kolejki do reuse (nie klonuj po wysłaniu)
    let queuedBubble = null;
    // 1) jawna flaga _queued (preferuj najnowszą)
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].role === "user" && allMessages[i]._queued) {
        queuedBubble = allMessages[i];
        break;
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
        displayText && displayText !== "(załącznik)" ? displayText : "";
      if (showText || (atts && atts.length)) {
        const userMsg = {
          id: `u-local-${Date.now()}`,
          role: "user",
          text: showText,
          tools: [],
          attachments: atts || [],
          _local: true,
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
    };
    pushAll(streamingAssistant);
    toAppend.push(streamingAssistant);
    liveTools = [];

    if (clearInput) el.input.value = "";
    attachments = [];
    renderAttachChips();
    autosize();
    // Enter: NIE wipe'uj DOM (replaceChildren = scrollTop→0 = skok w górę).
    // Tylko doklej nowe bańki na koniec + force scroll na dół.
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
      busySessionId = sessionId;
      snapshotCurrentBuildSession();
    }
    setStatus("thinking", mode === "home" ? "Myślę…" : "Agent startuje…", mode, {
      sessionId,
    });
    try {
      el.input.focus({ preventScroll: true });
    } catch {
      el.input.focus();
    }

    const res = await api.chatSend({
      text: text === "(załącznik)" ? "" : text,
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

    // posprzątaj echa które weszły mimo bramek
    dedupeTrailingUserMessages();
    if (res.ok && res.sessionId) {
      // domknij stream tej sesji w buforze
      const doneSid = res.sessionId;
      if (streamBySession[doneSid] && streamingAssistant) {
        streamingAssistant._streaming = false;
        snapshotCurrentBuildSession();
      }
      // po zakończeniu zostaw snapshot do momentu przeładowania transcriptu
    }
    if (busySessionId === (res.sessionId || sessionId)) {
      busySessionId = null;
    }
    setBusy(false);
    if (!res.ok) {
      showToast(res.error || "Nie udało się wysłać", "error");
      setStatus("error", res.error || "Błąd");
      el.input.focus();
      // nadal spróbuj kolejkę
      await drainQueue();
      return;
    }

    liveSessionId = res.sessionId;
    selectedId = res.sessionId;
    if (streamingAssistant) streamingAssistant._streaming = false;

    if (mode === "home" && res.assistant) {
      if (streamingAssistant) {
        streamingAssistant.text = res.assistant.content || "";
        streamingAssistant.images = res.assistant.images || [];
        streamingAssistant._streaming = false;
        // podmień ostatnią bańkę asystenta bez wipe
        const lastRow = el.messages.lastElementChild;
        if (lastRow && lastRow.classList.contains("assistant")) {
          lastRow.replaceWith(buildMessageRow(streamingAssistant));
          scrollChatToBottom(true);
        } else {
          appendMessageRows([streamingAssistant], { stick: true });
        }
      } else {
        const msg = {
          id: res.assistant.id,
          role: "assistant",
          text: res.assistant.content || "",
          images: res.assistant.images || [],
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
      badge.textContent = "w kolejce";
      const inject = document.createElement("button");
      inject.type = "button";
      inject.className = "queued-inject";
      inject.title = "Wyślij teraz — przerwij i dołącz do bieżącej roboty";
      inject.textContent = "↩ Wyślij teraz";
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

  /** Zlej całą kolejkę w jedną wiadomość (dopowiedzenia = jedna tura, nie N). */
  function coalesceQueue() {
    if (!messageQueue.length) return null;
    const items = messageQueue.splice(0, messageQueue.length);
    const texts = [];
    const atts = [];
    for (const it of items) {
      const t = (it.text || "").trim();
      if (t && t !== "(załącznik)") texts.push(t);
      if (it.attachments && it.attachments.length) {
        atts.push(...it.attachments);
      }
    }
    // UI: jedna bańka „w kolejce” (zostaje _queued → runSendTurn nie dubluje)
    const queuedBubbles = allMessages.filter((m) => m._queued && m.role === "user");
    if (queuedBubbles.length) {
      const keep = queuedBubbles[0];
      keep.text = texts.join("\n") || "(załącznik)";
      keep.attachments = atts;
      for (let i = 1; i < queuedBubbles.length; i++) {
        const id = queuedBubbles[i].id;
        const idx = allMessages.findIndex((m) => m.id === id);
        if (idx >= 0) allMessages.splice(idx, 1);
      }
      syncVisibleMessages();
    }
    return {
      text: texts.join("\n") || "(załącznik)",
      attachments: atts,
    };
  }

  async function drainQueue() {
    if (drainingQueue || busy) return;
    if (!messageQueue.length) {
      updateQueueChip();
      return;
    }
    drainingQueue = true;
    updateQueueChip();
    setStatus("queued", "Kolejka → jedna wiadomość…");
    const merged = coalesceQueue();
    updateQueueChip();
    if (merged) {
      await runSendTurn(merged.text, merged.attachments || [], false);
    }
    // gdy w trakcie tury znów coś wpadło do kolejki
    while (messageQueue.length && !busy) {
      const again = coalesceQueue();
      updateQueueChip();
      if (!again) break;
      setStatus("queued", "Kolejka → jedna wiadomość…");
      await runSendTurn(again.text, again.attachments || [], false);
    }
    drainingQueue = false;
    updateQueueChip();
  }

  async function newChat() {
    selectedId = null;
    liveSessionId = null;
    allMessages = [];
    messages = [];
    streamingAssistant = null;
    liveTools = [];
    visibleCount = PAGE;
    attachments = [];
    messageQueue = [];
    bag().wsTitle = "New chat";
    renderAttachChips();
    el.wsTitle.textContent = "New chat";
    updatePathChips(mode === "home" ? "" : defaultCwd);
    pinMessagesBottom(false);
    renderMessages({ forceScroll: true });
    renderList();
    renderActivity();
    el.input.focus();

    if (mode === "home") {
      const res = await api.chatNew({ mode: "home" });
      if (res.ok) {
        liveSessionId = res.sessionId;
        selectedId = res.sessionId;
        await refresh();
      }
    }
    pushBag();
    persistNav();
    showToast(mode === "home" ? "Nowy czat Home" : "Nowa sesja Build — pisz poniżej", "ok");
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
      showToast("Wybierz czat z listy (albo New chat)", "");
      return;
    }
    const row = rowsForMode().find((r) => r.id === id);
    if (!row && act !== "copy") {
      showToast("Sesja nie znaleziona", "error");
      return;
    }

    if (act === "copy") {
      await navigator.clipboard.writeText(id);
      showToast("ID skopiowane", "ok");
      return;
    }
    if (act === "unread") {
      await markSessionFlag(id, { unread: true });
      showToast("Oznaczone jako nieprzeczytane", "ok");
      return;
    }
    if (act === "read") {
      await markSessionFlag(id, { unread: false });
      showToast("Oznaczone jako przeczytane", "ok");
      return;
    }
    if (act === "pin") {
      const cur = sessionFlagMap[id] || {};
      await markSessionFlag(id, { pinned: !cur.pinned });
      showToast(cur.pinned ? "Odpięte" : "Przypięte", "ok");
      return;
    }
    if (act === "reveal") {
      if (mode === "home") {
        showToast("Home chats: ~/Library/Application Support/grok-sessions/home-chats", "");
        return;
      }
      const res = await api.revealSession(row.dirPath);
      if (!res.ok) showToast(res.error, "error");
      return;
    }
    if (act === "delete") {
      const ok = await modalPrompt({
        title: "Delete chat?",
        body: `${row.title}\n\nPermanent.`,
        okLabel: "Delete",
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
          el.wsTitle.textContent = "New chat";
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
        title: "Rename",
        body: "Tytuł na liście",
        okLabel: "Save",
        inputValue: row.title,
      });
      if (name == null || !String(name).trim()) return;
      const res = await api.renameSession({
        id,
        title: String(name).trim(),
        mode,
      });
      if (!res.ok) showToast(res.error || "Nie udało się zmienić nazwy", "error");
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
      el.input.placeholder = "Opisz grafikę… (proporcje po prawej)";
    } else if (homeKind === "video") {
      el.input.placeholder = "Opisz wideo… (jeśli API niedostępne → storyboard)";
    } else {
      el.input.placeholder =
        "Message Grok… (Enter = send, ⌘V = wklej screenshot)";
    }
  });

  document.getElementById("effort-select")?.addEventListener("change", async (e) => {
    effortLevel = e.target.value || "high";
    const res = await api.chatSetEffort(effortLevel);
    if (!res.ok) showToast(res.error || "Nie udało się zmienić effort", "error");
    else showToast(`Effort: ${effortLevel}`, "ok");
  });
  el.form.onsubmit = (e) => {
    e.preventDefault();
    sendMessage();
  };
  el.input.addEventListener("input", autosize);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  el.filter.addEventListener("input", (e) => {
    filter = e.target.value || "";
    renderList();
  });
  el.btnStop.onclick = async () => {
    // przekaż tryb — w Home trzeba przerwać żądanie HTTP, nie proces agenta
    const res = await api.chatStop({ mode });
    setBusy(false);
    if (!res.ok) showToast(res.error || "Nie udało się zatrzymać", "error");
    else showToast("Zatrzymane", "ok");
  };
  el.modelSelect.addEventListener("change", async () => {
    const id = el.modelSelect.value;
    if (mode === "home") homeModelId = id;
    else codeModelId = id;
    const res = await api.chatSetModel({ modelId: id, mode });
    if (!res.ok) showToast(res.error || "Nie udało się zmienić modelu", "error");
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
    if (!res.ok) showToast(res.error || "Logowanie nie wystartowało", "error");
    else showToast("Logowanie otwarte w Terminalu", "ok");
  };
  document.getElementById("set-save").onclick = async () => {
    const theme = document.getElementById("set-theme").value;
    const permissionMode = document.getElementById("set-permission").value;
    await api.setSettings({
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
    el.settingsModal.classList.add("hidden");
    showToast("Zapisane", "ok");
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
    if (!res.ok) showToast(res.error || "Logowanie nie wystartowało", "error");
    else showToast("Logowanie otwarte", "ok");
  };

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      newChat();
    }
  });

  api.onUpdated(applyPayload);
  api.onChatUpdate(handleChatUpdate);
  api.onChatBusy(({ busy: b, sessionId, mode: evMode }) => {
    // Home i Build mają teraz osobne tory — zdarzenie z jednego nie może
    // przestawiać stanu drugiego.
    if (evMode === "home") {
      bags.home.busy = Boolean(b);
      if (mode === "home") setBusy(Boolean(b), "home");
      return;
    }
    if (b) {
      busySessionId =
        sessionId || busySessionId || null;
      // nie bierz selectedId jako busy — to była dziura
      if (!busySessionId && mode === "grok") {
        busySessionId = liveSessionId || selectedId || null;
      }
      bags.grok.busy = true;
      if (busySessionId && isViewingSession(busySessionId)) {
        snapshotCurrentBuildSession();
      }
    } else {
      if (busySessionId) {
        const buf = streamBySession[busySessionId];
        if (buf && buf.streamingAssistant) {
          buf.streamingAssistant._streaming = false;
        }
      }
      busySessionId = null;
      bags.grok.busy = false;
    }
    const viewingWork = b && busySessionId && isViewingSession(busySessionId);
    if (mode === "home") {
      bags.grok.busy = Boolean(b);
      el.busyChip.classList.add("hidden");
      el.statusBar.classList.add("hidden");
      renderList();
      return;
    }
    if (viewingWork) {
      setBusy(true, mode);
    } else if (b) {
      // pracuje indziej — kolejka OK, zero statusu Myślę
      busy = true;
      bags.grok.busy = true;
      el.busyChip.classList.add("hidden");
      el.btnStop.classList.remove("hidden");
      el.btnSend.classList.add("queue-mode");
      el.input.placeholder = "Agent pracuje w innej sesji Build…";
      el.statusBar.classList.add("hidden");
      el.statusText.textContent = "";
      liveTools = [];
      renderActivity();
    } else {
      setBusy(false, mode);
      el.statusBar.classList.add("hidden");
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
    const sid = sessionId || busySessionId || null;
    // zero statusu na obcej sesji
    if (mode === "grok" && busySessionId && selectedId !== busySessionId) {
      const buf = ensureSessionStream(busySessionId);
      if (buf) {
        buf.statusPhase = phase;
        buf.statusDetail = detail || "";
      }
      el.statusBar.classList.add("hidden");
      return;
    }
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
    permMode = data.settings?.permissionMode || "auto";
    paintPermChip();
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
          usageEls.weeklyMeta.textContent = Math.round(weekly.percent) + "% użyte";
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
            "Zaloguj się w Arc/Chrome na grok.com — stamtąd bierzemy % tygodniowy";
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
          mode === "home" ? "Home (brak signals)" : "—";
        setBar(usageEls.ctxBar, 0);
      }
      const used = u.context?.tokensUsed;
      const total = u.context?.tokensTotal;
      if (usageEls.ctxTokens) {
        usageEls.ctxTokens.textContent =
          used != null && total != null
            ? `${fmtTokens(used)} / ${fmtTokens(total)} · tury ${u.context?.turns ?? "—"} · tool ${u.context?.tools ?? "—"}`
            : mode === "home"
              ? "Home nie zapisuje context window jak Build"
              : "Brak signals.json — otwórz sesję Build";
      }
      const planBit = plan?.tierLabel ? ` · ${plan.tierLabel}` : "";
      if (usageEls.account) {
        usageEls.account.textContent = u.account?.email
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
      ? "Agent pyta o zgodę na każde narzędzie. Kliknij, żeby przełączyć na Auto."
      : "Agent używa narzędzi bez pytania. Kliknij, żeby przełączyć na Pytaj.";
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
          ? "Pytaj: agent poprosi o zgodę na każde narzędzie"
          : "Auto: agent działa bez pytania",
        "ok"
      );
    };
  }

  /* ===== Modal zgody na narzędzie ===== */
  const permModal = document.getElementById("perm-modal");
  const permQueue = [];
  let permShowing = false;

  function toolLabel(toolCall) {
    if (!toolCall) return "Narzędzie";
    return (
      toolCall.title ||
      toolCall.kind ||
      toolCall.name ||
      toolCall.toolName ||
      "Narzędzie"
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
    deny.textContent = "Odmów";
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
      btn.textContent = "Skopiowane";
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    } catch {
      showToast("Nie udało się skopiować", "error");
    }
  });

  bindChatScrollWatcher();

  boot().catch((err) => {
    console.error("boot failed", err);
    setMode("home");
    refresh();
  });
})();
