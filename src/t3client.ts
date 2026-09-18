/**
 * T3 Code v0.0.40 WebSocket RPC client.
 *
 * The server uses Effect RPC JSON frames over WebSocket. Client requests use
 * `id`; server responses use `requestId`. Streaming chunks contain a batch
 * of `values` and require an Ack before the server emits the next batch.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { AccessTokenProvider } from "./auth.js";

export interface T3ClientConfig {
  baseUrl: string;
  accessTokenProvider: AccessTokenProvider;
}

interface RpcRequest {
  _tag: "Request";
  id: string;
  tag: string;
  payload: unknown;
  headers: Array<[string, string]>;
}

interface RpcAck {
  _tag: "Ack";
  requestId: string;
}

interface RpcInterrupt {
  _tag: "Interrupt";
  requestId: string;
}

interface RpcExitSuccess {
  _tag: "Exit";
  requestId: string;
  exit: { _tag: "Success"; value: unknown };
}

interface RpcExitFailure {
  _tag: "Exit";
  requestId: string;
  exit: { _tag: "Failure"; cause: unknown };
}

interface RpcChunk {
  _tag: "Chunk";
  requestId: string;
  values: unknown[];
}

interface RpcDefect {
  _tag: "Defect";
  defect: unknown;
}

interface RpcClientProtocolError {
  _tag: "ClientProtocolError";
  error: unknown;
}

interface RpcPong {
  _tag: "Pong";
}

type RpcMessage =
  | RpcExitSuccess
  | RpcExitFailure
  | RpcChunk
  | RpcDefect
  | RpcClientProtocolError
  | RpcPong;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onChunk?: (value: unknown) => void;
}

class T3HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class T3Client {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private connectPromise: Promise<void> | null = null;
  private closing = false;

  constructor(private readonly config: T3ClientConfig) {}

  private get httpBase(): string {
    return new URL(this.config.baseUrl.replace(/^ws/, "http")).origin;
  }

  private get wsBase(): string {
    return new URL(this.config.baseUrl.replace(/^http/, "ws")).origin;
  }

  private async getWsTicket(accessToken: string): Promise<string> {
    const response = await fetch(`${this.httpBase}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new T3HttpError(
        `T3 Code websocket-ticket failed (${response.status}): ${detail}`,
        response.status,
      );
    }

    const data = (await response.json()) as { ticket?: unknown };
    if (typeof data.ticket !== "string" || !data.ticket) {
      throw new Error("T3 Code websocket-ticket response did not include a ticket");
    }

    return data.ticket;
  }

  private async issueWsTicket(): Promise<string> {
    let accessToken = await this.config.accessTokenProvider.getAccessToken();

    try {
      return await this.getWsTicket(accessToken);
    } catch (error) {
      if (
        error instanceof T3HttpError &&
        (error.status === 401 || error.status === 403) &&
        this.config.accessTokenProvider.invalidate()
      ) {
        accessToken = await this.config.accessTokenProvider.getAccessToken();
        return this.getWsTicket(accessToken);
      }
      throw error;
    }
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        const wsTicket = await this.issueWsTicket();
        const wsUrl =
          `${this.wsBase}/ws?wsTicket=${encodeURIComponent(wsTicket)}&orchestrationProtocol=1`;

        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          this.ws = ws;

          const failOpen = (error: Error) => {
            this.ws = null;
            reject(error);
          };

          ws.once("open", () => {
            ws.off("error", failOpen);
            resolve();
          });
          ws.once("error", failOpen);

          ws.on("message", (raw) => {
            try {
              this.handleMessage(JSON.parse(raw.toString()) as RpcMessage);
            } catch (error) {
              process.stderr.write(
                `Ignoring malformed T3 RPC message: ${error instanceof Error ? error.message : String(error)}\n`,
              );
            }
          });

          ws.on("close", () => {
            this.ws = null;
            if (!this.closing) {
              const error = new Error("T3 Code WebSocket closed unexpectedly");
              for (const [, pending] of this.pending) pending.reject(error);
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
    if (msg._tag === "Pong") return;

    if (msg._tag === "Defect" || msg._tag === "ClientProtocolError") {
      const detail = msg._tag === "Defect" ? msg.defect : msg.error;
      const error = new Error(`T3 Code RPC protocol error: ${JSON.stringify(detail)}`);
      for (const [, pending] of this.pending) pending.reject(error);
      this.pending.clear();
      return;
    }

    const pending = this.pending.get(msg.requestId);

    if (msg._tag === "Chunk") {
      this.send({ _tag: "Ack", requestId: msg.requestId });
      if (!pending?.onChunk) return;
      for (const value of msg.values) pending.onChunk(value);
      return;
    }

    if (!pending) return;

    this.pending.delete(msg.requestId);
    if (msg.exit._tag === "Success") {
      pending.resolve(msg.exit.value);
    } else {
      pending.reject(new Error(`T3 Code RPC error: ${JSON.stringify(msg.exit.cause)}`));
    }
  }

  private send(message: RpcRequest | RpcAck | RpcInterrupt): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("T3 Code WebSocket is not connected");
    }
    this.ws.send(JSON.stringify(message));
  }

  async request<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
    await this.connect();
    const id = randomUUID();

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      try {
        this.send({ _tag: "Request", id, tag: method, payload, headers: [] });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async requestStream<T = unknown>(
    method: string,
    payload: unknown,
    onChunk: (value: T) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.connect();
    const id = randomUUID();

    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
        onChunk: onChunk as (value: unknown) => void,
      });

      const abort = () => {
        try {
          this.send({ _tag: "Interrupt", requestId: id });
        } catch {
          // The WebSocket may already be gone; local cleanup still matters.
        }
        this.pending.delete(id);
        resolve();
      };

      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });

      try {
        this.send({ _tag: "Request", id, tag: method, payload, headers: [] });
      } catch (error) {
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
    this.ws = null;

    const error = new Error("T3 Code client closed");
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
  }

  async getConfig(): Promise<unknown> {
    return this.request("server.getConfig", {});
  }

  async dispatchCommand(command: unknown): Promise<{ sequence: number }> {
    return this.request<{ sequence: number }>("orchestration.dispatchCommand", command);
  }

  async subscribeThread(
    threadId: string,
    onItem: (item: unknown) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.requestStream(
      "orchestration.subscribeThread",
      { threadId },
      onItem,
      signal,
    );
  }
}
