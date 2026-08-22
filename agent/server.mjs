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
//     path — that holds for the optional Claude brain too (see
//     claudeBrain.mjs): its only capability is the same allowlist lookup,
//     with Claude Code's shell/file/web tools explicitly disallowed.
//   - Rejects WebSocket upgrades from origins outside ALLOWED_ORIGINS.
//
// Run with: npm run agent

import { WebSocketServer } from "ws";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadApps, runTarget } from "./appResolver.mjs";
import { askClaude } from "./claudeBrain.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ULTRON_AGENT_PORT ?? 8765);
const TOKEN_FILE = path.join(__dirname, ".token");
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

const token = loadToken();

console.log("ULTRON local agent");
console.log(`  listening: ws://127.0.0.1:${PORT} (localhost only)`);
console.log(`  platform:  ${process.platform}`);
console.log(`  token:     ${token}`);
console.log("  Paste this token into the ULTRON web UI's AGENT connect prompt.");
console.log(`  (also saved to ${TOKEN_FILE} — keep it out of version control)`);
console.log("  Edit apps.json to add/change what voice commands are allowed to open.");
console.log("  Unmatched voice commands are handed to Claude Code (`claude` on PATH), scoped to the same allowlist — see claudeBrain.mjs.");

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

  ws.on("message", async (raw) => {
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
        let appCount = 0;
        try {
          appCount = Object.keys(loadApps()).length;
        } catch {
          // apps.json is malformed — report 0 rather than failing auth over it
        }
        ws.send(JSON.stringify({ type: "auth_ok", platform: process.platform, appCount }));
      } else {
        ws.send(JSON.stringify({ type: "auth_fail" }));
        ws.close(1008, "bad token");
      }
      return;
    }

    if (!authed) return;

    if (msg.type === "command" && msg.action === "open") {
      const result = await runTarget(msg.target);
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: result.ok, message: result.message }));
      return;
    }

    if (msg.type === "ask" && typeof msg.text === "string") {
      const result = await askClaude(msg.text);
      ws.send(JSON.stringify({ type: "answer", id: msg.id, ok: result.ok, text: result.text }));
      return;
    }
  });

  ws.on("close", () => clearTimeout(authTimer));
});
