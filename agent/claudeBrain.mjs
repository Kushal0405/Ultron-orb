// Routes voice commands the fixed parser didn't recognize to Claude Code's
// CLI, running locally under whatever account it's already logged in with
// (a Claude Pro/Max subscription login works — this rides on that, not a
// separately billed API key). Each call is a fresh, non-interactive `claude
// -p` subprocess: no persisted memory between calls, one prompt in, one
// answer out.
//
// Claude's only capability here is the open_app MCP tool (mcpServer.mjs),
// wired to the exact same apps.json allowlist voice commands already use.
// Claude Code's built-in tools — Bash, Edit, Write, Read, Glob, Grep,
// WebFetch, WebSearch, Task, and the rest — are explicitly disallowed.
// That boundary is deliberate: a voice-triggered path with real shell/file
// access would mean a misheard phrase, background audio, or anyone near the
// mic could cause arbitrary code execution on this machine. Scoped to one
// pre-defined action, a wrong call just fails harmlessly.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_TIMEOUT_MS = 60_000;
const CLAUDE_MODEL = process.env.ULTRON_CLAUDE_MODEL || "sonnet";
const ALLOWED_TOOLS = ["mcp__ultron-tools__open_app"];
const DISALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "PowerShell",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
  "Artifact",
  "ScheduleWakeup",
  "SlashCommand",
];

const SYSTEM_PRIMER =
  "You are ULTRON's voice-command brain, a local desktop HUD assistant. " +
  "You have exactly one tool, open_app, which runs a pre-defined action from an allowlist by name " +
  "(apps, and system actions like lock/mute/volume/screenshot). " +
  "You cannot run shell commands, read/write files, or browse the web — don't claim to. " +
  "Give a short, spoken-style answer (it will be read aloud), and only call open_app when the " +
  "user clearly asked to open or run something.";

function mcpConfigPath() {
  const config = {
    mcpServers: {
      "ultron-tools": {
        command: process.execPath,
        args: [path.join(__dirname, "mcpServer.mjs")],
      },
    },
  };
  const file = path.join(tmpdir(), "ultron-mcp-config.json");
  writeFileSync(file, JSON.stringify(config));
  return file;
}

/** Sends one prompt to Claude Code in headless mode. Never throws — failures come back as {ok: false}. */
export function askClaude(prompt) {
  const args = [
    "-p",
    prompt,
    "--append-system-prompt",
    SYSTEM_PRIMER,
    "--mcp-config",
    mcpConfigPath(),
    "--strict-mcp-config",
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
    "--model",
    CLAUDE_MODEL,
    "--output-format",
    "json",
  ];

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("claude", args, { shell: process.platform === "win32" });
    } catch (err) {
      resolve({ ok: false, text: `Claude Code CLI not available: ${err.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      resolve({ ok: false, text: "Claude took too long to respond." });
    }, CLAUDE_TIMEOUT_MS);

    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, text: `Claude Code CLI not found — install it and make sure "claude" is on PATH and logged in. (${err.message})` });
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        resolve({ ok: false, text: `Claude Code exited with code ${code}: ${stderr.trim().slice(0, 200)}` });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {
        resolve({ ok: false, text: "Claude Code returned output that wasn't valid JSON." });
        return;
      }
      if (payload.is_error) {
        resolve({ ok: false, text: payload.result || "Claude Code reported an error." });
        return;
      }
      resolve({ ok: true, text: payload.result || "" });
    });
  });
}
