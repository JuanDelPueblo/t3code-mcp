import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeSessionId, nativeSessionLookup, stateDbPathFromEnvironment } from "../src/native-session.js";
import { registerTools } from "../src/tools.js";
import { attentionReason, waitForThreads, type T3ShellThread } from "../src/wait.js";

type Emit = (item: unknown) => void;

/** Pin Date (not timers) so T3's 120 s queued-message grace applies to fixed fixtures. */
function clock(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}
afterEach(() => vi.useRealTimers());

function thread(overrides: Partial<T3ShellThread> & { turn?: string | null } = {}): T3ShellThread {
  const { turn = "completed", ...rest } = overrides;
  return {
    id: "t1",
    title: "Worker",
    latestUserMessageAt: "2026-10-04T00:00:00.000Z",
    latestTurn:
      turn === null
        ? null
        : {
            turnId: "turn-1",
            state: turn,
            requestedAt: "2026-10-04T00:00:00.000Z",
            startedAt: "2026-10-04T00:00:00.000Z",
            completedAt: turn === "running" ? null : "2026-10-04T00:01:00.000Z",
            assistantMessageId: null,
          },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: { status: turn === "running" ? "running" : "ready", activeTurnId: null, lastError: null },
    ...rest,
  };
}

/** A shell stream that runs `script` and resolves on abort, like the real RPC stream. */
function shellClient(...scripts: Array<(emit: Emit) => Promise<void> | void>) {
  let call = 0;
  return {
    calls: () => call,
    subscribeShell: vi.fn((onItem: Emit, signal?: AbortSignal) => {
      const script = scripts[Math.min(call, scripts.length - 1)];
      call += 1;
      return new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
        Promise.resolve()
          .then(() => script(onItem))
          .catch(reject);
      });
    }),
  };
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshot = (sequence: number, threads: T3ShellThread[]) => ({
  kind: "snapshot",
  snapshot: { snapshotSequence: sequence, threads },
});
const upsert = (sequence: number, value: T3ShellThread) => ({ kind: "thread-upserted", sequence, thread: value });

describe("attentionReason", () => {
  it("treats a running turn, a busy session, or a queued message as busy", () => {
    clock("2026-10-04T00:02:30.000Z");
    expect(attentionReason(thread({ turn: "running" }))).toBeNull();
    expect(attentionReason(thread({ session: { status: "starting" } }))).toBeNull();
    expect(attentionReason(thread({ latestUserMessageAt: "2026-10-04T00:02:00.000Z" }))).toBeNull();
    expect(attentionReason(thread({ turn: null, session: { status: "starting" } }))).toBeNull();
  });

  it("names why a thread needs attention", () => {
    expect(attentionReason(thread())).toBe("turn-completed");
    expect(attentionReason(thread({ turn: "error" }))).toBe("turn-error");
    expect(attentionReason(thread({ turn: "interrupted" }))).toBe("turn-interrupted");
    expect(attentionReason(thread({ session: { status: "error", lastError: "boom" } }))).toBe("session-error");
    expect(attentionReason(thread({ turn: null, latestUserMessageAt: null }))).toBe("idle");
    expect(attentionReason(undefined)).toBe("not-found");
    expect(attentionReason(thread({ deletedAt: "2026-10-04T00:03:00.000Z" }))).toBe("not-found");
  });

  it("wakes on pending approvals and input only in attention mode", () => {
    const blocked = thread({ turn: "running", hasPendingApprovals: true });
    expect(attentionReason(blocked)).toBe("approval-requested");
    expect(attentionReason(blocked, "turn-end")).toBeNull();
    expect(attentionReason(thread({ turn: "running", hasPendingUserInput: true }))).toBe("user-input-requested");
  });
});

describe("waitForThreads", () => {
  it("returns when a watched thread finishes, without polling", async () => {
    const client = shellClient(async (emit) => {
      emit(snapshot(10, [thread({ turn: "running" }), thread({ id: "other", turn: "running" })]));
      await later(20);
      emit(upsert(11, thread({ id: "other" })));
      await later(20);
      emit(upsert(12, thread()));
    });
    const result = await waitForThreads(client, { threadIds: ["t1"], timeoutMs: 5000 });
    expect(result.status).toBe("ready");
    expect(result.sequence).toBe(12);
    expect(result.ready.map((state) => [state.threadId, state.reason])).toEqual([["t1", "turn-completed"]]);
    expect(client.calls()).toBe(1);
  });

  it("returns at once for a thread that already needs attention", async () => {
    const client = shellClient((emit) => emit(snapshot(5, [thread()])));
    const result = await waitForThreads(client, { threadIds: ["t1"], timeoutMs: 5000 });
    expect(result.status).toBe("ready");
    expect(result.waitedMs).toBeLessThan(1000);
  });

  it("ignores state older than afterSequence", async () => {
    clock("2026-10-04T00:05:30.000Z");
    const client = shellClient(async (emit) => {
      emit(snapshot(10, [thread()]));
      await later(20);
      emit(upsert(12, thread({ latestUserMessageAt: "2026-10-04T00:05:00.000Z" })));
      await later(20);
      emit(upsert(13, thread({ turn: "completed", latestUserMessageAt: "2026-10-04T00:05:00.000Z",
        latestTurn: { turnId: "turn-2", state: "completed", requestedAt: "2026-10-04T00:05:00.000Z",
          startedAt: null, completedAt: "2026-10-04T00:06:00.000Z", assistantMessageId: null } })));
    });
    const result = await waitForThreads(client, { threadIds: ["t1"], timeoutMs: 5000, afterSequence: 12 });
    expect(result.status).toBe("ready");
    expect(result.ready[0].turnId).toBe("turn-2");
  });

  it("waits for every thread in all mode", async () => {
    const client = shellClient(async (emit) => {
      emit(snapshot(1, [thread(), thread({ id: "t2", turn: "running" })]));
      await later(20);
      emit(upsert(2, thread({ id: "t2" })));
    });
    const result = await waitForThreads(client, { threadIds: ["t1", "t2"], mode: "all", timeoutMs: 5000 });
    expect(result.status).toBe("ready");
    expect(result.ready).toHaveLength(2);
    expect(result.pending).toHaveLength(0);
  });

  it("times out cleanly and reports pending threads", async () => {
    const client = shellClient((emit) => emit(snapshot(1, [thread({ turn: "running" })])));
    const result = await waitForThreads(client, { threadIds: ["t1"], timeoutMs: 1000 });
    expect(result.status).toBe("timeout");
    expect(result.pending[0]).toMatchObject({ threadId: "t1", reason: null, turnState: "running" });
  });

  it("stops when the client cancels", async () => {
    const controller = new AbortController();
    const client = shellClient((emit) => emit(snapshot(1, [thread({ turn: "running" })])));
    setTimeout(() => controller.abort(), 30);
    const result = await waitForThreads(client, { threadIds: ["t1"], timeoutMs: 5000, signal: controller.signal });
    expect(result.status).toBe("cancelled");
  });

  it("resubscribes after the stream drops", async () => {
    const client = shellClient(
      () => {
        throw new Error("T3 Code WebSocket closed unexpectedly");
      },
      (emit) => emit(snapshot(3, [thread()])),
    );
    const result = await waitForThreads(client, { threadIds: ["t1"], timeoutMs: 5000, reconnectDelayMs: 10 });
    expect(result.status).toBe("ready");
    expect(client.calls()).toBe(2);
  });

  it("reports a missing thread instead of hanging", async () => {
    const client = shellClient((emit) => emit(snapshot(1, [])));
    const result = await waitForThreads(client, { threadIds: ["gone"], timeoutMs: 5000 });
    expect(result.ready[0]).toMatchObject({ threadId: "gone", reason: "not-found", sessionStatus: "unknown" });
  });

  it("sends progress keepalives while waiting", async () => {
    const progress: number[] = [];
    const client = shellClient(async (emit) => {
      emit(snapshot(1, [thread({ turn: "running" })]));
      await later(120);
      emit(upsert(2, thread()));
    });
    await waitForThreads(client, {
      threadIds: ["t1"], timeoutMs: 5000, progressIntervalMs: 30, onProgress: (ms) => void progress.push(ms),
    });
    expect(progress.length).toBeGreaterThan(1);
  });
});

function captureTools(client: unknown, nativeSession?: unknown) {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
  const fakeServer = {
    server: { setRequestHandler: vi.fn() },
    registerTool: (name: string, _config: unknown, handler: never) => tools.set(name, handler),
  };
  registerTools(fakeServer as never, client as never, { antigravityCli: null, timeoutMs: 1000 },
    { nativeSession: nativeSession as never });
  return tools;
}

const detail = (text: string) => ({
  snapshotSequence: 9,
  thread: {
    ...thread(), projectId: "p1", runtimeMode: "approval-required", interactionMode: "default",
    branch: null, worktreePath: null, createdAt: "", updatedAt: "", archivedAt: null, settledOverride: null,
    settledAt: null, deletedAt: null, activities: [], modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
    messages: [{ id: "m1", role: "assistant", text, createdAt: "" }],
  },
});

describe("t3_wait tool", () => {
  it("returns ready threads with their last assistant message", async () => {
    const client = {
      ...shellClient((emit) => emit(snapshot(4, [thread()]))),
      getThreadSnapshot: vi.fn(async () => detail("REVIEW_RESULT_JSON: {}")),
    };
    const result = await captureTools(client).get("t3_wait")!({ threadIds: ["t1"], timeoutMs: 2000 });
    expect(result.isError).toBeUndefined();
    const content = result.structuredContent as { status: string; ready: Array<{ lastAssistantMessage: string }> };
    expect(content.status).toBe("ready");
    expect(content.ready[0].lastAssistantMessage).toBe("REVIEW_RESULT_JSON: {}");
  });

  it("lets t3_send_message start a turn and wait for it in one call", async () => {
    clock("2026-10-04T01:00:30.000Z");
    const dispatched: unknown[] = [];
    const client = {
      ...shellClient(async (emit) => {
        emit(snapshot(20, [thread()]));
        await later(10);
        emit(upsert(21, thread({ latestUserMessageAt: "2026-10-04T01:00:00.000Z" })));
        await later(10);
        emit(upsert(22, thread({ latestUserMessageAt: "2026-10-04T01:00:00.000Z",
          latestTurn: { turnId: "turn-2", state: "completed", requestedAt: "2026-10-04T01:00:00.000Z",
            startedAt: null, completedAt: "2026-10-04T01:01:00.000Z", assistantMessageId: null } })));
      }),
      getThreadSnapshot: vi.fn(async () => detail("fixed")),
      dispatchCommand: vi.fn(async (command: unknown) => (dispatched.push(command), { sequence: 21 })),
      subscribeThread: vi.fn(),
    };
    const result = await captureTools(client).get("t3_send_message")!({
      threadId: "t1", prompt: "Fix the finding.", waitUntil: "turn-end", waitTimeoutMs: 2000,
    });
    expect(result.isError).toBeUndefined();
    const content = result.structuredContent as { wait: { status: string; ready: Array<{ turnId: string }> } };
    expect(content.wait.status).toBe("ready");
    expect(content.wait.ready[0].turnId).toBe("turn-2");
    expect(client.subscribeThread).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(1);
  });

  it("adds the native session to t3_get_thread", async () => {
    const client = { getThreadSnapshot: vi.fn(async () => detail("x")) };
    const lookup = vi.fn(async () => ({
      provider: "claudeAgent", instanceId: "claudeAgent", status: "stopped", nativeSessionId: "claude-session",
      resumeCursor: { resume: "claude-session" }, lastSeenAt: null, source: "t3-state-db",
    }));
    const result = await captureTools(client, lookup).get("t3_get_thread")!({ threadId: "t1" });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { nativeSession: { nativeSessionId: string } }).nativeSession.nativeSessionId)
      .toBe("claude-session");
  });
});

describe("native session lookup", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("extracts each provider's own session ID", () => {
    expect(nativeSessionId({ threadId: "t3", resume: "claude" }, "t3")).toBe("claude");
    expect(nativeSessionId({ threadId: "codex-thread" }, "t3")).toBe("codex-thread");
    expect(nativeSessionId({ schemaVersion: 1, sessionId: "ses_x" }, "t3")).toBe("ses_x");
    expect(nativeSessionId({ threadId: "t3" }, "t3")).toBeNull();
    expect(nativeSessionId(null, "t3")).toBeNull();
  });

  it("reads T3's state database read-only and tolerates absence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3-state-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, provider_instance_id TEXT, " +
        "status TEXT, resume_cursor_json TEXT, last_seen_at TEXT)",
    );
    db.prepare("INSERT INTO provider_session_runtime VALUES (?, ?, ?, ?, ?, ?)")
      .run("t1", "opencode", "opencode", "stopped", '{"schemaVersion":1,"sessionId":"ses_abc"}', "2026-10-04");
    db.close();
    const lookup = nativeSessionLookup(path)!;
    expect(await lookup("t1")).toMatchObject({ provider: "opencode", nativeSessionId: "ses_abc" });
    expect(await lookup("missing")).toBeNull();
    expect(await nativeSessionLookup(join(dir, "absent.sqlite"))!("t1")).toBeNull();
  });

  it("finds the database from the T3 home", () => {
    expect(stateDbPathFromEnvironment({ T3_CODE_BASE_DIR: "/srv/t3" })).toBe("/srv/t3/userdata/state.sqlite");
    expect(stateDbPathFromEnvironment({ T3_STATE_DB: "/x.db", T3_CODE_BASE_DIR: "/srv/t3" })).toBe("/x.db");
    expect(stateDbPathFromEnvironment({ T3_STATE_DB: "", T3_CODE_BASE_DIR: "/srv/t3" })).toBeNull();
    expect(stateDbPathFromEnvironment({})).toBeNull();
  });
});

describe("waitForThreads outage", () => {
  it("raises the error when T3 never answers", async () => {
    const client = shellClient(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(waitForThreads(client, { threadIds: ["t1"], timeoutMs: 1000, reconnectDelayMs: 10 }))
      .rejects.toThrow("ECONNREFUSED");
  });
});

describe("t3_send_prompt project reuse", () => {
  it("reuses the active project of a workspace root instead of creating a duplicate", async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const client = {
      getReadModel: vi.fn(async () => ({
        snapshotSequence: 1, updatedAt: "", threads: [],
        projects: [{ id: "existing", title: "Repo", workspaceRoot: "/srv/repo/", createdAt: "", updatedAt: "" }],
      })),
      dispatchCommand: vi.fn(async (command: Record<string, unknown>) => (dispatched.push(command), { sequence: 5 })),
      getThreadSnapshot: vi.fn(async () => detail("ok")),
      subscribeThread: vi.fn(),
    };
    const result = await captureTools(client).get("t3_send_prompt")!({
      workspaceRoot: "/srv/repo", prompt: "work", instanceId: "codex", model: "gpt-6-luna", waitMs: 0,
    });
    expect(result.isError).toBeUndefined();
    expect(dispatched.map((command) => command.type)).toEqual(["thread.create", "thread.turn.start"]);
    expect(dispatched[0].projectId).toBe("existing");
  });
});

describe("queued turns", () => {
  it("reports a queued follow-up as queued, not as the previous completed turn", async () => {
    clock("2026-10-04T00:09:30.000Z");
    const queued = thread({ latestUserMessageAt: "2026-10-04T00:09:00.000Z", session: { status: "starting" } });
    const client = shellClient((emit) => emit(snapshot(1, [queued])));
    const result = await waitForThreads(client, { threadIds: ["t1"], timeoutMs: 1000 });
    expect(result.status).toBe("timeout");
    expect(result.pending[0]).toMatchObject({ turnState: "queued", turnId: null, turnCompletedAt: null, sessionStatus: "starting" });
  });
});

describe("messages that do not start a turn", () => {
  it("does not treat an answered question as a queued turn once the turn completes", () => {
    // The answer arrives mid-turn as a user message; the turn then completes after it.
    clock("2026-10-04T00:05:00.000Z");
    const answered = thread({ latestUserMessageAt: "2026-10-04T00:00:30.000Z",
      latestTurn: { turnId: "turn-1", state: "completed", requestedAt: "2026-10-04T00:00:00.000Z",
        startedAt: "2026-10-04T00:00:00.000Z", completedAt: "2026-10-04T00:04:00.000Z", assistantMessageId: null } });
    expect(attentionReason(answered)).toBe("turn-completed");
  });

  it("stops counting a message as queued after T3's grace period", () => {
    const stale = thread({ latestUserMessageAt: "2026-10-04T00:02:00.000Z" });
    clock("2026-10-04T00:03:00.000Z");
    expect(attentionReason(stale)).toBeNull();
    clock("2026-10-04T00:05:00.000Z");
    expect(attentionReason(stale)).toBe("turn-completed");
  });
});
