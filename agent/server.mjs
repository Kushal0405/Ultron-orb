#!/usr/bin/env node
// ULTRON local agent — the only piece of this project allowed to touch the
// OS. A browser tab can't launch native apps by itself (sandboxing), so the
// web UI talks to this small localhost process instead.
//
// Security model, deliberately conservative:
//   - Binds to 127.0.0.1 only — never reachable off this machine.
//   - Requires a random token (generated on first run) before accepting
//     any command; the token lives in agent/.token, gitignored.
//   - Only ever runs commands that already exist in apps.json, matched by
//     alias. Voice/UI text is used ONLY to look up an alias — it is never
//     concatenated into a shell command. There is no "run arbitrary text"
//     path.
//   - Rejects WebSocket upgrades from origins outside ALLOWED_ORIGINS.
//
// Run with: npm run agent

import { WebSocketServer } from "ws";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ULTRON_AGENT_PORT ?? 8765);
const TOKEN_FILE = path.join(__dirname, ".token");
const APPS_FILE = path.join(__dirname, "apps.json");
const AUTH_TIMEOUT_MS = 5000;
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function loadToken() {
  if (process.env.ULTRON_AGENT_TOKEN) return process.env.ULTRON_AGENT_TOKEN;
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

function loadApps() {
  const raw = JSON.parse(readFileSync(APPS_FILE, "utf8"));
  delete raw._comment;
  return raw;
}

function resolveCommand(apps, target) {
  const platform = process.platform; // 'darwin' | 'win32' | 'linux'
  const key = String(target ?? "").toLowerCase().trim();
  if (!key) return null;

  let entry = apps[key];
  if (!entry) {
    const words = key.split(/\s+/);
    const wordAlias = Object.keys(apps).find((k) => words.includes(k));
    // Substring fallback for a truncated/partial name, alias-contains-target
    // direction only: the reverse ("unlock" containing "lock") would make
    // almost any longer word fuzzy-match a short allowlisted alias.
    const alias = wordAlias ?? Object.keys(apps).find((k) => k.length >= 4 && k.includes(key));
    if (alias) entry = apps[alias];
  }
  return entry?.[platform] ?? null;
}

const token = loadToken();

console.log("ULTRON local agent");
console.log(`  listening: ws://127.0.0.1:${PORT} (localhost only)`);
console.log(`  platform:  ${process.platform}`);
console.log(`  token:     ${token}`);
console.log("  Paste this token into the ULTRON web UI's AGENT connect prompt.");
console.log(`  (also saved to ${TOKEN_FILE} — keep it out of version control)`);
console.log(`  Edit ${APPS_FILE} to add/change what voice commands are allowed to open.`);

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    ws.close(1008, "origin not allowed");
    return;
  }

  let authed = false;
  const authTimer = setTimeout(() => {
    if (!authed) ws.close(1008, "auth timeout");
  }, AUTH_TIMEOUT_MS);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "auth") {
      clearTimeout(authTimer);
      if (typeof msg.token === "string" && msg.token === token) {
        authed = true;
        ws.send(JSON.stringify({ type: "auth_ok" }));
      } else {
        ws.send(JSON.stringify({ type: "auth_fail" }));
        ws.close(1008, "bad token");
      }
      return;
    }

    if (!authed) return;

    if (msg.type === "command" && msg.action === "open") {
      let apps;
      try {
        apps = loadApps();
      } catch (err) {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, message: `apps.json error: ${err.message}` }));
        return;
      }

      const cmd = resolveCommand(apps, msg.target);
      if (!cmd) {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, message: `no allowlisted app matches "${msg.target}"` }));
        return;
      }

      exec(cmd, (err) => {
        ws.send(
          JSON.stringify({
            type: "result",
            id: msg.id,
            ok: !err,
            message: err ? err.message : "opened",
          }),
        );
      });
    }
  });

  ws.on("close", () => clearTimeout(authTimer));
});
