/**
 * Notification-relevant state transitions for T3 Code threads.
 *
 * The notifier polls T3's supported HTTP read model
 * (`/api/orchestration/snapshot`) and detects user-visible transitions:
 * a thread settling (turn finished, failed, or stopped) and pending
 * approval or user-input requests. The logic is pure so tests can drive
 * it without a T3 server or Discord webhook.
 */

import type { T3Thread } from "./t3client.js";

export type NotificationKind =
  | "agent-finished"
  | "agent-failed"
  | "agent-stopped"
  | "approval-needed"
  | "input-needed";

export interface Notification {
  kind: NotificationKind;
  threadId: string;
  threadTitle: string;
  detail?: string;
}

export interface ThreadObservation {
  id: string;
  title: string;
  updatedAt: string;
  latestTurnState: string | null;
  settled: boolean;
  approvalPending: boolean;
  userInputPending: boolean;
  approvalDetail?: string;
  userInputDetail?: string;
}

/** The newest requested activity wins; a later resolve clears the pending flag. */
export function hasPendingActivity(
  activities: T3Thread["activities"],
  requestedKind: string,
  resolvedKind: string,
): { pending: boolean; summary?: string } {
  let requestedAt: string | null = null;
  let summary: string | undefined;
  let resolvedAt: string | null = null;

  for (const activity of activities) {
    if (activity.kind === requestedKind) {
      requestedAt = activity.createdAt;
      summary = activity.summary;
    } else if (activity.kind === resolvedKind) {
      resolvedAt = activity.createdAt;
    }
  }

  if (requestedAt === null) return { pending: false };
  if (resolvedAt !== null && resolvedAt >= requestedAt) return { pending: false };
  return { pending: true, summary };
}

export function observeThread(thread: T3Thread): ThreadObservation {
  const approval = hasPendingActivity(
    thread.activities ?? [],
    "approval.requested",
    "approval.resolved",
  );
  const userInput = hasPendingActivity(
    thread.activities ?? [],
    "user-input.requested",
    "user-input.resolved",
  );

  return {
    id: thread.id,
    title: thread.title || thread.id,
    updatedAt: thread.updatedAt,
    latestTurnState: thread.latestTurn?.state ?? null,
    settled: thread.settledAt !== null || thread.settledOverride === "settled",
    approvalPending: approval.pending,
    userInputPending: userInput.pending,
    ...(approval.pending ? { approvalDetail: approval.summary } : {}),
    ...(userInput.pending ? { userInputDetail: userInput.summary } : {}),
  };
}

export class NotifierState {
  private readonly threads = new Map<string, ThreadObservation>();
  private primed = false;

  /**
   * Ingest one poll of thread observations and return the notifications to
   * deliver. The first poll and newly discovered threads only prime the
   * state, so restarts and threads observed mid-flight do not re-notify.
   */
  ingest(observations: ThreadObservation[]): Notification[] {
    if (!this.primed) {
      this.primed = true;
      for (const observation of observations) this.threads.set(observation.id, observation);
      return [];
    }

    const notifications: Notification[] = [];

    for (const next of observations) {
      const previous = this.threads.get(next.id);
      this.threads.set(next.id, next);
      if (!previous) continue;

      if (!previous.settled && next.settled) {
        notifications.push({
          kind: next.latestTurnState === "error"
            ? "agent-failed"
            : next.latestTurnState === "interrupted"
              ? "agent-stopped"
              : "agent-finished",
          threadId: next.id,
          threadTitle: next.title,
        });
      }

      if (!previous.approvalPending && next.approvalPending) {
        notifications.push({
          kind: "approval-needed",
          threadId: next.id,
          threadTitle: next.title,
          ...(next.approvalDetail ? { detail: next.approvalDetail } : {}),
        });
      }

      if (!previous.userInputPending && next.userInputPending) {
        notifications.push({
          kind: "input-needed",
          threadId: next.id,
          threadTitle: next.title,
          ...(next.userInputDetail ? { detail: next.userInputDetail } : {}),
        });
      }
    }

    return notifications;
  }
}
