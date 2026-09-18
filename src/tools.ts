/**
 * MCP tool implementations for T3 Code v0.0.40.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { T3Client } from "./t3client.js";

function now(): string {
  return new Date().toISOString();
}

function commandId(): string {
  return randomUUID();
}

const terminalEventTypes = new Set([
  "thread.turn-diff-completed",
  "thread.session-stop-requested",
  "thread.turn-completed",
  "thread.turn-failed",
]);

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
        if (!item || typeof item !== "object") return;

        const record = item as Record<string, unknown>;
        if (record.kind !== "event") return;

        const event = record.event as Record<string, unknown> | undefined;
        if (event?.type && terminalEventTypes.has(String(event.type))) {
          controller.abort();
        }
      },
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }

  return events;
}

function formatThreadEvents(events: unknown[]): string {
  if (events.length === 0) return "(no events captured)";

  const parts: string[] = [];

  for (const item of events) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;

    if (record.kind === "snapshot") {
      const snapshot = record.snapshot as Record<string, unknown> | null;
      const thread = snapshot?.thread as Record<string, unknown> | null;
      const session = thread?.session as Record<string, unknown> | null;
      parts.push(`[snapshot] status=${session?.status ?? "idle"}`);

      const messages = thread?.messages as unknown[] | null;
      if (Array.isArray(messages)) {
        for (const itemMessage of messages) {
          const message = itemMessage as Record<string, unknown>;
          parts.push(
            `  [${message.role ?? "unknown"}] ${String(message.text ?? "").slice(0, 1000)}`,
          );
        }
      }
      continue;
    }

    if (record.kind !== "event") continue;

    const event = record.event as Record<string, unknown> | undefined;
    if (!event?.type) continue;

    if (event.type === "thread.message-sent") {
      const payload = event.payload as Record<string, unknown> | undefined;
      parts.push(
        `[message] role=${payload?.role ?? "unknown"} text=${String(payload?.text ?? "").slice(0, 1000)}`,
      );
    } else {
      parts.push(`[event] ${String(event.type)}`);
    }
  }

  return parts.join("\n") || "(events captured but no readable content)";
}

export function registerTools(server: McpServer, client: T3Client): void {
  server.tool(
    "t3_send_prompt",
    "Create a T3 Code thread and send it a coding task. Call t3_get_config first " +
      "to discover the configured provider instance IDs and model slugs.",
    {
      prompt: z.string().min(1).describe("Coding task or question to send to T3 Code"),
      projectId: z
        .string()
        .min(1)
        .optional()
        .describe("Existing T3 Code project ID. Omit to create a project."),
      workspaceRoot: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute workspace path. Required when projectId is omitted."),
      instanceId: z
        .string()
        .min(1)
        .describe("Configured T3 provider instance ID returned by t3_get_config"),
      model: z.string().min(1).describe("Model slug returned by t3_get_config"),
      runtimeMode: z
        .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
        .optional()
        .describe("T3 runtime mode. Defaults to full-access."),
      interactionMode: z
        .enum(["default", "plan"])
        .optional()
        .describe("Provider interaction mode. Defaults to default."),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .describe("Milliseconds to collect response events before returning. Default 30000."),
    },
    async ({
      prompt,
      projectId,
      workspaceRoot,
      instanceId,
      model,
      runtimeMode,
      interactionMode,
      waitMs,
    }) => {
      try {
        const resolvedRuntimeMode = runtimeMode ?? "full-access";
        const resolvedInteractionMode = interactionMode ?? "default";
        const modelSelection = { instanceId, model };
        let resolvedProjectId = projectId;

        if (!resolvedProjectId) {
          if (!workspaceRoot) {
            throw new Error("workspaceRoot is required when projectId is omitted");
          }

          resolvedProjectId = randomUUID();
          await client.dispatchCommand({
            type: "project.create",
            commandId: commandId(),
            projectId: resolvedProjectId,
            title: `MCP session ${resolvedProjectId.slice(0, 8)}`,
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: modelSelection,
            createdAt: now(),
          });
        }

        const threadId = randomUUID();

        await client.dispatchCommand({
          type: "thread.create",
          commandId: commandId(),
          threadId,
          projectId: resolvedProjectId,
          title: prompt.slice(0, 80),
          modelSelection,
          runtimeMode: resolvedRuntimeMode,
          interactionMode: resolvedInteractionMode,
          branch: null,
          worktreePath: null,
          createdAt: now(),
        });

        await client.dispatchCommand({
          type: "thread.turn.start",
          commandId: commandId(),
          threadId,
          message: {
            messageId: randomUUID(),
            role: "user",
            text: prompt,
            attachments: [],
          },
          modelSelection,
          runtimeMode: resolvedRuntimeMode,
          interactionMode: resolvedInteractionMode,
          createdAt: now(),
        });

        const events = await collectThreadEvents(client, threadId, waitMs ?? 30_000);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Thread created: ${threadId}`,
                `Project: ${resolvedProjectId}`,
                "",
                "Response events:",
                formatThreadEvents(events),
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "t3_get_status",
    "Collect recent events from an existing T3 Code thread.",
    {
      threadId: z.string().min(1).describe("Thread ID returned by t3_send_prompt"),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .describe("Milliseconds to collect events. Default 5000."),
    },
    async ({ threadId, waitMs }) => {
      try {
        const events = await collectThreadEvents(client, threadId, waitMs ?? 5_000);
        return {
          content: [
            {
              type: "text" as const,
              text: `Thread ${threadId} events:\n${formatThreadEvents(events)}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "t3_interrupt",
    "Interrupt the currently running turn in a T3 Code thread.",
    {
      threadId: z.string().min(1).describe("Thread ID to interrupt"),
      turnId: z.string().min(1).optional().describe("Specific turn ID to interrupt"),
    },
    async ({ threadId, turnId }) => {
      try {
        const result = await client.dispatchCommand({
          type: "thread.turn.interrupt",
          commandId: commandId(),
          threadId,
          ...(turnId ? { turnId } : {}),
          createdAt: now(),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Interrupt dispatched. Sequence: ${result.sequence}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "t3_stop_session",
    "Stop the provider session for a T3 Code thread.",
    {
      threadId: z.string().min(1).describe("Thread ID whose provider session should stop"),
    },
    async ({ threadId }) => {
      try {
        const result = await client.dispatchCommand({
          type: "thread.session.stop",
          commandId: commandId(),
          threadId,
          createdAt: now(),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Session stop dispatched. Sequence: ${result.sequence}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "t3_get_config",
    "Retrieve T3 Code server configuration, including provider instances and models.",
    {},
    async () => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(await client.getConfig(), null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
