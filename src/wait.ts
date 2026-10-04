/**
 * Block until watched T3 threads need attention, driven by T3's shell stream.
 *
 * `orchestration.subscribeShell` sends a snapshot of every thread summary and
 * then one `thread-upserted` item per change. The waiter re-evaluates the
 * watched threads on each item, so callers never poll. The check is
 * level-triggered: a thread that already needs attention returns at once.
 */

import type { PendingRequest } from "./requests.js";
import type { T3Client, T3LatestTurn } from "./t3client.js";

export type WaitUntil = "attention" | "turn-end";
export type WaitMode = "any" | "all";

export type WaitReason =
  | "turn-completed"
  | "turn-error"
  | "turn-interrupted"
  | "turn-ended"
  | "idle"
  | "approval-requested"
  | "user-input-requested"
  | "session-error"
  | "not-found";

/** The fields of a shell thread summary that the waiter reads. */
export interface T3ShellThread {
  id: string;
  title?: string;
  latestTurn: T3LatestTurn | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  deletedAt?: string | null;
  session: {
    status: string;
    activeTurnId?: string | null;
    lastError?: string | null;
  } | null;
}

const BUSY_SESSION_STATUSES = new Set(["starting", "running"]);

/**
 * Why a thread needs attention, or null while it is still working.
 *
 * A user message newer than the latest turn means T3 has queued a turn that
 * has not started yet; the thread is busy even though its previous turn has
 * completed. T3 sets the turn's requestedAt to that message's createdAt.
 */
export function attentionReason(
  thread: T3ShellThread | undefined,
  until: WaitUntil = "attention",
): WaitReason | null {
  if (!thread || thread.deletedAt) return "not-found";

  if (until === "attention") {
    if (thread.hasPendingApprovals) return "approval-requested";
    if (thread.hasPendingUserInput) return "user-input-requested";
  }

  const status = thread.session?.status ?? "no-session";
  if (status === "error") return "session-error";

  const turn = thread.latestTurn;
  const queued =
    !!thread.latestUserMessageAt && (!turn || thread.latestUserMessageAt > turn.requestedAt);
  if (queued || BUSY_SESSION_STATUSES.has(status) || thread.session?.activeTurnId) return null;
  if (!turn) return "idle";

  switch (turn.state) {
    case "running":
      return null;
    case "completed":
      return "turn-completed";
    case "error":
      return "turn-error";
    case "interrupted":
      return "turn-interrupted";
    default:
      return "turn-ended";
  }
}

export interface ThreadWaitState {
  threadId: string;
  title: string | null;
  reason: WaitReason | null;
  turnState: string;
  turnId: string | null;
  turnCompletedAt: string | null;
  sessionStatus: string;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  lastError: string | null;
  lastAssistantMessage: string | null;
  /** Open approval and user-input requests; filled for threads that need attention. */
  pendingRequests: PendingRequest[];
}

export interface WaitResult {
  status: "ready" | "timeout" | "cancelled";
  until: WaitUntil;
  mode: WaitMode;
  waitedMs: number;
  /** Latest shell sequence the waiter observed; pass it as afterSequence to continue. */
  sequence: number | null;
  ready: ThreadWaitState[];
  pending: ThreadWaitState[];
}

export interface WaitOptions {
  threadIds: string[];
  until?: WaitUntil;
  mode?: WaitMode;
  timeoutMs: number;
  /** Ignore states older than this orchestration sequence (for example a dispatch sequence). */
  afterSequence?: number;
  signal?: AbortSignal;
  /** Called about every progressIntervalMs while waiting, for MCP progress keepalives. */
  onProgress?: (waitedMs: number) => void | Promise<void>;
  progressIntervalMs?: number;
  /** Delay before resubscribing after the stream drops. */
  reconnectDelayMs?: number;
}

function waitState(
  threadId: string,
  thread: T3ShellThread | undefined,
  until: WaitUntil,
): ThreadWaitState {
  return {
    threadId,
    title: thread?.title ?? null,
    reason: attentionReason(thread, until),
    turnState: thread?.latestTurn?.state ?? (thread ? "no-turns" : "unknown"),
    turnId: thread?.latestTurn?.turnId ?? null,
    turnCompletedAt: thread?.latestTurn?.completedAt ?? null,
    sessionStatus: thread?.session?.status ?? (thread ? "no-session" : "unknown"),
    hasPendingApprovals: thread?.hasPendingApprovals ?? false,
    hasPendingUserInput: thread?.hasPendingUserInput ?? false,
    lastError: thread?.session?.lastError ?? null,
    lastAssistantMessage: null,
    pendingRequests: [],
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Wait on T3's shell stream until the watched threads need attention. */
export async function waitForThreads(
  client: Pick<T3Client, "subscribeShell">,
  options: WaitOptions,
): Promise<WaitResult> {
  const until = options.until ?? "attention";
  const mode = options.mode ?? "any";
  const watched = [...new Set(options.threadIds)];
  const started = Date.now();
  const states = new Map<string, T3ShellThread | undefined>();
  let sequence: number | null = null;
  let synced = false;
  let everSynced = false;
  let lastError: unknown = null;
  let failures = 0;
  const baseDelay = options.reconnectDelayMs ?? 1000;
  const retryDelay = () => Math.min(baseDelay * 2 ** Math.max(failures - 1, 0), Math.max(baseDelay, 30_000));
  let outcome: WaitResult["status"] | null = null;

  const satisfied = (): boolean => {
    if (!synced) return false;
    if (options.afterSequence !== undefined && (sequence ?? -1) < options.afterSequence) return false;
    const ready = watched.filter((id) => attentionReason(states.get(id), until) !== null);
    return mode === "any" ? ready.length > 0 : ready.length === watched.length;
  };

  const deadline = started + options.timeoutMs;
  let progressTimer: NodeJS.Timeout | undefined;
  if (options.onProgress) {
    progressTimer = setInterval(() => {
      void Promise.resolve(options.onProgress?.(Date.now() - started)).catch(() => undefined);
    }, options.progressIntervalMs ?? 30_000);
  }

  try {
    while (outcome === null) {
      const remaining = deadline - Date.now();
      if (options.signal?.aborted) {
        outcome = "cancelled";
        break;
      }
      if (remaining <= 0) {
        outcome = "timeout";
        break;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        outcome ??= "timeout";
        controller.abort();
      }, remaining);
      const onCancel = () => {
        outcome ??= "cancelled";
        controller.abort();
      };
      options.signal?.addEventListener("abort", onCancel, { once: true });

      synced = false;
      try {
        await client.subscribeShell((item) => {
          const value = record(item);
          if (!value) return;
          if (value.kind === "snapshot") {
            const snapshot = record(value.snapshot);
            const threads = Array.isArray(snapshot?.threads) ? (snapshot.threads as T3ShellThread[]) : [];
            const byId = new Map(threads.map((thread) => [thread.id, thread]));
            for (const id of watched) states.set(id, byId.get(id));
            if (typeof snapshot?.snapshotSequence === "number") sequence = snapshot.snapshotSequence;
            synced = true;
            everSynced = true;
            if (failures > 0) {
              process.stderr.write(`t3_wait: shell stream restored after ${failures} failed attempt(s)\n`);
              failures = 0;
            }
          } else {
            if (typeof value.sequence === "number") sequence = Math.max(sequence ?? 0, value.sequence);
            const thread = record(value.thread) as T3ShellThread | null;
            if (thread && watched.includes(thread.id)) {
              states.set(thread.id, thread);
            } else if (typeof value.threadId === "string" && watched.includes(value.threadId) &&
                       /removed|deleted/.test(String(value.kind))) {
              states.set(value.threadId, undefined);
            }
          }
          if (satisfied()) {
            outcome ??= "ready";
            controller.abort();
          }
        }, controller.signal);
      } catch (error) {
        lastError = error;
        failures += 1;
        // The stream dropped (for example a T3 restart). Resubscribe with
        // backoff: the new snapshot restores the full state, so no change is
        // lost. Log the first failure of a streak only.
        if (outcome === null && Date.now() + retryDelay() >= deadline) {
          outcome = "timeout";
        } else if (outcome === null && failures === 1) {
          process.stderr.write(
            `t3_wait: shell stream dropped, resubscribing: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onCancel);
      }
      if (outcome === null) {
        await new Promise((resolve) => setTimeout(resolve, failures > 0 ? retryDelay() : baseDelay));
      }
    }
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }

  // Never reaching T3 at all is an outage, not a slow worker.
  if (!everSynced && lastError && outcome !== "cancelled") throw lastError;

  const all = watched.map((id) => waitState(id, states.get(id), until));
  return {
    status: outcome ?? "timeout",
    until,
    mode,
    waitedMs: Date.now() - started,
    sequence,
    ready: all.filter((state) => state.reason !== null),
    pending: all.filter((state) => state.reason === null),
  };
}
