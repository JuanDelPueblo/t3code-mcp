/**
 * A thread's context-window usage, read from its T3 activities.
 *
 * T3 records each provider token-usage report as a `context-window.updated`
 * activity and each finished compaction as a `context-compaction` activity
 * with before and after token counts. Thread snapshots keep the latest usage
 * row of every turn. OpenCode reports no usage, so its threads have none.
 */

import type { T3Activity } from "./t3client.js";

export interface ContextCompaction {
  at: string;
  beforeTokens: number | null;
  afterTokens: number | null;
}

export interface ContextWindow {
  /** Tokens in the context now: the latest report, or the size after a newer compaction. */
  usedTokens: number;
  /** Context window size, or null when the provider did not report one. */
  maxTokens: number | null;
  usedPercent: number | null;
  remainingTokens: number | null;
  /** Whether the provider compacts by itself near the limit, when it says so. */
  compactsAutomatically: boolean | null;
  autoCompactThreshold: number | null;
  updatedAt: string;
  lastCompaction: ContextCompaction | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The latest context-window usage of a thread, or null when none was reported. */
export function contextWindow(activities: readonly T3Activity[]): ContextWindow | null {
  let usage: { payload: Record<string, unknown>; usedTokens: number; at: string } | null = null;
  let maxTokens: number | null = null;
  let compaction: ContextCompaction | null = null;

  for (const activity of activities) {
    const payload = record(activity.payload);
    if (!payload) continue;
    if (activity.kind === "context-window.updated") {
      const usedTokens = count(payload.usedTokens);
      if (usedTokens === null || (usage && activity.createdAt < usage.at)) continue;
      usage = { payload, usedTokens, at: activity.createdAt };
      maxTokens = count(payload.maxTokens) ?? maxTokens;
    } else if (activity.kind === "context-compaction" && payload.state === "compacted") {
      if (compaction && activity.createdAt < compaction.at) continue;
      compaction = {
        at: activity.createdAt,
        beforeTokens: count(payload.beforeTokens),
        afterTokens: count(payload.afterTokens),
      };
    }
  }

  if (!usage && compaction?.afterTokens == null) return null;

  // Codex reports its post-compaction usage just before the compaction row and
  // Claude just after, so a newer compaction's size replaces an older report.
  const compactedLater = compaction !== null && compaction.afterTokens !== null && (!usage || compaction.at > usage.at);
  const usedTokens = compactedLater ? compaction!.afterTokens! : usage!.usedTokens;
  const payload = usage?.payload ?? {};
  return {
    usedTokens,
    maxTokens,
    usedPercent: maxTokens ? Math.round((usedTokens / maxTokens) * 1000) / 10 : null,
    remainingTokens: maxTokens ? Math.max(maxTokens - usedTokens, 0) : null,
    compactsAutomatically: typeof payload.compactsAutomatically === "boolean" ? payload.compactsAutomatically : null,
    autoCompactThreshold: count(payload.autoCompactThreshold),
    updatedAt: compactedLater ? compaction!.at : usage!.at,
    lastCompaction: compaction,
  };
}
