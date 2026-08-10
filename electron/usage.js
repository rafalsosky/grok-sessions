"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { resolveGrokHome, readJsonSafe, loadActiveMap, UUID_RE } =
  require("./sessions");

function findSessionDir(grokHome, sessionId) {
  if (!sessionId || !UUID_RE.test(sessionId)) return null;
  const root = path.join(grokHome, "sessions");
  if (!fs.existsSync(root)) return null;
  let found = null;
  const walk = (dir, depth) => {
    if (found || depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === sessionId) {
        found = full;
        return;
      }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function loadSignals(sessionDir) {
  if (!sessionDir) return null;
  return readJsonSafe(path.join(sessionDir, "signals.json"), null);
}

function loadAuthKey(grokHome) {
  const auth = readJsonSafe(path.join(grokHome, "auth.json"), null);
  if (!auth || typeof auth !== "object") return null;
  for (const v of Object.values(auth)) {
    if (v && typeof v === "object" && typeof v.key === "string" && v.key) {
      return {
        key: v.key,
        email: v.email || null,
        name: [v.first_name, v.last_name].filter(Boolean).join(" ") || null,
        expiresAt: v.expires_at || null,
      };
    }
  }
  return null;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function httpsJson({ hostname, path: p, method = "GET", token, body }) {
  return new Promise((resolve) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "GrokSessions/0.1",
      Origin: "https://grok.com",
      Referer: "https://grok.com/",
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request(
      { hostname, path: p, method, headers, timeout: 12000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* ignore */
          }
          resolve({
            status: res.statusCode,
            headers: res.headers || {},
            json,
            raw: raw.slice(0, 500),
          });
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

let rateCache = { at: 0, data: null };
let planCache = { at: 0, data: null };

async function probeApiRate(token) {
  const now = Date.now();
  if (rateCache.data && now - rateCache.at < 60_000) return rateCache.data;
  const res = await httpsJson({
    hostname: "api.x.ai",
    path: "/v1/chat/completions",
    method: "POST",
    token,
    body: {
      model: "grok-4-1-fast-non-reasoning",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    },
  });
  if (!res) return null;
  const h = res.headers;
  const data = {
    tokensLimit: num(h["x-ratelimit-limit-tokens"]),
    tokensRemaining: num(h["x-ratelimit-remaining-tokens"]),
    requestsLimit: num(h["x-ratelimit-limit-requests"]),
    requestsRemaining: num(h["x-ratelimit-remaining-requests"]),
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
  };
  rateCache = { at: Date.now(), data };
  return data;
}

/**
 * Plan / weekly SuperGrok Heavy usage (browser-style).
 * Subscriptions work with OIDC. Weekly rate-limits are blocked for OAuth2
 * tokens by xAI — we still try and surface a clear status.
 */
async function fetchPlanUsage(token) {
  const now = Date.now();
  if (planCache.data && now - planCache.at < 120_000) return planCache.data;

  const subRes = await httpsJson({
    hostname: "grok.com",
    path: "/rest/subscriptions",
    method: "GET",
    token,
  });

  let tier = null;
  let tierLabel = null;
  let status = null;
  let billingPeriodEnd = null;
  if (subRes && subRes.json && Array.isArray(subRes.json.subscriptions)) {
    const active = subRes.json.subscriptions.find(
      (s) => s.status === "SUBSCRIPTION_STATUS_ACTIVE"
    );
    const pick = active || subRes.json.subscriptions[0];
    if (pick) {
      tier = pick.tier || null;
      status = pick.status || null;
      billingPeriodEnd = pick.billingPeriodEnd || null;
      // SuperGrok Heavy / Pro naming from productId + tier
      const product =
        (pick.google && pick.google.productId) ||
        pick.productId ||
        "";
      if (/ultra|heavy/i.test(product) || /PRO|HEAVY|ULTRA/i.test(String(tier))) {
        tierLabel = "SuperGrok Heavy";
      } else if (/lite/i.test(product) || /LITE/i.test(String(tier))) {
        tierLabel = "SuperGrok Lite";
      } else if (tier) {
        tierLabel = String(tier)
          .replace(/^SUBSCRIPTION_TIER_/, "")
          .replace(/_/g, " ");
      }
    }
  }

  // Browser weekly limit — blocked for OIDC/OAuth2 build tokens
  const rlRes = await httpsJson({
    hostname: "grok.com",
    path: "/rest/rate-limits",
    method: "POST",
    token,
    body: {},
  });

  let weekly = null;
  let weeklyError = null;
  if (rlRes && rlRes.status === 200 && rlRes.json) {
    weekly = parseWeeklyFromRateLimits(rlRes.json);
  } else if (rlRes && rlRes.json && rlRes.json.message) {
    weeklyError =
      /oauth2/i.test(rlRes.json.message) || /WKE=unauthorized/i.test(rlRes.json.message)
        ? "xAI blokuje % tygodniowy dla tokena Build (tylko przeglądarka)"
        : String(rlRes.json.message).slice(0, 160);
  } else if (rlRes && rlRes.status) {
    weeklyError = `rate-limits HTTP ${rlRes.status}`;
  } else {
    weeklyError = "Brak odpowiedzi rate-limits";
  }

  const data = {
    tier,
    tierLabel: tierLabel || "SuperGrok",
    status,
    billingPeriodEnd,
    weekly, // { percent, label, resetsAt, windowLabel } | null
    weeklyError,
    weeklyUrl: "https://grok.com/", // settings → Zużycie
  };
  planCache = { at: Date.now(), data };
  return data;
}

function parseWeeklyFromRateLimits(json) {
  if (!json || typeof json !== "object") return null;
  // tolerate several shapes seen in xAI clients
  const candidates = [];
  const push = (o, label) => {
    if (!o || typeof o !== "object") return;
    const pct =
      num(o.percentUsed) ??
      num(o.percent_used) ??
      num(o.usedPercent) ??
      num(o.usagePercent) ??
      (num(o.remaining) != null && num(o.limit)
        ? Math.round(((o.limit - o.remaining) / o.limit) * 100)
        : null) ??
      (num(o.used) != null && num(o.limit)
        ? Math.round((o.used / o.limit) * 100)
        : null);
    if (pct == null) return;
    candidates.push({
      percent: Math.max(0, Math.min(100, pct)),
      label:
        label ||
        o.name ||
        o.windowName ||
        o.feature ||
        o.limitName ||
        "Weekly",
      resetsAt:
        o.resetsAt ||
        o.resetTime ||
        o.reset_at ||
        o.windowEnd ||
        o.expiresAt ||
        null,
      windowLabel: o.windowLabel || o.period || "tydzień",
    });
  };

  if (Array.isArray(json.rateLimits)) {
    for (const r of json.rateLimits) push(r, r.name);
  }
  if (Array.isArray(json.limits)) {
    for (const r of json.limits) push(r, r.name);
  }
  if (json.weekly) push(json.weekly, "Weekly");
  if (json.superGrokHeavy) push(json.superGrokHeavy, "SuperGrok Heavy");
  if (json.usage) push(json.usage, "Usage");
  // nested map
  for (const [k, v] of Object.entries(json)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (
        /week|heavy|build|limit/i.test(k) ||
        "percentUsed" in v ||
        "used" in v
      ) {
        push(v, k);
      }
    }
  }
  if (!candidates.length) return null;
  // prefer weekly / heavy / build
  candidates.sort((a, b) => {
    const score = (x) =>
      (/heavy|week|build/i.test(x.label) ? 10 : 0) + (x.percent || 0) / 100;
    return score(b) - score(a);
  });
  return candidates[0];
}

/**
 * @param {{ sessionId?: string, grokHome?: string, includeRate?: boolean }} opts
 */
async function getUsage(opts = {}) {
  const grokHome = resolveGrokHome(opts.grokHome);
  const sessionId = opts.sessionId || null;
  const sessionDir = sessionId ? findSessionDir(grokHome, sessionId) : null;
  const signals = loadSignals(sessionDir);
  const activeMap = loadActiveMap(grokHome);
  const active = sessionId ? activeMap.get(sessionId) : null;
  const auth = loadAuthKey(grokHome);

  let rate = null;
  let plan = null;
  if (opts.includeRate !== false && auth?.key) {
    try {
      const [r, p] = await Promise.all([
        probeApiRate(auth.key),
        fetchPlanUsage(auth.key),
      ]);
      rate = r;
      plan = p;
    } catch {
      /* ignore */
    }
  } else if (auth?.key) {
    try {
      plan = await fetchPlanUsage(auth.key);
    } catch {
      /* ignore */
    }
  }

  const contextPct =
    signals && typeof signals.contextWindowUsage === "number"
      ? signals.contextWindowUsage
      : null;

  return {
    ok: true,
    sessionId,
    sessionDir,
    account: auth
      ? { email: auth.email, name: auth.name, expiresAt: auth.expiresAt }
      : null,
    context: {
      percent: contextPct,
      tokensUsed: signals?.contextTokensUsed ?? null,
      tokensTotal: signals?.contextWindowTokens ?? null,
      turns: signals?.turnCount ?? null,
      tools: signals?.toolCallCount ?? null,
      model: signals?.primaryModelId || null,
      compactions: signals?.compactionCount ?? null,
    },
    terminal: {
      isActive: Boolean(active?.isActive),
      pid: active?.pid || null,
      cwd: active?.cwd || null,
    },
    plan,
    rate,
    at: Date.now(),
  };
}

module.exports = {
  getUsage,
  findSessionDir,
  loadSignals,
};
