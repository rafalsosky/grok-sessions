"use strict";

/**
 * Warstwa językowa.
 *
 * Kluczem jest angielski tekst, więc kod czyta się bez zaglądania do
 * słownika, a brak tłumaczenia degraduje się do angielskiego zamiast do
 * pustego miejsca. Angielski jest bazą: to repozytorium jest publiczne.
 *
 * Dodanie języka = jeden wpis w DICTS i jedna opcja w Ustawieniach.
 */

const PL = {
  // Nawigacja i pusty stan
  "New chat": "Nowy czat",
  "New session": "Nowa sesja",
  Today: "Dzisiaj",
  Yesterday: "Wczoraj",
  "Previous 7 days": "Ostatnie 7 dni",
  Earlier: "Wcześniej",
  "Home chat": "Czat Home",
  "browser-style": "jak w przeglądarce",
  Chat: "Czat",
  Image: "Grafika",
  Video: "Wideo",
  Search: "Szukaj",
  "Recents · Home": "Ostatnie · Home",
  "Recents · Build": "Ostatnie · Build",
  Build: "Build",
  "No Home chats yet — write below": "Brak czatów Home — napisz poniżej",
  "No Build sessions": "Brak sesji Build",
  "How can I help you today?": "W czym mogę pomóc?",
  "What should we build?": "Co budujemy?",
  "Like Grok in the browser: chat, ideas, /image for graphics. Not a coding agent.":
    "Jak Grok w przeglądarce: rozmowa, pomysły, /image do grafik. Nie agent kodujący.",
  "Build: files, shell, edits. Attachments go to the agent as paths.":
    "Build: pliki, shell, edycje. Załączniki idą do agenta jako ścieżki.",
  "Home · chat and graphics (/image …) · drop files or paste a screenshot":
    "Home · czat i grafiki (/image …) · przeciągnij pliki lub wklej screenshot",
  "Build · agent with tools · attachments as paths on disk":
    "Build · agent z narzędziami · załączniki jako ścieżki na dysku",
  "Drop files, folders or images": "Upuść pliki, foldery lub grafiki",
  Collapse: "Zwiń",
  "Show session list": "Pokaż listę sesji",
  "🎨 Generate an image": "🎨 Wygeneruj grafikę",
  "💬 Ask like in the browser": "💬 Pytanie jak w przeglądarce",
  "📋 Content plan": "📋 Plan treści",
  "Aspect ratio": "Proporcje",
  "Tool permission mode. Click to switch Auto / Ask.":
    "Tryb uprawnień narzędzi. Kliknij, żeby przełączyć Auto / Pytaj.",
  "Reasoning effort": "Głębokość myślenia (reasoning effort)",

  // Composer
  "Message Grok… (Enter = send, ⌘V = paste screenshot)":
    "Napisz do Groka… (Enter = wyślij, ⌘V = wklej zrzut)",
  "Describe the image… (aspect ratio on the right)":
    "Opisz grafikę… (proporcje po prawej)",
  "Describe the video… (takes about a minute)":
    "Opisz wideo… (generuje się ok. minuty)",
  "Describe the video… (8 s, takes about a minute)":
    "Opisz wideo… (8 s, generuje się ok. minuty)",
  Steps: "Kroki",
  "Active in terminal": "Aktywna w terminalu",
  "Home chats are stored in the app data folder":
    "Czaty Home są w folderze danych aplikacji",
  "Keep typing — Enter adds to the queue…":
    "Pisz dalej — Enter doda do kolejki…",
  "Agent is working in another Build session…":
    "Agent pracuje w innej sesji Build…",
  Send: "Wyślij",
  Stop: "Zatrzymaj",
  "Add file / folder": "Dodaj plik lub folder",
  "Add to queue (sends after the reply)":
    "Dodaj do kolejki (wyśle po odpowiedzi)",
  "Agent busy in another Build session — Enter queues the message":
    "Agent w innej sesji Build — Enter doda do kolejki",

  // Status
  "Starting…": "Start…",
  "Starting agent…": "Uruchamiam agenta…",
  "Loading session…": "Ładuję sesję…",
  "Thinking…": "Myślę…",
  "Generating image…": "Generuję grafikę…",
  "Writing…": "Piszę…",
  "Working…": "Pracuję…",
  "Working in the background…": "Pracuję w tle…",
  Done: "Gotowe",
  Stopped: "Zatrzymane",
  Error: "Błąd",
  "Agent is working…": "Agent pracuje…",
  "Agent starting…": "Agent startuje…",
  "Queue → one message…": "Kolejka → jedna wiadomość…",

  // Narzędzia (etykiety zamiast surowych komend)
  Tool: "Narzędzie",
  Terminal: "Terminal",
  "Reading file": "Czytam plik",
  "Editing file": "Edytuję plik",
  Searching: "Szukam",
  Network: "Sieć",
  File: "Plik",
  "Show steps": "Pokaż kroki",
  "Hide steps": "Ukryj kroki",
  "Read 1 file": "1 plik",
  "almost done": "prawie koniec",
  "Now": "Teraz",
  Next: "Dalej",
  "running now": "w toku",
  "Queued — will send after this batch":
    "W kolejce — wyślę po tej paczce narzędzi",
  "In progress": "W toku",
  Completed: "Ukończone",
  Show: "Pokaż",
  completed: "ukończonych",
  "collapsed by default": "zwinięte domyślnie",
  Working: "Pracuję",
  "background steps (hidden) · see „Steps”":
    "kroków w tle (ukryte) · patrz „Kroki”",
  "background steps · „Steps”": "kroków w tle · „Kroki”",
  "Thinking (hidden in chat)": "Thinking (ukryte w czacie)",

  // Kolejka
  queued: "w kolejce",
  "↩ Send now": "↩ Wyślij teraz",
  "Send now": "Wyślij teraz",
  "Send now — interrupt and fold into current work":
    "Wyślij teraz — przerwij i dołącz do bieżącej roboty",
  "Sending now (current turn interrupted)":
    "Wysyłam teraz (przerwano bieżącą turę)",
  "Appended to the queued message": "Doklejone do kolejki (1 wiadomość)",
  "Queued — click ↩ Send now, or wait for the turn to end":
    "W kolejce — kliknij ↩ Wyślij teraz, albo poczekaj na koniec tury",
  "Queued — press Send now above the composer, or wait":
    "W kolejce — kliknij Wyślij teraz nad polem, albo poczekaj",
  "Send queued messages now": "Wyślij teraz wiadomości z kolejki",
  "Waiting to send": "Czeka na wysłanie",
  "Remove from queue": "Usuń z kolejki",
  "Sending next queued message…": "Wysyłam następną z kolejki…",
  Queue: "Kolejka",

  // Akcje pod wiadomością
  Copy: "Kopiuj",
  Copied: "Skopiowane",
  Edit: "Edytuj",
  Retry: "Ponów",
  Delete: "Usuń",
  "Copy message text": "Skopiuj treść wiadomości",
  "Go back to this message and send a corrected version":
    "Wróć do tej wiadomości i wyślij poprawioną",
  "Send this message again": "Wyślij tę wiadomość jeszcze raz",
  "Generate the answer again": "Wygeneruj odpowiedź jeszcze raz",
  "Removes from view. The agent still remembers this turn in its session.":
    "Usuwa z widoku. Agent nadal pamięta tę turę w swojej sesji.",
  "Removes from the chat view": "Usuwa z widoku czatu",
  "Removed from view (the agent still remembers it)":
    "Usunięte z widoku (agent nadal to pamięta)",
  "Removed from view": "Usunięte z widoku",
  "Edit and send": "Popraw i wyślij",
  "Edit and send. Note: the agent remembers the previous version.":
    "Popraw i wyślij. Uwaga: agent pamięta poprzednią wersję.",
  "Stop the current turn first (■)": "Najpierw zatrzymaj bieżącą turę (■)",
  "Nothing to retry": "Nie ma czego ponowić",

  // Menu sesji
  Rename: "Zmień nazwę",
  "Mark unread": "Oznacz jako nieprzeczytane",
  "Mark read": "Oznacz jako przeczytane",
  "Pin / Unpin": "Przypnij / odepnij",
  "Copy session ID": "Kopiuj ID sesji",
  "Show in Finder": "Pokaż w Finderze",
  "Delete chat": "Usuń czat",
  "Delete chat?": "Usunąć czat?",
  Permanent: "Nieodwracalne",
  "Title in the list": "Tytuł na liście",
  "Session ID copied": "ID skopiowane",
  Pinned: "Przypięte",
  Unpinned: "Odpięte",
  "Marked unread": "Oznaczone jako nieprzeczytane",
  "Marked read": "Oznaczone jako przeczytane",
  "Session not found": "Sesja nie znaleziona",
  "Pick a chat from the list (or New chat)":
    "Wybierz czat z listy (albo Nowy czat)",
  "New Home chat": "Nowy czat Home",
  "New Build session — write below": "Nowa sesja Build — pisz poniżej",
  "working…": "pracuje…",
  "Working in this session": "Pracuje w tej sesji",
  "Home (no signals)": "Home (brak signals)",

  // Uprawnienia
  Auto: "Auto",
  Ask: "Pytaj",
  "The agent uses tools without asking. Click to switch to Ask.":
    "Agent używa narzędzi bez pytania. Kliknij, żeby przełączyć na Pytaj.",
  "The agent asks before every tool. Click to switch to Auto.":
    "Agent pyta o zgodę na każde narzędzie. Kliknij, żeby przełączyć na Auto.",
  "Auto: the agent works without asking": "Auto: agent działa bez pytania",
  "Ask: the agent will request approval for every tool":
    "Pytaj: agent poprosi o zgodę na każde narzędzie",
  "The agent asks for permission": "Agent prosi o zgodę",
  Deny: "Odmów",

  // Ustawienia
  Settings: "Ustawienia",
  Save: "Zapisz",
  Cancel: "Anuluj",
  Saved: "Zapisane",
  "Log in": "Zaloguj",
  "Switch account": "Zmień konto",
  "Sign in with: grok login": "Zaloguj przez: grok login",
  "Sign in again, e.g. with a different account":
    "Zaloguj ponownie, np. na inne konto",
  Account: "Konto",
  Close: "Zamknij",
  Theme: "Motyw",
  Dark: "Ciemny",
  Light: "Jasny",
  "Follow system": "Jak system",
  Language: "Język",
  "System language": "Język systemu",
  English: "Angielski",
  Polish: "Polski",
  "Path to grok binary": "Ścieżka do binarki grok",
  "Browse…": "Wybierz…",
  "Default working directory (Build)": "Domyślny katalog roboczy (Build)",
  "Show subagents in Build list": "Pokaż subagentów na liście Build",
  "Agent tool permissions (Build)": "Uprawnienia narzędzi agenta (Build)",
  "Auto — the agent works without asking": "Auto — agent działa bez pytania",
  "Ask — I approve every tool": "Pytaj — zatwierdzam każde narzędzie",
  "Maximum reply length in Home (tokens)":
    "Maksymalna długość odpowiedzi w Home (tokeny)",
  "Always use the latest Grok model. When a new version appears, Home and Build switch to it.":
    "Zawsze używaj najnowszego modelu Grok. Gdy wyjdzie nowa wersja, Home i Build przełączą się same.",
  "Privacy mode — hide name and e-mail in the interface. For screenshots and recordings. Shortcut: ⌘⇧P.":
    "Tryb prywatności — ukryj imię i e-mail w interfejsie. Do zrzutów ekranu i nagrań. Skrót: ⌘⇧P.",
  "Read grok.com cookies from Arc/Chrome (weekly usage %). Requires Python with the rookiepy module. Off by default.":
    "Czytaj ciasteczka grok.com z Arc/Chrome (tygodniowy % zużycia). Wymaga Pythona z modułem rookiepy. Domyślnie wyłączone.",
  "Path to Python with rookiepy (empty = search PATH)":
    "Ścieżka do Pythona z rookiepy (puste = szukaj w PATH)",
  "Privacy mode on — account details hidden":
    "Tryb prywatności włączony — dane konta ukryte",
  "Privacy mode off": "Tryb prywatności wyłączony",
  "Signed in": "Zalogowano",
  "Not signed in": "Nie zalogowano",
  "account hidden": "konto ukryte",
  "signed in": "zalogowano",
  "Account details hidden (privacy mode)":
    "Dane konta ukryte (tryb prywatności)",
  "Not signed in. Use „Log in”.": "Nie zalogowano. Użyj „Zaloguj”.",
  "Log in opened in Terminal": "Logowanie otwarte w Terminalu",
  "Log in opened": "Logowanie otwarte",
  "SuperGrok / xAI session": "Sesja SuperGrok / xAI",

  // Zużycie
  Usage: "Zużycie",
  "Context and limits": "Zużycie kontekstu i limity",
  "Weekly SuperGrok limit": "Tygodniowy limit SuperGrok",
  Weekly: "Tygodniowy",
  "Context window (session)": "Context window (sesja)",
  "% used": "% użyte",
  Reset: "Reset",
  turns: "tury",
  tools: "narzędzia",
  "Home does not track a context window like Build":
    "Home nie zapisuje context window jak Build",
  "No signals.json — open a Build session":
    "Brak signals.json — otwórz sesję Build",
  "account: —": "konto: —",
  "Weekly %: Settings → „Read grok.com cookies”. xAI does not expose this limit to the grok login token.":
    "Tygodniowy %: Ustawienia → „Czytaj ciasteczka grok.com”. xAI nie udostępnia tego limitu tokenowi z grok login.",

  // Błędy
  "Send failed": "Nie udało się wysłać",
  "Copy failed": "Nie udało się skopiować",
  "Attach failed": "Nie udało się dodać pliku",
  "Import failed": "Nie udało się zaimportować",
  "Stop failed": "Nie udało się zatrzymać",
  "Rename failed": "Nie udało się zmienić nazwy",
  "Model change failed": "Nie udało się zmienić modelu",
  "Effort change failed": "Nie udało się zmienić effort",
  "Log in did not start": "Logowanie nie wystartowało",
  "Missing bridge API (preload).": "Brak mostu API (preload).",
  "(attachment)": "(załącznik)",
  "Load earlier": "Wczytaj wcześniejsze",
  "Thinking": "Thinking",
};

const DICTS = { pl: PL };

let current = "en";

/** "auto" → język systemu; nieznany → angielski. */
function resolveLang(setting, systemLocale) {
  const want =
    setting && setting !== "auto"
      ? setting
      : String(systemLocale || "en").slice(0, 2).toLowerCase();
  return DICTS[want] ? want : "en";
}

function setLang(lang) {
  current = DICTS[lang] ? lang : "en";
  return current;
}

function getLang() {
  return current;
}

/** t("Send") → "Wyślij" w PL, "Send" w EN i przy braku tłumaczenia. */
function t(text) {
  if (current === "en") return text;
  const dict = DICTS[current];
  return (dict && dict[text]) || text;
}

/**
 * Tłumaczy statyczny HTML: data-i18n (treść), data-i18n-placeholder,
 * data-i18n-title. Wołane po każdej zmianie języka.
 */
function applyDomTranslations(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
  scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
}

if (typeof window !== "undefined") {
  window.i18n = { t, setLang, getLang, resolveLang, applyDomTranslations };
  // tr(), nie t(): w app.js „t” jest zajęte przez zmienne pętli po narzędziach
  window.tr = t;
}

if (typeof module !== "undefined") {
  module.exports = { t, setLang, getLang, resolveLang, DICTS, PL };
}
