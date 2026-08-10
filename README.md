# SuperGrok Desktop SoskyApp

Lokalna aplikacja desktopowa (macOS, Electron) do pracy z **SuperGrok / Grok Build** w stylu Claude Code:

- lista sesji z boku,
- czat w oknie (nie w Terminalu jako główny UI),
- tryb **Home** (rozmowa / grafiki) i **Build** (agent z narzędziami).

**Nie jest oficjalnym produktem xAI.** To open-source shell wokół CLI `grok` i lokalnych plików sesji.

Repo: https://github.com/rafalsosky/grok-sessions

---

## Wymagania

| Co | Po co |
|---|---|
| macOS | uruchomienie Electron |
| Node.js 18+ | `npm install` / `npm start` |
| [Grok Build CLI](https://docs.x.ai) | agent i sesje (`grok`) |
| Konto SuperGrok / xAI | logowanie: `grok login` |

---

## Instalacja

```bash
git clone https://github.com/rafalsosky/grok-sessions.git
cd grok-sessions
npm install
npm start
```

### Opcjonalnie: skrót na Pulpicie

Aplikacja startuje z katalogu projektu:

```bash
# z katalogu repo
npx electron .
```

Możesz zrobić własne `.app` / skrypt `.command`, które wołają:

```text
…/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron  /ścieżka/do/grok-sessions
```

Ikona: `assets/GrokSessions.icns` (ciemne tło + znak Grok).

---

## Co jest w środku

### Home
- Czat jak w przeglądarce Grok
- Generowanie grafik / wideo (API xAI, zależnie od konta)
- Załączniki: drag & drop, wklejanie screenshotów

### Build
- Agent Grok (ACP: `grok agent --always-approve stdio`)
- Lista sesji z `~/.grok/sessions`
- Effort: Low / Med / High / xHigh
- Kolejka wiadomości gdy agent pracuje
- **↩ Wyślij teraz** na bańce w kolejce — przerywa turę i wysyła od razu
- Stream **izolowany per sesja** (przełączenie listy nie miesza odpowiedzi)

### Ogólne
- Motyw dark / light / auto (ustawienia)
- Panel zużycia (context %, rate limit API, plan SuperGrok gdy API pozwala)
- Menu sesji (PPM): rename, unread, pin, delete, copy ID
- Tryb **Auto** = always-approve narzędzi (jak Auto w Claude Code)

---

## Jak to działa (technicznie)

| Warstwa | Mechanizm |
|---|---|
| UI | Electron + HTML/CSS/JS (`src/`) |
| Lista sesji | skan `~/.grok/sessions/**/summary.json` |
| Historia Build | `updates.jsonl` |
| Agent | proces `grok agent … stdio` (ACP) |
| Home czat | HTTP API `api.x.ai` + token z lokalnego logowania |
| Auth | **tylko** lokalnie: `~/.grok/auth.json` |
| Flagi unread/pin | lokalnie w Electron `userData` |

**Żadne hasła, tokeny ani historia czatu nie są w tym repozytorium.**

---

## Bezpieczeństwo i prywatność

Przed publikacją sprawdzone:

| Ryzyko | Status |
|---|---|
| Tokeny / API keys w repo | **brak** |
| `auth.json` w repo | **brak** (`.gitignore`) |
| Twoje ścieżki (`/Users/…`) | **brak** w kodzie |
| E-mail / dane konta | **brak** — apka czyta je lokalnie po `grok login` |
| `node_modules` | **nie** commitowane |

Po sklonowaniu u kogoś:

1. On instaluje własne Node + Grok CLI  
2. Robi **własne** `grok login`  
3. Ma własne `~/.grok/` — Twoje konto się nie udostępnia  

---

## Skrypty

```bash
npm start                 # uruchom SuperGrok Desktop SoskyApp
npm run verify-sessions   # porównanie listy sesji z dysku
npm run smoke             # szybki test ACP (wymaga zalogowania)
```

---

## Struktura katalogów

```text
grok-sessions/
  electron/     # main process, ACP, API xAI, sesje
  src/          # UI (index.html, app.js, styles)
  assets/       # ikona .icns / PNG
  scripts/      # weryfikacja / smoke
  package.json
```

---

## Roadmapa / ograniczenia

- **% tygodniowy SuperGrok Heavy** jak w przeglądarce: xAI blokuje ten endpoint dla tokena Build — w panelu widać plan + context/rate; pełne weekly % często tylko na grok.com  
- Wideo Home zależy od dostępności API na koncie  
- Windows / Linux: nie testowane (skupienie na macOS)

---

## Licencja

MIT — używaj, forku, ulepszaj.

Marka **Sosky** / **SuperGrok Desktop SoskyApp** — warstwa UI; Grok / SuperGrok / xAI to znaki xAI.

---

## Autor

Open-source shell pod pracę z Grok Build.  
Pytania i PR: issues na GitHubie.
