# Grok Sessions

Desktop shell for **Grok Build** (SuperGrok) — Claude Code–style UI on macOS.

| Mode | What it does |
|---|---|
| **Home** | Browser-like chat + images/video |
| **Build** | Coding agent (tools, files, shell) via Grok ACP |

## Requirements

- macOS
- Node.js 18+
- [Grok Build CLI](https://docs.x.ai) installed and logged in (`grok login`)
- SuperGrok / xAI account

## Install

```bash
git clone https://github.com/rafalsosky/grok-sessions.git
cd grok-sessions
npm install
npm start
```

Optional desktop launcher: open the app once with `npm start`, or wrap with your own `.app` pointing at:

```bash
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
```

## Features

- Session sidebar from `~/.grok/sessions`
- In-window chat (no Terminal as primary UI)
- Attachments: drag / paste / pick files
- Message queue while the agent is busy (merged into one turn)
- Usage panel: context % + API rate limits + plan tier
- Themes: dark / light / auto
- Effort control (Build mode)

## Privacy

- **No secrets in this repo.** Auth stays in `~/.grok/auth.json` on your machine.
- Home chats live under Electron `userData` (local only).
- Sessions are Grok’s own files under `~/.grok/sessions`.

## Scripts

```bash
npm start              # run app
npm run verify-sessions
npm run smoke          # ACP smoke test (needs login)
```

## License

MIT — use, fork, improve. Not affiliated with xAI.
