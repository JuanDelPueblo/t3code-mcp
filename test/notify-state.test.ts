import { describe, expect, it } from "vitest";
import {
  NotifierState,
  observeThread,
  type ThreadObservation,
} from "../src/notify-state.js";
import type { T3Thread } from "../src/t3client.js";

function makeThread(overrides: Partial<T3Thread> = {}): T3Thread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the parser",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: "2026-09-21T12:00:00.000Z",
      startedAt: "2026-09-21T12:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: "2026-09-21T12:00:00.000Z",
    updatedAt: "2026-09-21T12:00:02.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    session: {
      status: "running",
      providerName: "codex",
      activeTurnId: "turn-1",
      lastError: null,
      updatedAt: "2026-09-21T12:00:02.000Z",
    },
    ...overrides,
  };
}

function observation(overrides: Partial<ThreadObservation>): ThreadObservation {
  return {
    id: "thread-1",
    title: "Fix the parser",
    updatedAt: "2026-09-21T12:00:02.000Z",
    latestTurnState: "running",
    settled: false,
    approvalPending: false,
    userInputPending: false,
    ...overrides,
  };
}

describe("observeThread", () => {
  it("treats settledAt as settled", () => {
    const result = observeThread(makeThread({ settledAt: "2026-09-21T12:05:00.000Z" }));
    expect(result.settled).toBe(true);
  });

  it("treats settledOverride=settled as settled", () => {
    const result = observeThread(makeThread({ settledOverride: "settled" }));
    expect(result.settled).toBe(true);
  });

  it("treats settledOverride=active as not settled", () => {
    const result = observeThread(
      makeThread({ settledOverride: "active", settledAt: null }),
    );
    expect(result.settled).toBe(false);
  });

  it("detects a pending approval without a resolution", () => {
    const result = observeThread(
      makeThread({
        activities: [
          {
            id: "a1",
            tone: "info",
            kind: "approval.requested",
            summary: "Run shell command",
            payload: {},
            turnId: "turn-1",
            createdAt: "2026-09-21T12:01:00.000Z",
          },
        ],
      }),
    );
    expect(result.approvalPending).toBe(true);
    expect(result.approvalDetail).toBe("Run shell command");
  });

  it("clears a pending approval after resolution", () => {
    const result = observeThread(
      makeThread({
        activities: [
          {
            id: "a1",
            tone: "info",
            kind: "approval.requested",
            summary: "Run shell command",
            payload: {},
            turnId: "turn-1",
            createdAt: "2026-09-21T12:01:00.000Z",
          },
          {
            id: "a2",
            tone: "info",
            kind: "approval.resolved",
            summary: "Approved",
            payload: {},
            turnId: "turn-1",
            createdAt: "2026-09-21T12:02:00.000Z",
          },
        ],
      }),
    );
    expect(result.approvalPending).toBe(false);
  });

  it("detects a pending user input request", () => {
    const result = observeThread(
      makeThread({
        activities: [
          {
            id: "a3",
            tone: "info",
            kind: "user-input.requested",
            summary: "Which database?",
            payload: {},
            turnId: "turn-1",
            createdAt: "2026-09-21T12:03:00.000Z",
          },
        ],
      }),
    );
    expect(result.userInputPending).toBe(true);
    expect(result.userInputDetail).toBe("Which database?");
  });
});

describe("NotifierState", () => {
  it("returns no notifications on the first poll", () => {
    const state = new NotifierState();
    // Even a mid-flight or already-settled thread only primes the baseline.
    expect(state.ingest([observation({ settled: false })])).toEqual([]);
    expect(new NotifierState().ingest([observation({ settled: true, latestTurnState: "completed" })]))
      .toEqual([]);
  });

  it("notifies agent-finished when a running thread settles completed", () => {
    const state = new NotifierState();
    state.ingest([observation({ latestTurnState: "running", settled: false })]);
    expect(state.ingest([observation({ latestTurnState: "completed", settled: true })]))
      .toEqual([
        {
          kind: "agent-finished",
          threadId: "thread-1",
          threadTitle: "Fix the parser",
        },
      ]);
  });

  it("notifies agent-failed when a thread settles with an error turn", () => {
    const state = new NotifierState();
    state.ingest([observation({ latestTurnState: "running", settled: false })]);
    expect(state.ingest([observation({ latestTurnState: "error", settled: true })]))
      .toEqual([
        {
          kind: "agent-failed",
          threadId: "thread-1",
          threadTitle: "Fix the parser",
        },
      ]);
  });

  it("notifies agent-stopped when a thread settles interrupted", () => {
    const state = new NotifierState();
    state.ingest([observation({ latestTurnState: "running", settled: false })]);
    expect(state.ingest([observation({ latestTurnState: "interrupted", settled: true })]))
      .toEqual([
        {
          kind: "agent-stopped",
          threadId: "thread-1",
          threadTitle: "Fix the parser",
        },
      ]);
  });

  it("notifies approval-needed and input-needed when they appear", () => {
    const state = new NotifierState();
    state.ingest([observation({})]);
    expect(
      state.ingest([
        observation({
          approvalPending: true,
          approvalDetail: "Run shell command",
        }),
      ]),
    ).toEqual([
      {
        kind: "approval-needed",
        threadId: "thread-1",
        threadTitle: "Fix the parser",
        detail: "Run shell command",
      },
    ]);

    expect(
      state.ingest([
        observation({
          approvalPending: true,
          approvalDetail: "Run shell command",
          userInputPending: true,
          userInputDetail: "Which database?",
        }),
      ]),
    ).toEqual([
      {
        kind: "input-needed",
        threadId: "thread-1",
        threadTitle: "Fix the parser",
        detail: "Which database?",
      },
    ]);
  });

  it("does not repeat a pending request on later polls", () => {
    const state = new NotifierState();
    state.ingest([observation({})]);
    state.ingest([observation({ approvalPending: true, approvalDetail: "x" })]);
    expect(state.ingest([observation({ approvalPending: true, approvalDetail: "x" })]))
      .toEqual([]);
  });

  it("re-notifies after resolve and a new request", () => {
    const state = new NotifierState();
    state.ingest([observation({})]);
    state.ingest([observation({ approvalPending: true, approvalDetail: "first" })]);
    state.ingest([observation({})]);
    expect(state.ingest([observation({ approvalPending: true, approvalDetail: "second" })]))
      .toEqual([
        {
          kind: "approval-needed",
          threadId: "thread-1",
          threadTitle: "Fix the parser",
          detail: "second",
        },
      ]);
  });

  it("re-notifies when an unsettled thread settles again", () => {
    const state = new NotifierState();
    state.ingest([observation({ settled: true, latestTurnState: "completed" })]);
    state.ingest([observation({ settled: false, latestTurnState: "running" })]);
    expect(state.ingest([observation({ settled: true, latestTurnState: "completed" })]))
      .toEqual([
        {
          kind: "agent-finished",
          threadId: "thread-1",
          threadTitle: "Fix the parser",
        },
      ]);
  });

  it("primes newly discovered threads without notifying", () => {
    const state = new NotifierState();
    state.ingest([observation({})]);
    expect(
      state.ingest([
        observation({}),
        observation({ id: "thread-2", settled: true, latestTurnState: "completed" }),
      ]),
    ).toEqual([]);
    expect(
      state.ingest([
        observation({}),
        observation({ id: "thread-2", settled: false, latestTurnState: "running" }),
      ]),
    ).toEqual([]);
    expect(
      state.ingest([
        observation({}),
        observation({ id: "thread-2", settled: true, latestTurnState: "completed" }),
      ]),
    ).toEqual([
      {
        kind: "agent-finished",
        threadId: "thread-2",
        threadTitle: "Fix the parser",
      },
    ]);
  });
});
