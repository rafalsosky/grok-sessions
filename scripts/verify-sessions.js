#!/usr/bin/env node
"use strict";

/**
 * Compare disk scan (top-level only) with `grok sessions list` from default cwd.
 * Exit 0 if sets match (or CLI empty + only explain), exit 1 on mismatch.
 */

const { execFileSync } = require("child_process");
const path = require("path");
const {
  scanSessions,
  resolveGrokHome,
  defaultGrokPath,
} = require("../electron/sessions");

const grokHome = resolveGrokHome();
const grokPath = defaultGrokPath(grokHome);
const defaultCwd = process.env.GROK_SESSIONS_CWD || require("os").homedir();

const scan = scanSessions({ showSubagents: false, grokHome });
const diskIds = new Set(scan.rows.map((r) => r.id));

let cliOut = "";
try {
  cliOut = execFileSync(grokPath, ["sessions", "list", "-n", "200"], {
    cwd: defaultCwd,
    encoding: "utf8",
    timeout: 30000,
  });
} catch (err) {
  console.error("CLI list failed:", err.message);
  process.exit(2);
}

const cliIds = new Set();
for (const line of cliOut.split("\n")) {
  const m = line.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
  );
  if (m) cliIds.add(m[1]);
}

const onlyDisk = [...diskIds].filter((id) => !cliIds.has(id));
const onlyCli = [...cliIds].filter((id) => !diskIds.has(id));

console.log("grokHome:", grokHome);
console.log("cwd for CLI:", defaultCwd);
console.log("disk top-level:", diskIds.size);
console.log("cli list:", cliIds.size);
console.log(
  "titles (disk):",
  scan.rows.map((r) => `${r.id.slice(0, 8)} ${r.title}`).join("\n  ")
);

if (onlyDisk.length || onlyCli.length) {
  console.error("MISMATCH");
  if (onlyDisk.length) console.error("only on disk:", onlyDisk);
  if (onlyCli.length) console.error("only in CLI:", onlyCli);
  // CLI is cwd-scoped: onlyDisk may include other cwds — warn, not always fail
  const otherCwd = scan.rows.filter((r) => r.cwd !== defaultCwd).map((r) => r.id);
  const unexpectedDisk = onlyDisk.filter((id) => !otherCwd.includes(id));
  if (unexpectedDisk.length || onlyCli.length) {
    process.exit(1);
  }
  console.log("OK (disk has extra sessions from other cwds)");
  process.exit(0);
}

console.log("OK match");
process.exit(0);
