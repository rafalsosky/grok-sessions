"use strict";

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const readline = require("readline");
const { expandHome } = require("./sessions");
const { FALLBACK_CHAT_MODEL } = require("./models");

/**
 * Long-lived grok agent stdio ACP client.
 * Emits: 'update', 'notification', 'error', 'exit', 'ready', 'models'
 */
class AcpClient extends EventEmitter {
  constructor({
    grokPath,
    model,
    alwaysApprove = true,
    reasoningEffort = "high",
  } = {}) {
    super();
    this.grokPath = expandHome(grokPath);
    this.model = model || FALLBACK_CHAT_MODEL;
    this.alwaysApprove = alwaysApprove;
    this.reasoningEffort = reasoningEffort || "high";
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.sessionId = null;
    this.models = [];
    this.currentModelId = null;
    this._starting = null;
    this.cwd = null;
  }

  async start() {
    if (this.ready) return;
    if (this._starting) return this._starting;
    this._starting = this._doStart();
    try {
      await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async _doStart() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }

    const args = ["agent"];
    if (this.alwaysApprove) args.push("--always-approve");
    if (this.model) args.push("--model", this.model);
    if (this.reasoningEffort) {
      args.push("--reasoning-effort", this.reasoningEffort);
    }
    args.push("stdio");

    this.proc = spawn(this.grokPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this._onLine(line));
    this.proc.stderr.on("data", (buf) => {
      const s = buf.toString();
      if (s.trim()) this.emit("stderr", s);
    });
    this.proc.on("exit", (code) => {
      this.ready = false;
      this.sessionId = null;
      for (const [, p] of this.pending) {
        p.reject(new Error(`Agent exited (${code})`));
      }
      this.pending.clear();
      this.emit("exit", code);
    });

    // WAŻNE: nie deklaruj fs/terminal capabilities, jeśli ich nie implementujemy.
    // Agent wtedy wisi na reverse-RPC (fs/read_text_file itd.) i czat „nie działa”.
    // Puste capabilities → narzędzia lecą po stronie procesu grok (jak headless).
    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "grok-sessions", version: "0.2.1" },
      clientCapabilities: {},
    });

    const meta = init._meta || {};
    const modelState = meta.modelState || {};
    this.currentModelId =
      modelState.currentModelId || (init.models && init.models.currentModelId) || this.model;
    this.models =
      (modelState.availableModels ||
        (init.models && init.models.availableModels) ||
        []) ||
      [];
    this.ready = true;
    this.emit("ready", init);
    this.emit("models", {
      currentModelId: this.currentModelId,
      availableModels: this.models,
    });
    return init;
  }

  _onLine(line) {
    if (!line || !line.trim()) return;
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      this.emit("error", new Error(`Bad JSON from agent: ${line.slice(0, 200)}`));
      return;
    }

    // Response to our request
    if (data.id != null && this.pending.has(data.id) && (data.result !== undefined || data.error)) {
      const p = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.error) {
        p.reject(
          Object.assign(new Error(data.error.message || "ACP error"), {
            data: data.error,
          })
        );
      } else p.resolve(data.result);
      return;
    }

    // Reverse request FROM agent TO client
    if (data.method && data.id != null && data.result === undefined && !data.error) {
      // Tryb "ask": agent pyta o zgodę na narzędzie — przekaż do UI zamiast
      // odsyłać method-not-found (to wcześniej wymuszało always-approve).
      if (/request_permission/i.test(data.method)) {
        this.emit("permission", { id: data.id, params: data.params || {} });
        return;
      }
      this._replyMethodNotFound(data.id, data.method);
      return;
    }

    if (data.method) {
      this.emit("notification", data);
      if (data.method === "session/update" && data.params) {
        this.emit("update", data.params);
      }
    }
  }

  _replyMethodNotFound(id, method) {
    if (!this.proc || !this.proc.stdin.writable) return;
    try {
      this.proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Client does not implement ${method}`,
          },
        }) + "\n"
      );
    } catch {
      /* ignore */
    }
  }

  /** Odpowiedź na session/request_permission. optionId = null → odmowa. */
  respondPermission(id, optionId) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    const outcome = optionId
      ? { outcome: "selected", optionId }
      : { outcome: "cancelled" };
    try {
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, result: { outcome } }) + "\n"
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Zmiana trybu uprawnień wymaga restartu procesu (flaga CLI). */
  async setPermissionMode(mode, { cwd } = {}) {
    const next = mode === "ask" ? false : true;
    if (this.alwaysApprove === next) return { ok: true, changed: false };
    this.alwaysApprove = next;
    if (cwd) this.cwd = cwd;
    const sid = this.sessionId;
    const workCwd = this.cwd;
    await this.stop();
    await this.start();
    if (sid) {
      try {
        await this.ensureSession({ sessionId: sid, cwd: workCwd });
      } catch {
        /* nowa sesja, gdy load nie wyjdzie */
      }
    }
    return { ok: true, changed: true, alwaysApprove: this.alwaysApprove };
  }

  request(method, params, { timeoutMs = 120000 } = {}) {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error("Agent not running"));
    }
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.proc.stdin.write(JSON.stringify(msg) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async ensureSession({ sessionId, cwd, mode }) {
    await this.start();
    if (cwd) this.cwd = cwd;
    if (sessionId && this.sessionId === sessionId) return { sessionId };

    if (sessionId) {
      // Prefer load; fall back to resume
      try {
        const res = await this.request("session/load", {
          sessionId,
          cwd,
          mcpServers: [],
        });
        this.sessionId = sessionId;
        this._applyModels(res);
        return { sessionId, ...res };
      } catch (err) {
        const res = await this.request("session/resume", {
          sessionId,
          cwd,
          mcpServers: [],
        });
        this.sessionId = sessionId;
        this._applyModels(res);
        return { sessionId, ...res };
      }
    }

    const res = await this.request("session/new", {
      cwd,
      mcpServers: [],
      // yoloMode tylko w trybie "auto" — w "ask" agent ma pytać o narzędzia
      _meta: { yoloMode: this.alwaysApprove },
    });
    this.sessionId = res.sessionId;
    this._applyModels(res);
    return res;
  }

  _applyModels(res) {
    if (!res) return;
    const models = res.models || {};
    if (models.currentModelId) this.currentModelId = models.currentModelId;
    if (models.availableModels) {
      this.models = models.availableModels;
      this.emit("models", {
        currentModelId: this.currentModelId,
        availableModels: this.models,
      });
    }
  }

  /**
   * Send a user prompt and wait for turn end. Streams via 'update' events.
   * @param {string|Array} textOrBlocks - plain text or ACP content blocks
   */
  async prompt(textOrBlocks, { sessionId, cwd } = {}) {
    await this.ensureSession({ sessionId, cwd });
    const sid = sessionId || this.sessionId;
    const prompt = Array.isArray(textOrBlocks)
      ? textOrBlocks
      : [{ type: "text", text: String(textOrBlocks) }];
    const result = await this.request(
      "session/prompt",
      {
        sessionId: sid,
        prompt,
      },
      { timeoutMs: 600000 }
    );
    return result;
  }

  async setEffort(level, { cwd } = {}) {
    this.reasoningEffort = level || "high";
    if (cwd) this.cwd = cwd;
    // Effort na żywym agencie — restart procesu (pewne)
    const sid = this.sessionId;
    const workCwd = this.cwd;
    await this.stop();
    await this.start();
    if (sid) {
      try {
        await this.ensureSession({
          sessionId: sid,
          cwd: workCwd,
        });
      } catch {
        /* new session if load fails */
      }
    }
    return { ok: true, effort: this.reasoningEffort };
  }

  async setModel(modelId) {
    this.model = modelId;
    // Many agents need restart to change default model for new sessions.
    // Try extension methods first; if none, restart process.
    try {
      await this.request("session/set_model", {
        sessionId: this.sessionId,
        modelId,
      });
      this.currentModelId = modelId;
      return { ok: true, method: "session/set_model" };
    } catch {
      /* fall through */
    }
    try {
      await this.request("x.ai/model/set", {
        sessionId: this.sessionId,
        modelId,
      });
      this.currentModelId = modelId;
      return { ok: true, method: "x.ai/model/set" };
    } catch {
      /* restart */
    }
    await this.stop();
    this.model = modelId;
    await this.start();
    return { ok: true, method: "restart" };
  }

  async stop() {
    this.ready = false;
    this.sessionId = null;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try {
        p.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // SIGTERM sam nie wystarczy: zawieszony `grok` zostawał jako sierota
      // po zamknięciu apki. Daj 3 s, potem SIGKILL.
      await new Promise((resolve) => {
        if (p.exitCode !== null || p.signalCode) return resolve();
        const t = setTimeout(() => {
          try {
            p.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          resolve();
        }, 3000);
        p.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    for (const [, pend] of this.pending) {
      pend.reject(new Error("stopped"));
    }
    this.pending.clear();
  }
}

module.exports = { AcpClient };
