import { describe, expect, it, vi } from "vitest";
import { registerTools } from "../src/tools.js";
import type { UsageProbeOptions } from "../src/usage.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}>;

const usageOptions: UsageProbeOptions = {
  antigravityCli: null,
  timeoutMs: 1000,
};

function captureTools(client: unknown): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const fakeServer = {
    server: { setRequestHandler: vi.fn() },
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

function fakeClient(dispatch?: (command: unknown) => Promise<{ sequence: number }>) {
  const dispatched: unknown[] = [];
  return {
    dispatched,
    client: {
      dispatchCommand: vi.fn(async (command: unknown) => {
        dispatched.push(command);
        return dispatch ? dispatch(command) : { sequence: 42 };
      }),
    },
  };
}

describe("t3_settle_thread", () => {
  it("dispatches thread.settle by default", async () => {
    const { client, dispatched } = fakeClient();
    const result = await captureTools(client).get("t3_settle_thread")!({ threadId: "thread-1" });

    expect(dispatched).toHaveLength(1);
    const command = dispatched[0] as Record<string, unknown>;
    expect(Object.keys(command).sort()).toEqual(["commandId", "threadId", "type"]);
    expect(command.type).toBe("thread.settle");
    expect(command.threadId).toBe("thread-1");
    expect(typeof command.commandId).toBe("string");
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ threadId: "thread-1", action: "thread.settle", sequence: 42 });
    expect(result.content[0].text).toContain("42");
  });

  it("dispatches thread.unsettle with reason user when settled is false", async () => {
    const { client, dispatched } = fakeClient();
    const result = await captureTools(client).get("t3_settle_thread")!({
      threadId: "thread-1",
      settled: false,
    });

    const command = dispatched[0] as Record<string, unknown>;
    expect(Object.keys(command).sort()).toEqual(["commandId", "reason", "threadId", "type"]);
    expect(command.type).toBe("thread.unsettle");
    expect(command.reason).toBe("user");
    expect(JSON.parse(result.content[0].text)).toEqual({ threadId: "thread-1", action: "thread.unsettle", sequence: 42 });
  });

  it("returns the server's refusal as a tool error", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("OrchestrationThreadSettleBlockedError: session is running");
    });
    const result = await captureTools(client).get("t3_settle_thread")!({ threadId: "thread-1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("OrchestrationThreadSettleBlockedError");
  });
});
