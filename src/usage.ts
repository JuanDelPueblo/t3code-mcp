/**
 * Provider usage limits for t3_get_usage_limits.
 *
 * T3 reports subscription limits for Codex and Claude Code in its server
 * config. It reports nothing for Antigravity or OpenCode Go, so two optional
 * probes fill the gap:
 *
 * - Antigravity: the read-only `agy --print /usage --output-format json`.
 * - OpenCode Go: the read-only `https://opencode.ai/zen/go/v1/usage` endpoint.
 *
 * Every source becomes one normalized UsageReport. The text output and the
 * structured output of the tool both come from that report. The report never
 * carries account emails or API keys.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type UsageWindowKind = "session" | "weekly" | "monthly" | "other";
export type UsageSource = "t3" | "antigravity-cli" | "opencode-go-api";

export interface UsageWindow {
  id: string;
  kind: UsageWindowKind;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

/** One shared quota pool. Every model in `models` draws from these windows. */
export interface UsagePool {
  id: string;
  name: string | null;
  models: string | null;
  windows: UsageWindow[];
}

export interface ProviderUsage {
  provider: string;
  instanceId: string | null;
  displayName: string;
  plan: string | null;
  source: UsageSource;
  available: boolean;
  reason: string | null;
  checkedAt: string | null;
  resetCredits: number | null;
  pools: UsagePool[];
}

export interface UsageReport {
  checkedAt: string;
  providers: ProviderUsage[];
  /** Enabled T3 instances with no usage source at all. */
  noUsageData: string[];
}

/** Minimal shape of one T3 usage limit window from server.getConfig. */
export interface T3UsageLimitWindow {
  id?: string;
  kind?: "session" | "weekly" | "monthly" | "other";
  label?: string;
  usedPercent?: number;
  resetsAt?: string | null;
  windowDurationMins?: number;
}

/** Minimal shape of T3 provider usage limits from server.getConfig. */
export interface T3UsageLimits {
  checkedAt?: string;
  unavailable?: { reason?: string; message?: string } | null;
  windows?: T3UsageLimitWindow[];
  resetCredits?: { availableCount?: number } | null;
}

export interface T3UsageLimitSource {
  providers?: Array<{
    instanceId?: string;
    driver?: string;
    displayName?: string;
    status?: string;
    enabled?: boolean;
    auth?: { label?: string; email?: string };
    usageLimits?: T3UsageLimits | null;
  }>;
}

type T3Provider = NonNullable<T3UsageLimitSource["providers"]>[number];

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isActive(provider: T3Provider): boolean {
  return provider.enabled !== false && provider.status !== "disabled";
}

function hasT3Windows(provider: T3Provider): boolean {
  return (provider.usageLimits?.windows ?? []).some((win) => typeof win.usedPercent === "number");
}

function t3WindowLabel(win: T3UsageLimitWindow): string {
  if (win.label) return win.label;
  if (win.kind === "session") return "Session";
  if (win.kind === "weekly") return "Weekly";
  if (win.kind === "monthly") return "Monthly";
  return win.id ?? "Window";
}

/** Convert the T3 usage limits of one provider into a ProviderUsage. */
function fromT3Provider(provider: T3Provider): ProviderUsage {
  const limits = provider.usageLimits ?? {};
  const windows: UsageWindow[] = [];
  for (const win of limits.windows ?? []) {
    if (typeof win.usedPercent !== "number") continue;
    const used = clampPercent(win.usedPercent);
    windows.push({
      id: win.id ?? win.kind ?? "window",
      kind: win.kind ?? "other",
      label: t3WindowLabel(win),
      usedPercent: round1(used),
      remainingPercent: round1(100 - used),
      resetsAt: win.resetsAt ?? null,
      windowMinutes: win.windowDurationMins ?? null,
    });
  }

  const credits = limits.resetCredits?.availableCount;
  return {
    provider: provider.instanceId ?? "provider",
    instanceId: provider.instanceId ?? null,
    displayName: provider.displayName ?? provider.instanceId ?? "provider",
    plan: provider.auth?.label ?? null,
    source: "t3",
    available: windows.length > 0,
    reason: limits.unavailable?.message ?? null,
    checkedAt: limits.checkedAt ?? null,
    resetCredits: typeof credits === "number" ? credits : null,
    pools: windows.length > 0 ? [{ id: "default", name: null, models: null, windows }] : [],
  };
}

function unavailable(
  base: Pick<ProviderUsage, "provider" | "instanceId" | "displayName" | "source">,
  reason: string,
  checkedAt: string,
): ProviderUsage {
  return { ...base, plan: null, available: false, reason, checkedAt, resetCredits: null, pools: [] };
}

const ANTIGRAVITY_WINDOWS: Record<string, { kind: UsageWindowKind; label: string; minutes: number }> = {
  "5h": { kind: "session", label: "Session", minutes: 300 },
  weekly: { kind: "weekly", label: "Weekly", minutes: 10080 },
};

/**
 * Parse `agy --print /usage --output-format json`. Each group is one shared
 * quota pool. Do not split a group into separate quotas per model.
 */
export function parseAntigravityUsage(
  raw: unknown,
  instanceId: string | null,
  checkedAt: string,
): ProviderUsage {
  const base = {
    provider: "antigravity",
    instanceId,
    displayName: "Antigravity",
    source: "antigravity-cli" as const,
  };
  const doc = raw as {
    status?: unknown;
    command?: { data?: { groups?: unknown } };
  } | null;
  if (!doc || doc.status !== "SUCCESS") {
    return unavailable(base, `agy status is ${String(doc?.status ?? "missing")}, not SUCCESS`, checkedAt);
  }
  const groups = doc.command?.data?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return unavailable(base, "agy returned no quota groups", checkedAt);
  }

  const pools: UsagePool[] = [];
  for (const [index, group] of groups.entries()) {
    const g = group as { name?: unknown; description?: unknown; buckets?: unknown };
    const windows: UsageWindow[] = [];
    for (const bucket of Array.isArray(g.buckets) ? g.buckets : []) {
      const b = bucket as { id?: unknown; window?: unknown; remaining_fraction?: unknown; reset_time?: unknown };
      if (typeof b.remaining_fraction !== "number") continue;
      const windowName = String(b.window ?? "");
      const known = ANTIGRAVITY_WINDOWS[windowName];
      const remaining = clampPercent(b.remaining_fraction * 100);
      windows.push({
        id: typeof b.id === "string" ? b.id : windowName || "window",
        kind: known?.kind ?? "other",
        label: known?.label ?? (windowName || "Window"),
        usedPercent: round1(100 - remaining),
        remainingPercent: round1(remaining),
        resetsAt: typeof b.reset_time === "string" ? b.reset_time : null,
        windowMinutes: known?.minutes ?? null,
      });
    }
    const models = typeof g.description === "string"
      ? g.description.replace(/^Models within this group:\s*/i, "")
      : null;
    pools.push({
      id: typeof g.name === "string" ? g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : `group-${index}`,
      name: typeof g.name === "string" ? g.name : null,
      models,
      windows,
    });
  }

  const available = pools.some((pool) => pool.windows.length > 0);
  return {
    ...base,
    plan: null,
    available,
    reason: available ? null : "agy groups hold no usable buckets",
    checkedAt,
    resetCredits: null,
    pools,
  };
}

const OPENCODE_GO_WINDOWS: Record<string, { kind: UsageWindowKind; label: string; minutes: number | null }> = {
  rolling: { kind: "session", label: "Rolling", minutes: null },
  weekly: { kind: "weekly", label: "Weekly", minutes: 10080 },
  monthly: { kind: "monthly", label: "Monthly", minutes: null },
};

/**
 * Parse the OpenCode Go usage response. `percent` is the used share of the
 * window, not the remaining share. A window with a status other than `ok`
 * makes the provider unavailable, because the numbers are not reliable.
 */
export function parseOpencodeGoUsage(
  raw: unknown,
  instanceId: string | null,
  checkedAt: string,
): ProviderUsage {
  const base = {
    provider: "opencode-go",
    instanceId,
    displayName: "OpenCode Go",
    source: "opencode-go-api" as const,
  };
  const usage = (raw as { usage?: unknown } | null)?.usage;
  if (!usage || typeof usage !== "object") {
    return unavailable(base, "response has no usage object", checkedAt);
  }

  const windows: UsageWindow[] = [];
  const bad: string[] = [];
  for (const [name, value] of Object.entries(usage as Record<string, unknown>)) {
    const w = value as { status?: unknown; percent?: unknown; resetsAt?: unknown } | null;
    if (!w || w.status !== "ok" || typeof w.percent !== "number") {
      bad.push(`${name}=${String(w?.status ?? "malformed")}`);
      continue;
    }
    const known = OPENCODE_GO_WINDOWS[name];
    const used = clampPercent(w.percent);
    windows.push({
      id: name,
      kind: known?.kind ?? "other",
      label: known?.label ?? name,
      usedPercent: round1(used),
      remainingPercent: round1(100 - used),
      resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
      windowMinutes: known?.minutes ?? null,
    });
  }

  if (bad.length > 0 || windows.length === 0) {
    return unavailable(
      base,
      bad.length > 0 ? `window status not ok: ${bad.join(", ")}` : "response has no windows",
      checkedAt,
    );
  }
  return {
    ...base,
    plan: null,
    available: true,
    reason: null,
    checkedAt,
    resetCredits: null,
    pools: [{ id: "opencode-go", name: null, models: "opencode-go/*", windows }],
  };
}

export interface UsageProbeOptions {
  /** Antigravity CLI command. `null` disables the probe. */
  antigravityCli: string | null;
  /** Reads the OpenCode Go API key. `null` disables the probe. */
  opencodeGoApiKey: (() => Promise<string>) | null;
  opencodeGoUsageUrl: string;
  timeoutMs: number;
}

/** Read probe options from the environment. See README "Usage limits". */
export function usageProbeOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): UsageProbeOptions {
  const cli = env.T3_USAGE_ANTIGRAVITY_CLI ?? "agy";
  const timeout = Number.parseInt(env.T3_USAGE_PROBE_TIMEOUT_MS ?? "20000", 10);

  let opencodeGoApiKey: UsageProbeOptions["opencodeGoApiKey"] = null;
  const credentialFile = env.CREDENTIALS_DIRECTORY
    ? join(env.CREDENTIALS_DIRECTORY, "opencode-go-api-key")
    : null;
  if (env.OPENCODE_GO_API_KEY) {
    const key = env.OPENCODE_GO_API_KEY;
    opencodeGoApiKey = async () => key;
  } else if (env.OPENCODE_GO_API_KEY_FILE) {
    const file = env.OPENCODE_GO_API_KEY_FILE;
    opencodeGoApiKey = async () => (await readFile(file, "utf8")).trim();
  } else if (credentialFile && existsSync(credentialFile)) {
    opencodeGoApiKey = async () => (await readFile(credentialFile, "utf8")).trim();
  }

  return {
    antigravityCli: cli === "" || cli === "off" ? null : cli,
    opencodeGoApiKey,
    opencodeGoUsageUrl: env.OPENCODE_GO_USAGE_URL ?? "https://opencode.ai/zen/go/v1/usage",
    timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : 20000,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error(`${command} failed: ${error.message.split("\n")[0].slice(0, 200)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Parse CLI output that holds one JSON document, maybe after log lines. */
function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    if (start < 0) throw new Error("output holds no JSON object");
    return JSON.parse(text.slice(start));
  }
}

export async function probeAntigravity(
  options: UsageProbeOptions,
  instanceId: string | null,
): Promise<ProviderUsage> {
  const checkedAt = new Date().toISOString();
  try {
    const stdout = await runCommand(
      options.antigravityCli!,
      ["--print", "/usage", "--output-format", "json"],
      options.timeoutMs,
    );
    return parseAntigravityUsage(parseJsonOutput(stdout), instanceId, checkedAt);
  } catch (error) {
    return unavailable(
      { provider: "antigravity", instanceId, displayName: "Antigravity", source: "antigravity-cli" },
      errorMessage(error),
      checkedAt,
    );
  }
}

export async function probeOpencodeGo(
  options: UsageProbeOptions,
  instanceId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderUsage> {
  const checkedAt = new Date().toISOString();
  const base = {
    provider: "opencode-go",
    instanceId,
    displayName: "OpenCode Go",
    source: "opencode-go-api" as const,
  };
  let key: string;
  try {
    key = await options.opencodeGoApiKey!();
  } catch {
    // The error text can hold the key file path only; still report no detail.
    return unavailable(base, "API key is not readable", checkedAt);
  }
  if (!key) return unavailable(base, "API key is empty", checkedAt);

  try {
    const response = await fetchImpl(options.opencodeGoUsageUrl, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    // Never copy the response body into the reason: keep the key and the
    // account data out of error text.
    if (!response.ok) return unavailable(base, `usage request failed (HTTP ${response.status})`, checkedAt);
    return parseOpencodeGoUsage(await response.json(), instanceId, checkedAt);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return unavailable(
      base,
      name === "TimeoutError" ? "usage request timed out" : "usage request failed",
      checkedAt,
    );
  }
}

/**
 * Build the report from the T3 config, then run the probes for the enabled
 * instances that T3 reports no windows for. T3 data wins when it exists.
 */
export async function collectUsageReport(
  config: T3UsageLimitSource,
  options: UsageProbeOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<UsageReport> {
  const providers = config.providers ?? [];
  const fromT3 = providers.filter(hasT3Windows).map(fromT3Provider);
  const missing = providers.filter((p) => isActive(p) && !hasT3Windows(p));

  const probes: Array<Promise<ProviderUsage>> = [];
  const probed = new Set<T3Provider>();
  const antigravity = missing.find((p) => p.driver === "antigravity");
  if (antigravity && options.antigravityCli) {
    probed.add(antigravity);
    probes.push(probeAntigravity(options, antigravity.instanceId ?? null));
  }
  const opencode = missing.find((p) => p.driver === "opencode");
  if (opencode && options.opencodeGoApiKey) {
    probed.add(opencode);
    probes.push(probeOpencodeGo(options, opencode.instanceId ?? null, fetchImpl));
  }

  return {
    checkedAt: new Date().toISOString(),
    providers: [...fromT3, ...(await Promise.all(probes))],
    noUsageData: missing
      .filter((p) => !probed.has(p))
      .map((p) => p.displayName ?? p.instanceId ?? "provider"),
  };
}

/** Build a report from the T3 config only, with no probes. */
export function usageReportFromConfig(config: T3UsageLimitSource, checkedAt = new Date().toISOString()): UsageReport {
  const providers = config.providers ?? [];
  return {
    checkedAt,
    providers: providers.filter(hasT3Windows).map(fromT3Provider),
    noUsageData: providers
      .filter((p) => isActive(p) && !hasT3Windows(p))
      .map((p) => p.displayName ?? p.instanceId ?? "provider"),
  };
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

function formatWindow(win: UsageWindow, nowMs: number): string {
  const duration = win.windowMinutes ? ` ${Math.round(win.windowMinutes / 60)}h window` : "";
  const reset = win.resetsAt
    ? `, resets in ${formatRemaining(win.resetsAt, nowMs)} (at ${win.resetsAt})`
    : "";
  return `${win.label}:${duration} ${Math.round(win.usedPercent)}% used${reset}`;
}

/** Format a usage report into readable rows. */
export function formatUsageReport(report: UsageReport, nowMs = Date.now()): string {
  const lines: string[] = [];

  for (const provider of report.providers) {
    lines.push(`${provider.displayName}${provider.plan ? ` (${provider.plan})` : ""}`);
    const named = provider.pools.length > 1 || provider.pools.some((pool) => pool.name);
    for (const pool of provider.pools) {
      const indent = named ? "    " : "  ";
      if (named) {
        lines.push(`  ${pool.name ?? pool.id}${pool.models ? ` (${pool.models})` : ""}:`);
      }
      for (const win of pool.windows) lines.push(`${indent}${formatWindow(win, nowMs)}`);
    }
    if (provider.resetCredits && provider.resetCredits > 0) {
      lines.push(`  Reset credits available: ${provider.resetCredits}`);
    }
    if (provider.reason) {
      lines.push(`  Unavailable: ${provider.reason}`);
    }
  }

  if (report.noUsageData.length > 0) {
    lines.push(`No usage data: ${report.noUsageData.join(", ")}`);
  }

  if (lines.length === 0) return "(no usage limits reported)";
  return lines.join("\n");
}
