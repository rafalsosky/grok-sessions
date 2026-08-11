"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFile } = require("child_process");
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

function httpsRequest({
  hostname,
  path: p,
  method = "GET",
  headers = {},
  body = null,
  timeout = 12000,
}) {
  return new Promise((resolve) => {
    const payload =
      body == null
        ? null
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(
              typeof body === "string" ? body : JSON.stringify(body),
              "utf8"
            );
    const hdrs = { ...headers };
    if (payload && !hdrs["Content-Length"]) {
      hdrs["Content-Length"] = String(payload.length);
    }
    const req = https.request(
      { hostname, path: p, method, headers: hdrs, timeout },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers || {},
            body: Buffer.concat(chunks),
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

function httpsJson({ hostname, path: p, method = "GET", token, body, cookie }) {
  const headers = {
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    Origin: "https://grok.com",
    Referer: "https://grok.com/",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body != null) headers["Content-Type"] = "application/json";
  return httpsRequest({ hostname, path: p, method, headers, body }).then(
    (res) => {
      if (!res) return null;
      let json = null;
      const raw = res.body.toString("utf8");
      try {
        json = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      return {
        status: res.status,
        headers: res.headers,
        json,
        raw: raw.slice(0, 500),
      };
    }
  );
}

/* ─── Browser cookies (Arc/Chrome via rookiepy) for weekly % ─── */

const COOKIE_DOMAINS = ["grok.com", ".grok.com", "x.ai", ".x.ai", "auth.x.ai"];
const COOKIE_NAMES = new Set(["sso", "sso-rw", "cf_clearance", "__cf_bm"]);
let cookieCache = { at: 0, header: null, error: null };

/**
 * Python z modułem rookiepy. Kolejność: jawne ustawienie użytkownika,
 * potem PATH, potem typowe lokalizacje. Zero ścieżek zaszytych pod
 * konkretne konto — patrz README, sekcja „Tygodniowy %".
 */
function findRookiePython(explicitPath) {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const full = expandUser(p);
    if (out.includes(full)) return;
    try {
      fs.accessSync(full, fs.constants.X_OK);
      out.push(full);
    } catch {
      /* nie ma albo nie wykonywalny */
    }
  };

  add(explicitPath);
  add(process.env.GROK_SESSIONS_PYTHON);

  const home = process.env.HOME || "";
  // Narzędzia uv trzymają własne wirtualne środowiska; rookiepy bywa tylko
  // w jednym z nich. Przeglądamy katalog, nie zgadujemy nazwy narzędzia.
  const uvTools = path.join(home, ".local/share/uv/tools");
  try {
    for (const name of fs.readdirSync(uvTools)) {
      add(path.join(uvTools, name, "bin", "python"));
      add(path.join(uvTools, name, "bin", "python3"));
    }
  } catch {
    /* brak uv */
  }

  for (const d of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    add(path.join(d, "python3"));
    add(path.join(d, "python"));
  }
  add(path.join(home, ".local/bin/python3"));
  add("/opt/homebrew/bin/python3");
  add("/usr/local/bin/python3");
  add("/usr/bin/python3");

  return out;
}

function expandUser(p) {
  if (!p) return p;
  const home = process.env.HOME || "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/**
 * NIE spawnSync — to blokowało cały proces main (zamrożone UI i strumień
 * agenta na czas odczytu ciasteczek). execFile + Promise.
 */
function loadBrowserCookieHeader(pythonPath) {
  const now = Date.now();
  if (cookieCache.header && now - cookieCache.at < 120_000) {
    return Promise.resolve(cookieCache.header);
  }
  if (cookieCache.error && now - cookieCache.at < 120_000) {
    // nie próbuj co odświeżenie, gdy i tak nie ma czego czytać
    return Promise.resolve(null);
  }
  const pythons = findRookiePython(pythonPath);
  if (!pythons.length) {
    cookieCache = {
      at: now,
      header: null,
      error: "Python not found (see README)",
    };
    return Promise.resolve(null);
  }
  const script = `
import json, sys
try:
    import rookiepy
except Exception as e:
    print(json.dumps({"ok": False, "error": "rookiepy: " + str(e)}))
    sys.exit(0)
domains = ${JSON.stringify(COOKIE_DOMAINS)}
names = set(${JSON.stringify([...COOKIE_NAMES])})
cookies = []
for browser in ("arc", "chrome", "chromium"):
    getter = getattr(rookiepy, browser, None)
    if not getter:
        continue
    try:
        got = getter(domains) or []
    except Exception:
        continue
    if got:
        cookies = got
        break
if not cookies:
    print(json.dumps({"ok": False, "error": "No grok.com cookies (sign in via Arc/Chrome)"}))
    sys.exit(0)
picked = [c for c in cookies if c.get("name") in names]
if not picked:
    picked = cookies
header = "; ".join(f"{c['name']}={c['value']}" for c in picked)
print(json.dumps({"ok": True, "header": header, "count": len(picked)}))
`;
  // Nie każdy Python ma rookiepy — bierzemy pierwszy, który naprawdę zadziała,
  // zamiast pierwszego z PATH.
  const runOne = (py) =>
    new Promise((resolve) => {
      execFile(
        py,
        ["-c", script],
        { encoding: "utf8", timeout: 15000, env: process.env },
        (err, stdout, stderr) => {
          const line = (stdout || "").trim().split("\n").pop() || "";
          try {
            const data = JSON.parse(line);
            resolve(data && data.ok && data.header ? data : { ok: false, error: data.error });
          } catch {
            resolve({
              ok: false,
              error: ((err && err.message) || stderr || "cookie script fail").slice(0, 160),
            });
          }
        }
      );
    });

  return (async () => {
    let lastError = "No cookies";
    for (const py of pythons) {
      const res = await runOne(py);
      if (res.ok) {
        cookieCache = { at: Date.now(), header: res.header, error: null };
        return res.header;
      }
      if (res.error) lastError = res.error;
      // brak modułu = próbuj kolejnego interpretera; inny błąd = to nie python
      if (!/rookiepy|No module named/i.test(String(res.error || ""))) break;
    }
    cookieCache = {
      at: Date.now(),
      header: null,
      error: /rookiepy|No module named/i.test(lastError)
        ? "No Python has the rookiepy module — install it: pip3 install rookiepy"
        : lastError,
    };
    return null;
  })();
}

/* ─── Protobuf (minimal) for GetGrokCreditsConfig ─── */

function readVarint(buf, i) {
  let result = 0;
  let shift = 0;
  while (i < buf.length) {
    const b = buf[i++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 56) break;
  }
  return [result, i];
}

function parseFields(buf) {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    const [key, i2] = readVarint(buf, i);
    if (i2 === i) break;
    i = i2;
    const field = key >>> 3;
    const wt = key & 7;
    if (wt === 0) {
      const [val, ni] = readVarint(buf, i);
      i = ni;
      fields.push({ field, wt: "varint", val });
    } else if (wt === 1) {
      if (i + 8 > buf.length) break;
      const val = buf.readDoubleLE(i);
      i += 8;
      fields.push({ field, wt: "fixed64", val });
    } else if (wt === 2) {
      const [ln, ni] = readVarint(buf, i);
      i = ni;
      const data = buf.subarray(i, i + ln);
      i += ln;
      let nested = null;
      try {
        nested = parseFields(data);
      } catch {
        nested = null;
      }
      fields.push({ field, wt: "bytes", data, nested });
    } else if (wt === 5) {
      if (i + 4 > buf.length) break;
      const fval = buf.readFloatLE(i);
      i += 4;
      fields.push({ field, wt: "fixed32", val: fval });
    } else {
      break;
    }
  }
  return fields;
}

function parseGrpcWebFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    // text trailers sometimes glued
    if (
      buf[i] === 0x67 &&
      buf.subarray(i, i + 11).toString("utf8") === "grpc-status"
    ) {
      frames.push({ flags: 0x80, payload: buf.subarray(i) });
      break;
    }
    const flags = buf[i];
    const length = buf.readUInt32BE(i + 1);
    i += 5;
    const payload = buf.subarray(i, i + length);
    i += length;
    frames.push({ flags, payload });
    if (flags & 0x80) break;
  }
  return frames;
}

const PRODUCT_LABEL = {
  0: "Unspecified",
  1: "API",
  2: "Grok Build",
  3: "Plugins",
  4: "Chat",
  5: "Imagine",
  6: "Voice",
  7: "App Builder",
};

const PERIOD_LABEL = {
  0: "unspecified",
  1: "monthly",
  2: "weekly",
};

function extractTimestampSeconds(fields) {
  if (!fields) return null;
  for (const f of fields) {
    if (f.field === 1 && f.wt === "varint") return f.val;
  }
  return null;
}

function parseCreditsConfig(fields) {
  // Response: field 1 = GrokCreditsConfig message
  const config =
    fields.find((f) => f.field === 1 && f.wt === "bytes" && f.nested) || null;
  if (!config) return null;
  const cf = config.nested;
  let creditUsagePercent = null;
  let resetsAt = null;
  let periodStart = null;
  let periodType = null;
  const products = [];

  for (const f of cf) {
    // overall percent (float)
    if (f.wt === "fixed32" && f.val >= 0 && f.val <= 100) {
      if (creditUsagePercent == null) creditUsagePercent = f.val;
    }
    // ProductUsage-like: enum + float
    if (f.wt === "bytes" && f.nested) {
      let product = null;
      let pct = null;
      let type = null;
      let startSec = null;
      let endSec = null;
      for (const n of f.nested) {
        if (n.wt === "varint" && n.field === 1 && n.val >= 0 && n.val <= 20) {
          // could be product enum or period type
          if (product == null) product = n.val;
          if (type == null) type = n.val;
        }
        if (n.wt === "fixed32" && n.val >= 0 && n.val <= 100) {
          pct = n.val;
        }
        if (n.wt === "bytes" && n.nested) {
          const sec = extractTimestampSeconds(n.nested);
          if (sec != null) {
            if (startSec == null) startSec = sec;
            else if (endSec == null) endSec = sec;
          }
        }
      }
      // Product usage row (has both product enum 1-7 and percent)
      if (product != null && pct != null && product >= 1 && product <= 10) {
        products.push({
          product,
          label: PRODUCT_LABEL[product] || `product ${product}`,
          percent: Math.round(pct * 10) / 10,
        });
      }
      // Period message: type + two timestamps
      if (type != null && startSec != null && endSec != null && pct == null) {
        periodType = PERIOD_LABEL[type] || String(type);
        periodStart = startSec;
        resetsAt = endSec;
      }
      // top-level timestamps without period wrapper
      if (startSec != null && endSec == null && product == null && pct == null) {
        // single timestamp fields inside config
        if (!periodStart) periodStart = startSec;
        else if (!resetsAt) resetsAt = startSec;
      }
    }
  }

  // Prefer Grok Build product percent for the main bar (this app is Build)
  const build = products.find((p) => p.product === 2) || products[0] || null;
  const percent =
    build?.percent != null
      ? build.percent
      : creditUsagePercent != null
        ? Math.round(creditUsagePercent * 10) / 10
        : null;

  if (percent == null) return null;

  return {
    percent,
    creditUsagePercent:
      creditUsagePercent != null
        ? Math.round(creditUsagePercent * 10) / 10
        : percent,
    label: build?.label || "Grok Build",
    products,
    periodType: periodType || "weekly",
    periodStart: periodStart ? new Date(periodStart * 1000).toISOString() : null,
    resetsAt: resetsAt ? new Date(resetsAt * 1000).toISOString() : null,
    windowLabel: periodType === "monthly" ? "month" : "week",
  };
}

async function fetchWeeklyFromBrowser(cookieHeader) {
  // Empty protobuf request, grpc-web envelope
  const empty = Buffer.alloc(5);
  empty[0] = 0;
  empty.writeUInt32BE(0, 1);

  const res = await httpsRequest({
    hostname: "grok.com",
    path: "/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
    method: "POST",
    headers: {
      Cookie: cookieHeader,
      "Content-Type": "application/grpc-web+proto",
      Accept: "application/grpc-web+proto",
      "X-Grpc-Web": "1",
      "X-User-Agent": "grpc-web-javascript/0.1",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Origin: "https://grok.com",
      Referer: "https://grok.com/settings/usage",
    },
    body: empty,
    timeout: 15000,
  });
  if (!res || !res.body || !res.body.length) {
    return { weekly: null, error: "Empty credits response" };
  }
  const frames = parseGrpcWebFrames(res.body);
  const dataFrame = frames.find((f) => f.flags === 0);
  if (!dataFrame) {
    return { weekly: null, error: "No gRPC frame" };
  }
  try {
    const fields = parseFields(dataFrame.payload);
    const weekly = parseCreditsConfig(fields);
    if (!weekly) {
      return { weekly: null, error: "Could not parse % from the response" };
    }
    return { weekly, error: null };
  } catch (err) {
    return { weekly: null, error: err.message || "parse fail" };
  }
}

let planCache = { at: 0, data: null };

// Usunięto probeApiRate: żeby odczytać nagłówki rate-limit, wysyłał prawdziwe
// (płatne) zapytanie do /v1/chat/completions co odświeżenie panelu. UI i tak
// nigdy tych danych nie pokazywał.

/**
 * Plan tier (OAuth token) + weekly SuperGrok % (browser cookies / sso).
 * OAuth cannot call weekly — xAI returns oauth2-auth-forbidden.
 * Weekly comes from GrokBuildBilling.GetGrokCreditsConfig via Arc/Chrome session.
 */
async function fetchPlanUsage(token, opts = {}) {
  const now = Date.now();
  if (planCache.data && now - planCache.at < 90_000) return planCache.data;

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
      const product =
        (pick.google && pick.google.productId) || pick.productId || "";
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

  let weekly = null;
  let weeklyError = null;
  let weeklySource = null;

  // Domyślnie WYŁĄCZONE: czytanie ciasteczek przeglądarki to dostęp do
  // zalogowanej sesji użytkownika. Włącza się świadomie w Ustawieniach.
  const cookieHeader = opts.readBrowserCookies
    ? await loadBrowserCookieHeader(opts.pythonPath)
    : null;
  if (cookieHeader) {
    const fromBrowser = await fetchWeeklyFromBrowser(cookieHeader);
    if (fromBrowser.weekly) {
      weekly = fromBrowser.weekly;
      weeklySource = "browser-session";
    } else {
      weeklyError =
        fromBrowser.error ||
        cookieCache.error ||
        "Could not read the limit from the browser session";
    }
  } else {
    // fallback: try OAuth rate-limits (usually blocked)
    const rlRes = await httpsJson({
      hostname: "grok.com",
      path: "/rest/rate-limits",
      method: "POST",
      token,
      body: { modelName: "build" },
    });
    if (rlRes && rlRes.status === 200 && rlRes.json) {
      const total = num(rlRes.json.totalQueries);
      const rem = num(rlRes.json.remainingQueries);
      if (total != null && rem != null && total > 0) {
        const usedPct = Math.round(((total - rem) / total) * 100);
        weekly = {
          percent: usedPct,
          label: "Build (2 h window)",
          resetsAt: null,
          windowLabel: "2 h",
          periodType: "short",
        };
        weeklySource = "oauth-short-window";
      }
    } else if (rlRes && rlRes.json && rlRes.json.message) {
      weeklyError =
        /oauth2/i.test(rlRes.json.message) ||
        /WKE=unauthorized/i.test(rlRes.json.message)
          ? "xAI blocks this limit for OAuth tokens (oauth2-auth-forbidden). The only route is a browser session: Settings → „Read grok.com cookies”."
          : String(rlRes.json.message).slice(0, 160);
    } else if (!opts.readBrowserCookies) {
      weeklyError =
        "Weekly % needs a browser session. Enable it in Settings: „Read grok.com cookies from Arc/Chrome”.";
    } else {
      weeklyError =
        cookieCache.error ||
        "No browser session (Arc/Chrome signed in to grok.com)";
    }
  }

  const data = {
    tier,
    tierLabel: tierLabel || "SuperGrok",
    status,
    billingPeriodEnd,
    weekly,
    weeklyError,
    weeklySource,
    weeklyUrl: "https://grok.com/settings/usage",
  };
  planCache = { at: Date.now(), data };
  return data;
}

/**
 * @param {{ sessionId?: string, grokHome?: string,
 *           readBrowserCookies?: boolean, pythonPath?: string }} opts
 */
async function getUsage(opts = {}) {
  const planOpts = {
    readBrowserCookies: Boolean(opts.readBrowserCookies),
    pythonPath: opts.pythonPath || "",
  };
  const grokHome = resolveGrokHome(opts.grokHome);
  const sessionId = opts.sessionId || null;
  const sessionDir = sessionId ? findSessionDir(grokHome, sessionId) : null;
  const signals = loadSignals(sessionDir);
  const activeMap = loadActiveMap(grokHome);
  const active = sessionId ? activeMap.get(sessionId) : null;
  const auth = loadAuthKey(grokHome);

  let plan = null;
  if (auth?.key) {
    try {
      plan = await fetchPlanUsage(auth.key, planOpts);
    } catch {
      /* ignore */
    }
  } else if (planOpts.readBrowserCookies) {
    // bez OAuth zostaje tylko sesja przeglądarki — i tylko za zgodą
    try {
      const cookieHeader = await loadBrowserCookieHeader(planOpts.pythonPath);
      if (cookieHeader) {
        const fromBrowser = await fetchWeeklyFromBrowser(cookieHeader);
        plan = {
          tier: null,
          tierLabel: "SuperGrok",
          status: null,
          billingPeriodEnd: null,
          weekly: fromBrowser.weekly,
          weeklyError: fromBrowser.error,
          weeklySource: fromBrowser.weekly ? "browser-session" : null,
          weeklyUrl: "https://grok.com/settings/usage",
        };
      }
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
    at: Date.now(),
  };
}

module.exports = {
  getUsage,
  findSessionDir,
  loadSignals,
};
