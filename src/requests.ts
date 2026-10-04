/**
 * Open approval and user-input requests of a T3 thread.
 *
 * T3 records each request as an activity (`approval.requested` or
 * `user-input.requested`, keyed by `payload.requestId`) and clears it with the
 * matching `*.resolved` activity, or with a `provider.*.respond.failed`
 * activity whose detail marks the request stale or unknown. This mirrors T3's
 * own `openRequests` rule, so the result agrees with the shell's
 * `hasPendingApprovals` and `hasPendingUserInput` flags.
 */

import type { T3Activity } from "./t3client.js";

export const APPROVAL_DECISIONS = ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface PendingQuestion {
  id: string;
  header: string | null;
  question: string;
  options: Array<{ label: string; description: string | null; value: string | null }>;
  allowCustomAnswer: boolean;
  multiSelect: boolean;
}

export interface PendingRequest {
  requestId: string;
  kind: "approval" | "user-input";
  createdAt: string;
  summary: string;
  /** For approvals: what the agent wants to do, for example a command or tool call. */
  detail: string | null;
  requestKind: string | null;
  /** For approvals: the decisions the provider offers. */
  decisions: ApprovalDecision[];
  /** For user input: the questions to answer, keyed by `id` in t3_respond answers. */
  questions: PendingQuestion[];
}

const STALE_DETAILS = [
  "stale pending approval request",
  "unknown pending approval request",
  "unknown pending permission request",
  "stale pending user-input request",
  "unknown pending user-input request",
  "unknown pending user input request",
  "unknown pending codex user input request",
];

function payloadOf(activity: T3Activity): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isStaleFailure(payload: Record<string, unknown>): boolean {
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : null;
  return detail !== null && STALE_DETAILS.some((phrase) => detail.includes(phrase));
}

function questionsOf(payload: Record<string, unknown>): PendingQuestion[] {
  if (!Array.isArray(payload.questions)) return [];
  return payload.questions.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const question = raw as Record<string, unknown>;
    const id = text(question.id);
    if (!id) return [];
    const options = Array.isArray(question.options) ? question.options : [];
    return [{
      id,
      header: text(question.header),
      question: text(question.question) ?? "",
      options: options.flatMap((option) => {
        if (!option || typeof option !== "object") return [];
        const value = option as Record<string, unknown>;
        const label = text(value.label);
        return label ? [{ label, description: text(value.description), value: text(value.value) }] : [];
      }),
      allowCustomAnswer: question.allowCustomAnswer === true,
      multiSelect: question.multiSelect === true,
    }];
  });
}

function decisionsOf(payload: Record<string, unknown>): ApprovalDecision[] {
  if (!Array.isArray(payload.options)) return [...APPROVAL_DECISIONS];
  const offered = payload.options
    .map((option) => (option && typeof option === "object" ? (option as Record<string, unknown>).decision : null))
    .filter((decision): decision is ApprovalDecision =>
      APPROVAL_DECISIONS.includes(decision as ApprovalDecision));
  return offered.length > 0 ? offered : [...APPROVAL_DECISIONS];
}

/** The requests that are still open, oldest first. */
export function openRequests(activities: T3Activity[]): PendingRequest[] {
  const open = new Map<string, T3Activity>();
  for (const activity of activities) {
    const payload = payloadOf(activity);
    const requestId = text(payload?.requestId);
    if (!payload || !requestId) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      open.set(requestId, activity);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      open.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleFailure(payload)
    ) {
      open.delete(requestId);
    }
  }

  return [...open.entries()].map(([requestId, activity]) => {
    const payload = payloadOf(activity) ?? {};
    const approval = activity.kind === "approval.requested";
    return {
      requestId,
      kind: approval ? "approval" : "user-input",
      createdAt: activity.createdAt,
      summary: activity.summary ?? "",
      detail: text(payload.detail),
      requestKind: text(payload.requestKind) ?? text(payload.requestType),
      decisions: approval ? decisionsOf(payload) : [],
      questions: approval ? [] : questionsOf(payload),
    };
  });
}
