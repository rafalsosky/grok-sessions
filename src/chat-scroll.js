"use strict";

/**
 * Follow the bottom only while the user is already there.
 * A stream chunk must never yank the viewport back down.
 */

function distanceFromBottom(box) {
  if (!box) return 0;
  return box.scrollHeight - box.scrollTop - box.clientHeight;
}

function isNearBottom(box, threshold) {
  if (!box) return true;
  const t = threshold == null ? 80 : threshold;
  return distanceFromBottom(box) < t;
}

function createChatScroll(opts) {
  const nearPx = (opts && opts.nearBottomPx) || 80;
  let stick = true;
  let programmatic = false;

  function shouldFollow() {
    return stick;
  }

  function pin() {
    stick = true;
  }

  function release() {
    stick = false;
  }

  function onUserScroll(box) {
    if (programmatic) return stick;
    stick = isNearBottom(box, nearPx);
    return stick;
  }

  function withProgrammatic(fn) {
    programmatic = true;
    try {
      return fn();
    } finally {
      programmatic = false;
    }
  }

  function applyBottom(box) {
    if (!box || !stick) return false;
    withProgrammatic(() => {
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      box.scrollTop = max;
    });
    return true;
  }

  return {
    shouldFollow,
    pin,
    release,
    onUserScroll,
    withProgrammatic,
    applyBottom,
    isProgrammatic: () => programmatic,
  };
}

const api = {
  createChatScroll,
  isNearBottom,
  distanceFromBottom,
};

if (typeof window !== "undefined") window.chatScroll = api;
if (typeof module !== "undefined") module.exports = api;
