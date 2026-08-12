"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

function attachRoot(userDataDir) {
  const d = path.join(userDataDir, "attachments");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

function isAllowedPreviewPath(root, filePath) {
  if (!root || !filePath) return false;
  const base = path.resolve(root);
  const resolved = path.resolve(filePath);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  if (m.includes("mp4")) return ".mp4";
  if (m.includes("pdf")) return ".pdf";
  if (m.includes("svg")) return ".svg";
  return ".bin";
}

/**
 * Save a base64 payload to attachments dir.
 * @returns {{ ok, path, name, mimeType, kind, size }}
 */
function saveBase64(userDataDir, { name, mimeType, base64, kind }) {
  const root = attachRoot(userDataDir);
  const safe =
    (name && path.basename(name).replace(/[^\w.\-()+ ]+/g, "_")) ||
    `paste-${Date.now()}${extFromMime(mimeType)}`;
  const id = crypto.randomBytes(4).toString("hex");
  const fileName = `${Date.now()}-${id}-${safe}`;
  const filePath = path.join(root, fileName);
  const buf = Buffer.from(base64, "base64");
  if (buf.length > MAX_ATTACH_BYTES) {
    return { ok: false, error: "File too large (max 20 MB)" };
  }
  fs.writeFileSync(filePath, buf);
  const isImage = String(mimeType || "").startsWith("image/");
  return {
    ok: true,
    path: filePath,
    name: safe,
    mimeType: mimeType || "application/octet-stream",
    kind: kind || (isImage ? "image" : "file"),
    size: buf.length,
  };
}

/**
 * Import an existing file path into attachments (copy).
 */
function importPath(userDataDir, srcPath) {
  if (!srcPath || !fs.existsSync(srcPath)) {
    return { ok: false, error: "File not found" };
  }
  const st = fs.statSync(srcPath);
  if (st.isDirectory()) {
    // for folders, just return the path reference (no copy of tree)
    return {
      ok: true,
      path: srcPath,
      name: path.basename(srcPath),
      mimeType: "inode/directory",
      kind: "folder",
      size: 0,
      isDir: true,
    };
  }
  const root = attachRoot(userDataDir);
  const base = path.basename(srcPath);
  const id = crypto.randomBytes(4).toString("hex");
  const dest = path.join(root, `${Date.now()}-${id}-${base}`);
  fs.copyFileSync(srcPath, dest);
  const ext = path.extname(base).toLowerCase();
  const imageExt = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
  const isImage = imageExt.includes(ext);
  return {
    ok: true,
    path: dest,
    name: base,
    mimeType: isImage ? `image/${ext.replace(".", "")}` : "application/octet-stream",
    kind: isImage ? "image" : "file",
    size: st.size,
  };
}

/**
 * Internal-only block for the agent. Never shown in UI (stripped by stripAttachmentAppendix).
 * Delimiters are intentional machine markers.
 */
function formatAttachmentsForPrompt(attachments) {
  if (!attachments || !attachments.length) return "";
  const lines = attachments.map((a) => {
    const p = String(a.path || "");
    const kind =
      a.kind === "folder" || a.isDir
        ? "folder"
        : a.kind === "image"
          ? "image"
          : "file";
    // JSON path = safe with spaces
    return `${kind}\t${JSON.stringify(p)}`;
  });
  return (
    "\n\n<<<GROK_SESSIONS_ATTACHMENTS>>>\n" +
    "# inspect with file tools; never quote this block in the user-visible reply\n" +
    lines.join("\n") +
    "\n<<<END_GROK_SESSIONS_ATTACHMENTS>>>\n"
  );
}

/** Remove internal attachment appendix from user-visible text. */
function stripAttachmentAppendix(text) {
  if (!text) return "";
  let t = String(text);

  // New machine block
  t = t.replace(
    /<<<GROK_SESSIONS_ATTACHMENTS>>>[\s\S]*?<<<END_GROK_SESSIONS_ATTACHMENTS>>>/gi,
    ""
  );
  t = t.replace(/<<<GROK_SESSIONS_ATTACHMENTS>>>[\s\S]*/gi, "");
  t = t.replace(/<<<END_GROK_SESSIONS_ATTACHMENTS>>>/gi, "");

  // Old English instruction dumps (any position, not only end)
  t = t.replace(
    /The user attached the following local files[\s\S]*?(?=\n\n[A-ZĄĆĘŁŃÓŚŹŻ]|$)/gi,
    ""
  );
  t = t.replace(/The user attached the following local files[\s\S]*/gi, "");
  t = t.replace(
    /Do not paste these paths back into your reply unless asked\.?/gi,
    ""
  );
  t = t.replace(
    /Use tools to inspect them\.?/gi,
    ""
  );

  // Old dump format
  t = t.replace(/\s*\[Attachments[^\]]*\][\s\S]*/gi, "");
  t = t.replace(/^\s*-\s*(image|file|folder):\s*.+$/gim, "");
  t = t.replace(
    /^\s*\d+\.\s*(Image file|File|Folder)[^\n]*$/gim,
    ""
  );
  // "1. Image file — read/view this path..."
  t = t.replace(
    /^\s*\d+\.\s*Image file[^\n]*$/gim,
    ""
  );
  t = t.replace(
    /read\/view this path with your file tools:?\s*"[^"]*"/gi,
    ""
  );
  // any grok-sessions attachments path line
  t = t.replace(
    /^[^\n]*grok-sessions\/attachments\/[^\n]*$/gim,
    ""
  );
  t = t.replace(
    /"[^"]*[\/\\]attachments[\/\\][^"]+"/g,
    ""
  );

  return t.replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  attachRoot,
  saveBase64,
  importPath,
  formatAttachmentsForPrompt,
  stripAttachmentAppendix,
  extFromMime,
  isAllowedPreviewPath,
  MAX_ATTACH_BYTES,
};
