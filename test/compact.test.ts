import { describe, expect, it, vi } from "vitest";
import { contextWindow } from "../src/context.js";
import { registerTools } from "../src/tools.js";
import type { T3Activity, T3ThreadDetailSnapshot } from "../src/t3client.js";

const usage = (createdAt: string, payload: Record<string, unknown>): T3Activity => ({
  id: `usage-${createdAt}`, tone: "info", kind: "context-window.updated", summary: "Context window updated",
  payload, turnId: null, createdAt,
});
const compacted = (createdAt: string, beforeTokens: number, afterTokens: number, requestId = "m0"): T3Activity => ({
  id: `compaction-${createdAt}`, tone: "info", kind: "context-compaction", summary: "Compacted context",
  payload: { state: "compacted", beforeTokens, afterTokens, requestId }, turnId: "turn-2", createdAt,
});

describe("contextWindow", () => {
  it("returns null without usage reports", () => {
    expect(contextWindow([])).toBeNull();
  });

  it("reports the latest usage with percent and remaining tokens", () => {
    const window = contextWindow([
      usage("2026-10-04T10:00:00.000Z", { usedTokens: 50_000, maxTokens: 200_000 }),
      usage("2026-10-04T10:05:00.000Z", { usedTokens: 150_000, maxTokens: 200_000, compactsAutomatically: true }),
    ]);
    expect(window).toMatchObject({
      usedTokens: 150_000, maxTokens: 200_000, usedPercent: 75, remainingTokens: 50_000,
      compactsAutomatically: true, updatedAt: "2026-10-04T10:05:00.000Z", lastCompaction: null,
    });
  });

  it("keeps the last reported window size when a later report omits it", () => {
    const window = contextWindow([
      usage("2026-10-04T10:00:00.000Z", { usedTokens: 10, maxTokens: 100 }),
      usage("2026-10-04T10:01:00.000Z", { usedTokens: 20 }),
    ]);
    expect(window?.usedPercent).toBe(20);
  });

  it("uses a newer compaction's size (Claude reports usage after it)", () => {
    const window = contextWindow([
      usage("2026-10-04T10:00:00.000Z", { usedTokens: 24_774, maxTokens: 200_000 }),
      compacted("2026-10-04T10:01:00.000Z", 24_775, 2_817),
    ]);
    expect(window).toMatchObject({ usedTokens: 2_817, usedPercent: 1.4 });
    expect(window?.lastCompaction).toEqual({ at: "2026-10-04T10:01:00.000Z", beforeTokens: 24_775, afterTokens: 2_817 });
  });

  it("keeps a usage report newer than the compaction", () => {
    const window = contextWindow([
      compacted("2026-10-04T10:01:00.000Z", 180_000, 20_000),
      usage("2026-10-04T10:02:00.000Z", { usedTokens: 35_000, maxTokens: 258_400 }),
    ]);
    expect(window?.usedTokens).toBe(35_000);
  });
});

function snapshotWith(overrides: Partial<T3ThreadDetailSnapshot["thread"]>): T3ThreadDetailSnapshot {
  return {
    snapshotSequence: 20,
    thread: {
      id: "t1", projectId: "p1", title: "Worker", runtimeMode: "full-access", interactionMode: "default",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
      branch: null, worktreePath: null,
      latestTurn: { turnId: "turn-1", state: "completed", requestedAt: "2026-10-04T09:00:00.000Z", startedAt: null,
        completedAt: "2026-10-04T10:00:00.000Z", assistantMessageId: null },
      createdAt: "", updatedAt: "", archivedAt: null, settledOverride: null, settledAt: null, deletedAt: null,
      messages: [{ id: "m1", role: "user", text: "Do the task.", createdAt: "2026-10-04T09:00:00.000Z" }],
      activities: [usage("2026-10-04T10:00:00.000Z", { usedTokens: 180_000, maxTokens: 200_000 })],
      session: { status: "ready", providerName: "claudeAgent", activeTurnId: null, lastError: null, updatedAt: "" },
      ...overrides,
    },
  };
}

/** A fake T3 whose shell reports the thread idle and whose snapshots follow `after` once dispatched. */
function fakeT3(after?: (messageId: string) => Partial<T3ThreadDetailSnapshot["thread"]>) {
  const dispatched: Array<{ message: { messageId: string; text: string } }> = [];
  return {
    dispatched,
    getThreadSnapshot: vi.fn(async () => {
      const sent = dispatched.at(-1);
      return snapshotWith(sent && after ? after(sent.message.messageId) : {});
    }),
    dispatchCommand: vi.fn(async (command: never) => (dispatched.push(command), { sequence: 21 })),
    subscribeShell: vi.fn((onItem: (item: unknown) => void, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
        onItem({ kind: "snapshot", snapshot: { snapshotSequence: 30, threads: [snapshotWith({}).thread] } });
      })),
  };
}

function compactTool(client: unknown) {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
  const fakeServer = {
    server: { setRequestHandler: vi.fn() },
    registerTool: (name: string, _config: unknown, handler: never) => tools.set(name, handler),
  };
  registerTools(fakeServer as never, client as never, { antigravityCli: null, timeoutMs: 1000 });
  return tools.get("t3_compact_thread")!;
}

describe("t3_compact_thread", () => {
  it("sends /compact and reports the provider's before and after sizes", async () => {
    const t3 = fakeT3((messageId) => ({
      activities: [
        usage("2026-10-04T10:00:00.000Z", { usedTokens: 180_000, maxTokens: 200_000 }),
        compacted("2026-10-04T10:02:00.000Z", 180_000, 12_000, messageId),
      ],
    }));
    const result = await compactTool(t3)({ threadId: "t1", minUsedPercent: 80, waitTimeoutMs: 2000 });
    expect(result.isError).toBeUndefined();
    expect(t3.dispatched).toHaveLength(1);
    expect(t3.dispatched[0].message.text).toBe("/compact");
    expect(result.structuredContent).toMatchObject({
      status: "compacted", sequence: 21,
      before: { usedPercent: 90 }, after: { usedTokens: 12_000, usedPercent: 6 },
      compaction: { beforeTokens: 180_000, afterTokens: 12_000 },
    });
  });

  it("skips a thread below minUsedPercent without dispatching", async () => {
    const t3 = fakeT3();
    const result = await compactTool(t3)({ threadId: "t1", minUsedPercent: 95 });
    expect(result.structuredContent).toMatchObject({ status: "skipped", sequence: null });
    expect((result.structuredContent as { reason: string }).reason).toContain("90%");
    expect(t3.dispatchCommand).not.toHaveBeenCalled();
  });

  it("skips minUsedPercent when the provider reports no window size", async () => {
    const t3 = { ...fakeT3(), getThreadSnapshot: vi.fn(async () => snapshotWith({ activities: [] })) };
    const result = await compactTool(t3)({ threadId: "t1", minUsedPercent: 50 });
    expect(result.structuredContent).toMatchObject({ status: "skipped", before: null });
    expect(t3.dispatchCommand).not.toHaveBeenCalled();
  });

  it("skips a thread without a conversation, which T3 cannot compact", async () => {
    const t3 = { ...fakeT3(), getThreadSnapshot: vi.fn(async () => snapshotWith({ messages: [] })) };
    const result = await compactTool(t3)({ threadId: "t1" });
    expect(result.structuredContent).toMatchObject({ status: "skipped" });
    expect(t3.dispatchCommand).not.toHaveBeenCalled();
  });

  it("refuses a running turn", async () => {
    const t3 = {
      ...fakeT3(),
      getThreadSnapshot: vi.fn(async () => snapshotWith({
        latestTurn: { turnId: "turn-1", state: "running", requestedAt: "2026-10-04T09:00:00.000Z", startedAt: null, completedAt: null,
          assistantMessageId: null },
      })),
    };
    const result = await compactTool(t3)({ threadId: "t1" });
    expect(result.isError).toBe(true);
    expect(t3.dispatchCommand).not.toHaveBeenCalled();
  });

  it("reports T3's compaction failure", async () => {
    const t3 = fakeT3((messageId) => ({
      activities: [{ id: "f1", tone: "error", kind: "provider.turn.start.failed", summary: "Context compaction failed",
        payload: { detail: "Provider did not finish context compaction.", requestId: messageId },
        turnId: null, createdAt: "2026-10-04T10:02:00.000Z" }],
    }));
    const result = await compactTool(t3)({ threadId: "t1", waitTimeoutMs: 2000 });
    expect(result.structuredContent).toMatchObject({
      status: "failed", reason: "Context compaction failed: Provider did not finish context compaction.",
    });
  });

  it("waits for a compaction row that T3 records just after the turn ends", async () => {
    let reads = 0;
    const t3 = fakeT3((messageId) => ({
      activities: (reads += 1) < 4 ? [] : [compacted("2026-10-04T10:02:00.000Z", 180_000, 12_000, messageId)],
    }));
    const result = await compactTool(t3)({ threadId: "t1", waitTimeoutMs: 2000 });
    expect(result.structuredContent).toMatchObject({ status: "compacted", after: { usedTokens: 12_000 } });
  });

  it("passes on the provider's reply when it compacted nothing", async () => {
    const t3 = fakeT3((messageId) => ({
      messages: [
        { id: "m1", role: "user", text: "Do the task.", createdAt: "2026-10-04T09:00:00.000Z" },
        { id: messageId, role: "user", text: "/compact", createdAt: "2026-10-04T10:01:00.000Z" },
        { id: "m3", role: "assistant", text: "Not enough messages to compact.", createdAt: "2026-10-04T10:01:02.000Z" },
      ],
      activities: [{ id: "c1", tone: "info", kind: "context-compaction", summary: "Context compacted",
        payload: { state: "compacted", requestId: messageId }, turnId: null, createdAt: "2026-10-04T10:01:02.000Z" }],
    }));
    const result = await compactTool(t3)({ threadId: "t1", waitTimeoutMs: 2000 });
    expect(result.structuredContent).toMatchObject({
      status: "compacted", reason: "Provider reply: Not enough messages to compact.",
      compaction: { beforeTokens: null, afterTokens: null },
    });
  });

  it("returns at once with wait=false", async () => {
    const t3 = fakeT3();
    const result = await compactTool(t3)({ threadId: "t1", wait: false });
    expect(result.structuredContent).toMatchObject({ status: "started", sequence: 21, after: null });
    expect(t3.subscribeShell).not.toHaveBeenCalled();
  });
});
