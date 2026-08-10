"use strict";

const fs = require("fs");
const path = require("path");

function loadAccount(grokHome) {
  const authPath = path.join(grokHome, "auth.json");
  if (!fs.existsSync(authPath)) {
    return {
      loggedIn: false,
      email: null,
      name: null,
      label: "Nie zalogowano",
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, "utf8"));
    // values are keyed by oidc issuer::client
    const entries = Object.values(raw || {});
    const first = entries.find((e) => e && (e.email || e.user_id)) || entries[0];
    if (!first) {
      return {
        loggedIn: false,
        email: null,
        name: null,
        label: "Nie zalogowano",
      };
    }
    const name = [first.first_name, first.last_name].filter(Boolean).join(" ");
    const email = first.email || null;
    return {
      loggedIn: true,
      email,
      name: name || null,
      label: email || name || "Zalogowano",
      expiresAt: first.expires_at || null,
    };
  } catch {
    return {
      loggedIn: false,
      email: null,
      name: null,
      label: "Auth uszkodzony",
    };
  }
}

module.exports = { loadAccount };
