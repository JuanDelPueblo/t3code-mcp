import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

interface HttpMcpOptions {
  host: string;
  port: number;
  path: string;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new Error("MCP request body exceeds 4 MiB");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function serveStreamableHttp(
  createMcpServer: () => McpServer,
  options: HttpMcpOptions,
): Promise<() => Promise<void>> {
  const sessions = new Map<string, Session>();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (requestUrl.pathname !== options.path) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    if (req.method === "HEAD") {
      res.writeHead(405, { Allow: "GET, POST, DELETE" });
      res.end();
      return;
    }

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: error instanceof Error ? error.message : "Invalid JSON request",
          },
          id: null,
        });
        return;
      }
    }

    const sessionId = headerValue(req.headers["mcp-session-id"]);
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session && req.method === "POST" && isInitializeRequest(body)) {
      let initializedSessionId: string | undefined;
      const server = createMcpServer();
      let transport!: StreamableHTTPServerTransport;

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          initializedSessionId = newSessionId;
          sessions.set(newSessionId, { server, transport });
        },
      });

      transport.onclose = () => {
        if (initializedSessionId) sessions.delete(initializedSessionId);
      };

      await server.connect(transport);
      session = { server, transport };
    }

    if (!session) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: no valid MCP session",
        },
        id: null,
      });
      return;
    }

    await session.transport.handleRequest(req, res, body);
  };

  const httpServer = createHttpServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      process.stderr.write(
        `MCP HTTP request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error" },
          id: null,
        });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  process.stderr.write(
    `t3code-mcp listening on http://${options.host}:${options.port}${options.path}\n`,
  );

  return async () => {
    await Promise.allSettled(
      Array.from(sessions.values(), async ({ server }) => {
        await server.close();
      }),
    );
    sessions.clear();

    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  };
}
