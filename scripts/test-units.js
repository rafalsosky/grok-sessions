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

  test("sklejone zdania zostają w jednym akapicie, jak u Claude", () => {
    const { renderMarkdown, appendStreamChunk } = require("../src/markdown.js");
    const glued = "na VPS.Praca siedzi na boxie.Jest nowszy handover.";
    const out = renderMarkdown(glued);
    const paras = out.match(/<p>/g) || [];
    assert.ok(paras.length === 1, "każde zdanie to osobny akapit: " + out);
    assert.ok(out.includes("na VPS."));
    assert.ok(out.includes("Praca siedzi"));
    assert.ok(out.includes("VPS. Praca") || out.includes("VPS.Praca") === false);

    const joined = appendStreamChunk("na VPS.", "Praca siedzi na boxie.");
    assert.strictEqual(joined, "na VPS. Praca siedzi na boxie.");
    assert.ok(!joined.includes("\n\n"), "zdanie nie może otwierać nowego akapitu");
  });

  test("appendStreamChunk nie psuje już poprawnych spacji", () => {
    const { appendStreamChunk } = require("../src/markdown.js");
    assert.strictEqual(appendStreamChunk("Hello. ", "World"), "Hello. World");
    assert.strictEqual(appendStreamChunk("Hello.\n\n", "World"), "Hello.\n\nWorld");
    assert.strictEqual(appendStreamChunk("J", "as"), "Jas");
    assert.strictEqual(appendStreamChunk("Jas", "ne"), "Jasne");
    assert.strictEqual(appendStreamChunk("abc", "def"), "abcdef");
  });

  test("numerowana lista nie przykleja się do poprzedniego zdania", () => {
    const { renderMarkdown, appendStreamChunk } = require("../src/markdown.js");
    const joined = appendStreamChunk(
      "Możesz resetować.",
      "1. SuperGrok → Quit SuperGrok Desktop."
    );
    assert.ok(joined.includes("\n1. "), joined);
    const out = renderMarkdown("Możesz resetować.1. SuperGrok → Quit.");
    assert.ok(out.includes("<ol"), "lista nie jest listą: " + out);
    assert.ok(!out.includes("resetować.1."), out);
  });

  test("pogrubiony tytuł nie zjada reszty akapitu", () => {
    const out = renderMarkdown("**Kolejka.** Dopowiedzenia scalały się w jedną pozycję.");
    assert.ok(out.includes("md-h"), "tytuł nie jest nagłówkiem: " + out);
    assert.ok(out.includes("<p>"), "brak akapitu po tytule");
    assert.ok(!/<strong>[^<]{80,}/.test(out), "ściana bold: " + out);
  });

  test("zmieniłemKolejka rozdziela się, openSession nie", () => {
    const { normalizeMarkdown, renderMarkdown } = require("../src/markdown.js");
    const out = renderMarkdown("Co zmieniłemKolejka ma pasek nad polem.");
    assert.ok(out.includes("Kolejka ma pasek"), out);
    assert.ok((out.match(/<p>/g) || []).length >= 2, "nie rozbito sklejonego tytułu");
    const code = renderMarkdown("Wywołaj openSession potem.");
    assert.ok(code.includes("openSession"), "camelCase rozbity");
  });

  test("kod w fence nie jest rozbijany na akapity", () => {
    const out = renderMarkdown("```js\nfoo.Bar = 1;\n```");
    assert.ok(out.includes("foo.Bar = 1;"), "identyfikator w kodzie rozbity");
    assert.ok(!out.includes("<p>Bar"), "Bar wyciekł do akapitu");
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

  test("newChat w Build nie zabija pracującej sesji", () => {
    const fn = app.match(/async function newChat\(\) \{[\s\S]*?\n  \}/);
    assert.ok(fn, "brak newChat");
    assert.ok(/mode === "grok"/.test(fn[0]), "newChat nie rozróżnia Build");
    assert.ok(
      !/chatStop\(\{\s*mode:\s*"grok"/.test(fn[0]),
      "New session nadal zabija agenta pierwszej sesji"
    );
    assert.ok(
      /snapshotCurrentBuildSession/.test(fn[0]),
      "New session kasuje bufor pracującej sesji zamiast go odłożyć"
    );
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
      /isBusy/.test(block[0]),
      "zmiana modelu w Build nie sprawdza, czy TA sesja leci"
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

  test("setPermissionMode nie wrzuca cwd na homedir", () => {
    const fn = acp.match(/async setPermissionMode\([\s\S]*?\n  \}/);
    assert.ok(fn, "brak setPermissionMode");
    assert.ok(
      !/homedir\(\)/.test(fn[0]),
      "Auto/Pytaj nadal ładuje sesję z os.homedir()"
    );
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
      /isBusy/.test(main) && /alwaysLatestModel/.test(main),
      "brak wartownika alwaysLatest vs tura"
    );
    const block = main.match(/client\.on\("models"[\s\S]*?\}\);/);
    assert.ok(block, "brak handlera models na kliencie puli");
    assert.ok(
      /isBusy/.test(block[0]),
      "handler models nie sprawdza, czy TEN agent pracuje"
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

/* ── 3e. Otwarcie sesji z historią: nowa wiadomość na dole ─────────────
   layoutChatBottom zerował paddingTop przed pomiarem, więc scrollTop
   zostawał na górze ostatniej strony historii. Transkrypt nadpisywał
   bańkę wysłaną w trakcie ładowania. */
group("work-summary: linia jak u Claude");
{
  const ws = require("../src/work-summary.js");

  test("klasyfikuje read / command / edit", () => {
    assert.strictEqual(ws.classifyTool("read_file"), "read");
    assert.strictEqual(ws.classifyTool("run_terminal_command"), "command");
    assert.strictEqual(ws.classifyTool("search_replace"), "edit");
    assert.strictEqual(ws.classifyTool("grep"), "search");
  });

  test("Read 7 files, ran 5 commands", () => {
    const tools = [
      ...Array(7).fill({ title: "read_file" }),
      ...Array(5).fill({ title: "run_terminal_command" }),
    ];
    assert.strictEqual(ws.summarizeTools(tools), "Read 7 files, ran 5 commands");
  });

  test("plan pokazuje bieżące i prawie koniec", () => {
    const plan = ws.planProgress([
      { content: "A", status: "completed" },
      { content: "B", status: "completed" },
      { content: "Commit package", status: "in_progress" },
      { content: "Deploy", status: "pending" },
    ]);
    assert.strictEqual(plan.done, 2);
    assert.strictEqual(plan.current, "Commit package");
    assert.strictEqual(plan.next, "Deploy");
    const st = ws.buildWorkStatus({
      tools: [{ title: "read_file", status: "completed" }],
      planEntries: [
        { content: "A", status: "completed" },
        { content: "B", status: "in_progress" },
      ],
      phase: "tool",
      elapsed: "3:22",
    });
    assert.ok(st.headline.includes("Read"));
    assert.ok(st.now.includes("B"));
    assert.ok(st.footer.includes("1/2"));
    assert.ok(st.footer.includes("almost done"));
  });
}

group("chat-history: dół sesji i merge po transkrypcie");
{
  const ch = require("../src/chat-history");

  test("padding liczy się bez zerowania aktualnego paddingu", () => {
    assert.strictEqual(ch.nextChatPadding(800, 200), 600);
    assert.strictEqual(ch.nextChatPadding(800, 900), 0);
    assert.strictEqual(ch.contentHeightWithoutPad(500, 120), 380);
  });

  test("transkrypt nie zjada lokalnie wysłanej bańki", () => {
    const mapped = [
      { role: "user", text: "stare" },
      { role: "assistant", text: "Sprawdzę…" },
    ];
    const current = [
      { role: "user", text: "stare" },
      { role: "assistant", text: "Sprawdzę…" },
      { role: "user", text: "nowe pytanie", _local: true },
      { role: "assistant", text: "", _streaming: true },
    ];
    const out = ch.mergeTranscriptWithLocals(mapped, current);
    assert.strictEqual(out[out.length - 2].text, "nowe pytanie");
    assert.strictEqual(out[out.length - 1]._streaming, true);
  });

  test("live bufor bez usera odzyskuje pierwszą lokalną wiadomość", () => {
    const live = [
      { role: "assistant", text: "Zaczynam od screenów", _streaming: true },
    ];
    const current = [
      {
        role: "user",
        text: "sprawdź swój kod",
        _local: true,
        _sid: null,
      },
      { role: "assistant", text: "", _streaming: true, _sid: null },
    ];
    const out = ch.mergeLiveBufferWithLocals(live, current, "sid-1");
    assert.strictEqual(out[0].role, "user");
    assert.strictEqual(out[0].text, "sprawdź swój kod");
    assert.ok(out.some((m) => m.role === "assistant" && m.text));
  });

  test("follow-up nie wskakuje nad starą odpowiedź Groka", () => {
    const live = [
      {
        role: "assistant",
        text: "Zaczynam od screenów",
        tools: [{ title: "read_file" }, { title: "grep" }],
      },
    ];
    const current = [
      { role: "user", text: "Spoko, zrobiłem restart", _local: true },
    ];
    const out = ch.mergeLiveBufferWithLocals(live, current, "sid-1");
    assert.strictEqual(out[0].role, "assistant", "user wskoczył na górę historii");
    assert.strictEqual(out[out.length - 1].role, "user");
    assert.strictEqual(out[out.length - 1].text, "Spoko, zrobiłem restart");
  });

  test("przełączenie sesji nie wlewa czatu A do czatu B", () => {
    const liveB = [
      { role: "user", text: "zadanie B", _sid: "b" },
      { role: "assistant", text: "odpowiedź B", _sid: "b" },
    ];
    const viewA = [
      { role: "user", text: "zadanie A", _sid: "a" },
      { role: "assistant", text: "To nie jest praca w dwóch sesjach", _sid: "a", _streaming: true },
    ];
    const out = ch.loadSessionView(liveB, viewA, "b");
    assert.ok(
      !out.some((m) => /dwóch sesjach/.test(m.text || "")),
      "stream A wyciekł do B"
    );
    assert.ok(out.some((m) => m.text === "odpowiedź B"));
    assert.strictEqual(
      out.filter((m) => m._sid && m._sid !== "b").length,
      0
    );
  });

  test("dłuższa historia w widoku wygrywa z krótkim live buforem", () => {
    const live = [{ role: "assistant", text: "stara odpowiedź", tools: [{}] }];
    const current = [
      { role: "user", text: "pierwsza" },
      { role: "assistant", text: "odp 1" },
      { role: "user", text: "druga", _local: true },
    ];
    const out = ch.mergeLiveBufferWithLocals(live, current, "sid-1");
    assert.ok(out.length >= 3, "historia ucięta do live bufora");
    assert.strictEqual(out[0].text, "pierwsza");
    assert.strictEqual(out[out.length - 1].text, "druga");
  });

  test("nowa tura nie dopisuje do poprzedniej bańki asystenta", () => {
    const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
    assert.ok(
      /function closeStreamingAssistant/.test(app),
      "brak closeStreamingAssistant"
    );
    assert.ok(
      /turn_completed/.test(app),
      "ACP turn_completed jest ignorowane — nowa tura sklei się ze starą"
    );
    assert.ok(
      /after !== streamingAssistant/.test(app),
      "ensureStreamingAssistant nie odpuszcza starej bańki po wiadomości usera"
    );
    assert.ok(
      /emptyShell/.test(app),
      "ensureStreamingAssistant nadal otwiera starą odpowiedź z narzędziami"
    );
  });

  test("kolejka ma dock nad composerem i nie scala pozycji", () => {
    const html = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8");
    const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
    assert.ok(/id="queue-dock"/.test(html), "brak #queue-dock");
    assert.ok(/function renderQueueDock/.test(app), "brak renderQueueDock");
    assert.ok(
      /function injectOldestQueued/.test(app),
      "brak injectOldestQueued — nie da się pchnąć kolejki"
    );
    assert.ok(
      /messageQueue\.push/.test(app) && !/lastQ\.text =/.test(app),
      "kolejne dopowiedzenia nadal sklejają się w jedną pozycję"
    );
  });

  test("openSession nie czyści allMessages przed transkryptem", () => {
    const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
    const fn = app.match(/async function openSession\([\s\S]*?\n  \}/);
    assert.ok(fn, "brak openSession");
    assert.ok(
      /mergeTranscriptWithLocals/.test(fn[0]),
      "openSession nie scala lokalnych baniek z transkryptem"
    );
    assert.ok(
      /loadSessionView/.test(fn[0]),
      "openSession nie ładuje widoku po sid — czat A wejdzie do B"
    );
    assert.ok(
      !/allMessages = \[\];\s*messages = \[\];\s*renderMessages/.test(fn[0]),
      "openSession nadal wipe'uje czat przed await transcript"
    );
    assert.ok(
      /m\._sid === row\.id/.test(fn[0]),
      "openSession wpuszcza bańki bez _sid z poprzedniej sesji"
    );
  });

  test("status i kolejka: plan + steer po paczce narzędzi", () => {
    const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8");
    assert.ok(/work-summary\.js/.test(html), "brak work-summary.js");
    assert.ok(/id="status-sub"/.test(html), "brak drugiej linii statusu");
    assert.ok(/kind === "plan"/.test(app), "ACP plan jest ignorowane");
    assert.ok(/function scheduleSteerQueue/.test(app), "brak steer kolejki");
    assert.ok(/function maybeSteerQueue/.test(app), "brak maybeSteerQueue");
  });

  test("nowy czat Build zostaje na widoku po pojawieniu się session id", () => {
    const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
    assert.ok(/pendingNewSession/.test(app), "brak pendingNewSession");
    assert.ok(/function adoptBuildSession/.test(app), "brak adoptBuildSession");
    assert.ok(
      /pendingNewSession && !selectedId/.test(app),
      "isViewingSession nie trzyma nowej sesji"
    );
    assert.ok(
      /!streamBySession\[sid\]/.test(app),
      "nowy czat nadal zgłasza się po sid cudzej sesji"
    );
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

/* ── 7b. Pula agentów: dwie sesje = dwa procesy ───────────────────────
   Jeden AcpClient na całą apkę: Enter w B robił session/load na procesie A
   i pierwsza sesja umierała. New session wołał Stop. */ 
group("agent-pool: sesje jak karty terminala");
{
  const { createAgentPool } = require("../electron/agent-pool");
  const pool = createAgentPool();
  const a = { sessionId: "sid-a", stopCalls: 0, stop() { this.stopCalls++; } };
  const b = { sessionId: "sid-b", stopCalls: 0, stop() { this.stopCalls++; } };
  pool.put("sid-a", a);
  pool.put("sid-b", b);
  pool.markBusy("sid-a", true);

  test("dwie sesje to dwaj klienci", () => {
    assert.strictEqual(pool.get("sid-a"), a);
    assert.strictEqual(pool.get("sid-b"), b);
    assert.strictEqual(pool.ids().length, 2);
  });
  test("busy A nie blokuje B", () => {
    assert.strictEqual(pool.isBusy("sid-a"), true);
    assert.strictEqual(pool.isBusy("sid-b"), false);
  });
  test("stop A nie rusza B", () => {
    pool.stop("sid-a");
    assert.strictEqual(a.stopCalls, 1);
    assert.strictEqual(b.stopCalls, 0);
    assert.strictEqual(pool.has("sid-a"), false);
    assert.strictEqual(pool.has("sid-b"), true);
    assert.strictEqual(pool.isBusy("sid-a"), false);
  });

  const main = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  test("chat:send nie ma globalnego promptBusy.grok", () => {
    const block = main.match(/ipcMain\.handle\("chat:send"[\s\S]*?\n  \}\);/);
    assert.ok(block, "brak chat:send");
    assert.ok(
      !/if \(promptBusy\[lane\]\)/.test(block[0]),
      "druga sesja nadal stoi za jedną flagą promptBusy"
    );
    assert.ok(
      /isBusy/.test(block[0]),
      "chat:send nie sprawdza busy per sesja"
    );
  });
  test("chat:open nie ładuje sesji na wspólnym procesie", () => {
    const block = main.match(/ipcMain\.handle\("chat:open"[\s\S]*?\n  \}\);/);
    assert.ok(block, "brak chat:open");
    assert.ok(
      !/ensureSession/.test(block[0]),
      "otwarcie B nadal robi session/load na agencie A"
    );
  });
  test("chat:stop wymaga sessionId i nie zabija puli", () => {
    const block = main.match(/ipcMain\.handle\("chat:stop"[\s\S]*?\n  \}\);/);
    assert.ok(block, "brak chat:stop");
    assert.ok(/payload\.sessionId|sessionId/.test(block[0]), "Stop bez sessionId");
    assert.ok(/pool\.stop/.test(block[0]), "Stop nie idzie w pulę");
    assert.ok(
      !/acp = null/.test(block[0]),
      "Stop nadal zeruje jedynego agenta"
    );
  });
  test("UI nie blokuje composera bo pracuje inna sesja", () => {
    assert.ok(
      !/Agent is working in another Build session/.test(app),
      "composer nadal udaje, że jest jeden agent"
    );
  });
}

/* ── 7c. Scroll: pisanie nie porywa widoku ────────────────────────────
   holdStick + rAF ustawiające stickToBottom=true = nie da się czytać
   od góry, gdy agent jeszcze pisze. */
group("chat-scroll: user na górze zostaje na górze");
{
  const cs = require("../src/chat-scroll");
  const box = { scrollHeight: 2000, scrollTop: 40, clientHeight: 400 };
  test("przy dole follow jest włączony", () => {
    assert.strictEqual(cs.isNearBottom(box, 80), false);
    box.scrollTop = 1600;
    assert.strictEqual(cs.isNearBottom(box, 80), true);
  });
  test("scroll w górę wyłącza follow, chunk nie ciągnie", () => {
    const s = cs.createChatScroll();
    s.pin();
    box.scrollTop = 40;
    s.onUserScroll(box);
    assert.strictEqual(s.shouldFollow(), false);
    assert.strictEqual(s.applyBottom(box), false);
    assert.strictEqual(box.scrollTop, 40);
  });
  test("programowy scroll nie zbiją stick", () => {
    const s = cs.createChatScroll();
    s.pin();
    s.withProgrammatic(() => {
      box.scrollTop = 0;
      s.onUserScroll(box);
    });
    assert.strictEqual(s.shouldFollow(), true);
  });
  const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  test("app.js nie resetuje stick w rAF po każdym chunku", () => {
    assert.ok(/chatScroll\.createChatScroll|createChatScroll\(/.test(app), "brak chat-scroll w UI");
    const fn = app.match(/function scrollChatToBottom[\s\S]*?\n  \}/);
    assert.ok(fn, "brak scrollChatToBottom");
    assert.ok(
      !/stickToBottom = true/.test(fn[0]),
      "rAF nadal wymusza stickToBottom = true"
    );
  });
}

/* ── 7b. Tura należy do SWOJEJ sesji ──────────────────────────────────
   17.08: `runSendTurn` czekał na koniec tury, a potem — już po `await` —
   przestawiał selectedId/liveSessionId, gasił busy i domykał bańkę na tym,
   co akurat było otwarte. Koniec tury A robił to sesji B: ten sam tekst
   w dwóch kartach, „working” na obu, wiadomość usera lądująca w środku. */
group("send: koniec tury A nie rusza widoku sesji B");
{
  const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  const fn = app.match(/async function runSendTurn\([\s\S]*?\n  \}\n/);
  test("runSendTurn trzyma własną bańkę tury", () => {
    assert.ok(fn, "brak runSendTurn");
    assert.ok(
      /const turnAssistant = streamingAssistant/.test(fn[0]),
      "tura nie zapamiętuje swojej bańki — po await zamknie cudzą"
    );
  });
  test("po await widok zmienia się tylko gdy to nadal ta sesja", () => {
    assert.ok(/const stillViewing =/.test(fn[0]), "brak bramki stillViewing");
    const tail = fn[0].slice(fn[0].indexOf("const stillViewing"));
    assert.ok(
      /if \(!stillViewing\)[\s\S]*?return;/.test(tail),
      "brak wyjścia dla sesji, której już nie oglądamy"
    );
    const guard = tail.slice(0, tail.indexOf("return;"));
    assert.ok(
      !/selectedId =|liveSessionId =/.test(guard),
      "gałąź „już nie oglądam” nadal przestawia selectedId/liveSessionId"
    );
  });
  test("selectedId i liveSessionId nie rozjeżdżają się po turze", () => {
    const set = fn[0].match(/liveSessionId = res\.sessionId;\s*\n\s*selectedId = res\.sessionId;/);
    assert.ok(set, "id sesji ustawiane osobno — dwie karty na liście jako 'selected'");
  });
  test("gest użytkownika zdejmuje trzymanie dołu od razu", () => {
    assert.ok(
      /addEventListener\("wheel"/.test(app) && /scroller\.release\(\)/.test(app),
      "kółko myszy nie zwalnia stick — nie da się czytać, gdy agent pisze"
    );
  });
}

/* ── 7c. Tytuł nowej sesji od pierwszej wiadomości ────────────────────── */
group("sessions: nowa sesja nie stoi na liście jako uuid");
{
  const sessions = require("../electron/sessions");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-title-"));
  fs.writeFileSync(
    path.join(dir, "updates.jsonl"),
    JSON.stringify({
      method: "session/update",
      params: {
        sessionId: "x",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "sprawdź czemu scroll ucieka na dół" },
        },
      },
    }) + "\n"
  );
  test("tytuł bierze się z pierwszej wiadomości, nie z id", () => {
    const t = sessions.titleFromSummary(
      { info: { id: "01a00e99-1111-2222-3333-444444444444" } },
      dir
    );
    assert.strictEqual(t, "sprawdź czemu scroll ucieka na dół");
  });
  test("prawdziwy tytuł agenta wygrywa z zastępczym", () => {
    const t = sessions.titleFromSummary(
      { info: { id: "01a00e99" }, generated_title: "Fix session UI" },
      dir
    );
    assert.strictEqual(t, "Fix session UI");
  });
  test("brak pliku = brak wybuchu", () => {
    const t = sessions.titleFromSummary(
      { info: { id: "01a00e99-1111-2222-3333-444444444444" } },
      path.join(dir, "nie-ma")
    );
    assert.strictEqual(t, "01a00e99");
  });
}

/* ── 7d. Gęstość i struktura markdownu ────────────────────────────────── */
group("markdown: struktura jak w źródle, nie sitko akapitów");
{
  const { renderMarkdown } = require("../src/markdown.js");
  test("twardy łamacz GFM (dwie spacje) daje <br>, nie nowy akapit", () => {
    const out = renderMarkdown("Repo: `a`  \nGałąź: `main`  \nHEAD: `632be50`");
    assert.strictEqual((out.match(/<p>/g) || []).length, 1, out);
    assert.strictEqual((out.match(/<br>/g) || []).length, 2, out);
  });
  test("wcięta linia zostaje w punkcie listy", () => {
    const out = renderMarkdown(
      "1. `94bfbff` — kolejka  \n   `src/app.js`, `src/styles.css`\n2. `02de77c` — pierwsza wiadomość"
    );
    assert.strictEqual((out.match(/<li>/g) || []).length, 2, out);
    assert.ok(!/<p>/.test(out), "ciąg dalszy punktu wypadł z listy: " + out);
  });
  test("numerowany nagłówek zostaje nagłówkiem, nie listą po „###”", () => {
    const out = renderMarkdown("### 1. Jedna sesja, nie dwie");
    assert.ok(/md-h/.test(out), "nagłówek rozbity na listę: " + out);
    assert.ok(!/<p>###<\/p>/.test(out), "samotne ### w czacie: " + out);
  });
  test("łamacz nie przemyca HTML-a", () => {
    const out = renderMarkdown("a  \n<img src=x onerror=alert(1)>");
    assert.ok(!out.includes("<img"), out);
    assert.ok(out.includes("<br>"), out);
  });
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
