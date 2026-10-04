/**
 * Read a thread's native provider session from T3's local state database.
 *
 * T3's HTTP and RPC APIs do not report the provider's own session ID (the
 * Claude session, Codex thread, or OpenCode session). T3 keeps it in the
 * `provider_session_runtime.resume_cursor_json` column of
 * `<T3 home>/userdata/state.sqlite`. This is a private schema, so the lookup is
 * read-only, optional, and returns null instead of failing when the database,
 * table, or row is absent or its shape changes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface NativeSession {
  /** T3 provider name, for example claudeAgent, codex, or opencode. */
  provider: string | null;
  instanceId: string | null;
  status: string | null;
  /** The provider's own session ID, usable with its CLI resume or export. */
  nativeSessionId: string | null;
  resumeCursor: unknown;
  lastSeenAt: string | null;
  source: "t3-state-db";
}

export type NativeSessionLookup = (threadId: string) => Promise<NativeSession | null>;

/** Extract the provider's own session ID from a T3 resume cursor. */
export function nativeSessionId(cursor: unknown, t3ThreadId: string): string | null {
  if (!cursor || typeof cursor !== "object") return null;
  const value = cursor as Record<string, unknown>;
  for (const key of ["resume", "sessionId"]) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string;
  }
  // Codex stores its own thread ID; Claude stores T3's thread ID under this key.
  if (typeof value.threadId === "string" && value.threadId && value.threadId !== t3ThreadId) {
    return value.threadId;
  }
  return null;
}

export function stateDbPathFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.T3_STATE_DB === "") return null;
  if (env.T3_STATE_DB) return env.T3_STATE_DB;
  const home = env.T3CODE_HOME ?? env.T3_CODE_BASE_DIR;
  return home ? join(home, "userdata", "state.sqlite") : null;
}

/** A lookup bound to one database path; null when the feature is unavailable. */
export function nativeSessionLookup(dbPath: string | null): NativeSessionLookup | null {
  if (!dbPath) return null;
  return async (threadId) => {
    if (!existsSync(dbPath)) return null;
    let db: { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void } | null = null;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db
        .prepare(
          "SELECT provider_name, provider_instance_id, status, resume_cursor_json, last_seen_at " +
            "FROM provider_session_runtime WHERE thread_id = ?",
        )
        .get(threadId) as Record<string, unknown> | undefined;
      if (!row) return null;
      let cursor: unknown = null;
      try {
        cursor = typeof row.resume_cursor_json === "string" ? JSON.parse(row.resume_cursor_json) : null;
      } catch {
        cursor = null;
      }
      const text = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : null);
      return {
        provider: text("provider_name"),
        instanceId: text("provider_instance_id"),
        status: text("status"),
        nativeSessionId: nativeSessionId(cursor, threadId),
        resumeCursor: cursor,
        lastSeenAt: text("last_seen_at"),
        source: "t3-state-db",
      };
    } catch (error) {
      process.stderr.write(
        `native session lookup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return null;
    } finally {
      db?.close();
    }
  };
}
