"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { UUID_RE, expandHome } = require("./sessions");

const execFileAsync = promisify(execFile);

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildGrokCommand({ grokPath, cwd, mode, sessionId }) {
  const bin = expandHome(grokPath);
  const workdir = expandHome(cwd);
  if (mode === "new") {
    return `cd ${shellQuote(workdir)} && ${shellQuote(bin)} --cwd ${shellQuote(workdir)}`;
  }
  if (mode === "login") {
    return `${shellQuote(bin)} login`;
  }
  if (mode === "resume") {
    if (!UUID_RE.test(sessionId || "")) {
      throw new Error("Invalid session id (UUID expected)");
    }
    return `cd ${shellQuote(workdir)} && ${shellQuote(bin)} --resume ${shellQuote(sessionId)} --cwd ${shellQuote(workdir)}`;
  }
  throw new Error(`Unknown launch mode: ${mode}`);
}

function applescriptEscape(s) {
  // AppleScript string in double quotes
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function launchViaAppleScript(command) {
  const script = `
tell application "Terminal"
  activate
  do script "${applescriptEscape(command)}"
end tell
`;
  await execFileAsync("osascript", ["-e", script], { timeout: 15000 });
}

async function launchViaCommandFile(command) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sessions-"));
  const file = path.join(dir, "open-grok.command");
  const body = `#!/bin/zsh
set -e
${command}
exec zsh
`;
  fs.writeFileSync(file, body, { mode: 0o755 });
  await execFileAsync("open", [file], { timeout: 15000 });
  // leave file; OS opens it async. Clean old dirs best-effort later.
  return file;
}

/**
 * Open Terminal.app with a grok command.
 * Prefer AppleScript; fall back to .command file.
 */
async function launchInTerminal(opts) {
  const command = buildGrokCommand(opts);

  // Otwieranie terminala jest zrobione pod macOS (AppleScript / .command).
  // Zamiast udawać, że zadziałało, na innych systemach mówimy wprost, co
  // wpisać ręcznie — to jedna komenda.
  if (process.platform !== "darwin") {
    return {
      ok: false,
      method: null,
      command,
      error: `Automatic terminal launch is macOS-only. Run this yourself: ${command}`,
    };
  }

  try {
    await launchViaAppleScript(command);
    return { ok: true, method: "applescript", command };
  } catch (err) {
    try {
      const file = await launchViaCommandFile(command);
      return {
        ok: true,
        method: "command-file",
        command,
        file,
        warning: `AppleScript nie wyszedł (${err.message}). Użyto pliku .command.`,
      };
    } catch (err2) {
      return {
        ok: false,
        method: null,
        command,
        error: `Launch failed. AppleScript: ${err.message}. Fallback: ${err2.message}`,
      };
    }
  }
}

module.exports = {
  buildGrokCommand,
  launchInTerminal,
};
