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
      reject(new Error("Przerwano"));
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
          reject(new Error("Przerwano"));
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
      reject(new Error("Przerwano"));
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
          reject(new Error("Przerwano"));
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

/**
 * Image generation via grok-imagine-image*
 * returns { b64, mimeType, model }
 */
async function generateImage(
  token,
  { prompt, model = "grok-imagine-image", aspect_ratio = "1:1", signal = null }
) {
  const body = {
    model,
    prompt,
    n: 1,
    response_format: "b64_json",
  };
  if (aspect_ratio) body.aspect_ratio = aspect_ratio;
  const res = await apiRequest(token, "/v1/images/generations", body, {
    timeoutMs: 180000,
    signal,
  });
  const item = res && res.data && res.data[0];
  if (!item || !item.b64_json) {
    throw new Error("Image API returned no data");
  }
  return {
    b64: item.b64_json,
    mimeType: item.mime_type || "image/png",
    model,
  };
}

/**
 * Best-effort video generation. xAI video models differ by account —
 * try /v1/videos/generations then fall back to clear error.
 */
async function generateVideo(
  token,
  { prompt, model = "grok-imagine-video", aspect_ratio = "16:9", signal = null }
) {
  const attempts = [
    {
      path: "/v1/videos/generations",
      body: {
        model,
        prompt,
        aspect_ratio,
      },
    },
    {
      path: "/v1/images/generations",
      body: {
        model: "grok-imagine-image",
        prompt: `[VIDEO STORYBOARD FRAME] ${prompt}`,
        n: 1,
        response_format: "b64_json",
        aspect_ratio: aspect_ratio || "16:9",
      },
      storyboardFallback: true,
    },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const res = await apiRequest(token, a.path, a.body, {
        timeoutMs: 300000,
        signal,
      });
      if (a.storyboardFallback) {
        const item = res && res.data && res.data[0];
        if (!item || !item.b64_json) throw new Error("no frame");
        return {
          kind: "storyboard",
          b64: item.b64_json,
          mimeType: item.mime_type || "image/png",
          model: "grok-imagine-image",
          note:
            "Pełne wideo API niedostępne na tym koncie — wygenerowałem klatkę storyboard (image).",
        };
      }
      // video response shapes vary
      const item = (res && res.data && res.data[0]) || res;
      const url = item.url || item.video_url;
      const b64 = item.b64_json || item.video_b64;
      return {
        kind: "video",
        url,
        b64,
        model,
        raw: item,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Video generation failed");
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
  listModels,
  chatCompletions,
  chatCompletionsStream,
  generateImage,
  generateVideo,
  looksLikeImagePrompt,
  stripImageCommand,
  loadAccount,
};
