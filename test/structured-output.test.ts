import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "../src/tools.js";
import type { T3Client, T3ThreadDetailSnapshot } from "../src/t3client.js";

const timestamp = "2026-10-01T12:00:00.000Z";
const longMessage = "full assistant reply ".repeat(100);
const snapshot: T3ThreadDetailSnapshot = {
  snapshotSequence: 77,
  thread: {
    id: "thread-1", projectId: "project-1", title: "Worker",
    runtimeMode: "full-access", interactionMode: "default",
    modelSelection: { instanceId: "opencode", model: "opencode-go/model" },
    branch: "feature", worktreePath: "/srv/work/feature",
    latestTurn: null, createdAt: timestamp, updatedAt: timestamp,
    archivedAt: null, deletedAt: null, settledOverride: null, settledAt: null,
    messages: [{ id: "message-1", role: "assistant", text: longMessage, createdAt: timestamp }],
    activities: [{ id: "activity-1", tone: "approval", kind: "approval.requested", summary: "Command approval requested",
      turnId: null, createdAt: timestamp,
      payload: { requestId: "req-1", requestKind: "command", detail: "npm test",
        options: [{ decision: "accept", label: "Accept" }, { decision: "decline", label: "Decline" }] } }],
    session: null,
  },
};
const project = { id: "project-1", title: "Project", workspaceRoot: "/srv/work/project", createdAt: timestamp, updatedAt: timestamp };
const config = {
  providers: [{ instanceId: "opencode", driver: "opencode", displayName: "OpenCode", enabled: true,
    models: [{ id: "opencode-go/model", capabilities: { optionDescriptors: [{ id: "variant", values: ["high"] }] } }],
    usageLimits: { checkedAt: timestamp, windows: [{ id: "go_weekly", kind: "weekly", label: "Go · Weekly", usedPercent: 28 }] },
  }],
  threadSnapshotPagination: true,
  futureField: { nested: [1, false, "keep"] },
};
const event = { kind: "event", event: {
  sequence: 78, type: "thread.message-sent", payload: { role: "assistant", text: longMessage, future: { keep: true } },
} };

const calls: Array<[string, Record<string, unknown>]> = [
  ["t3_list_threads", {}],
  ["t3_get_thread", { threadId: "thread-1" }],
  ["t3_rename_thread", { threadId: "thread-1", title: "Renamed" }],
  ["t3_send_prompt", { projectId: "project-1", prompt: "work", instanceId: "opencode", model: "opencode-go/model", waitMs: 50 }],
  ["t3_send_message", { threadId: "thread-1", prompt: "continue", waitMs: 50 }],
  ["t3_get_status", { threadId: "thread-1", waitMs: 50 }],
  ["t3_interrupt", { threadId: "thread-1", turnId: "turn-1" }],
  ["t3_stop_session", { threadId: "thread-1" }],
  ["t3_settle_thread", { threadId: "thread-1" }],
  ["t3_wait", { threadIds: ["thread-1"], timeoutMs: 1000 }],
  ["t3_respond", { threadId: "thread-1", requestId: "req-1", decision: "accept" }],
  ["t3_get_usage_limits", {}],
  ["t3_get_config", {}],
];

function expectJsonMirror(result: CallToolResult): void {
  expect(result.structuredContent).toBeDefined();
  expect(result.content).toHaveLength(1);
  const content = result.content[0];
  expect(content.type).toBe("text");
  if (content.type !== "text") throw new Error("Expected JSON text");
  expect(JSON.parse(content.text)).toEqual(result.structuredContent);
}

describe("MCP structured output over a real client transport", () => {
  let server: McpServer;
  let client: Client;
  let upstream: ReturnType<typeof makeUpstream>;

  function makeUpstream() {
    return {
      getConfig: vi.fn(async () => config),
      getReadModel: vi.fn(async () => ({ projects: [project], threads: [snapshot.thread], snapshotSequence: 77, updatedAt: timestamp })),
      getThreadSnapshot: vi.fn(async (id: string) => ({ ...snapshot, thread: { ...snapshot.thread, id } })),
      dispatchCommand: vi.fn(async (_command: unknown) => ({ sequence: 78 })),
      subscribeThread: vi.fn(async (_id: string, onItem: (item: unknown) => void) => {
        onItem({ kind: "synchronized" });
        onItem(event);
        onItem({ kind: "event", event: { sequence: 79, type: "thread.settled", payload: {} } });
      }),
      // An idle thread with no turns needs attention at once; tests can replace it.
      subscribeShell: vi.fn((onItem: (item: unknown) => void, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
          onItem({ kind: "snapshot", snapshot: { snapshotSequence: 77, threads: [{ ...snapshot.thread, session: null }] } });
        })),
    };
  }

  beforeEach(async () => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    upstream = makeUpstream();
    registerTools(server, upstream as unknown as T3Client, { antigravityCli: null, timeoutMs: 1000 });
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  }

  it("advertises an object output schema for every registered tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(calls.map(([name]) => name).sort());
    for (const tool of tools) {
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(Object.keys(tool.outputSchema?.properties ?? {}).length, tool.name).toBeGreaterThan(0);
    }
  });

  it.each(calls)("%s validates its successful output and mirrors JSON text", async (name, args) => {
    // SDK Client.callTool validates structuredContent against tools/list outputSchema.
    const result = await call(name, args);
    expect(result.isError).not.toBe(true);
    expectJsonMirror(result);
    if (name === "t3_get_config") expect(result.structuredContent).toEqual({ config });
    if (["t3_get_status", "t3_get_thread"].includes(name)) {
      expect(result.structuredContent?.lastAssistantMessage).toBe(longMessage);
    }
    if (["t3_get_status", "t3_send_prompt", "t3_send_message"].includes(name)) {
      expect(result.structuredContent?.events).toContainEqual(event);
    }
  });

  it.each(calls)("%s returns structured upstream errors", async (name, args) => {
    const failure = new Error("Upstream unavailable");
    upstream.getConfig.mockRejectedValue(failure);
    upstream.getReadModel.mockRejectedValue(failure);
    upstream.getThreadSnapshot.mockRejectedValue(failure);
    upstream.dispatchCommand.mockRejectedValue(failure);
    upstream.subscribeShell.mockRejectedValue(failure);
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expectJsonMirror(result);
    expect(result.structuredContent).toEqual({ error: { message: "Upstream unavailable" } });
  });

  it.each([
    ["t3_get_thread", { threadId: "" }],
    ["t3_interrupt", { threadId: "thread-1", turnId: 123 }],
    ["t3_send_prompt", { prompt: "work" }],
    ["t3_get_status", { threadId: "thread-1", waitMs: -1 }],
    ["t3_settle_thread", { threadId: "thread-1", settled: "yes" }],
  ] as Array<[string, Record<string, unknown>]>)("%s returns structured validation errors without upstream calls", async (name, args) => {
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expectJsonMirror(result);
    expect(result.structuredContent?.error).toMatchObject({ message: expect.any(String) });
    for (const method of Object.values(upstream)) expect(method).not.toHaveBeenCalled();
  });

  it("returns structured errors for unknown tools", async () => {
    const result = await client.request({ method: "tools/call", params: { name: "missing", arguments: {} } }, CallToolResultSchema);
    expectJsonMirror(result);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { message: "Tool missing not found" } });
  });

  it("returns a structured error if an upstream payload violates the output schema", async () => {
    upstream.dispatchCommand.mockResolvedValue({ sequence: -1 });
    const result = await call("t3_stop_session", { threadId: "thread-1" });
    expect(result.isError).toBe(true);
    expectJsonMirror(result);
  });

  it.each(["t3_get_status", "t3_send_prompt", "t3_send_message"])("%s skips streaming with waitMs=0", async (name) => {
    const args = calls.find(([tool]) => tool === name)![1];
    const result = await call(name, { ...args, waitMs: 0 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.events).toEqual([]);
    expect(upstream.subscribeThread).not.toHaveBeenCalled();
  });

  it("keeps follow-up events and marks state unknown if the post-dispatch snapshot fails", async () => {
    upstream.getThreadSnapshot.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("Snapshot unavailable"));
    const result = await call("t3_send_message", { threadId: "thread-1", prompt: "continue", waitMs: 50 });
    expect(result.isError).not.toBe(true);
    expectJsonMirror(result);
    expect(result.structuredContent).toMatchObject({ sequence: 78, snapshotAvailable: false, snapshotSequence: null, turnState: "unknown", sessionStatus: "unknown" });
    expect(result.structuredContent?.events).toContainEqual(event);
  });

  it("creates an isolated worktree with the v0.0.44 bootstrap shape", async () => {
    const result = await call("t3_send_prompt", {
      projectId: "project-1", prompt: "work", instanceId: "opencode", model: "opencode-go/model",
      modelOptions: { variant: "high" }, baseBranch: "main", branch: "worker", waitMs: 0,
    });
    expect(result.isError).not.toBe(true);
    expect(upstream.dispatchCommand).toHaveBeenCalledTimes(1);
    expect(upstream.dispatchCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "thread.turn.start",
      modelSelection: { instanceId: "opencode", model: "opencode-go/model", options: { variant: "high" } },
      bootstrap: expect.objectContaining({
        prepareWorktree: { projectCwd: project.workspaceRoot, baseBranch: "main", branch: "worker" },
        runSetupScript: true,
      }),
    }));
    expect(result.structuredContent).toMatchObject({ sequence: 78, worktreePath: snapshot.thread.worktreePath, snapshotAvailable: true });
  });

  it("streams progress keepalives during t3_wait and honors client cancellation", async () => {
    upstream.subscribeShell.mockImplementation((onItem: (item: unknown) => void, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
        onItem({ kind: "snapshot", snapshot: { snapshotSequence: 77, threads: [{ ...snapshot.thread,
          latestTurn: { turnId: "turn-1", state: "running", requestedAt: timestamp, startedAt: timestamp,
            completedAt: null, assistantMessageId: null },
          session: { status: "running", activeTurnId: "turn-1", lastError: null } }] } });
      }));
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const progress: number[] = [];
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "t3_wait", arguments: { threadIds: ["thread-1"], timeoutMs: 120_000 } },
      undefined,
      { signal: controller.signal, onprogress: (value) => progress.push(value.progress), timeout: 200_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await vi.advanceTimersByTimeAsync(65_000);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(progress.length).toBeGreaterThanOrEqual(2);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upstream.subscribeShell).toHaveBeenCalledTimes(1);
  });

  it("acknowledges unsettle with the same lifecycle result shape", async () => {
    const result = await call("t3_settle_thread", { threadId: "thread-1", settled: false });
    expect(result.structuredContent).toEqual({ threadId: "thread-1", action: "thread.unsettle", sequence: 78 });
    expect(upstream.dispatchCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.unsettle", reason: "user" }));
  });
});
