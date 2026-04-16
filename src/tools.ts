/**
 * MCP tool implementations for T3 Code.
 *
 * Tools exposed:
 *  - t3_send_prompt    — Start a new coding turn (create thread + dispatch turn.start)
 *  - t3_get_status     — Fetch the current thread snapshot / latest events
 *  - t3_interrupt      — Interrupt the currently running turn
 *  - t3_stop_session   — Stop the provider session for a thread
 *  - t3_get_config     — Retrieve server configuration (providers, models, settings)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { T3Client } from "./t3client.js";
import { randomUUID } from "crypto";

/** Build a CommandId (non-empty trimmed string; we use a UUID) */
function makeCommandId(): string {
  return randomUUID();
}

/** Build a ThreadId */
function makeThreadId(): string {
  return randomUUID();
}

/** Build a MessageId */
function makeMessageId(): string {
  return randomUUID();
}

/** Current ISO datetime */
function now(): string {
  return new Date().toISOString();
}

/** Default model selection (codex with o4-mini). Can be overridden by caller. */
const DEFAULT_MODEL_SELECTION = {
  provider: "codex",
  model: "o4-mini",
};

/**
 * Collect up to N events from a thread subscription, stopping after
 * `timeoutMs` or when the turn completes/errors.
 */
async function collectThreadEvents(
  client: T3Client,
  threadId: string,
  timeoutMs: number,
): Promise<unknown[]> {
  const events: unknown[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await client.subscribeThread(
      threadId,
      (item) => {
        events.push(item);
        // Stop collecting when turn finishes
        if (
          item &&
          typeof item === "object" &&
          "kind" in (item as Record<string, unknown>) &&
          (item as Record<string, unknown>).kind === "event"
        ) {
          const event = (item as Record<string, unknown>).event as Record<string, unknown>;
          if (
            event?.type === "thread.turn-diff-completed" ||
            event?.type === "thread.session-stop-requested"
          ) {
            controller.abort();
          }
        }
      },
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }

  return events;
}

/** Format events into a readable summary for the LLM */
function formatThreadEvents(events: unknown[]): string {
  if (events.length === 0) return "(no events captured)";

  const parts: string[] = [];
  for (const item of events) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;

    if (i.kind === "snapshot") {
      const snap = i.snapshot as Record<string, unknown> | null;
      if (snap) {
        parts.push(`[snapshot] status=${snap.status ?? "unknown"}`);
        const messages = snap.messages as unknown[] | null;
        if (Array.isArray(messages)) {
          for (const m of messages) {
            const msg = m as Record<string, unknown>;
            parts.push(`  [${msg.role}] ${String(msg.text ?? "").slice(0, 500)}`);
          }
        }
      }
    } else if (i.kind === "event") {
      const ev = i.event as Record<string, unknown>;
      if (ev?.type === "thread.message-sent") {
        const payload = ev.payload as Record<string, unknown>;
        const msg = payload?.message as Record<string, unknown> | null;
        if (msg) {
          parts.push(`[message] role=${msg.role} text=${String(msg.text ?? "").slice(0, 500)}`);
        }
      } else if (ev?.type === "thread.turn-diff-completed") {
        parts.push(`[turn completed]`);
      } else if (ev?.type === "thread.session-stop-requested") {
        parts.push(`[session stop requested]`);
      } else if (ev?.type) {
        parts.push(`[event] ${ev.type}`);
      }
    }
  }

  return parts.join("\n") || "(events captured but no readable content)";
}

export function registerTools(server: McpServer, client: T3Client): void {
  // ─── t3_send_prompt ──────────────────────────────────────────────────────
  server.tool(
    "t3_send_prompt",
    "Send a coding prompt to T3 Code. Creates a new thread and starts a turn. " +
      "Returns the thread ID and collected response events. " +
      "Use t3_get_status to poll for more events if needed.",
    {
      prompt: z.string().describe("The coding task or question to send to T3 Code"),
      projectId: z
        .string()
        .optional()
        .describe(
          "T3 Code project ID to use. If omitted, a new ephemeral project will be created " +
            "at the current working directory.",
        ),
      workspaceRoot: z
        .string()
        .optional()
        .describe(
          "Absolute path to the workspace root. Required when projectId is not provided.",
        ),
      model: z
        .string()
        .optional()
        .describe("Model slug to use (e.g. o4-mini, o3). Defaults to o4-mini."),
      provider: z
        .enum(["codex", "claudeAgent"])
        .optional()
        .describe("Provider kind. Defaults to codex."),
      waitMs: z
        .number()
        .optional()
        .describe(
          "How long (ms) to wait collecting response events before returning. Default 30000.",
        ),
    },
    async ({ prompt, projectId, workspaceRoot, model, provider, waitMs }) => {
      try {
        const resolvedProvider = provider ?? "codex";
        const resolvedModel = model ?? DEFAULT_MODEL_SELECTION.model;
        const resolvedWaitMs = waitMs ?? 30_000;

        // If no projectId given, create one
        let resolvedProjectId = projectId;
        if (!resolvedProjectId) {
          resolvedProjectId = randomUUID();
          const root = workspaceRoot ?? process.cwd();
          await client.dispatchCommand({
            type: "project.create",
            commandId: makeCommandId(),
            projectId: resolvedProjectId,
            title: `MCP session ${resolvedProjectId.slice(0, 8)}`,
            workspaceRoot: root,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: { provider: resolvedProvider, model: resolvedModel },
            createdAt: now(),
          });
        }

        const threadId = makeThreadId();

        // Create the thread
        await client.dispatchCommand({
          type: "thread.create",
          commandId: makeCommandId(),
          threadId,
          projectId: resolvedProjectId,
          title: prompt.slice(0, 80),
          modelSelection: { provider: resolvedProvider, model: resolvedModel },
          runtimeMode: "full-access",
          interactionMode: "default",
        });

        // Start the turn
        await client.dispatchCommand({
          type: "thread.turn.start",
          commandId: makeCommandId(),
          threadId,
          message: {
            messageId: makeMessageId(),
            role: "user",
            text: prompt,
            attachments: [],
          },
          modelSelection: { provider: resolvedProvider, model: resolvedModel },
          bootstrap: null,
        });

        // Collect events
        const events = await collectThreadEvents(client, threadId, resolvedWaitMs);
        const summary = formatThreadEvents(events);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Thread created: ${threadId}`,
                `Project: ${resolvedProjectId}`,
                "",
                "Response events:",
                summary,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
        };
      }
    },
  );

  // ─── t3_get_status ───────────────────────────────────────────────────────
  server.tool(
    "t3_get_status",
    "Subscribe to a T3 Code thread for a short time and collect recent events. " +
      "Use this to poll for progress on a running turn.",
    {
      threadId: z.string().describe("Thread ID returned by t3_send_prompt"),
      waitMs: z
        .number()
        .optional()
        .describe("How many ms to collect events (default 5000)"),
    },
    async ({ threadId, waitMs }) => {
      try {
        const events = await collectThreadEvents(client, threadId, waitMs ?? 5_000);
        const summary = formatThreadEvents(events);
        return {
          content: [
            {
              type: "text" as const,
              text: `Thread ${threadId} events:\n${summary}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
        };
      }
    },
  );

  // ─── t3_interrupt ────────────────────────────────────────────────────────
  server.tool(
    "t3_interrupt",
    "Interrupt the currently running turn in a T3 Code thread.",
    {
      threadId: z.string().describe("Thread ID to interrupt"),
      turnId: z.string().optional().describe("Specific turn ID to interrupt (optional)"),
    },
    async ({ threadId, turnId }) => {
      try {
        const result = await client.dispatchCommand({
          type: "thread.turn.interrupt",
          commandId: makeCommandId(),
          threadId,
          ...(turnId ? { turnId } : {}),
          createdAt: now(),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Interrupt dispatched. Sequence: ${(result as { sequence: number }).sequence}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
        };
      }
    },
  );

  // ─── t3_stop_session ─────────────────────────────────────────────────────
  server.tool(
    "t3_stop_session",
    "Stop the provider session for a T3 Code thread, terminating any running process.",
    {
      threadId: z.string().describe("Thread ID whose session to stop"),
    },
    async ({ threadId }) => {
      try {
        const result = await client.dispatchCommand({
          type: "thread.session.stop",
          commandId: makeCommandId(),
          threadId,
          createdAt: now(),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Session stop dispatched. Sequence: ${(result as { sequence: number }).sequence}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
        };
      }
    },
  );

  // ─── t3_get_config ───────────────────────────────────────────────────────
  server.tool(
    "t3_get_config",
    "Retrieve the T3 Code server configuration, including available providers, models, and settings.",
    {},
    async () => {
      try {
        const config = await client.getConfig();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(config, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
        };
      }
    },
  );
}
