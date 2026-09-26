/**
 * MCP tool implementations for T3 Code v0.0.42.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { T3Client, type T3ReadModel, type T3ThreadDetailSnapshot } from "./t3client.js";

function now(): string {
  return new Date().toISOString();
}

function commandId(): string {
  return randomUUID();
}

/** Terminal event types in T3 v0.0.42's orchestration vocabulary. */
export const terminalEventTypes: ReadonlySet<string> = new Set([
  "thread.settled",
  "thread.turn-diff-completed",
  "thread.session-stop-requested",
]);

const MAX_TEXT_CHARS = 1000;

function truncate(text: string, maxChars = MAX_TEXT_CHARS): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

async function collectThreadEvents(
  client: T3Client,
  threadId: string,
  timeoutMs: number,
  afterSequence?: number,
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
      afterSequence,
    );
  } finally {
    clearTimeout(timer);
  }

  return events;
}

/** Format a read model into discovery rows for t3_list_threads. */
export function formatThreadRows(
  readModel: T3ReadModel,
  options: { query?: string; limit?: number } = {},
): string {
  const limit = options.limit ?? 20;
  const query = options.query?.trim().toLowerCase();
  const projectTitles = new Map(
    readModel.projects.map((project) => [project.id, project]),
  );

  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .filter((thread) => thread.archivedAt === undefined || thread.archivedAt === null)
    .filter((thread) => {
      if (!query) return true;
      return (
        thread.title.toLowerCase().includes(query) ||
        thread.id.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit);

  if (threads.length === 0) {
    return query ? "(no threads match the query)" : "(no threads exist)";
  }

  return threads
    .map((thread) => {
      const turnState = thread.latestTurn?.state ?? "no-turns";
      const settled = thread.settledAt !== null || thread.settledOverride === "settled";
      const sessionStatus = thread.session?.status ?? "no-session";
      const project = projectTitles.get(thread.projectId);
      const projectLabel = project ? `${project.title} (${project.workspaceRoot})` : thread.projectId;
      const placement = [
        ...(thread.branch ? [`branch=${thread.branch}`] : []),
        ...(thread.worktreePath ? [`worktree=${thread.worktreePath}`] : []),
      ].join(" ");
      return [
        `${thread.title} — turn=${turnState} session=${sessionStatus}${settled ? " settled" : ""}`,
        `  id: ${thread.id}`,
        `  project: ${projectLabel}`,
        ...(placement ? [`  ${placement}`] : []),
        `  updated: ${thread.updatedAt}`,
      ].join("\n");
    })
    .join("\n");
}

/** Format an HTTP thread detail snapshot for t3_get_thread / t3_get_status. */
export function formatThreadDetail(
  snapshot: T3ThreadDetailSnapshot,
  messageLimit = 10,
  activityLimit = 10,
): string {
  const thread = snapshot.thread;
  const turn = thread.latestTurn;
  const turnState = turn?.state ?? "no-turns";
  const settled = thread.settledAt !== null || thread.settledOverride === "settled";
  const sessionStatus = thread.session?.status ?? "no-session";

  const parts: string[] = [
    `Thread: ${thread.title}`,
    `id: ${thread.id}`,
    `State: turn=${turnState} session=${sessionStatus}${settled ? " settled" : ""} (snapshot sequence ${snapshot.snapshotSequence})`,
  ];

  if (turn) {
    parts.push(
      `Latest turn: state=${turn.state} started=${turn.startedAt ?? "n/a"} completed=${turn.completedAt ?? "n/a"}`,
    );
  }
  if (thread.branch) {
    parts.push(`Branch: ${thread.branch}`);
  }
  if (thread.worktreePath) {
    parts.push(`Worktree: ${thread.worktreePath}`);
  }
  if (thread.session?.lastError) {
    parts.push(`Session error: ${truncate(thread.session.lastError)}`);
  }

  const messages = thread.messages ?? [];
  if (messages.length > 0) {
    parts.push(`Last messages (${Math.min(messageLimit, messages.length)} of ${messages.length}):`);
    for (const message of messages.slice(-messageLimit)) {
      parts.push(`  [${message.role ?? "unknown"}] ${truncate(String(message.text ?? ""))}`);
    }
  } else {
    parts.push("Last messages: (none)");
  }

  const activities = thread.activities ?? [];
  if (activities.length > 0) {
    parts.push(`Recent activities (${Math.min(activityLimit, activities.length)} of ${activities.length}):`);
    for (const activity of activities.slice(-activityLimit)) {
      parts.push(`  [${activity.kind}] ${truncate(activity.summary ?? "", 300)}`);
    }
  } else {
    parts.push("Recent activities: (none)");
  }

  return parts.join("\n");
}

function formatThreadEvents(events: unknown[]): string {
  if (events.length === 0) return "(no events captured)";

  const parts: string[] = [];

  for (const item of events) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;

    if (record.kind === "synchronized") {
      parts.push("[synchronized] caught up to live events");
      continue;
    }

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
            `  [${message.role ?? "unknown"}] ${truncate(String(message.text ?? ""))}`,
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
        `[message] role=${payload?.role ?? "unknown"} text=${truncate(String(payload?.text ?? ""))}`,
      );
    } else {
      parts.push(`[event] ${String(event.type)}`);
    }
  }

  return parts.join("\n") || "(events captured but no readable content)";
}

/** Minimal shape of T3 provider usage limits as returned by server.getConfig. */
export interface T3UsageLimitWindow {
  id?: string;
  kind?: "session" | "weekly" | "monthly" | "other";
  label?: string;
  usedPercent?: number;
  resetsAt?: string | null;
  windowDurationMins?: number;
}

/** Minimal shape of T3 provider usage limits as returned by server.getConfig. */
export interface T3UsageLimits {
  checkedAt?: string;
  unavailable?: { reason?: string; message?: string } | null;
  windows?: T3UsageLimitWindow[];
  resetCredits?: { availableCount?: number } | null;
}

export interface T3UsageLimitSource {
  providers?: Array<{
    instanceId?: string;
    displayName?: string;
    status?: string;
    enabled?: boolean;
    auth?: { label?: string; email?: string };
    usageLimits?: T3UsageLimits | null;
  }>;
}

/** Humanize the wait until an ISO reset instant, e.g. "1h41m". */
export function formatRemaining(resetsAt: string, nowMs: number): string {
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return "unknown";

  const ms = target - nowMs;
  if (ms <= 0) return "now";

  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [
    ...(days > 0 ? [`${days}d`] : []),
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(days === 0 && mins > 0 ? [`${mins}m`] : []),
  ];
  return parts.join("") || "now";
}

/** Kind label for a usage limit window, preferring the 5h session form. */
function windowLabel(win: T3UsageLimitWindow): string {
  if (win.label) return win.label;
  if (win.kind === "session") return "Session";
  if (win.kind === "weekly") return "Weekly";
  if (win.kind === "monthly") return "Monthly";
  return win.id ?? "Window";
}

/** Format the server config's provider usage limits into readable rows. */
export function formatUsageLimits(config: T3UsageLimitSource, nowMs = Date.now()): string {
  const providers = config.providers ?? [];
  const lines: string[] = [];

  const withLimits = providers.filter((p) => p.usageLimits?.windows?.length);
  const withoutLimits = providers.filter(
    (p) => p.enabled !== false && p.status !== "disabled" && !p.usageLimits?.windows?.length,
  );

  for (const provider of withLimits) {
    const auth = provider.auth ? [provider.auth.label, provider.auth.email].filter(Boolean).join(" — ") : "";
    lines.push(`${provider.displayName ?? provider.instanceId ?? "provider"}${auth ? ` (${auth})` : ""}`);

    const limits = provider.usageLimits!;
    for (const win of limits.windows ?? []) {
      if (typeof win.usedPercent !== "number") continue;
      const label = windowLabel(win);
      const duration = win.windowDurationMins ? ` ${Math.round(win.windowDurationMins / 60)}h window` : "";
      const reset = win.resetsAt
        ? `, resets in ${formatRemaining(win.resetsAt, nowMs)} (at ${win.resetsAt})`
        : "";
      lines.push(`  ${label}:${duration} ${Math.round(win.usedPercent)}% used${reset}`);
    }

    const credits = limits.resetCredits?.availableCount;
    if (credits && credits > 0) {
      lines.push(`  Reset credits available: ${credits}`);
    }

    if (limits.unavailable?.message) {
      lines.push(`  Unavailable: ${limits.unavailable.message}`);
    }
  }

  if (withoutLimits.length > 0) {
    lines.push(`No usage data: ${withoutLimits.map((p) => p.displayName ?? p.instanceId).join(", ")}`);
  }

  if (lines.length === 0) return "(no usage limits reported)";
  return lines.join("\n");
}

function errorResult(error: unknown) {
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

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function registerTools(server: McpServer, client: T3Client): void {
  server.tool(
    "t3_list_threads",
    "List existing T3 Code threads with their current state, including threads " +
      "started from the T3 UI or any other client. Use t3_get_thread to inspect one.",
    {
      query: z
        .string()
        .min(1)
        .optional()
        .describe("Case-insensitive substring filter on thread title or ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum number of threads to return. Default 20."),
    },
    async ({ query, limit }) => {
      try {
        const readModel = await client.getReadModel();
        return textResult(formatThreadRows(readModel, { query, limit }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "t3_get_thread",
    "Get the current snapshot of an existing T3 Code thread: state, latest turn, " +
      "recent messages and activities. Works for threads started from any client " +
      "and returns immediately without waiting for new events.",
    {
      threadId: z.string().min(1).describe("T3 Code thread ID (from t3_list_threads or t3_send_prompt)"),
      messageLimit: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("How many recent messages to include. Default 10."),
      activityLimit: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("How many recent activities to include. Default 10."),
    },
    async ({ threadId, messageLimit, activityLimit }) => {
      try {
        const snapshot = await client.getThreadSnapshot(threadId);
        return textResult(
          formatThreadDetail(snapshot, messageLimit ?? 10, activityLimit ?? 10),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "t3_send_prompt",
    "Create a T3 Code thread and send it a coding task. Call t3_get_config first " +
      "to discover the configured provider instance IDs, model slugs, and model " +
      "option IDs (capabilities.optionDescriptors) for modelOptions. Pass baseBranch " +
      "to create an isolated git worktree, or worktreePath to reuse one; " +
      "t3_list_threads and t3_get_thread report each thread's branch and worktree.",
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
      modelOptions: z
        .record(z.string(), z.union([z.string(), z.boolean()]))
        .optional()
        .describe(
          "Model option values keyed by option ID from the model's " +
            "capabilities.optionDescriptors in t3_get_config (e.g. reasoningEffort " +
            "for Codex, effort for Claude, variant for OpenCode; also serviceTier, " +
            "fastMode, contextWindow, agent). Omit to use T3 defaults.",
        ),
      runtimeMode: z
        .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
        .optional()
        .describe("T3 runtime mode. Defaults to full-access."),
      interactionMode: z
        .enum(["default", "plan"])
        .optional()
        .describe("Provider interaction mode. Defaults to default."),
      branch: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Branch name to record on the thread. With baseBranch, T3 creates the " +
            "new worktree on this new branch. With worktreePath, it records the " +
            "branch of the reused worktree.",
        ),
      worktreePath: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Absolute path of an existing git worktree for the thread to reuse. " +
            "Cannot be combined with baseBranch.",
        ),
      baseBranch: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Base branch (e.g. main) for T3 to create a fresh git worktree from " +
            "the project checkout. Requires a git repository. The worktree stays " +
            "on disk after the thread settles; remove it with git worktree remove " +
            "when done. Cannot be combined with worktreePath.",
        ),
      startFromOrigin: z
        .boolean()
        .optional()
        .describe("Fetch baseBranch from origin before creating the worktree. Only with baseBranch."),
      runSetupScript: z
        .boolean()
        .optional()
        .describe(
          "Run the project's setup script in a created worktree. Defaults to true. " +
            "Only with baseBranch.",
        ),
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
      modelOptions,
      runtimeMode,
      interactionMode,
      branch,
      worktreePath,
      baseBranch,
      startFromOrigin,
      runSetupScript,
      waitMs,
    }) => {
      try {
        const resolvedRuntimeMode = runtimeMode ?? "full-access";
        const resolvedInteractionMode = interactionMode ?? "default";
        // T3 accepts modelSelection.options as a plain {id: value} object.
        const modelSelection = {
          instanceId,
          model,
          ...(modelOptions && Object.keys(modelOptions).length > 0
            ? { options: modelOptions }
            : {}),
        };

        if (worktreePath && baseBranch) {
          throw new Error("worktreePath (reuse) and baseBranch (create) are mutually exclusive");
        }
        if (startFromOrigin && !baseBranch) {
          throw new Error("startFromOrigin requires baseBranch");
        }
        if (runSetupScript === true && !baseBranch) {
          throw new Error("runSetupScript requires baseBranch");
        }

        let resolvedProjectId = projectId;
        let projectCwd = workspaceRoot;

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
        } else if (baseBranch && !projectCwd) {
          const project = (await client.getReadModel()).projects.find(
            (candidate) => candidate.id === resolvedProjectId,
          );
          if (!project) {
            throw new Error(`Project not found: ${resolvedProjectId}`);
          }
          projectCwd = project.workspaceRoot;
        }

        const threadId = randomUUID();
        const title = prompt.slice(0, 80);
        const threadBranch = branch ?? null;
        let worktreeSummary: string;

        if (baseBranch) {
          // Native isolated-worktree flow: the server creates the thread and
          // claims a fresh worktree path inside one turn.start bootstrap.
          if (!projectCwd) {
            throw new Error("baseBranch requires a project workspace root");
          }
          worktreeSummary = `Worktree: creating from ${baseBranch}${branch ? ` on new branch ${branch}` : ""}`;
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
            bootstrap: {
              createThread: {
                projectId: resolvedProjectId,
                title,
                modelSelection,
                runtimeMode: resolvedRuntimeMode,
                interactionMode: resolvedInteractionMode,
                branch: threadBranch,
                worktreePath: null,
                createdAt: now(),
              },
              prepareWorktree: {
                projectCwd,
                baseBranch,
                ...(branch ? { branch } : {}),
                ...(startFromOrigin ? { startFromOrigin: true } : {}),
              },
              ...((runSetupScript ?? true) ? { runSetupScript: true } : {}),
            },
            createdAt: now(),
          });
        } else {
          worktreeSummary = worktreePath
            ? `Worktree: reusing ${worktreePath}${branch ? ` (branch ${branch})` : ""}`
            : branch
              ? `Branch: ${branch} (project checkout)`
              : "Worktree: project checkout";

          await client.dispatchCommand({
            type: "thread.create",
            commandId: commandId(),
            threadId,
            projectId: resolvedProjectId,
            title,
            modelSelection,
            runtimeMode: resolvedRuntimeMode,
            interactionMode: resolvedInteractionMode,
            branch: threadBranch,
            worktreePath: worktreePath ?? null,
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
        }

        const events = await collectThreadEvents(client, threadId, waitMs ?? 30_000);

        // Report the server-claimed worktree path when T3 created one.
        let createdWorktreePath: string | null = null;
        try {
          const snapshot = await client.getThreadSnapshot(threadId);
          createdWorktreePath = snapshot.thread.worktreePath;
        } catch {
          // The events below already carry the response; a missing snapshot
          // must not fail the whole call.
        }

        return textResult(
          [
            `Thread created: ${threadId}`,
            `Project: ${resolvedProjectId}`,
            worktreeSummary,
            ...(createdWorktreePath ? [`Worktree path: ${createdWorktreePath}`] : []),
            "",
            "Response events:",
            formatThreadEvents(events),
          ].join("\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "t3_send_message",
    "Start another turn on an existing T3 Code thread. Unlike t3_send_prompt " +
      "(which creates a new thread), t3_send_message reuses the supplied threadId " +
      "and preserves its model selection, runtime mode, interaction mode, branch, " +
      "and worktree. Use it to wake/reuse a worker thread or to wake an idle " +
      "orchestrator thread. waitMs=0 dispatches and returns immediately.",
    {
      threadId: z.string().min(1).describe("Existing T3 Code thread ID (from t3_list_threads or t3_send_prompt)"),
      prompt: z.string().min(1).describe("User message to send as a new turn on the existing thread"),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .describe("Milliseconds to collect response events before returning. Default 0 (return immediately)."),
    },
    async ({ threadId, prompt, waitMs }) => {
      try {
        // Read the existing thread first: validates the ID (unknown IDs fail
        // here with a useful error) and obtains the model/runtime settings
        // required by thread.turn.start.
        const snapshot = await client.getThreadSnapshot(threadId);
        const thread = snapshot.thread;

        // Reuse the thread's own configuration; never create a project,
        // thread, branch, or worktree here (no bootstrap payload).
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
          ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
          ...(thread.runtimeMode ? { runtimeMode: thread.runtimeMode } : {}),
          ...(thread.interactionMode ? { interactionMode: thread.interactionMode } : {}),
          createdAt: now(),
        });

        const wait = waitMs ?? 0;
        const header = [
          `Turn dispatched on thread: ${threadId}`,
          `Model: ${JSON.stringify(thread.modelSelection ?? null)}`,
          `Runtime: ${thread.runtimeMode ?? "n/a"} Interaction: ${thread.interactionMode ?? "n/a"}`,
          ...(thread.branch ? [`Branch: ${thread.branch}`] : []),
          ...(thread.worktreePath ? [`Worktree: ${thread.worktreePath}`] : []),
        ].join("\n");

        if (wait === 0) {
          return textResult(header);
        }

        const events = await collectThreadEvents(
          client,
          threadId,
          wait,
          snapshot.snapshotSequence,
        );
        return textResult(
          [header, "", "Response events:", formatThreadEvents(events)].join("\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "t3_get_status",
    "Get the current state of a T3 Code thread: an immediate snapshot plus, " +
      "optionally, live events collected for waitMs milliseconds.",
    {
      threadId: z.string().min(1).describe("Thread ID returned by t3_send_prompt or t3_list_threads"),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .describe(
          "Milliseconds to additionally collect live events after the snapshot. Default 0.",
        ),
    },
    async ({ threadId, waitMs }) => {
      try {
        const snapshot = await client.getThreadSnapshot(threadId);
        const tailMs = waitMs ?? 0;

        if (tailMs === 0) {
          return textResult(formatThreadDetail(snapshot));
        }

        const events = await collectThreadEvents(
          client,
          threadId,
          tailMs,
          snapshot.snapshotSequence,
        );
        return textResult(
          [
            formatThreadDetail(snapshot),
            "",
            `Live events (${tailMs}ms):`,
            formatThreadEvents(events),
          ].join("\n"),
        );
      } catch (error) {
        return errorResult(error);
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
        return textResult(`Interrupt dispatched. Sequence: ${result.sequence}`);
      } catch (error) {
        return errorResult(error);
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
        return textResult(`Session stop dispatched. Sequence: ${result.sequence}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "t3_get_usage_limits",
    "Get provider subscription usage limits for T3 Code, especially Codex " +
      "(ChatGPT) and Claude Code. Reports used percent and reset time for the " +
      "5 hour session quota and the weekly quota.",
    {},
    async () => {
      try {
        return textResult(formatUsageLimits(await client.getConfig() as T3UsageLimitSource));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    "t3_get_config",
    "Retrieve T3 Code server configuration, including provider instances and models.",
    {},
    async () => {
      try {
        return textResult(JSON.stringify(await client.getConfig(), null, 2));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
