import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serveStreamableHttp } from "../src/http.js";

const port = 20_000 + Math.floor(Math.random() * 20_000);
const url = `http://127.0.0.1:${port}/mcp`;
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let close: (() => Promise<void>) | null = null;

function createServer(): McpServer {
  const server = new McpServer({ name: "test", version: "1" });
  server.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: "text", text }],
  }));
  return server;
}

async function start(onPort = port): Promise<void> {
  close = await serveStreamableHttp(createServer, { host: "127.0.0.1", port: onPort, path: "/mcp" });
}

afterEach(async () => {
  await close?.();
  close = null;
});

describe("Streamable HTTP sessions", () => {
  it("keeps a client working across a server restart", async () => {
    await start();
    const client = new Client({ name: "test-client", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    expect((await client.callTool({ name: "echo", arguments: { text: "before" } })).content).toEqual([
      { type: "text", text: "before" },
    ]);

    await close!();
    await start();
    // Let the client see its old socket close, as it does when a process exits.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The client still sends its old session ID; the server answers statelessly.
    expect((await client.callTool({ name: "echo", arguments: { text: "after" } })).content).toEqual([
      { type: "text", text: "after" },
    ]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    await client.close().catch(() => undefined);
  });

  it("answers 404 to a stream or delete for an unknown session, and 400 without a session", async () => {
    // A separate port: fetch would reuse a pooled connection to the closed server.
    await start(port + 1);
    const url = `http://127.0.0.1:${port + 1}/mcp`;
    const stream = await fetch(url, { method: "GET", headers: { ...headers, "mcp-session-id": "gone" } });
    expect(stream.status).toBe(404);
    const missing = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(missing.status).toBe(400);
  });
});
