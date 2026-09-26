/**
 * T3 Code v0.0.42 orchestration client.
 *
 * The server uses Effect RPC JSON frames over WebSocket. Client requests use
 * `id`; server responses use `requestId`. Streaming chunks contain a batch
 * of `values` and require an Ack before the server emits the next batch.
 *
 * Thread discovery and current-state snapshots use T3's supported HTTP
 * orchestration API instead of private state: `/api/orchestration/snapshot`
 * returns the full read model and `/api/orchestration/threads/:threadId`
 * returns one thread's detail snapshot.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { AccessTokenProvider } from "./auth.js";

export interface T3ClientConfig {
  baseUrl: string;
  accessTokenProvider: AccessTokenProvider;
}

export interface T3LatestTurn {
  turnId: string;
  state: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
}

export interface T3Activity {
  id: string;
  tone: string;
  kind: string;
  summary: string;
  payload: unknown;
  turnId: string | null;
  createdAt: string;
}

export interface T3Message {
  id: string;
  role: string;
  text: string;
  createdAt: string;
}

export interface T3ModelSelection {
  instanceId?: string;
  model?: unknown;
  options?: unknown;
}

export interface T3Thread {
  id: string;
  projectId: string;
  title: string;
  modelSelection?: T3ModelSelection | null;
  runtimeMode: string;
  interactionMode: string;
  branch: string | null;
  worktreePath: string | null;
  latestTurn: T3LatestTurn | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null | undefined;
  settledOverride: "settled" | "active" | null;
  settledAt: string | null;
  deletedAt: string | null;
  messages: T3Message[];
  activities: T3Activity[];
  session: {
    status: string;
    providerName: string | null;
    activeTurnId: string | null;
    lastError: string | null;
    updatedAt: string;
  } | null;
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
}

export interface T3ReadModel {
  snapshotSequence: number;
  projects: T3Project[];
  threads: T3Thread[];
  updatedAt: string;
}

export interface T3ThreadDetailSnapshot {
  snapshotSequence: number;
  thread: T3Thread;
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

  private async httpGetJson(
    accessToken: string,
    path: string,
    params?: URLSearchParams,
  ): Promise<unknown> {
    const url = new URL(path, `${this.httpBase}/`);
    if (params) {
      for (const [key, value] of params) url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new T3HttpError(
        `T3 Code ${path} failed (${response.status}): ${detail}`,
        response.status,
      );
    }

    return response.json();
  }

  private async authedGet(path: string, params?: URLSearchParams): Promise<unknown> {
    let accessToken = await this.config.accessTokenProvider.getAccessToken();

    try {
      return await this.httpGetJson(accessToken, path, params);
    } catch (error) {
      if (
        error instanceof T3HttpError &&
        (error.status === 401 || error.status === 403) &&
        this.config.accessTokenProvider.invalidate()
      ) {
        accessToken = await this.config.accessTokenProvider.getAccessToken();
        return this.httpGetJson(accessToken, path, params);
      }
      throw error;
    }
  }

  /**
   * Fetch T3's full orchestration read model over the supported HTTP API.
   * Includes every project and thread with its current state, so callers can
   * discover threads created by any client without touching private state.
   */
  async getReadModel(): Promise<T3ReadModel> {
    return (await this.authedGet("/api/orchestration/snapshot")) as T3ReadModel;
  }

  /**
   * Fetch one thread's current detail snapshot over the supported HTTP API.
   * Returns immediately with the present state; no event waiting is involved.
   */
  async getThreadSnapshot(
    threadId: string,
    turnLimit?: number,
  ): Promise<T3ThreadDetailSnapshot> {
    const params = new URLSearchParams();
    if (turnLimit !== undefined) params.set("turnLimit", String(turnLimit));
    const snapshot = await this.authedGet(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      params,
    );
    return snapshot as T3ThreadDetailSnapshot;
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

  async connect(): Promise<void> {    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        const wsTicket = await this.issueWsTicket();
        const wsUrl = `${this.wsBase}/ws?wsTicket=${encodeURIComponent(wsTicket)}`;

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

  /**
   * Stream one thread's snapshot plus live events. Without `afterSequence`
   * the server emits `{kind: "snapshot"}` first, then catch-up and live
   * events, and marks the catch-up boundary with `{kind: "synchronized"}`.
   */
  async subscribeThread(
    threadId: string,
    onItem: (item: unknown) => void,
    signal?: AbortSignal,
    afterSequence?: number,
  ): Promise<void> {
    return this.requestStream(
      "orchestration.subscribeThread",
      afterSequence === undefined ? { threadId } : { threadId, afterSequence },
      onItem,
      signal,
    );
  }
}
