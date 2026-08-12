"use strict";

/**
 * Wspólna lista modeli czatu. Home woła api.x.ai, Build bierze listę z CLI.
 * Publiczny czat to tylko grok-N.M — bez 4.20-*, build i wideo.
 */

const FALLBACK_HOME_MODELS = [
  { modelId: "grok-4.6", name: "Grok 4.6" },
  { modelId: "grok-4.5", name: "Grok 4.5" },
  { modelId: "grok-4.3", name: "Grok 4.3" },
  { modelId: "grok-imagine-image", name: "Imagine · image" },
];

const FALLBACK_BUILD_MODELS = [
  { modelId: "grok-4.6", name: "Grok 4.6" },
  { modelId: "grok-4.5", name: "Grok 4.5" },
];

const FALLBACK_CHAT_MODEL = "grok-4.6";
const IMAGINE_IMAGE = "grok-imagine-image";

function isPublicChatModel(id) {
  return typeof id === "string" && /^grok-\d+\.\d+$/.test(id);
}

function isHomeListModel(id) {
  return isPublicChatModel(id) || id === IMAGINE_IMAGE;
}

function parseVersion(id) {
  const m = typeof id === "string" ? /^grok-(\d+)\.(\d+)$/.exec(id) : null;
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function compareChatIds(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va && !vb) return 0;
  if (!va) return 1;
  if (!vb) return -1;
  if (va[0] !== vb[0]) return vb[0] - va[0];
  return vb[1] - va[1];
}

function modelIdOf(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.modelId || item.id || "";
}

function displayName(id) {
  if (id === IMAGINE_IMAGE) return "Imagine · image";
  if (isPublicChatModel(id)) return "Grok " + id.slice("grok-".length);
  return id;
}

function homeModelsFromApi(raw) {
  const ids = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    const id = modelIdOf(item);
    if (id && isHomeListModel(id) && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return FALLBACK_HOME_MODELS.slice();
  const chat = ids.filter(isPublicChatModel).sort(compareChatIds);
  const rest = ids.filter((id) => !isPublicChatModel(id));
  return [...chat, ...rest].map((id) => ({ modelId: id, name: displayName(id) }));
}

function highestChatModelId(models) {
  const ids = (models || [])
    .map(modelIdOf)
    .filter(isPublicChatModel)
    .sort(compareChatIds);
  return ids[0] || FALLBACK_CHAT_MODEL;
}

function resolveChatModelId({ alwaysLatest, savedId, models } = {}) {
  const highest = highestChatModelId(models);
  if (alwaysLatest) return highest;
  const ids = (models || []).map(modelIdOf);
  if (savedId && ids.includes(savedId)) return savedId;
  return highest;
}

module.exports = {
  FALLBACK_HOME_MODELS,
  FALLBACK_BUILD_MODELS,
  FALLBACK_CHAT_MODEL,
  IMAGINE_IMAGE,
  isPublicChatModel,
  homeModelsFromApi,
  highestChatModelId,
  resolveChatModelId,
};
