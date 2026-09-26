/**
 * MCP tool implementations for T3 Code v0.0.42.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  T3Client,
  type T3Project,
  type T3ReadModel,
  type T3Thread,
  type T3ThreadDetailSnapshot,
} from "./t3client.js";
import {
  collectUsageReport,
  formatUsageReport,
  usageReportFromConfig,
  type T3UsageLimitSource,
  type UsageProbeOptions,
} from "./usage.js";

export type { T3UsageLimitSource } from "./usage.js";

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

/** Structured summary of one thread, shared by the list and detail tools. */
export interface ThreadSummary {
  id: string;
  title: string;
  projectId: string;
  projectTitle: string | null;
  workspaceRoot: string | null;
  instanceId: string | null;
  model: string | null;
  runtimeMode: string;
  interactionMode: string;
  turnState: string;
  turnId: string | null;
  sessionStatus: string;
  settled: boolean;
  branch: string | null;
  worktreePath: string | null;
  updatedAt: string;
}

export function threadSummary(thread: T3Thread, project?: T3Project): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    projectTitle: project?.title ?? null,
    workspaceRoot: project?.workspaceRoot ?? null,
    instanceId: thread.modelSelection?.instanceId ?? null,
    model: thread.modelSelection?.model ?? null,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    turnState: thread.latestTurn?.state ?? "no-turns",
    turnId: thread.latestTurn?.turnId ?? null,
    sessionStatus: thread.session?.status ?? "no-session",
    settled: thread.settledAt !== null || thread.settledOverride === "settled",
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    updatedAt: thread.updatedAt,
  };
}

export interface ThreadList {
  projects: Array<{ id: string; title: string; workspaceRoot: string }>;
  threads: ThreadSummary[];
}

/** Select, sort, and summarize threads for t3_list_threads. */
export function listThreads(
  readModel: T3ReadModel,
  options: { query?: string; limit?: number } = {},
): ThreadList {
  const limit = options.limit ?? 20;
  const query = options.query?.trim().toLowerCase();
  const projects = new Map(readModel.projects.map((project) => [project.id, project]));

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

  return {
    projects: readModel.projects.map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot })),
    threads: threads.map((thread) => threadSummary(thread, projects.get(thread.projectId))),
  };
}

/** Format a read model into discovery rows for t3_list_threads. */
export function formatThreadRows(
  readModel: T3ReadModel,
  options: { query?: string; limit?: number } = {},
): string {
  const { threads } = listThreads(readModel, options);

  if (threads.length === 0) {
    return options.query?.trim() ? "(no threads match the query)" : "(no threads exist)";
  }

  return threads
    .map((thread) => {
      const projectLabel = thread.projectTitle
        ? `${thread.projectTitle} (${thread.workspaceRoot})`
        : thread.projectId;
      const placement = [
        ...(thread.branch ? [`branch=${thread.branch}`] : []),
        ...(thread.worktreePath ? [`worktree=${thread.worktreePath}`] : []),
      ].join(" ");
      return [
        `${thread.title} — turn=${thread.turnState} session=${thread.sessionStatus}${thread.settled ? " settled" : ""}`,
        `  id: ${thread.id}`,
        `  project: ${projectLabel}`,
        ...(placement ? [`  ${placement}`] : []),
        `  updated: ${thread.updatedAt}`,
      ].join("\n");
    })
    .join("\n");
}

/** The last `limit` items. `slice(-0)` returns every item, so handle 0 apart. */
function lastItems<T>(items: T[], limit: number): T[] {
  return limit > 0 ? items.slice(-limit) : [];
}

export interface ThreadDetail extends ThreadSummary {
  snapshotSequence: number;
  turnStartedAt: string | null;
  turnCompletedAt: string | null;
  lastError: string | null;
  /** Full text of the last assistant message that has text, for callers that parse replies. */
  lastAssistantMessage: string | null;
  messageCount: number;
  messages: Array<{ id: string; role: string; text: string; createdAt: string }>;
  activityCount: number;
  activities: Array<{ kind: string; tone: string; summary: string; createdAt: string }>;
}

/** Structured thread detail. Messages keep their full text. */
export function threadDetail(
  snapshot: T3ThreadDetailSnapshot,
  messageLimit = 10,
  activityLimit = 10,
  project?: T3Project,
): ThreadDetail {
  const thread = snapshot.thread;
  const messages = thread.messages ?? [];
  const activities = thread.activities ?? [];
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && String(message.text ?? "").trim() !== "");
  return {
    ...threadSummary(thread, project),
    snapshotSequence: snapshot.snapshotSequence,
    turnStartedAt: thread.latestTurn?.startedAt ?? null,
    turnCompletedAt: thread.latestTurn?.completedAt ?? null,
    lastError: thread.session?.lastError ?? null,
    lastAssistantMessage: lastAssistant ? String(lastAssistant.text) : null,
    messageCount: messages.length,
    messages: lastItems(messages, messageLimit).map((message) => ({
      id: message.id,
      role: message.role ?? "unknown",
      text: String(message.text ?? ""),
      createdAt: message.createdAt,
    })),
    activityCount: activities.length,
    activities: lastItems(activities, activityLimit).map((activity) => ({
      kind: activity.kind,
      tone: activity.tone,
      summary: activity.summary ?? "",
      createdAt: activity.createdAt,
    })),
  };
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
    for (const message of lastItems(messages, messageLimit)) {
      parts.push(`  [${message.role ?? "unknown"}] ${truncate(String(message.text ?? ""))}`);
    }
  } else {
    parts.push("Last messages: (none)");
  }

  const activities = thread.activities ?? [];
  if (activities.length > 0) {
    parts.push(`Recent activities (${Math.min(activityLimit, activities.length)} of ${activities.length}):`);
    for (const activity of lastItems(activities, activityLimit)) {
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

const threadSummaryShape = {
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectTitle: z.string().nullable(),
  workspaceRoot: z.string().nullable(),
  instanceId: z.string().nullable(),
  model: z.string().nullable(),
  runtimeMode: z.string(),
  interactionMode: z.string(),
  turnState: z.string(),
  turnId: z.string().nullable(),
  sessionStatus: z.string(),
  settled: z.boolean(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  updatedAt: z.string(),
};

/** Output schema of t3_list_threads. Mirrors ThreadList. */
export const threadListOutputSchema = {
  projects: z.array(z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string() })),
  threads: z.array(z.object(threadSummaryShape)),
};

/** Output schema of t3_get_thread. Mirrors ThreadDetail. */
export const threadDetailOutputSchema = {
  ...threadSummaryShape,
  snapshotSequence: z.number(),
  turnStartedAt: z.string().nullable(),
  turnCompletedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastAssistantMessage: z.string().nullable(),
  messageCount: z.number(),
  messages: z.array(z.object({ id: z.string(), role: z.string(), text: z.string(), createdAt: z.string() })),
  activityCount: z.number(),
  activities: z.array(z.object({ kind: z.string(), tone: z.string(), summary: z.string(), createdAt: z.string() })),
};

/** Output schema of t3_send_prompt and t3_send_message. */
export const turnStartedOutputSchema = {
  threadId: z.string(),
  projectId: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  turnState: z.string(),
  sessionStatus: z.string(),
  settled: z.boolean(),
  lastAssistantMessage: z.string().nullable(),
};

const usageWindowSchema = z.object({
  id: z.string(),
  kind: z.enum(["session", "weekly", "monthly", "other"]),
  label: z.string(),
  usedPercent: z.number(),
  remainingPercent: z.number(),
  resetsAt: z.string().nullable(),
  windowMinutes: z.number().nullable(),
});

/** Output schema of t3_get_usage_limits. Mirrors UsageReport in usage.ts. */
export const usageReportOutputSchema = {
  checkedAt: z.string(),
  providers: z.array(
    z.object({
      provider: z.string(),
      instanceId: z.string().nullable(),
      displayName: z.string(),
      plan: z.string().nullable(),
      source: z.enum(["t3", "antigravity-cli", "opencode-go-api"]),
      available: z.boolean(),
      reason: z.string().nullable(),
      checkedAt: z.string().nullable(),
      resetCredits: z.number().nullable(),
      pools: z.array(
        z.object({
          id: z.string(),
          name: z.string().nullable(),
          models: z.string().nullable(),
          windows: z.array(usageWindowSchema),
        }),
      ),
    }),
  ),
  noUsageData: z.array(z.string()),
};

/** Format the server config's provider usage limits into readable rows, with no probes. */
export function formatUsageLimits(config: T3UsageLimitSource, nowMs = Date.now()): string {
  return formatUsageReport(usageReportFromConfig(config), nowMs);
}

/**
 * Build the command for a follow-up turn on an existing thread. T3 takes the
 * runtime and interaction modes of the thread for the new turn, so send the
 * values of the thread. Omit modelSelection so the thread keeps its model.
 */
export function followUpTurnCommand(
  thread: Pick<T3Thread, "id" | "runtimeMode" | "interactionMode">,
  prompt: string,
  ids: { commandId: string; messageId: string; createdAt: string },
) {
  return {
    type: "thread.turn.start",
    commandId: ids.commandId,
    threadId: thread.id,
    message: {
      messageId: ids.messageId,
      role: "user",
      text: prompt,
      attachments: [],
    },
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: ids.createdAt,
  };
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

function structuredResult<T extends object>(text: string, data: T) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data as unknown as Record<string, unknown>,
  };
}

/** Structured state after a turn start, for t3_send_prompt and t3_send_message. */
function turnStarted(threadId: string, projectId: string, snapshot: T3ThreadDetailSnapshot | null) {
  const detail = snapshot ? threadDetail(snapshot, 0, 0) : null;
  return {
    threadId,
    projectId: detail?.projectId ?? projectId,
    branch: detail?.branch ?? null,
    worktreePath: detail?.worktreePath ?? null,
    turnState: detail?.turnState ?? "unknown",
    sessionStatus: detail?.sessionStatus ?? "unknown",
    settled: detail?.settled ?? false,
    lastAssistantMessage: detail?.lastAssistantMessage ?? null,
  };
}

export function registerTools(
  server: McpServer,
  client: T3Client,
  usageOptions: UsageProbeOptions,
): void {
  server.registerTool(
    "t3_list_threads",
    {
      description:
        "List existing T3 Code threads with their current state, including threads " +
        "started from the T3 UI or any other client. Use t3_get_thread to inspect one. " +
        "structuredContent also lists every project with its ID and workspace root.",
      outputSchema: threadListOutputSchema,
      inputSchema: {
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
    },
    async ({ query, limit }) => {
      try {
        const readModel = await client.getReadModel();
        return structuredResult(
          formatThreadRows(readModel, { query, limit }),
          listThreads(readModel, { query, limit }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_get_thread",
    {
      description:
        "Get the current snapshot of an existing T3 Code thread: state, latest turn, " +
        "recent messages and activities. Works for threads started from any client " +
        "and returns immediately without waiting for new events. structuredContent " +
        "keeps the full message text and gives lastAssistantMessage.",
      outputSchema: threadDetailOutputSchema,
      inputSchema: {
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
    },
    async ({ threadId, messageLimit, activityLimit }) => {
      try {
        const snapshot = await client.getThreadSnapshot(threadId);
        return structuredResult(
          formatThreadDetail(snapshot, messageLimit ?? 10, activityLimit ?? 10),
          threadDetail(snapshot, messageLimit ?? 10, activityLimit ?? 10),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_send_prompt",
    {
      description:
        "Create a T3 Code thread and send it a coding task. Call t3_get_config first " +
        "to discover the configured provider instance IDs, model slugs, and model " +
        "option IDs (capabilities.optionDescriptors) for modelOptions. Pass baseBranch " +
        "to create an isolated git worktree, or worktreePath to reuse one; " +
        "t3_list_threads and t3_get_thread report each thread's branch and worktree. " +
        "structuredContent gives the thread ID, worktree path, and turn state.",
      outputSchema: turnStartedOutputSchema,
      inputSchema: {
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
        let after: T3ThreadDetailSnapshot | null = null;
        try {
          after = await client.getThreadSnapshot(threadId);
        } catch {
          // The events below already carry the response; a missing snapshot
          // must not fail the whole call.
        }
        const createdWorktreePath = after?.thread.worktreePath ?? null;

        return structuredResult(
          [
            `Thread created: ${threadId}`,
            `Project: ${resolvedProjectId}`,
            worktreeSummary,
            ...(createdWorktreePath ? [`Worktree path: ${createdWorktreePath}`] : []),
            "",
            "Response events:",
            formatThreadEvents(events),
          ].join("\n"),
          turnStarted(threadId, resolvedProjectId, after),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "t3_send_message",
    {
      description:
        "Send a follow-up message to an existing T3 Code thread and start a new turn " +
        "in the same provider session, so the agent keeps its context. The turn " +
        "uses the model, runtime mode, interaction mode, and worktree of the thread. " +
        "Use it to wake or reuse a worker thread, or to wake an idle orchestrator thread. " +
        "Fails when a turn is still running; wait, or call t3_interrupt first. " +
        "structuredContent gives the turn state after waitMs.",
      outputSchema: turnStartedOutputSchema,
      inputSchema: {
      threadId: z.string().min(1).describe("Thread ID from t3_send_prompt or t3_list_threads"),
      prompt: z.string().min(1).describe("Message to send to the agent of the thread"),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .describe("Milliseconds to collect response events before returning. Default 30000."),
      },
    },
    async ({ threadId, prompt, waitMs }) => {
      try {
        const snapshot = await client.getThreadSnapshot(threadId);
        const thread = snapshot.thread;
        if (thread.deletedAt !== null) {
          throw new Error(`Thread ${threadId} is deleted`);
        }
        if (thread.latestTurn?.state === "running") {
          throw new Error(
            `Thread ${threadId} has a running turn (${thread.latestTurn.turnId}). ` +
              "Wait for it to finish, or call t3_interrupt first.",
          );
        }

        const result = await client.dispatchCommand(
          followUpTurnCommand(thread, prompt, {
            commandId: commandId(),
            messageId: randomUUID(),
            createdAt: now(),
          }),
        );
        // Start after the pre-dispatch snapshot, so the tail holds only this turn.
        const events = await collectThreadEvents(
          client,
          threadId,
          waitMs ?? 30_000,
          snapshot.snapshotSequence,
        );

        let after: T3ThreadDetailSnapshot | null = null;
        try {
          after = await client.getThreadSnapshot(threadId);
        } catch {
          // The events already carry the response; see t3_send_prompt.
        }

        return structuredResult(
          [
            `Message sent to thread ${threadId} (sequence ${result.sequence})`,
            ...(thread.worktreePath ? [`Worktree: ${thread.worktreePath}`] : []),
            "",
            "Response events:",
            formatThreadEvents(events),
          ].join("\n"),
          turnStarted(threadId, thread.projectId, after ?? snapshot),
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

  server.registerTool(
    "t3_get_usage_limits",
    {
      description:
        "Get provider subscription usage limits: Codex (ChatGPT) and Claude Code " +
        "from T3, plus Antigravity and OpenCode Go from their own usage sources " +
        "when configured. Reports used and remaining percent and the reset time " +
        "for each quota window (5h session, rolling, weekly, monthly). Models in " +
        "one pool share its windows. structuredContent holds the same data as JSON.",
      inputSchema: {},
      outputSchema: usageReportOutputSchema,
    },
    async () => {
      try {
        const config = (await client.getConfig()) as T3UsageLimitSource;
        const report = await collectUsageReport(config, usageOptions);
        return {
          content: [{ type: "text" as const, text: formatUsageReport(report) }],
          structuredContent: report as unknown as Record<string, unknown>,
        };
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
