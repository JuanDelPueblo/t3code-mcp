import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serveStreamableHttp } from "../src/http.js";

const port = 20_000 + Math.floor(Math.random() * 20_000);
const url = `http://127.0.0.1:${port}/mcp`;
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.();
  close = null;
});

describe("Streamable HTTP sessions", () => {
  it("answers an unknown session ID with 404 so clients start a new session", async () => {
    close = await serveStreamableHttp(() => new McpServer({ name: "test", version: "1" }), {
      host: "127.0.0.1", port, path: "/mcp",
    });
    const stale = await fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": "from-before-a-restart" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(stale.status).toBe(404);

    const missing = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(missing.status).toBe(400);
  });
});
