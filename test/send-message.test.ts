import { describe, expect, it, vi } from "vitest";
import { registerTools } from "../src/tools.js";
import type { T3ThreadDetailSnapshot } from "../src/t3client.js";
import type { UsageProbeOptions } from "../src/usage.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

const usageOptions: UsageProbeOptions = {
  antigravityCli: null,
  opencodeGoApiKey: null,
  opencodeGoUsageUrl: "",
  timeoutMs: 1000,
};

function snapshotFixture(
  threadOverrides: Partial<T3ThreadDetailSnapshot["thread"]> = {},
): T3ThreadDetailSnapshot {
  return {
    snapshotSequence: 77,
    thread: {
      id: "thread-existing",
      projectId: "project-1",
      title: "Worker",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
      branch: "feature-x",
      worktreePath: "/srv/work/wt-1",
      latestTurn: null,
      createdAt: "2026-09-21T11:00:00.000Z",
      updatedAt: "2026-09-21T11:30:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      activities: [],
      session: null,
      ...threadOverrides,
    },
  };
}

function captureTools(client: unknown): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const fakeServer = {
    tool: (name: string, ...rest: unknown[]) => {
      tools.set(name, rest[rest.length - 1] as ToolHandler);
    },
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerTools(fakeServer as never, client as never, usageOptions);
  return tools;
}

function fakeClient(overrides: Record<string, unknown> = {}, snapshot = snapshotFixture()) {
  const dispatched: unknown[] = [];
  const subscribeCalls: Array<{ threadId: string; afterSequence?: number }> = [];
  return {
    dispatched,
    subscribeCalls,
    snapshot,
    client: {
      getThreadSnapshot: vi.fn(async (threadId: string) => {
        if (threadId !== snapshot.thread.id) {
          throw new Error(`T3 Code /api/orchestration/threads/${threadId} failed (404): thread not found`);
        }
        return snapshot;
      }),
      dispatchCommand: vi.fn(async (command: unknown) => {
        dispatched.push(command);
        return { sequence: 123 };
      }),
      subscribeThread: vi.fn(
        async (
          threadId: string,
          onItem: (item: unknown) => void,
          _signal?: AbortSignal,
          afterSequence?: number,
        ) => {
          subscribeCalls.push({ threadId, afterSequence });
          onItem({ kind: "snapshot", snapshot: { thread: { session: { status: "ready" }, messages: [] } } });
          onItem({
            kind: "event",
            event: { type: "thread.message-sent", payload: { role: "assistant", text: "done" } },
          });
          onItem({ kind: "event", event: { type: "thread.settled", payload: {} } });
        },
      ),
      ...overrides,
    } as never,
  };
}

describe("t3_send_message", () => {
  it("is registered alongside t3_send_prompt", () => {
    const { client } = fakeClient();
    const tools = captureTools(client);
    expect(tools.has("t3_send_message")).toBe(true);
    expect(tools.has("t3_send_prompt")).toBe(true);
  });

  it("targets the supplied thread and dispatches thread.turn.start without creates", async () => {
    const { client, dispatched } = fakeClient();
    const tools = captureTools(client);
    const result = await tools.get("t3_send_message")!({
      threadId: "thread-existing",
      prompt: "continue",
      waitMs: 0,
    });

    expect(dispatched).toHaveLength(1);
    const command = dispatched[0] as Record<string, unknown>;
    expect(command.type).toBe("thread.turn.start");
    expect(command.threadId).toBe("thread-existing");
    const message = command.message as Record<string, unknown>;
    expect(message.role).toBe("user");
    expect(message.text).toBe("continue");
    const types = dispatched.map((c) => (c as Record<string, unknown>).type);
    expect(types).not.toContain("thread.create");
    expect(types).not.toContain("project.create");
    expect(result.content[0].text).toContain("thread-existing");
    expect(result.content[0].text.toLowerCase()).toContain("sent");
  });

  it("reuses runtime/interaction mode and omits modelSelection so the thread keeps its own model", async () => {
    const { client, dispatched, snapshot } = fakeClient();
    const tools = captureTools(client);
    await tools.get("t3_send_message")!({
      threadId: "thread-existing",
      prompt: "continue",
      waitMs: 0,
    });

    const command = dispatched[0] as Record<string, unknown>;
    expect(command.runtimeMode).toBe(snapshot.thread.runtimeMode);
    expect(command.interactionMode).toBe(snapshot.thread.interactionMode);
    // Placement and model stay implicit to the thread: no bootstrap/placement fields.
    expect(command).not.toHaveProperty("modelSelection");
    expect(command).not.toHaveProperty("bootstrap");
    expect(command).not.toHaveProperty("branch");
    expect(command).not.toHaveProperty("worktreePath");
    expect(command).not.toHaveProperty("projectId");
  });

  it("returns structuredContent with the turn state after dispatch", async () => {
    const { client } = fakeClient();
    const tools = captureTools(client);
    const result = await tools.get("t3_send_message")!({
      threadId: "thread-existing",
      prompt: "continue",
      waitMs: 0,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      threadId: "thread-existing",
      projectId: "project-1",
      branch: "feature-x",
      worktreePath: "/srv/work/wt-1",
    });
  });

  it("collects response events in the same format used elsewhere", async () => {
    const { client, subscribeCalls } = fakeClient();
    const tools = captureTools(client);
    const result = await tools.get("t3_send_message")!({
      threadId: "thread-existing",
      prompt: "continue",
      waitMs: 50,
    });

    expect(subscribeCalls).toHaveLength(1);
    expect(subscribeCalls[0]).toMatchObject({ threadId: "thread-existing", afterSequence: 77 });
    const text = result.content[0].text;
    expect(text).toContain("Response events:");
    expect(text).toContain("[snapshot]");
    expect(text).toContain("[message] role=assistant text=done");
    expect(text).toContain("[event] thread.settled");
  });

  it("refuses a thread with a running turn", async () => {
    const snapshot = snapshotFixture({
      latestTurn: {
        turnId: "turn-1",
        state: "running",
        requestedAt: "2026-09-21T11:00:00.000Z",
        startedAt: "2026-09-21T11:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const { client, dispatched } = fakeClient({}, snapshot);
    const tools = captureTools(client);
    const result = await tools.get("t3_send_message")!({
      threadId: "thread-existing",
      prompt: "continue",
      waitMs: 0,
    });

    expect(dispatched).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("turn-1");
    expect(result.content[0].text.toLowerCase()).toContain("running");
  });

  it("refuses a deleted thread", async () => {
    const snapshot = snapshotFixture({ deletedAt: "2026-09-22T00:00:00.000Z" });
    const { client, dispatched } = fakeClient({}, snapshot);
    const tools = captureTools(client);
    const result = await tools.get("t3_send_message")!({
      threadId: "thread-existing",
      prompt: "continue",
      waitMs: 0,
    });

    expect(dispatched).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain("deleted");
  });

  it("returns a useful error for unknown thread IDs", async () => {
    const { client } = fakeClient();
    const tools = captureTools(client);
    const result = await tools.get("t3_send_message")!({
      threadId: "thread-nope",
      prompt: "continue",
      waitMs: 0,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("thread-nope");
    expect(result.content[0].text).toMatch(/404|not found/i);
  });
});
