// The allowlist: the only thing this project ever lets anything (WebSocket
// command, or Claude via the open_app MCP tool) actually execute. Shared by
// server.mjs and mcpServer.mjs so there is exactly one code path that turns
// an alias into a real command.

import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APPS_FILE = path.join(__dirname, "apps.json");

export function loadApps() {
  const raw = JSON.parse(readFileSync(APPS_FILE, "utf8"));
  delete raw._comment;
  return raw;
}

export function resolveCommand(apps, target) {
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

/** Resolves `target` against apps.json and runs it if (and only if) it matches. */
export function runTarget(target) {
  return new Promise((resolve) => {
    let apps;
    try {
      apps = loadApps();
    } catch (err) {
      resolve({ ok: false, message: `apps.json error: ${err.message}` });
      return;
    }

    const cmd = resolveCommand(apps, target);
    if (!cmd) {
      resolve({ ok: false, message: `no allowlisted app matches "${target}"` });
      return;
    }

    exec(cmd, (err) => {
      resolve({ ok: !err, message: err ? err.message : "opened" });
    });
  });
}
