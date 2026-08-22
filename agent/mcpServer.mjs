#!/usr/bin/env node
// The only capability Claude gets when acting as ULTRON's "brain" (see
// claudeBrain.mjs): one MCP tool, open_app, wired to the exact same
// allowlist the WebSocket agent uses. Claude Code's own built-in tools
// (Bash, Edit, Write, Read, WebFetch, ...) are explicitly disallowed by the
// caller — this server doesn't expose a way around that, it just gives
// Claude the one action ULTRON already lets voice commands trigger.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runTarget, APPS_FILE } from "./appResolver.mjs";

const server = new McpServer({ name: "ultron-tools", version: "1.0.0" });

server.registerTool(
  "open_app",
  {
    title: "Open an app or run a system action",
    description:
      `Opens an application or runs a system action (lock, mute, volume up, screenshot, etc.) ` +
      `from ULTRON's allowlist at ${APPS_FILE}. Only aliases already present there can run — ` +
      `this cannot execute arbitrary commands, only look one up by name and run its pre-defined ` +
      `command. If the target isn't in the allowlist, say so rather than guessing.`,
    inputSchema: {
      target: z.string().describe("The allowlist alias to run, e.g. 'spotify', 'lock', 'volume up', 'screenshot'"),
    },
  },
  async ({ target }) => {
    const result = await runTarget(target);
    return {
      content: [{ type: "text", text: result.ok ? `Opened "${target}".` : `Could not open "${target}": ${result.message}` }],
      isError: !result.ok,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
