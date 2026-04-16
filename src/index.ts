#!/usr/bin/env node
/**
 * t3code-mcp — MCP server for T3 Code
 *
 * Exposes T3 Code's WebSocket RPC API as MCP tools so any MCP-compatible
 * client (Claude Desktop, opencode, etc.) can delegate coding tasks to a
 * running T3 Code instance.
 *
 * Environment variables:
 *   T3_CODE_URL    Base URL of the T3 Code server (default: http://localhost:3000)
 *   T3_CODE_TOKEN  Bootstrap / pairing credential token (required)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { T3Client } from "./t3client.js";
import { registerTools } from "./tools.js";

const baseUrl = process.env.T3_CODE_URL ?? "http://localhost:3000";
const token = process.env.T3_CODE_TOKEN;

if (!token) {
  process.stderr.write(
    "ERROR: T3_CODE_TOKEN environment variable is required.\n" +
      "Set it to your T3 Code pairing/bootstrap credential token.\n",
  );
  process.exit(1);
}

const client = new T3Client({ baseUrl, token });

const server = new McpServer(
  {
    name: "t3code-mcp",
    version: "0.1.0",
    description:
      "MCP server for T3 Code — delegates coding tasks to a running T3 Code instance " +
      "via its WebSocket RPC API.",
  },
  {
    instructions: [
      "# T3 Code MCP — Guide for LLM clients",
      "",
      "You are connected to T3 Code, an AI-powered coding environment.",
      "Use these tools to send coding tasks, monitor progress, and control sessions.",
      "",
      "## Typical workflow",
      "1. Call `t3_get_config` once to see available providers and models.",
      "2. Call `t3_send_prompt` with your coding task. This creates a thread and",
      "   starts a turn. It will wait up to 30 s collecting response events.",
      "3. If the task is still running, call `t3_get_status` with the threadId",
      "   to collect more events.",
      "4. Use `t3_interrupt` to cancel a running turn, or `t3_stop_session` to",
      "   fully terminate the provider session.",
      "",
      "## Tool summary",
      "- `t3_send_prompt`  — Start a new coding task",
      "- `t3_get_status`   — Poll for progress on an existing thread",
      "- `t3_interrupt`    — Interrupt the running turn",
      "- `t3_stop_session` — Stop the provider session",
      "- `t3_get_config`   — Get server config (providers, models)",
    ].join("\n"),
  },
);

registerTools(server, client);

const transport = new StdioServerTransport();

// Graceful shutdown
process.on("SIGINT", () => {
  client.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  client.close();
  process.exit(0);
});

await server.connect(transport);
