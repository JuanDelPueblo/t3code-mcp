import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { T3Client } from "../src/t3client.js";

const tokens = { getAccessToken: async () => "token", invalidate: () => false };
let servers: Array<{ close(): void }> = [];

afterEach(() => {
  servers.forEach((server) => server.close());
  servers = [];
});

/** A fake T3: ticket endpoint plus a WebSocket that either hangs or speaks a little RPC. */
async function fakeT3(mode: "hang" | "silent" | "pong"): Promise<string> {
  const http: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ticket: "ticket" }));
  });
  if (mode === "hang") {
    http.on("upgrade", () => undefined); // never completes the upgrade
  } else {
    const wss = new WebSocketServer({ server: http });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message._tag === "Ping" && mode === "pong") socket.send(JSON.stringify({ _tag: "Pong" }));
        // Requests are never answered, like a stalled server.
      });
    });
    servers.push(wss);
  }
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => { http.closeAllConnections(); http.close(); } });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("T3Client connection limits", () => {
  it("gives up on a WebSocket that never opens", async () => {
    const client = new T3Client({ baseUrl: await fakeT3("hang"), accessTokenProvider: tokens,
      limits: { connectTimeoutMs: 200 } });
    const started = Date.now();
    await expect(client.connect()).rejects.toThrow("did not open");
    expect(Date.now() - started).toBeLessThan(2000);
    client.close();
  });

  it("returns from a stream when its caller cancels during a stalled connect", async () => {
    const client = new T3Client({ baseUrl: await fakeT3("hang"), accessTokenProvider: tokens,
      limits: { connectTimeoutMs: 10_000 } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    await client.subscribeShell(() => undefined, controller.signal);
    expect(Date.now() - started).toBeLessThan(2000);
    client.close();
  });

  it("closes a socket that stops answering pings, which fails its requests", async () => {
    const client = new T3Client({ baseUrl: await fakeT3("silent"), accessTokenProvider: tokens,
      limits: { pingIntervalMs: 50, pongTimeoutMs: 200 } });
    await expect(client.getConfig()).rejects.toThrow("closed unexpectedly");
    client.close();
  });

  it("keeps a socket open while T3 answers pings", async () => {
    const client = new T3Client({ baseUrl: await fakeT3("pong"), accessTokenProvider: tokens,
      limits: { pingIntervalMs: 50, pongTimeoutMs: 200 } });
    const request = client.getConfig().then(() => "answered", () => "failed");
    const outcome = await Promise.race([request, new Promise((resolve) => setTimeout(() => resolve("still open"), 600))]);
    expect(outcome).toBe("still open");
    client.close();
  });
});
