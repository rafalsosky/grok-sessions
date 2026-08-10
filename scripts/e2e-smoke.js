#!/usr/bin/env node
"use strict";

/**
 * Functional smoke test (no UI):
 * 1) list top-level sessions from disk
 * 2) load a transcript
 * 3) ACP: new session + prompt, expect non-empty reply
 * Exit 0 only if all pass.
 */

const path = require("path");
const {
  scanSessions,
  checkGrokBinary,
  defaultGrokPath,
  resolveGrokHome,
} = require("../electron/sessions");
const { loadTranscript } = require("../electron/transcript");
const { AcpClient } = require("../electron/acp-client");

async function main() {
  const grokHome = resolveGrokHome();
  const grokPath = defaultGrokPath(grokHome);
  const bin = checkGrokBinary(grokPath);
  if (!bin.ok) {
    console.error("FAIL binary:", bin.reason);
    process.exit(2);
  }
  console.log("OK binary", bin.path);

  const scan = scanSessions({ showSubagents: false, grokHome });
  if (!scan.rows.length) {
    console.error("FAIL no sessions on disk");
    process.exit(2);
  }
  console.log("OK sessions", scan.rows.length);
  for (const r of scan.rows.slice(0, 5)) {
    console.log(" -", r.id.slice(0, 8), r.title.slice(0, 50));
  }

  const sample = scan.rows[0];
  const tr = loadTranscript(sample.dirPath);
  if (tr.error) {
    console.error("FAIL transcript", tr.error);
    process.exit(2);
  }
  console.log("OK transcript messages", tr.messages.length, "for", sample.title.slice(0, 40));

  const acp = new AcpClient({
    grokPath,
    model: "grok-4.5",
    alwaysApprove: true,
  });

  let chunks = "";
  acp.on("update", (params) => {
    const u = params.update || {};
    if (u.sessionUpdate === "agent_message_chunk") {
      chunks += (u.content && u.content.text) || "";
    }
  });

  console.log("ACP start…");
  const t0 = Date.now();
  await acp.start();
  console.log("OK acp ready in", Date.now() - t0, "ms");

  const home = require("os").homedir();
  const created = await acp.ensureSession({ cwd: home });
  console.log("OK session/new", created.sessionId);

  const t1 = Date.now();
  const result = await acp.prompt(
    "Odpowiedz dokładnie jednym słowem: DZIALA",
    { sessionId: created.sessionId, cwd: home }
  );
  const ms = Date.now() - t1;
  console.log("OK prompt done in", ms, "ms", "stopReason", result && result.stopReason);
  console.log("reply:", JSON.stringify(chunks.slice(0, 200)));

  if (!chunks.trim()) {
    console.error("FAIL empty agent reply");
    await acp.stop();
    process.exit(1);
  }

  // Resume existing historical session (load path)
  const t2 = Date.now();
  try {
    await acp.ensureSession({
      sessionId: sample.id,
      cwd: sample.cwd || home,
    });
    console.log("OK session/load existing in", Date.now() - t2, "ms", sample.id.slice(0, 8));
  } catch (err) {
    console.error("FAIL session/load", err.message);
    await acp.stop();
    process.exit(1);
  }

  await acp.stop();
  console.log("ALL SMOKE PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
