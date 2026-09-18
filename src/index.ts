#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { accessTokenProviderFromEnvironment } from "./auth.js";
import { serveStreamableHttp } from "./http.js";
import { T3Client } from "./t3client.js";
import { registerTools } from "./tools.js";

const baseUrl = process.env.T3_CODE_URL ?? "http://127.0.0.1:3000";
const accessTokenProvider = await accessTokenProviderFromEnvironment(baseUrl);
const client = new T3Client({ baseUrl, accessTokenProvider });

function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "t3code-mcp",
      version: "0.1.0",
      description: "MCP server for orchestrating T3 Code",
    },
    {
      instructions: [
        "# T3 Code MCP",
        "",
        "Use T3 Code as a coding-agent orchestrator.",
        "1. Call t3_get_config to discover provider instance IDs and models.",
        "2. Call t3_send_prompt with an instanceId, model, and project/workspace.",
        "3. Poll with t3_get_status when more output is needed.",
        "4. Use t3_interrupt or t3_stop_session for lifecycle control.",
      ].join("\n"),
    },
  );

  registerTools(server, client);
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
