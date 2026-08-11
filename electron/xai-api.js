"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { loadAccount } = require("./account");

function getAccessToken(grokHome) {
  const authPath = path.join(grokHome, "auth.json");
  if (!fs.existsSync(authPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const entry = Object.values(raw || {}).find((e) => e && e.key) || Object.values(raw || {})[0];
    return entry && entry.key ? entry.key : null;
  } catch {
    return null;
  }
}

function apiRequest(
  token,
  apiPath,
  body,
  { method = "POST", timeoutMs = 120000, signal = null } = {}
) {
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const req = https.request(
      {
        hostname: "api.x.ai",
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "GrokSessions/0.3 (desktop)",
          Accept: "application/json",
          ...(payload
            ? { "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { raw: text };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const msg =
              (json && (json.error || json.message)) ||
              text.slice(0, 300) ||
              `HTTP ${res.statusCode}`;
            reject(new Error(typeof msg === "string" ? msg : JSON.stringify(msg)));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("xAI API timeout"));
    });
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          req.destroy();
          reject(new Error("Aborted"));
        },
        { once: true }
      );
    }
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Strumieniowany czat (SSE). onDelta(text) leci na bieżąco.
 * Zwraca pełną treść po zakończeniu.
 */
function chatCompletionsStream(
  token,
  { model, messages, max_tokens = 8192, signal = null },
  onDelta
) {
  const payload = JSON.stringify({
    model,
    messages,
    max_tokens,
    stream: true,
  });
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const req = https.request(
      {
        hostname: "api.x.ai",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "User-Agent": "GrokSessions (desktop)",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 300000,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let msg = text.slice(0, 300) || `HTTP ${res.statusCode}`;
            try {
              const j = JSON.parse(text);
              msg = j.error || j.message || msg;
            } catch {
              /* raw */
            }
            reject(new Error(typeof msg === "string" ? msg : JSON.stringify(msg)));
          });
          return;
        }
        let full = "";
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          // SSE: zdarzenia rozdzielone pustą linią, pola po "data: "
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const j = JSON.parse(data);
              const delta =
                (j.choices && j.choices[0] && j.choices[0].delta &&
                  j.choices[0].delta.content) || "";
              if (delta) {
                full += delta;
                if (typeof onDelta === "function") onDelta(delta);
              }
            } catch {
              /* niepełna ramka — pomiń */
            }
          }
        });
        res.on("end", () => resolve(full));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("xAI API timeout"));
    });
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          req.destroy();
          reject(new Error("Aborted"));
        },
        { once: true }
      );
    }
    req.write(payload);
    req.end();
  });
}

async function listModels(token) {
  const data = await apiRequest(token, "/v1/models", null, { method: "GET" });
  return (data && data.data) || [];
}

/**
 * Chat completion. messages: OpenAI-style [{role, content:string|parts}]
 */
async function chatCompletions(
  token,
  { model, messages, max_tokens = 8192, signal = null }
) {
  return apiRequest(
    token,
    "/v1/chat/completions",
    { model, messages, max_tokens },
    { signal }
  );
}

// imgen.x.ai / vidgen.x.ai stoją za Cloudflare i mają dwie pułapki:
// 1) skryptowy User-Agent dostaje 403 — musi być przeglądarkowy,
// 2) transfer potrafi urwać się w połowie, a krótki plik udaje wynik,
//    więc porównujemy rozmiar z Content-Length i ponawiamy.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0 Safari/537.36";

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("Aborted"));
        },
        { once: true }
      );
    }
  });
}

async function downloadBuffer(url, { signal = null, tries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA, Accept: "*/*" },
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const expected = Number(res.headers.get("content-length") || 0);
      if (!buf.length || (expected && buf.length !== expected)) {
        throw new Error(`urwane pobieranie (${buf.length}/${expected} B)`);
      }
      return { buf, mimeType: res.headers.get("content-type") || "" };
    } catch (err) {
      if (signal && signal.aborted) throw new Error("Aborted");
      lastErr = err;
      await sleep(1000 * (attempt + 1), signal);
    }
  }
  throw new Error(
    `Nie udało się pobrać pliku (${lastErr ? lastErr.message : "no details"}): ${url}`
  );
}

/**
 * Image generation via grok-imagine-image*
 * returns { b64, mimeType, model }
 *
 * response_format=url, nie b64_json: przy 250-350 KB odpowiedź base64
 * regularnie urywała się w połowie i generowanie padało mimo pobrania opłaty.
 * URL to kilkaset bajtów JSON-a, plik dociągamy osobno.
 */
async function generateImage(
  token,
  { prompt, model = "grok-imagine-image", aspect_ratio = "1:1", signal = null }
) {
  const body = {
    model,
    prompt,
    n: 1,
    response_format: "url",
  };
  if (aspect_ratio) body.aspect_ratio = aspect_ratio;
  const res = await apiRequest(token, "/v1/images/generations", body, {
    timeoutMs: 180000,
    signal,
  });
  const item = res && res.data && res.data[0];
  if (!item || !item.url) {
    throw new Error("Image API returned no data");
  }
  const dl = await downloadBuffer(item.url, { signal });
  return {
    b64: dl.buf.toString("base64"),
    mimeType: item.mime_type || dl.mimeType || "image/png",
    model,
  };
}

const VIDEO_POLL_MS = 5000;
const VIDEO_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Wideo jest asynchroniczne: POST oddaje SAM request_id (HTTP 200, bez url),
 * a gotowy plik trzeba odpytać. GET /v1/videos/{id} daje 202 + {status:"pending",
 * progress} dopóki leci, potem {status:"done", video:{url,duration}}.
 * onProgress(procent) leci do UI przy każdym odpytaniu.
 * returns { kind:"video", b64, mimeType, url, duration, model }
 */
async function generateVideo(
  token,
  {
    prompt,
    model = "grok-imagine-video",
    aspect_ratio = "16:9",
    signal = null,
    onProgress = null,
  }
) {
  const start = await apiRequest(
    token,
    "/v1/videos/generations",
    { model, prompt, aspect_ratio },
    { timeoutMs: 120000, signal }
  );
  const requestId = start && (start.request_id || start.id);
  if (!requestId) {
    throw new Error(
      `Video API nie zwróciło request_id: ${JSON.stringify(start).slice(0, 200)}`
    );
  }

  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  let job = null;
  let first = true;
  while (Date.now() < deadline) {
    // pierwsze odpytanie od razu: krótkie zlecenia bywają gotowe zanim
    // minie pełne okno pollingu
    if (first) first = false;
    else await sleep(VIDEO_POLL_MS, signal);
    job = await apiRequest(token, `/v1/videos/${requestId}`, null, {
      method: "GET",
      timeoutMs: 60000,
      signal,
    });
    const st = job && job.status;
    if (st === "done" || (job && job.video && job.video.url)) break;
    if (st === "failed" || st === "error" || (job && job.error)) {
      throw new Error(
        `Generowanie wideo nie powiodło się: ${JSON.stringify(job).slice(0, 200)}`
      );
    }
    if (typeof onProgress === "function") {
      onProgress(Math.round(Number(job && job.progress) || 0));
    }
    job = null;
  }

  const url = job && job.video && job.video.url;
  if (!url) {
    throw new Error(
      `Wideo nie zdążyło się wygenerować w ${VIDEO_TIMEOUT_MS / 1000} s (request_id=${requestId})`
    );
  }
  const dl = await downloadBuffer(url, { signal });
  return {
    kind: "video",
    b64: dl.buf.toString("base64"),
    mimeType: dl.mimeType.startsWith("video/") ? dl.mimeType : "video/mp4",
    url,
    duration: job.video.duration,
    model,
  };
}

/**
 * Czy to prośba o GRAFIKĘ.
 *
 * Poprzednia wersja łapała każde zdanie zaczynające się od „wygeneruj”,
 * więc „wygeneruj listę 10 hooków” szło do generatora obrazów. Teraz sam
 * czasownik nie wystarczy: musi paść też rzeczownik oznaczający obraz
 * (albo jawna komenda /image).
 */
function looksLikeImagePrompt(text) {
  const t = String(text || "").toLowerCase().trim();
  if (/^\/(image|img)\b/.test(t)) return true;
  if (/^(grafika|obraz|zdjęcie|zdjecie|ilustracja|image)\s*:/.test(t)) return true;

  const verb =
    /\b(wygeneruj|wygenerować|narysuj|narysować|zrób|zrob|stwórz|stworz|generate|create|draw|render|make)\b/;
  const noun =
    /\b(grafik\w*|obraz\w*|obrazek\w*|zdj[eę]ci\w*|ilustracj\w*|rysun\w*|plakat\w*|miniatur\w*|logo|render\w*|image|images|picture|illustration|artwork|thumbnail|poster)\b/;

  if (verb.test(t) && noun.test(t)) return true;
  // „imagine …” jako komenda na początku
  if (/^imagine\b/.test(t)) return true;
  return false;
}

function stripImageCommand(text) {
  return String(text || "")
    .replace(/^\/(image|img)\s+/i, "")
    .replace(/^(wygeneruj( grafik[ęe]?| obraz)?|narysuj|zrób grafik[ęe]?|generate (an )?image|imagine|draw)\s*[:\-]?\s*/i, "")
    .trim();
}

module.exports = {
  getAccessToken,
  downloadBuffer,
  listModels,
  chatCompletions,
  chatCompletionsStream,
  generateImage,
  generateVideo,
  looksLikeImagePrompt,
  stripImageCommand,
  loadAccount,
};
