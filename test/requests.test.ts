import { describe, expect, it, vi } from "vitest";
import { openRequests } from "../src/requests.js";
import { registerTools } from "../src/tools.js";
import type { T3Activity } from "../src/t3client.js";

let n = 0;
function activity(kind: string, payload: Record<string, unknown>): T3Activity {
  n += 1;
  return { id: `a${n}`, tone: "info", kind, summary: kind, payload, turnId: null, createdAt: `2026-10-04T00:00:${String(n).padStart(2, "0")}.000Z` };
}

const approval = activity("approval.requested", {
  requestId: "r1", requestKind: "mcp-elicitation", detail: 'Allow the t3code MCP server to run tool "t3_get_config"?',
  options: [{ decision: "cancel", label: "Cancel" }, { decision: "decline", label: "Decline" },
    { decision: "acceptForSession", label: "Always allow this session" }, { decision: "acceptAlways", label: "Always allow" }],
});
const question = activity("user-input.requested", {
  requestId: "q1",
  questions: [{ id: "scope", header: "Scope", question: "Which file?", allowCustomAnswer: true,
    options: [{ label: "README.md", description: "Top level" }] }],
});

describe("openRequests", () => {
  it("lists open approvals and questions with their offered choices", () => {
    const open = openRequests([approval, question]);
    expect(open.map((request) => [request.requestId, request.kind])).toEqual([["r1", "approval"], ["q1", "user-input"]]);
    expect(open[0].decisions).toEqual(["cancel", "decline", "acceptForSession", "acceptAlways"]);
    expect(open[0].detail).toContain("t3_get_config");
    expect(open[1].questions[0]).toMatchObject({ id: "scope", question: "Which file?", allowCustomAnswer: true });
  });

  it("drops resolved requests and stale failures, but keeps other failures", () => {
    expect(openRequests([approval, activity("approval.resolved", { requestId: "r1" })])).toEqual([]);
    expect(openRequests([question, activity("provider.user-input.respond.failed",
      { requestId: "q1", detail: "Unknown pending user-input request" })])).toEqual([]);
    expect(openRequests([approval, activity("provider.approval.respond.failed",
      { requestId: "r1", detail: "transport error" })])).toHaveLength(1);
  });
});

function tools(activities: T3Activity[]) {
  const dispatched: Array<Record<string, unknown>> = [];
  const client = {
    getThreadSnapshot: vi.fn(async () => ({ snapshotSequence: 1, thread: { id: "t1", activities } })),
    dispatchCommand: vi.fn(async (command: Record<string, unknown>) => (dispatched.push(command), { sequence: 9 })),
  };
  const registered = new Map<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
  registerTools({ registerTool: (name: string, _c: unknown, handler: never) => registered.set(name, handler),
    server: { setRequestHandler: vi.fn() } } as never, client as never, { antigravityCli: null, timeoutMs: 1000 });
  return { respond: registered.get("t3_respond")!, dispatched };
}

describe("t3_respond", () => {
  it("approves with an offered decision", async () => {
    const { respond, dispatched } = tools([approval]);
    const result = await respond({ threadId: "t1", requestId: "r1", decision: "acceptForSession" });
    expect(result.isError).toBeUndefined();
    expect(dispatched[0]).toMatchObject({ type: "thread.approval.respond", threadId: "t1", requestId: "r1", decision: "acceptForSession" });
  });

  it("refuses a decision the provider did not offer, a closed request, or a wrong shape", async () => {
    const { respond, dispatched } = tools([approval]);
    expect((await respond({ threadId: "t1", requestId: "r1", decision: "accept" })).isError).toBe(true);
    expect((await respond({ threadId: "t1", requestId: "gone", decision: "decline" })).isError).toBe(true);
    expect((await respond({ threadId: "t1", requestId: "r1" })).isError).toBe(true);
    expect((await respond({ threadId: "t1", requestId: "r1", decision: "decline", answers: { x: 1 } })).isError).toBe(true);
    expect(dispatched).toHaveLength(0);
  });

  it("answers or dismisses a question by question id", async () => {
    const { respond, dispatched } = tools([question]);
    expect((await respond({ threadId: "t1", requestId: "q1", answers: { other: "x" } })).isError).toBe(true);
    expect((await respond({ threadId: "t1", requestId: "q1", decision: "accept" })).isError).toBe(true);
    expect((await respond({ threadId: "t1", requestId: "q1", answers: { scope: "README.md" } })).isError).toBeUndefined();
    expect((await respond({ threadId: "t1", requestId: "q1", dismiss: true })).isError).toBeUndefined();
    expect(dispatched.map((command) => command.type)).toEqual(["thread.user-input.respond", "thread.user-input.dismiss"]);
    expect(dispatched[0].answers).toEqual({ scope: "README.md" });
  });
});

describe("t3_get_config compact view", () => {
  it("returns only dispatch fields, filtered by instance", async () => {
    const config = {
      keybindings: [{ big: true }],
      providers: [
        { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, status: "ready", skills: ["x"],
          models: [{ slug: "gpt-6-luna", name: "GPT-6 Luna", isCustom: false, capabilities: { optionDescriptors: [
            { id: "reasoningEffort", type: "select", label: "Reasoning", currentValue: "low",
              options: [{ id: "low", label: "Low", isDefault: true }, { id: "high", label: "High" }] }] } }] },
        { instanceId: "opencode", driver: "opencode", enabled: true, status: "ready", models: [] },
      ],
    };
    const registered = new Map<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
    registerTools({ registerTool: (name: string, _c: unknown, handler: never) => registered.set(name, handler),
      server: { setRequestHandler: vi.fn() } } as never, { getConfig: vi.fn(async () => config) } as never,
      { antigravityCli: null, timeoutMs: 1000 });
    const result = await registered.get("t3_get_config")!({ view: "providers", instanceIds: ["codex"] });
    expect(result.structuredContent).toEqual({ config: { providers: [{
      instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, status: "ready",
      models: [{ slug: "gpt-6-luna", name: "GPT-6 Luna",
        options: [{ id: "reasoningEffort", type: "select", values: ["low", "high"], default: "low" }] }],
    }] } });
    const full = await registered.get("t3_get_config")!({});
    expect((full.structuredContent as { config: Record<string, unknown> }).config.keybindings).toBeDefined();
  });
});

describe("argument names", () => {
  it("rejects an unknown argument and lists the valid ones", async () => {
    const registered = new Map<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>();
    const client = { getThreadSnapshot: vi.fn(), dispatchCommand: vi.fn() };
    registerTools({ registerTool: (name: string, _c: unknown, handler: never) => registered.set(name, handler),
      server: { setRequestHandler: vi.fn() } } as never, client as never, { antigravityCli: null, timeoutMs: 1000 });
    const result = await registered.get("t3_send_message")!({ threadId: "t1", prompt: "go", timeoutMs: 1000 });
    expect(result.isError).toBe(true);
    const message = (result.structuredContent as { error: { message: string } }).error.message;
    expect(message).toContain("Unknown argument for t3_send_message: timeoutMs");
    expect(message).toContain("waitTimeoutMs");
    expect(client.dispatchCommand).not.toHaveBeenCalled();
  });
});
