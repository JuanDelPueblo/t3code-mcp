/**
 * T3 Code WebSocket RPC client.
 *
 * T3 Code uses Effect's unstable RPC layer over WebSocket. The wire format is
 * NDJSON where each message is:
 *
 *   Request (client → server):
 *     { "_tag": "Request", "id": "<uuid>", "tag": "<method>", "payload": <object> }
 *
 *   Response (server → client):
 *     { "_tag": "Exit", "id": "<uuid>", "exit": { "_tag": "Success", "value": <object> } }
 *   or
 *     { "_tag": "Exit", "id": "<uuid>", "exit": { "_tag": "Failure", "cause": <object> } }
 *
 *   Stream item:
 *     { "_tag": "Chunk", "id": "<uuid>", "value": <object> }
 *   Stream end:
 *     { "_tag": "End", "id": "<uuid>" }
 *
 * Auth flow:
 *   1. POST /api/auth/bootstrap/bearer with { credential: "<token>" }
 *      → { sessionToken: "...", expiresAt: "..." }
 *   2. POST /api/auth/ws-token with Authorization: Bearer <sessionToken>
 *      → { token: "..." }
 *   3. Connect to ws://<host>/ws?token=<ws-token>
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";

export interface T3ClientConfig {
  /** Base URL of the T3 Code server, e.g. http://localhost:3000 */
  baseUrl: string;
  /** Bootstrap token (the pairing credential from T3 Code settings) */
  token: string;
}

interface RpcRequest {
  _tag: "Request";
  id: string;
  tag: string;
  payload: unknown;
}

interface RpcExitSuccess {
  _tag: "Exit";
  id: string;
  exit: { _tag: "Success"; value: unknown };
}

interface RpcExitFailure {
  _tag: "Exit";
  id: string;
  exit: { _tag: "Failure"; cause: unknown };
}

interface RpcChunk {
  _tag: "Chunk";
  id: string;
  value: unknown;
}

interface RpcEnd {
  _tag: "End";
  id: string;
}

type RpcMessage = RpcExitSuccess | RpcExitFailure | RpcChunk | RpcEnd;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** If set, this is a streaming request; chunks go here */
  onChunk?: (value: unknown) => void;
}

export class T3Client {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private sessionToken: string | null = null;
  private connectPromise: Promise<void> | null = null;
  private closing = false;

  constructor(private readonly config: T3ClientConfig) {}

  /** Normalize base URL: strip trailing slash, ensure http(s) scheme */
  private get httpBase(): string {
    const url = new URL(this.config.baseUrl.replace(/^ws/, "http"));
    return url.origin;
  }

  private get wsBase(): string {
    const url = new URL(this.config.baseUrl.replace(/^http/, "ws").replace(/^https/, "wss"));
    return url.origin;
  }

  /** Exchange the bootstrap token for a bearer session token */
  private async bootstrapSession(): Promise<string> {
    const res = await fetch(`${this.httpBase}/api/auth/bootstrap/bearer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: this.config.token }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`T3 Code auth bootstrap failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { sessionToken?: string; token?: string };
    const token = data.sessionToken ?? data.token;
    if (!token) {
      throw new Error(`T3 Code auth bootstrap response missing sessionToken: ${JSON.stringify(data)}`);
    }
    return token;
  }

  /** Exchange a bearer session token for a short-lived WebSocket token */
  private async getWsToken(bearerToken: string): Promise<string> {
    const res = await fetch(`${this.httpBase}/api/auth/ws-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`T3 Code ws-token failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      throw new Error(`T3 Code ws-token response missing token: ${JSON.stringify(data)}`);
    }
    return data.token;
  }

  /** Connect to T3 Code (idempotent — reuses an existing open connection) */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        // 1. Bootstrap bearer session
        this.sessionToken = await this.bootstrapSession();

        // 2. Get WS token
        const wsToken = await this.getWsToken(this.sessionToken);

        // 3. Open WebSocket
        const wsUrl = `${this.wsBase}/ws?token=${encodeURIComponent(wsToken)}`;
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          this.ws = ws;

          ws.once("open", () => resolve());
          ws.once("error", (err) => reject(err));

          ws.on("message", (raw) => {
            try {
              const msg = JSON.parse(raw.toString()) as RpcMessage;
              this.handleMessage(msg);
            } catch {
              // ignore malformed messages
            }
          });

          ws.on("close", () => {
            if (!this.closing) {
              // Reject all pending requests
              for (const [, pending] of this.pending) {
                pending.reject(new Error("WebSocket closed unexpectedly"));
              }
              this.pending.clear();
            }
          });
        });
      } finally {
        this.connectPromise = null;
      }
    })();

    return this.connectPromise;
  }

  private handleMessage(msg: RpcMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;

    if (msg._tag === "Exit") {
      this.pending.delete(msg.id);
      if (msg.exit._tag === "Success") {
        pending.resolve(msg.exit.value);
      } else {
        pending.reject(new Error(`T3 Code RPC error: ${JSON.stringify(msg.exit.cause)}`));
      }
    } else if (msg._tag === "Chunk" && pending.onChunk) {
      pending.onChunk(msg.value);
    } else if (msg._tag === "End") {
      this.pending.delete(msg.id);
      pending.resolve(null);
    }
  }

  private send(message: RpcRequest): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  /** Send a unary RPC request and await the response */
  async request<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
    await this.connect();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        this.send({ _tag: "Request", id, tag: method, payload });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Send a streaming RPC request; calls onChunk for each item, resolves when stream ends */
  async requestStream<T = unknown>(
    method: string,
    payload: unknown,
    onChunk: (value: T) => void,
  ): Promise<void> {
    await this.connect();
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
        onChunk: onChunk as (v: unknown) => void,
      });
      try {
        this.send({ _tag: "Request", id, tag: method, payload });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Close the WebSocket connection */
  close(): void {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
  }

  // ─── High-level API methods ───────────────────────────────────────────────

  /** Get server config (providers, keybindings, settings) */
  async getConfig(): Promise<unknown> {
    return this.request("server.getConfig", {});
  }

  /**
   * Dispatch an orchestration command (thread.turn.start, thread.turn.interrupt,
   * thread.session.stop, etc.)
   */
  async dispatchCommand(command: unknown): Promise<{ sequence: number }> {
    return this.request<{ sequence: number }>("orchestration.dispatchCommand", command);
  }

  /**
   * Subscribe to a thread's event stream. Returns collected events (up to
   * `timeoutMs` milliseconds). For persistent subscriptions use requestStream
   * directly.
   */
  async subscribeThread(
    threadId: string,
    onItem: (item: unknown) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const id = randomUUID();
    await this.connect();
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
        onChunk: onItem,
      });

      signal?.addEventListener("abort", () => {
        this.pending.delete(id);
        resolve();
      });

      try {
        this.send({
          _tag: "Request",
          id,
          tag: "orchestration.subscribeThread",
          payload: { threadId },
        });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }
}
