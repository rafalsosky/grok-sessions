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

/* ── 2b. Wideo i media w UI ───────────────────────────────────────────
   Wideo generuje się asynchronicznie i wraca jako plik na dysku. Trzy
   rzeczy potrafiły je „zgubić": CSP bez media-src (element <video> nie
   miał prawa wczytać pliku), brak przenoszenia pola `videos` przy
   odtwarzaniu historii czatu, i renderowanie przez data: URL. */
group("wideo: CSP, historia, źródło pliku");
{
  const html = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8");
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");

  test("CSP pozwala <video> wczytać plik (media-src)", () => {
    const csp = (html.match(/Content-Security-Policy"[\s\S]*?content="([^"]+)"/) ||
      [])[1];
    assert.ok(csp, "brak meta CSP");
    assert.ok(/media-src[^;]*file:/.test(csp), "media-src bez file: — wideo się nie odtworzy");
  });

  test("historia czatu zachowuje wideo", () =>
    assert.ok(/videos:\s*m\.videos/.test(main), "transcript gubi pole videos"));

  test("wideo leci z dysku, nie przez base64 w IPC", () => {
    assert.ok(/vid\.src = "file:\/\/"/.test(app), "wideo nadal przez data: URL");
  });

  test("extFromMime rozpoznaje mp4", () => {
    const { extFromMime } = require("../electron/attachments");
    assert.strictEqual(extFromMime("video/mp4"), ".mp4");
  });
}

/* ── 2c. Język ────────────────────────────────────────────────────────
   Interfejs był polsko-angielską hybrydą. Angielski jest teraz bazą,
   polski nakładką. Te testy pilnują, żeby nie rozjechało się z powrotem. */
group("i18n: angielski bazowy, polski kompletny");
{
  const i18n = require("../src/i18n.js");
  const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8");

  test("brak tłumaczenia = tekst angielski, nie pustka", () => {
    i18n.setLang("pl");
    assert.strictEqual(i18n.t("Totally unknown string"), "Totally unknown string");
    i18n.setLang("en");
  });

  test("angielski nie rusza tekstu", () => {
    i18n.setLang("en");
    assert.strictEqual(i18n.t("Send"), "Send");
  });

  test("polski tłumaczy", () => {
    i18n.setLang("pl");
    assert.strictEqual(i18n.t("Send"), "Wyślij");
    i18n.setLang("en");
  });

  test("„auto” bierze język systemu, reszta wprost", () => {
    assert.strictEqual(i18n.resolveLang("auto", "pl-PL"), "pl");
    assert.strictEqual(i18n.resolveLang("auto", "de-DE"), "en", "nieznany → angielski");
    assert.strictEqual(i18n.resolveLang("en", "pl-PL"), "en", "wybór użytkownika ma pierwszeństwo");
  });

  // Najważniejszy: każdy tekst użyty w kodzie musi mieć polski odpowiednik,
  // inaczej po przełączeniu na PL interfejs jest w połowie angielski.
  const used = new Set();
  for (const m of app.matchAll(/\btr\("((?:[^"\\]|\\.)*)"\)/g)) {
    used.add(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) {
    used.add(m[1]);
  }
  test(`wszystkie teksty UI mają tłumaczenie PL (${used.size} szt.)`, () => {
    const brak = [...used].filter((k) => !(k in i18n.PL));
    assert.strictEqual(
      brak.length,
      0,
      "brak w słowniku PL:\n       " + brak.slice(0, 12).join("\n       ")
    );
  });

  // Pierwsza wersja tego testu szukała tylko znaków ą/ć/ę/ł/…, więc
  // przepuściła „Zalogowano”, „konto ukryte” i „⌘V = wklej screenshot”.
  // Stąd druga siatka: typowo polskie słowa bez ogonków.
  const POLSKIE_SLOWA =
    /\b(zalogowano|konto|ukryte|ukryty|wklej|napisz|pisz|dalej|wyslij|jeszcze|sesji|sesja|czat|czaty|kolejce|kolejki|wiadomosc|wiadomosci|brak|pracuje|wybierz|nowy|nowa|usun|zmien|pokaz|ukryj|zrzut|ekranu|plik|pliki|teraz|przez|jako|albo|nieprzeczytane|przeczytane|znaleziona|zapisuje|zatrzymane|zapisane|skopiowane|edytuj|logowanie|otwarte|aktywna|startuje|kroki|toku)\b/i;

  test("w kodzie UI nie ma polskich literałów", () => {
    const zle = [];
    for (const [plik, src] of [
      ["src/app.js", app],
      ["src/index.html", html],
    ]) {
      const hits = src.match(/"[^"\n]{3,}"/g) || [];
      for (const h of hits) {
        const tekst = h.slice(1, -1);
        // pomiń wywołania tłumaczeń i klucze data-i18n (te są po angielsku)
        if (h.startsWith('"tr(')) continue;
        const podejrzany =
          /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(tekst) || POLSKIE_SLOWA.test(tekst);
        if (podejrzany) zle.push(`${plik}: ${h.slice(0, 70)}`);
      }
    }
    assert.strictEqual(
      zle.length,
      0,
      "niezlokalizowane teksty:\n       " + zle.slice(0, 10).join("\n       ")
    );
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

  // Tryb prywatności musi przetrwać restart, bo służy do nagrywania
  // i pokazywania aplikacji na żywo.
  test("tryb prywatności: domyślnie wyłączony, zapisuje się", () => {
    assert.strictEqual(loadSettings(dir).privacyMode, false);
    assert.strictEqual(saveSettings(dir, { privacyMode: true }).privacyMode, true);
    assert.strictEqual(loadSettings(dir).privacyMode, true);
    saveSettings(dir, { privacyMode: false });
  });

  test("motyw spoza listy wraca do dark", () => {
    assert.strictEqual(saveSettings(dir, { theme: "neon" }).theme, "dark");
    assert.strictEqual(saveSettings(dir, { theme: "light" }).theme, "light");
  });

  test("alwaysLatestModel: domyślnie włączony, da się wyłączyć", () => {
    assert.strictEqual(loadSettings(dir).alwaysLatestModel, true);
    assert.strictEqual(
      saveSettings(dir, { alwaysLatestModel: false }).alwaysLatestModel,
      false
    );
    assert.strictEqual(loadSettings(dir).alwaysLatestModel, false);
    saveSettings(dir, { alwaysLatestModel: true });
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 3b. Lista modeli Home ────────────────────────────────────────────
   Home nie czyta CLI — woła api.x.ai. Lista musi filtrować eksperymenty
   i stawiać najwyższy publiczny grok-N.M na górze. */
group("models: ranking i filtr listy Home");
{
  const m = require("../electron/models");

  test("4.6 jest wyżej niż 4.5 i 4.3", () => {
    const list = m.homeModelsFromApi([
      { id: "grok-4.3" },
      { id: "grok-4.6" },
      { id: "grok-4.5" },
    ]);
    assert.deepStrictEqual(
      list.filter((x) => m.isPublicChatModel(x.modelId)).map((x) => x.modelId),
      ["grok-4.6", "grok-4.5", "grok-4.3"]
    );
  });

  test("wycina 4.20, build i wideo, zostawia Imagine", () => {
    const list = m.homeModelsFromApi([
      { id: "grok-4.6" },
      { id: "grok-4.20-0309-reasoning" },
      { id: "grok-build-0.1" },
      { id: "grok-imagine-video-1.5" },
      { id: "grok-imagine-image" },
    ]);
    const ids = list.map((x) => x.modelId);
    assert.deepStrictEqual(ids, ["grok-4.6", "grok-imagine-image"]);
  });

  test("puste API = fallback z 4.6 na górze", () => {
    const list = m.homeModelsFromApi([]);
    assert.strictEqual(list[0].modelId, "grok-4.6");
    assert.ok(list.some((x) => x.modelId === "grok-imagine-image"));
  });

  test("alwaysLatest bierze najwyższy, pin trzyma wybrany", () => {
    const models = m.homeModelsFromApi([
      { id: "grok-4.6" },
      { id: "grok-4.5" },
    ]);
    assert.strictEqual(
      m.resolveChatModelId({
        alwaysLatest: true,
        savedId: "grok-4.5",
        models,
      }),
      "grok-4.6"
    );
    assert.strictEqual(
      m.resolveChatModelId({
        alwaysLatest: false,
        savedId: "grok-4.5",
        models,
      }),
      "grok-4.5"
    );
  });
}

/* ── 3c. Home: edycja musi iść na dysk ────────────────────────────────
   Retry/edycja/kasowanie tęły tylko allMessages. Po ponownym otwarciu
   wracała stara historia. */
group("home-chats: replaceMessages nadpisuje plik");
{
  const hc = require("../electron/home-chats");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-test-"));

  test("replaceMessages obcina historię na dysku", () => {
    const chat = hc.createHomeChat(dir, "T");
    hc.appendHomeMessage(dir, chat.id, {
      id: "u1",
      role: "user",
      content: "raz",
    });
    hc.appendHomeMessage(dir, chat.id, {
      id: "a1",
      role: "assistant",
      content: "odp",
    });
    const out = hc.replaceMessages(dir, chat.id, [
      { id: "u1", role: "user", content: "raz" },
    ]);
    assert.ok(out.ok);
    const loaded = hc.loadHomeChat(dir, chat.id);
    assert.strictEqual(loaded.messages.length, 1);
    assert.strictEqual(loaded.messages[0].content, "raz");
  });

  test("toDiskMessage bierze text albo content", () => {
    assert.strictEqual(hc.toDiskMessage({ role: "user", text: "abc" }).content, "abc");
    assert.strictEqual(
      hc.toDiskMessage({ role: "assistant", content: "xyz" }).content,
      "xyz"
    );
  });

  test("pruneEmptyHomeChats kasuje puste New chat, zostawia z treścią", () => {
    const empty = hc.createHomeChat(dir, "New chat");
    const filled = hc.createHomeChat(dir, "New chat");
    hc.appendHomeMessage(dir, filled.id, {
      id: "u1",
      role: "user",
      content: "hej",
    });
    const n = hc.pruneEmptyHomeChats(dir);
    assert.ok(n >= 1);
    assert.strictEqual(hc.loadHomeChat(dir, empty.id), null);
    assert.ok(hc.loadHomeChat(dir, filled.id));
  });

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 3d. New session w Build nie może zostać przy starej turze ─────────
   Klik „New session” zostawiał pasek Thinking i kolejny Enter szedł
   do tej samej sesji (kolejka), zamiast otworzyć nową. */
group("build: New session odłącza bieżącą turę");
{
  const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
  const acp = fs.readFileSync(path.join(ROOT, "electron", "acp-client.js"), "utf8");
  const xai = fs.readFileSync(path.join(ROOT, "electron", "xai-api.js"), "utf8");

  test("newChat w Build woła Stop zanim wyczyści widok", () => {
    const fn = app.match(/async function newChat\(\) \{[\s\S]*?\n  \}/);
    assert.ok(fn, "brak newChat");
    assert.ok(/chatStop/.test(fn[0]), "newChat nie przerywa agenta");
    assert.ok(/mode === "grok"/.test(fn[0]), "newChat nie rozróżnia Build");
  });

  test("newChat w Home przerywa myślenie i nie tworzy pustego pliku", () => {
    const fn = app.match(/async function newChat\(\) \{[\s\S]*?\n  \}/);
    assert.ok(fn, "brak newChat");
    assert.ok(
      /mode === "home"[\s\S]*chatStop|chatStop[\s\S]*mode === "home"/.test(fn[0]),
      "Home New chat nie woła Stop"
    );
    assert.ok(
      !/chatNew\(\{\s*mode:\s*"home"\s*\}\)/.test(fn[0]),
      "Home New chat nadal od razu tworzy pusty plik"
    );
  });

  test("podgląd załącznika nie czyta ścieżki spoza katalogu attachments", () => {
    const att = require("../electron/attachments");
    const root = "/tmp/sg-user/attachments";
    assert.strictEqual(
      att.isAllowedPreviewPath(root, "/tmp/sg-user/attachments/a.png"),
      true
    );
    assert.strictEqual(
      att.isAllowedPreviewPath(root, "/etc/passwd"),
      false
    );
    assert.strictEqual(
      att.isAllowedPreviewPath(root, "/tmp/sg-user/attachments/../settings.json"),
      false
    );
  });

  test("set-model w Build nie restartuje agenta w trakcie tury", () => {
    const block = main.match(/ipcMain\.handle\("chat:set-model"[\s\S]*?\n  \}\);/);
    assert.ok(block, "brak chat:set-model");
    assert.ok(
      /promptBusy\.grok/.test(block[0]),
      "zmiana modelu w Build nie sprawdza, czy tura leci"
    );
  });

  test("tooltip kropek nie jest surowym title=tr(", () => {
    assert.ok(!/title=tr\(/.test(app), "zepsuty tooltip title=tr(...)");
  });

  test("setEffort nie wrzuca cwd na homedir", () => {
    const fn = acp.match(/async setEffort\([\s\S]*?\n  \}/);
    assert.ok(fn, "brak setEffort");
    assert.ok(
      !/homedir\(\)/.test(fn[0]),
      "setEffort nadal ładuje sesję z os.homedir()"
    );
    assert.ok(/cwd/.test(fn[0]), "setEffort nie przyjmuje cwd sesji");
  });

  test("wideo idzie modelem 1.5", () => {
    assert.ok(
      /grok-imagine-video-1\.5/.test(xai),
      "brak grok-imagine-video-1.5"
    );
    const def = xai.match(/model = "([^"]+)"/);
    // pierwsza domyślna w generateVideo
    const vid = xai.match(/async function generateVideo[\s\S]*?model = "([^"]+)"/);
    assert.ok(vid, "brak defaultu w generateVideo");
    assert.strictEqual(vid[1], "grok-imagine-video-1.5");
  });

  test("przełączenie najnowszego modelu nie rusza tury w toku", () => {
    assert.ok(
      /promptBusy\.grok/.test(main) && /alwaysLatestModel/.test(main),
      "brak wartownika alwaysLatest vs tura"
    );
    const block = main.match(/acp\.on\("models"[\s\S]*?\}\);/);
    assert.ok(block, "brak handlera models");
    assert.ok(
      /promptBusy/.test(block[0]),
      "handler models nie sprawdza, czy agent pracuje"
    );
  });

  test("persistNav nie woła pełnego settings:set", () => {
    const fn = app.match(/function persistNav\(\) \{[\s\S]*?\n  \}/);
    assert.ok(fn, "brak persistNav");
    assert.ok(
      !/setSettings\(payload\)/.test(fn[0]),
      "persistNav nadal leci przez settings:set (odświeża modele i listę)"
    );
    assert.ok(/setNav|nav:set|saveNav/.test(fn[0]), "brak lekkiego zapisu nawigacji");
  });
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
      /Failed to download/
    );
  });
  srv.close();

  console.log(
    `\n${passed} testów przeszło` +
      (process.exitCode ? ", są błędy (patrz wyżej)" : ", zero błędów")
  );
})();
