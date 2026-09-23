import { describe, expect, it } from "vitest";
import {
  formatThreadDetail,
  formatThreadRows,
  formatUsageLimits,
  terminalEventTypes,
} from "../src/tools.js";
import type { T3ReadModel, T3ThreadDetailSnapshot } from "../src/t3client.js";

function readModel(threads: T3ReadModel["threads"]): T3ReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-09-21T12:00:00.000Z",
    projects: [
      {
        id: "project-1",
        title: "Parser",
        workspaceRoot: "/srv/work/parser",
        createdAt: "2026-09-21T11:00:00.000Z",
        updatedAt: "2026-09-21T11:00:00.000Z",
      },
    ],
    threads,
  };
}

function thread(overrides: Partial<T3ReadModel["threads"][number]>): T3ReadModel["threads"][number] {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the parser",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-21T11:00:00.000Z",
    updatedAt: "2026-09-21T11:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    session: null,
    ...overrides,
  };
}

describe("formatThreadRows", () => {
  it("lists existing threads with state, project, and workspace", () => {
    const output = formatThreadRows(
      readModel([
        thread({
          latestTurn: {
            turnId: "turn-1",
            state: "completed",
            requestedAt: "2026-09-21T11:00:00.000Z",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            status: "ready",
            providerName: null,
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-09-21T11:00:00.000Z",
          },
        }),
      ]),
    );

    expect(output).toContain("Fix the parser");
    expect(output).toContain("turn=completed");
    expect(output).toContain("session=ready");
    expect(output).toContain("id: thread-1");
    expect(output).toContain("Parser (/srv/work/parser)");
  });

  it("sorts by most recently updated and applies the limit", () => {
    const output = formatThreadRows(
      readModel([
        thread({ id: "thread-1", title: "Older", updatedAt: "2026-09-21T10:00:00.000Z" }),
        thread({ id: "thread-2", title: "Newer", updatedAt: "2026-09-21T12:00:00.000Z" }),
        thread({ id: "thread-3", title: "Newest", updatedAt: "2026-09-21T13:00:00.000Z" }),
      ]),
      { limit: 2 },
    );

    expect(output.indexOf("Newest")).toBeLessThan(output.indexOf("Newer"));
    expect(output).not.toContain("Older");
  });

  it("filters by query on title or id", () => {
    const model = readModel([
      thread({ id: "thread-1", title: "Fix the parser" }),
      thread({ id: "aabbccdd", title: "Write tests" }),
    ]);

    expect(formatThreadRows(model, { query: "parser" })).toContain("Fix the parser");
    expect(formatThreadRows(model, { query: "parser" })).not.toContain("Write tests");
    expect(formatThreadRows(model, { query: "AABB" })).toContain("Write tests");
  });

  it("excludes deleted and archived threads", () => {
    const model = readModel([
      thread({ id: "thread-1", title: "Deleted", deletedAt: "2026-09-21T12:00:00.000Z" }),
      thread({ id: "thread-2", title: "Archived", archivedAt: "2026-09-21T12:00:00.000Z" }),
      thread({ id: "thread-3", title: "Live" }),
    ]);

    const output = formatThreadRows(model);
    expect(output).toContain("Live");
    expect(output).not.toContain("Deleted");
    expect(output).not.toContain("Archived");
  });

  it("reports when nothing matches", () => {
    expect(formatThreadRows(readModel([]))).toBe("(no threads exist)");
    expect(formatThreadRows(readModel([thread({})]), { query: "zzz" })).toBe(
      "(no threads match the query)",
    );
  });
});

describe("formatThreadDetail", () => {
  const snapshot: T3ThreadDetailSnapshot = {
    snapshotSequence: 99,
    thread: thread({
      title: "Fix the parser",
      latestTurn: {
        turnId: "turn-1",
        state: "error",
        requestedAt: "2026-09-21T11:00:00.000Z",
        startedAt: "2026-09-21T11:00:01.000Z",
        completedAt: "2026-09-21T11:05:00.000Z",
        assistantMessageId: null,
      },
      settledAt: "2026-09-21T11:05:01.000Z",
      session: {
        status: "error",
        providerName: "codex",
        activeTurnId: null,
        lastError: "provider exploded",
        updatedAt: "2026-09-21T11:05:00.000Z",
      },
      messages: [
        { id: "m1", role: "user", text: "Fix it", createdAt: "2026-09-21T11:00:00.000Z" },
        { id: "m2", role: "assistant", text: "Working", createdAt: "2026-09-21T11:00:02.000Z" },
      ],
      activities: [
        {
          id: "a1",
          tone: "error",
          kind: "runtime.error",
          summary: "Turn failed",
          payload: {},
          turnId: "turn-1",
          createdAt: "2026-09-21T11:05:00.000Z",
        },
      ],
    }),
  };

  it("renders the immediate state without needing new events", () => {
    const output = formatThreadDetail(snapshot);
    expect(output).toContain("Thread: Fix the parser");
    expect(output).toContain("id: thread-1");
    expect(output).toContain("turn=error session=error settled");
    expect(output).toContain("snapshot sequence 99");
    expect(output).toContain("Session error: provider exploded");
  });

  it("renders messages and activities up to the limits", () => {
    const output = formatThreadDetail(snapshot, 1, 5);
    expect(output).toContain("[assistant] Working");
    expect(output).not.toContain("[user] Fix it");
    expect(output).toContain("[runtime.error] Turn failed");
    expect(output).toContain("of 2");
  });

  it("handles threads with no turn or session", () => {
    const output = formatThreadDetail({
      snapshotSequence: 5,
      thread: thread({ latestTurn: null, session: null }),
    });
    expect(output).toContain("turn=no-turns session=no-session");
    expect(output).toContain("Last messages: (none)");
    expect(output).toContain("Recent activities: (none)");
  });
});

describe("formatUsageLimits", () => {
  const nowMs = Date.parse("2026-09-23T17:30:00.000Z");
  const config = {
    providers: [
      {
        instanceId: "codex",
        displayName: "Codex",
        status: "ready",
        enabled: true,
        auth: { label: "ChatGPT Plus Subscription" },
        usageLimits: {
          checkedAt: "2026-09-23T17:27:14.002Z",
          windows: [
            {
              id: "primary",
              kind: "session" as const,
              label: "Session",
              usedPercent: 93,
              windowDurationMins: 300,
              resetsAt: "2026-09-23T19:08:14.000Z",
            },
            {
              id: "secondary",
              kind: "weekly" as const,
              label: "Weekly",
              usedPercent: 28,
              windowDurationMins: 10080,
              resetsAt: "2026-09-29T15:08:47.000Z",
            },
          ],
          resetCredits: { availableCount: 1 },
        },
      },
      {
        instanceId: "claudeAgent",
        displayName: "Claude",
        status: "ready",
        enabled: true,
        usageLimits: {
          checkedAt: "2026-09-23T17:26:29.144Z",
          windows: [
            { id: "five_hour", kind: "session" as const, usedPercent: 100, resetsAt: "2026-09-23T19:00:00.008Z" },
            { id: "seven_day", kind: "weekly" as const, usedPercent: 53, resetsAt: "2026-09-26T15:00:00.008Z" },
          ],
        },
      },
      { instanceId: "opencode", displayName: "OpenCode", status: "ready", enabled: true },
    ],
  };

  it("reports session and weekly usage with reset times", () => {
    const output = formatUsageLimits(config, nowMs);
    expect(output).toContain("Codex (ChatGPT Plus Subscription)");
    expect(output).toContain("Session: 5h window 93% used, resets in 1h39m");
    expect(output).toContain("Weekly: 168h window 28% used, resets in 5d21h");
    expect(output).toContain("Session: 100% used, resets in 1h31m");
    expect(output).toContain("Weekly: 53% used, resets in 2d21h");
    expect(output).toContain("Reset credits available: 1");
  });

  it("lists providers without usage data and handles an empty config", () => {
    const output = formatUsageLimits(config, nowMs);
    expect(output).toContain("No usage data: OpenCode");
    expect(formatUsageLimits({}, nowMs)).toBe("(no usage limits reported)");
  });
});

describe("terminalEventTypes", () => {
  it("matches T3 v0.0.42 event vocabulary", () => {
    expect(terminalEventTypes.has("thread.settled")).toBe(true);
    expect(terminalEventTypes.has("thread.turn-diff-completed")).toBe(true);
    expect(terminalEventTypes.has("thread.session-stop-requested")).toBe(true);
    // Removed in v0.0.42; must not be treated as terminal anymore.
    expect(terminalEventTypes.has("thread.turn-completed")).toBe(false);
    expect(terminalEventTypes.has("thread.turn-failed")).toBe(false);
  });
});
