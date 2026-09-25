#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { accessTokenProviderFromEnvironment } from "./auth.js";
import { serveStreamableHttp } from "./http.js";
import { T3Client } from "./t3client.js";
import { registerTools } from "./tools.js";
import { usageProbeOptionsFromEnvironment } from "./usage.js";

const baseUrl = process.env.T3_CODE_URL ?? "http://127.0.0.1:3000";
const accessTokenProvider = await accessTokenProviderFromEnvironment(baseUrl);
const client = new T3Client({ baseUrl, accessTokenProvider });
const usageOptions = usageProbeOptionsFromEnvironment();

function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "t3code-mcp",
      version: "0.2.0",
      description: "MCP server for orchestrating T3 Code",
    },
    {
      instructions: [
        "# T3 Code MCP",
        "",
        "Use T3 Code as a coding-agent orchestrator.",
        "1. Call t3_get_config to discover provider instance IDs and models.",
        "2. Call t3_list_threads to discover existing threads, including threads",
        "   started from the T3 UI or another client.",
        "3. Call t3_send_prompt with an instanceId, model, and project/workspace.",
        "   Pass modelOptions for reasoning/effort choices from t3_get_config,",
        "   baseBranch to create an isolated git worktree, or worktreePath to",
        "   reuse one.",
        "4. Inspect current state with t3_get_thread or t3_get_status; both return",
        "   an immediate snapshot and work for threads from any client.",
        "5. Call t3_send_message to continue a settled thread in its own session,",
        "   for example to send review findings back to the agent that did the work.",
        "6. Call t3_get_usage_limits before assigning work. Its structuredContent",
        "   gives used and remaining percent per quota window and per model pool.",
        "7. Use t3_interrupt or t3_stop_session for lifecycle control.",
      ].join("\n"),
    },
  );

  registerTools(server, client, usageOptions);
  return server;
}

try {
  await client.connect();
} catch (error) {
  process.stderr.write(
    `ERROR: could not connect to T3 Code: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

const transportMode = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
let closeMcp: () => Promise<void>;

if (transportMode === "http") {
  const port = Number.parseInt(process.env.MCP_HTTP_PORT ?? "8732", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT: ${process.env.MCP_HTTP_PORT}`);
  }

  closeMcp = await serveStreamableHttp(createMcpServer, {
    host: process.env.MCP_HTTP_HOST ?? "127.0.0.1",
    port,
    path: process.env.MCP_HTTP_PATH ?? "/mcp",
  });
} else if (transportMode === "stdio") {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  closeMcp = () => server.close();
} else {
  throw new Error(`Unsupported MCP_TRANSPORT: ${transportMode}`);
}

let shuttingDown = false;
const shutdown = async (exitCode: number) => {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await closeMcp();
  } catch (error) {
    process.stderr.write(
      `ERROR: failed to close MCP transport: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    client.close();
    process.exit(exitCode);
  }
};

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
