#!/usr/bin/env node
"use strict";

/**
 * E2E na ŻYWEJ aplikacji: `npm run e2e`.
 *
 * Po co to istnieje. 17.08 cztery poprawki zostały zgłoszone jako zrobione,
 * a nie robiły nic — literówka wpisywała je do cichej zmiennej globalnej.
 * `npm test` świecił na zielono, bo sprawdzał źródło, nie zachowanie.
 * Ten skrypt odpala prawdziwe okno i przechodzi scenariusze, które się psuły.
 *
 * Instancja jest WŁASNA (GROK_SESSIONS_E2E = osobna nazwa i katalog danych),
 * więc nie kłóci się z aplikacją, której używa człowiek.
 *
 * Uwaga: test wysyła kilka krótkich promptów do agenta `grok` — kosztuje tokeny.
 */

const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.E2E_PORT || 9412);
const UDD = path.join(
  process.env.TMPDIR || "/tmp",
  "supergrok-e2e-" + process.pid
);
const ELECTRON = path.join(
  ROOT,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let zdane = 0;
const bledy = [];

function ok(nazwa) {
  zdane++;
  console.log("  ok  " + nazwa);
}
function fail(nazwa, powod) {
  bledy.push(nazwa + " — " + powod);
  console.error("  FAIL " + nazwa);
  console.error("       " + powod);
}
function sprawdz(nazwa, warunek, powod) {
  if (warunek) ok(nazwa);
  else fail(nazwa, powod);
}

/* ── uruchomienie okna ───────────────────────────────────────────────── */

function pobierzJson(sciezka) {
  return new Promise((res, rej) => {
    http
      .get(`http://127.0.0.1:${PORT}${sciezka}`, (r) => {
        let s = "";
        r.on("data", (d) => (s += d));
        r.on("end", () => {
          try {
            res(JSON.parse(s));
          } catch (e) {
            rej(e);
          }
        });
      })
      .on("error", rej);
  });
}

async function czekajNaStrone(sekundy = 40) {
  for (let i = 0; i < sekundy * 2; i++) {
    try {
      const t = await pobierzJson("/json");
      const strona = t.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (strona) return strona;
    } catch {
      /* jeszcze nie wstalo */
    }
    await sleep(500);
  }
  throw new Error("okno nie wstało w " + sekundy + "s");
}

async function polacz(strona) {
  const ws = new WebSocket(strona.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const czekajace = new Map();
  const zdarzenia = [];
  ws.onmessage = (m) => {
    const o = JSON.parse(m.data);
    if (o.id && czekajace.has(o.id)) {
      czekajace.get(o.id)(o);
      czekajace.delete(o.id);
    } else if (o.method) zdarzenia.push(o);
  };
  const wyslij = (method, params) =>
    new Promise((res) => {
      const myId = ++id;
      czekajace.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
  const oceń = async (expr) => {
    const r = await wyslij("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    const wynik = r.result || {};
    if (wynik.exceptionDetails) {
      throw new Error(
        "błąd w oknie: " +
          (wynik.exceptionDetails.exception?.description || "").split("\n")[0]
      );
    }
    return wynik.result && wynik.result.value;
  };
  await wyslij("Runtime.enable");
  return { wyslij, oceń, zdarzenia, zamknij: () => ws.close() };
}

/* ── pomocnicze akcje w oknie ────────────────────────────────────────── */

const JS = {
  trybBuild: `document.getElementById("tab-grok").click()`,
  trybHome: `document.getElementById("tab-home").click()`,
  nowaSesja: `document.getElementById("btn-new").click()`,
  wyslij: (t) => `(() => {
    const ta = document.getElementById("input");
    ta.value = ${JSON.stringify(t)};
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("btn-send").click();
    return true;
  })()`,
  banki: `(() => [...document.querySelectorAll("#messages .msg")].map((m) => ({
    r: m.classList.contains("user") ? "user" : "grok",
    t: (m.querySelector(".msg-content")?.textContent || "").trim(),
  })))()`,
  lista: `(() => [...document.querySelectorAll("#session-list .session-item")].map((i) => ({
    t: i.querySelector(".title").textContent,
    wybrana: i.classList.contains("selected"),
    pracuje: i.classList.contains("working"),
  })))()`,
  klik: (frag) => `(() => {
    const it = [...document.querySelectorAll("#session-list .session-item")]
      .find((i) => i.querySelector(".title").textContent.includes(${JSON.stringify(frag)}));
    if (!it) return null;
    it.click();
    return it.querySelector(".title").textContent;
  })()`,
  scrollTop: `document.getElementById("chat-scroll").scrollTop`,
  kolejka: `document.querySelectorAll("#queue-dock .queue-dock-item").length`,
};

/**
 * Czekaj na KONIEC tury. Najpierw na jej start — inaczej sprawdzenie „czy
 * pasek zgasł" wracalo prawda natychmiast, bo tura jeszcze nie ruszyla,
 * i test czytal pusta banke.
 */
async function czekajNaKoniec(k, maxS = 120) {
  const pracuje = () =>
    k.oceń(`!document.getElementById("status-bar").classList.contains("hidden")`);
  for (let i = 0; i < 40 && !(await pracuje()); i++) await sleep(250);
  let spokoj = 0;
  for (let i = 0; i < maxS * 2; i++) {
    if (await pracuje()) spokoj = 0;
    else if (++spokoj >= 6) return true; // 3 s ciszy = naprawde koniec
    await sleep(500);
  }
  return false;
}

function duplikaty(banki) {
  const zle = [];
  for (let i = 1; i < banki.length; i++) {
    if (banki[i].r === banki[i - 1].r && banki[i].t && banki[i].t === banki[i - 1].t) {
      zle.push(banki[i].t.slice(0, 50));
    }
  }
  return zle;
}

/* ── scenariusze ─────────────────────────────────────────────────────── */

async function scenariusze(k) {
  console.log("\nstart okna");
  const wyjatki = k.zdarzenia.filter((e) => e.method === "Runtime.exceptionThrown");
  sprawdz(
    "start bez wyjątków w konsoli",
    wyjatki.length === 0,
    wyjatki
      .map((e) => e.params.exceptionDetails.exception?.description?.split("\n")[0])
      .join(" | ")
  );
  const moduly = await k.oceń(`JSON.stringify({
    cs: typeof window.chatScroll, ch: typeof window.chatHistory,
    ws: typeof window.workSummary, md: typeof window.renderMarkdown })`);
  const m = JSON.parse(moduly);
  sprawdz(
    "wszystkie moduły renderera żyją w oknie",
    m.cs === "object" && m.ch === "object" && m.ws === "object" && m.md === "function",
    moduly
  );

  await k.oceń(JS.trybBuild);
  await sleep(600);

  /* 1. Jedna tura = jedna bańka (zadanie z narzędziami) */
  console.log("\n1. jedna tura = jedna bańka");
  await k.oceń(JS.nowaSesja);
  await sleep(500);
  await k.oceń(
    JS.wyslij(
      "Policz pliki w katalogu src tego repo uzywajac narzedzi, potem policz linie w src/markdown.js, " +
        "i na koncu napisz jedno zdanie podsumowania. Repo: " + ROOT
    )
  );
  await sleep(4000);
  const skonczyla = await czekajNaKoniec(k, 120);
  sprawdz("tura z narzędziami kończy się", skonczyla, "pasek pracy nie zgasł w 120 s");
  await sleep(1500);
  const b1 = await k.oceń(JS.banki);
  const asyst = b1.filter((x) => x.r === "grok");
  sprawdz(
    "jedna odpowiedź to JEDNA bańka",
    asyst.length === 1,
    `bańek asystenta: ${asyst.length} — ${JSON.stringify(asyst.map((a) => a.t.slice(0, 30)))}`
  );
  sprawdz("brak duplikatów treści", duplikaty(b1).length === 0, JSON.stringify(duplikaty(b1)));
  sprawdz(
    "odpowiedź nie jest pusta",
    asyst[0] && asyst[0].t.length > 5,
    "pusta bańka asystenta"
  );

  /* 2. Kolejka przeżywa przełączenie sesji */
  console.log("\n2. kolejka należy do sesji");
  await k.oceń(JS.wyslij("Napisz doslownie: DRUGA-TURA"));
  await sleep(1500);
  await k.oceń(JS.wyslij("to jest wiadomosc w kolejce")); // busy → do kolejki
  await sleep(800);
  const kolejkaPrzed = await k.oceń(JS.kolejka);
  await czekajNaKoniec(k, 90);
  sprawdz(
    "wiadomość wysłana w trakcie tury trafia do kolejki",
    kolejkaPrzed >= 1,
    "kolejka pusta — dopowiedzenie przepadło"
  );

  /* 3. Dwie sesje równolegle — każda ze swoją treścią */
  console.log("\n3. dwie sesje, każda swoja");
  await k.oceń(JS.nowaSesja);
  await sleep(400);
  await k.oceń(JS.wyslij("Napisz doslownie: SESJA-ALFA"));
  await sleep(700);
  await k.oceń(JS.nowaSesja);
  await sleep(400);
  await k.oceń(JS.wyslij("Napisz doslownie: SESJA-BETA"));
  await sleep(700);
  for (let i = 0; i < 6; i++) {
    await k.oceń(JS.klik("ALFA") || "null");
    await sleep(500);
    await k.oceń(JS.klik("BETA") || "null");
    await sleep(500);
  }
  await sleep(20000);

  for (const [nazwa, znacznik, obcy] of [
    ["ALFA", "SESJA-ALFA", "SESJA-BETA"],
    ["BETA", "SESJA-BETA", "SESJA-ALFA"],
  ]) {
    const tytul = await k.oceń(JS.klik(znacznik));
    await sleep(2500);
    const b = await k.oceń(JS.banki);
    sprawdz(
      `sesja ${nazwa}: brak duplikatów`,
      duplikaty(b).length === 0,
      JSON.stringify(duplikaty(b))
    );
    sprawdz(
      `sesja ${nazwa}: zero treści z drugiej sesji`,
      !b.some((x) => x.t.includes(obcy)),
      `znaleziono „${obcy}" w czacie ${nazwa} (tytuł: ${tytul})`
    );
    sprawdz(
      `sesja ${nazwa}: ma swoją odpowiedź`,
      b.some((x) => x.r === "grok" && x.t.length > 2),
      "brak odpowiedzi agenta"
    );
  }

  /* 4. Jedna karta zaznaczona */
  const lista = await k.oceń(JS.lista);
  sprawdz(
    "dokładnie jedna karta jest zaznaczona",
    lista.filter((x) => x.wybrana).length === 1,
    `zaznaczonych: ${lista.filter((x) => x.wybrana).length}`
  );

  /* 5. Scroll w trakcie streamu */
  console.log("\n4. scroll w trakcie pisania");
  await k.oceń(
    JS.wyslij("Wypisz 40 nazw plikow zrodlowych projektu Node, numerowana lista, bez komentarzy.")
  );
  await sleep(4000);
  const przed = await k.oceń(`(() => {
    const box = document.getElementById("chat-scroll");
    box.scrollTop = 100;
    box.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }));
    return box.scrollTop;
  })()`);
  await sleep(6000);
  const po = await k.oceń(JS.scrollTop);
  sprawdz(
    "widok zostaje po przewinięciu w górę",
    Math.abs(po - przed) < 60,
    `scrollTop ${przed} → ${po}`
  );
  await czekajNaKoniec(k, 120);

  /* 6. Follow-up ląduje na końcu */
  console.log("\n5. follow-up na końcu");
  await k.oceń(JS.wyslij("Napisz doslownie: FOLLOW-UP-OK"));
  await czekajNaKoniec(k, 90);
  const b6 = await k.oceń(JS.banki);
  const idxUser = b6.map((x) => x.r).lastIndexOf("user");
  sprawdz(
    "wiadomość użytkownika nie ląduje w środku historii",
    idxUser === b6.length - 2 || idxUser === b6.length - 1,
    `kolejność: ${b6.map((x) => x.r).join(">")}`
  );
  sprawdz("brak duplikatów po follow-upie", duplikaty(b6).length === 0, JSON.stringify(duplikaty(b6)));

  /* 7. Przełączanie trybów */
  console.log("\n6. Home ↔ Build");
  const tytulBuild = await k.oceń(`document.getElementById("ws-title").textContent`);
  for (let i = 0; i < 3; i++) {
    await k.oceń(JS.trybHome);
    await sleep(900);
    await k.oceń(JS.trybBuild);
    await sleep(900);
  }
  const tytulPo = await k.oceń(`document.getElementById("ws-title").textContent`);
  sprawdz(
    "przełączanie trybów nie gubi otwartej sesji",
    tytulPo === tytulBuild,
    `„${tytulBuild}" → „${tytulPo}"`
  );
  const b7 = await k.oceń(JS.banki);
  sprawdz("po powrocie do Build czat nie jest pusty", b7.length > 0, "zero bańek");

  /* 8. Zero wyjątków przez cały przebieg */
  const wyjatkiKoncowe = k.zdarzenia.filter((e) => e.method === "Runtime.exceptionThrown");
  sprawdz(
    "zero wyjątków w całym przebiegu",
    wyjatkiKoncowe.length === 0,
    wyjatkiKoncowe
      .map((e) => e.params.exceptionDetails.exception?.description?.split("\n")[0])
      .slice(0, 5)
      .join(" | ")
  );
}

/* ── główna pętla ────────────────────────────────────────────────────── */

(async () => {
  const proc = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, GROK_SESSIONS_E2E: UDD },
  });

  let k = null;
  try {
    const strona = await czekajNaStrone(45);
    k = await polacz(strona);
    await sleep(1500);
    await scenariusze(k);
  } catch (err) {
    fail("przebieg E2E", err.message);
  } finally {
    if (k) {
      try {
        k.zamknij();
      } catch {
        /* ignore */
      }
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await sleep(1200);
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }

  console.log(
    "\n" +
      zdane +
      " sprawdzeń przeszło" +
      (bledy.length ? ", błędów: " + bledy.length : ", zero błędów")
  );
  if (bledy.length) {
    console.error("\nDo naprawy:");
    bledy.forEach((b) => console.error(" - " + b));
    process.exit(1);
  }
})();
