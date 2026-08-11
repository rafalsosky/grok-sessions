#!/usr/bin/env node
"use strict";

/**
 * Szybkie testy logiki bez UI i bez sieci: `npm test`.
 * Pilnują rzeczy, które faktycznie się psuły (patrz komentarze przy każdej
 * grupie). Zero frameworków — czysty assert, wychodzi 1 przy błędzie.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (err) {
    console.error("  FAIL " + name);
    console.error("       " + err.message);
    process.exitCode = 1;
  }
}

function group(name) {
  console.log("\n" + name);
}

/* ── 1. Heurystyka „to prośba o grafikę” ───────────────────────────────
   Wcześniej każde zdanie zaczynające się od „wygeneruj” szło do generatora
   obrazów, więc „wygeneruj listę hooków” zwracało obrazek. */
group("xai-api: rozpoznawanie próśb o grafikę");
{
  const xai = require("../electron/xai-api");
  const yes = [
    "/image a dog",
    "/img kot",
    "wygeneruj grafikę psa",
    "narysuj ilustrację miasta",
    "stwórz obraz zachodu słońca",
    "zrób mi zdjęcie produktu",
    "generate an image of a cat",
    "imagine a red car",
    "grafika: minimalistyczne logo",
  ];
  const no = [
    "wygeneruj listę 10 hooków",
    "wygeneruj raport sprzedaży",
    "zrób plan treści na 7 dni",
    "napisz mi maila do klienta",
    "narysuj wnioski z tych danych w tabeli",
    "",
  ];
  for (const t of yes) {
    test(`grafika: ${JSON.stringify(t)}`, () =>
      assert.strictEqual(xai.looksLikeImagePrompt(t), true));
  }
  for (const t of no) {
    test(`tekst: ${JSON.stringify(t)}`, () =>
      assert.strictEqual(xai.looksLikeImagePrompt(t), false));
  }
}

/* ── 2. Markdown ──────────────────────────────────────────────────────
   Bloki kodu były wycinane z odpowiedzi w trybie Build; tu pilnujemy, że
   przechodzą i że treść jest escapowana (renderMarkdown idzie w innerHTML). */
group("markdown: bloki kodu i bezpieczeństwo");
{
  const { renderMarkdown } = require("../src/markdown.js");

  test("blok kodu zostaje w wyniku", () => {
    const out = renderMarkdown("Przed\n\n```js\nconst a = 1;\n```\n\nPo");
    assert.ok(out.includes("md-code-wrap"), "brak opakowania bloku");
    assert.ok(out.includes("const a = 1;"), "zgubiona treść kodu");
  });

  test("niedomknięty fence ze streamu też się renderuje", () => {
    const out = renderMarkdown("Start:\n\n```python\nimport os");
    assert.ok(out.includes("import os"));
    assert.ok(out.includes("md-code"));
  });

  test("HTML z odpowiedzi modelu jest escapowany", () => {
    const out = renderMarkdown("```html\n<img src=x onerror=alert(1)>\n```");
    assert.ok(!out.includes("<img src=x"), "wstrzyknięty tag przeszedł");
    assert.ok(out.includes("&lt;img"));
  });

  test("escapowanie w zwykłym akapicie", () => {
    const out = renderMarkdown('<script>alert("x")</script>');
    assert.ok(!out.includes("<script>"));
  });

  test("linki tylko http(s)", () => {
    const ok = renderMarkdown("[klik](https://x.ai)");
    assert.ok(ok.includes('href="https://x.ai"'));
    const bad = renderMarkdown("[klik](javascript:alert(1))");
    assert.ok(!bad.includes("href=\"javascript:"), "przeszedł link javascript:");
  });

  // Regresja: normalizeMarkdown wstawiał puste linie wokół |---|---|,
  // co dzieliło poprawną tabelę na trzy bloki, a separator lądował
  // w czacie jako zwykły tekst.
  test("tabela ma nagłówek i nie gubi wierszy", () => {
    const out = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    assert.ok(out.includes("<table"), "brak tabeli");
    assert.ok(out.includes("<th>A</th>"), "brak wiersza nagłówka");
    assert.ok(out.includes("<td>1</td>"), "zgubiony wiersz danych");
    assert.ok(!out.includes("|---"), "separator wyciekł jako tekst");
  });

  test("tabela sklejona bez nowych linii też się składa", () => {
    const out = renderMarkdown("Tekst| A | B ||---|---||1|2|");
    assert.ok(out.includes("<th>A</th>"));
    assert.ok(!out.includes("|---"));
  });
}

/* ── 3. Ustawienia ────────────────────────────────────────────────────
   Nowe pola: tryb uprawnień, opt-in na ciasteczka, limit tokenów. */
group("settings: walidacja i wartości domyślne");
{
  const { loadSettings, saveSettings } = require("../electron/settings");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-settings-test-"));

  test("domyślnie: Auto, ciasteczka wyłączone", () => {
    const s = loadSettings(dir);
    assert.strictEqual(s.permissionMode, "auto");
    assert.strictEqual(s.readBrowserCookies, false);
    assert.ok(s.homeMaxTokens >= 1024);
  });

  test("nieznany tryb uprawnień wraca do auto", () => {
    const s = saveSettings(dir, { permissionMode: "cokolwiek" });
    assert.strictEqual(s.permissionMode, "auto");
  });

  test("tryb ask zapisuje się i wraca", () => {
    const s = saveSettings(dir, { permissionMode: "ask" });
    assert.strictEqual(s.permissionMode, "ask");
    assert.strictEqual(loadSettings(dir).permissionMode, "ask");
  });

  test("limit tokenów jest przycinany do zakresu", () => {
    assert.strictEqual(saveSettings(dir, { homeMaxTokens: 10 }).homeMaxTokens, 1024);
    assert.strictEqual(
      saveSettings(dir, { homeMaxTokens: 999999 }).homeMaxTokens,
      32768
    );
  });

  test("motyw spoza listy wraca do dark", () => {
    assert.strictEqual(saveSettings(dir, { theme: "neon" }).theme, "dark");
    assert.strictEqual(saveSettings(dir, { theme: "light" }).theme, "light");
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 4. Czyszczenie tekstu z markerów załączników ─────────────────────
   Regex miał zaszytą nazwę użytkownika (/Users/sosky/), więc u kogokolwiek
   innego nie działał. */
group("attachments: markery nie wyciekają do czatu");
{
  const {
    formatAttachmentsForPrompt,
    stripAttachmentAppendix,
  } = require("../electron/attachments");

  test("blok załączników jest wycinany w całości", () => {
    const block = formatAttachmentsForPrompt([
      { path: "/Users/ktokolwiek/attachments/a.png", kind: "image" },
    ]);
    const out = stripAttachmentAppendix("Cześć" + block);
    assert.strictEqual(out, "Cześć");
  });

  test("działa dla dowolnego użytkownika, nie tylko jednego", () => {
    for (const home of ["/Users/ala", "/home/bob", "/Users/sosky"]) {
      const txt = `Tekst\n"${home}/Library/attachments/x.png"`;
      assert.ok(
        !stripAttachmentAppendix(txt).includes("attachments"),
        "została ścieżka dla " + home
      );
    }
  });
}

/* ── 5. Brak zaszytych danych osobowych w kodzie ──────────────────────
   To repo jest publiczne. */
group("repo: bez zaszytych ścieżek i danych osobowych");
{
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        ["node_modules", ".git", "assets", "dist", "tmp", "out", "coverage"].includes(
          e.name
        )
      ) {
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|css|html|json|md)$/.test(e.name) && e.name !== "package-lock.json") {
        files.push(full);
      }
    }
  };
  walk(ROOT);

  // Nazwa konta w ścieżce (\/Users\/xxx) — wykrywa też wersję escapowaną w regexach
  const hardcodedHome = /Users[\\/]+sosky|home[\\/]+sosky/;
  const personalTool = /notebooklm-py|cpython-3\.12\.13-macos/;

  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const src = fs.readFileSync(f, "utf8");
    test(`${rel}: bez zaszytego katalogu domowego`, () => {
      const hit = src.match(hardcodedHome);
      // test-units.js sam trzyma te wzorce jako dane testowe
      if (rel === path.join("scripts", "test-units.js")) return;
      assert.ok(!hit, `znaleziono: ${hit && hit[0]}`);
    });
    test(`${rel}: bez ścieżek do prywatnych narzędzi`, () => {
      if (rel === path.join("scripts", "test-units.js")) return;
      const hit = src.match(personalTool);
      assert.ok(!hit, `znaleziono: ${hit && hit[0]}`);
    });
  }
}

/* ── 6. CSS: animacje mają swoje klatki ───────────────────────────────
   Trzy wskaźniki „pracuje" powoływały się na @keyframes, których w pliku
   nie było, więc nic nie migało. */
group("css: animacje są zdefiniowane");
{
  const css = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");
  const used = [...css.matchAll(/animation:\s*([A-Za-z0-9_-]+)/g)]
    .map((m) => m[1])
    .filter((n) => n !== "none" && n !== "inherit" && n !== "initial");
  const defined = new Set(
    [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1])
  );
  for (const name of new Set(used)) {
    test(`@keyframes ${name} istnieje`, () =>
      assert.ok(defined.has(name), `brak definicji @keyframes ${name}`));
  }
}

/* ── 7. Electron: okna i nawigacja są zabezpieczone ───────────────────
   Bez tego link z odpowiedzi modelu otwierał obcą stronę w oknie apki. */
group("electron: twarde zabezpieczenia w main.js");
{
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
  test("setWindowOpenHandler jest ustawiony", () =>
    assert.ok(main.includes("setWindowOpenHandler")));
  test("will-navigate jest obsłużone", () =>
    assert.ok(main.includes("will-navigate")));
  test("openExternal tylko dla http(s)", () =>
    assert.ok(/protocol === "http:"/.test(main) && /protocol === "https:"/.test(main)));
  test("contextIsolation włączone, nodeIntegration wyłączone", () => {
    assert.ok(/contextIsolation:\s*true/.test(main));
    assert.ok(/nodeIntegration:\s*false/.test(main));
  });

  const mk = fs.readFileSync(path.join(ROOT, "scripts", "make-app.sh"), "utf8");
  test("launcher .app nie wyłącza piaskownicy", () =>
    assert.ok(!mk.includes("--no-sandbox")));
}

/* ── 8. Pobieranie wygenerowanych plików ──────────────────────────────
   Obrazy i wideo z imgen/vidgen.x.ai potrafią urwać się w połowie
   transferu. Krótki plik udający wynik jest gorszy niż błąd, bo pieniądze
   za generowanie i tak poszły. */
(async () => {
  group("xai-api: pobieranie wygenerowanych plików");
  const http = require("http");
  const xai = require(path.join(ROOT, "electron", "xai-api"));

  const full = Buffer.alloc(64 * 1024, 7);
  let seenUA = "";
  const srv = http.createServer((req, res) => {
    seenUA = req.headers["user-agent"] || "";
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(full.length));
    if (req.url === "/truncated") {
      res.end(full.subarray(0, 1000)); // Content-Length kłamie — jak Cloudflare
      return;
    }
    res.end(full);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const asyncTest = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log("  ok  " + name);
    } catch (err) {
      console.error("  FAIL " + name);
      console.error("       " + err.message);
      process.exitCode = 1;
    }
  };

  await asyncTest("pełny plik przechodzi i ma poprawny rozmiar", async () => {
    const dl = await xai.downloadBuffer(`${base}/ok`);
    assert.strictEqual(dl.buf.length, full.length);
    assert.ok(dl.mimeType.includes("video/mp4"));
  });
  await asyncTest("User-Agent jest przeglądarkowy (Cloudflare 403)", () =>
    assert.ok(/Mozilla\/5\.0/.test(seenUA), `UA = ${seenUA}`));
  await asyncTest("urwane pobieranie rzuca błąd, nie oddaje kikuta", async () => {
    await assert.rejects(
      () => xai.downloadBuffer(`${base}/truncated`, { tries: 1 }),
      /Nie udało się pobrać/
    );
  });
  srv.close();

  console.log(
    `\n${passed} testów przeszło` +
      (process.exitCode ? ", są błędy (patrz wyżej)" : ", zero błędów")
  );
})();
