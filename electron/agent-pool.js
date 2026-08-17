"use strict";

/**
 * Jeden proces grok na jedną sesję Build.
 * Druga karta nie ma prawa session/load na procesie pierwszej.
 */

function createAgentPool() {
  const byId = new Map();
  const busy = new Set();

  function get(id) {
    return id ? byId.get(id) || null : null;
  }

  function has(id) {
    return Boolean(id && byId.has(id));
  }

  function all() {
    return Array.from(byId.values());
  }

  function ids() {
    return Array.from(byId.keys());
  }

  function busyIds() {
    return Array.from(busy);
  }

  function isBusy(id) {
    return Boolean(id && busy.has(id));
  }

  function anyBusy() {
    return busy.size > 0;
  }

  function put(id, client) {
    if (!id || !client) return client;
    byId.set(id, client);
    return client;
  }

  function markBusy(id, on) {
    if (!id) return;
    if (on) busy.add(id);
    else busy.delete(id);
  }

  function forget(id) {
    if (!id) return false;
    const had = byId.delete(id);
    busy.delete(id);
    return had;
  }

  function findByClient(client) {
    if (!client) return null;
    for (const [id, c] of byId) {
      if (c === client) return id;
    }
    return client.sessionId || null;
  }

  async function stop(id) {
    if (!id) return false;
    const client = byId.get(id);
    forget(id);
    if (!client) return false;
    try {
      await client.stop();
    } catch {
      /* już martwy */
    }
    return true;
  }

  async function stopAll() {
    const clients = all();
    byId.clear();
    busy.clear();
    await Promise.all(
      clients.map((c) =>
        c
          .stop()
          .catch(() => {
            /* ignore */
          })
      )
    );
  }

  return {
    get,
    has,
    all,
    ids,
    busyIds,
    isBusy,
    anyBusy,
    put,
    markBusy,
    forget,
    findByClient,
    stop,
    stopAll,
  };
}

module.exports = { createAgentPool };
