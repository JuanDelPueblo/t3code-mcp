/**
 * Provider usage limits for t3_get_usage_limits.
 *
 * T3 v0.0.44 reports subscription limits, including OpenCode Go, in its
 * server config. An optional read-only Antigravity CLI probe fills the gap
 * only when T3 has no native usage snapshot.
 *
 * Every source becomes one normalized UsageReport. The text output and the
 * structured output of the tool both come from that report. The report never
 * carries account emails or API keys.
 */

import { execFile } from "node:child_process";

export type UsageWindowKind = "session" | "weekly" | "monthly" | "other";
export type UsageSource = "t3" | "antigravity-cli";

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
  unavailableReason: string | null;
  checkedAt: string | null;
  resetCredits: number | null;
  externalUsage: { label: string; url: string } | null;
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
  externalUsage?: { label: string; url: string };
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
    if (typeof win.usedPercent !== "number" || !Number.isFinite(win.usedPercent)) continue;
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
    provider: provider.driver ?? provider.instanceId ?? "provider",
    instanceId: provider.instanceId ?? null,
    displayName: provider.displayName ?? provider.instanceId ?? "provider",
    plan: provider.auth?.label ?? null,
    source: "t3",
    available: windows.length > 0 && !limits.unavailable,
    reason: limits.unavailable?.message ?? limits.unavailable?.reason ??
      (windows.length === 0 ? "No usage windows reported" : null),
    unavailableReason: limits.unavailable?.reason ?? null,
    checkedAt: limits.checkedAt ?? null,
    resetCredits: typeof credits === "number" ? credits : null,
    externalUsage: limits.externalUsage ?? null,
    pools: windows.length > 0 ? [{
      id: "default", name: null,
      models: provider.driver === "opencode" && windows.every((win) => win.id.startsWith("go_"))
        ? "opencode-go/*" : null,
      windows,
    }] : [],
  };
}

function unavailable(
  base: Pick<ProviderUsage, "provider" | "instanceId" | "displayName" | "source">,
  reason: string,
  checkedAt: string,
): ProviderUsage {
  return { ...base, plan: null, available: false, reason, unavailableReason: "probeFailed", checkedAt, resetCredits: null, externalUsage: null, pools: [] };
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
    unavailableReason: available ? null : "probeFailed",
    checkedAt,
    resetCredits: null,
    externalUsage: null,
    pools,
  };
}

export interface UsageProbeOptions {
  /** Antigravity CLI command. `null` disables the probe. */
  antigravityCli: string | null;
  timeoutMs: number;
}

/** Read Antigravity probe options from the environment. */
export function usageProbeOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): UsageProbeOptions {
  const cli = env.T3_USAGE_ANTIGRAVITY_CLI ?? "agy";
  const timeout = Number.parseInt(env.T3_USAGE_PROBE_TIMEOUT_MS ?? "20000", 10);
  return {
    antigravityCli: cli === "" || cli === "off" ? null : cli,
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

/** A native usage snapshot is authoritative, including empty or unavailable limits. */
function hasT3Usage(provider: T3Provider): boolean {
  return provider.usageLimits != null;
}

/** Use T3's snapshots; only Antigravity may fall back to a local CLI probe. */
export async function collectUsageReport(
  config: T3UsageLimitSource,
  options: UsageProbeOptions,
): Promise<UsageReport> {
  const report = usageReportFromConfig(config);
  const missing = (config.providers ?? []).filter((p) => isActive(p) && !hasT3Usage(p));
  const antigravity = missing.find((p) => p.driver === "antigravity");
  if (antigravity && options.antigravityCli) {
    report.providers.push(await probeAntigravity(options, antigravity.instanceId ?? null));
    report.noUsageData = missing
      .filter((p) => p !== antigravity)
      .map((p) => p.displayName ?? p.instanceId ?? "provider");
  }
  return report;
}

/** Build a report from the T3 config only, with no probes. */
export function usageReportFromConfig(config: T3UsageLimitSource, checkedAt = new Date().toISOString()): UsageReport {
  const providers = (config.providers ?? []).filter(isActive);
  return {
    checkedAt,
    providers: providers.filter(hasT3Usage).map(fromT3Provider),
    noUsageData: providers
      .filter((p) => !hasT3Usage(p))
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

/** One provider refresh attempted before a usage read. */
export interface UsageRefresh {
  instanceId: string;
  /** status: a cheap status probe; models: T3's full rediscovery, which Claude needs. */
  method: "status" | "models";
  /** True when the provider's usage timestamp moved forward. */
  ok: boolean;
  checkedAt: string | null;
  error: string | null;
}

export interface UsageRefreshClient {
  getConfig(): Promise<unknown>;
  refreshProvider(instanceId: string, refreshModels: boolean): Promise<unknown>;
}

function usageCheckedAt(config: T3UsageLimitSource, instanceId: string): string | null {
  return config.providers?.find((p) => p.instanceId === instanceId)?.usageLimits?.checkedAt ?? null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms).unref()),
  ]);
}

/**
 * Ask T3 to refresh providers whose usage snapshot is older than maxAgeMs.
 * T3 updates usage only while a provider is in use, so an idle provider can
 * report hours-old windows. A status refresh updates most providers; Claude
 * reads usage from its agent initialization, so a provider whose timestamp
 * did not move gets one full refresh (refreshModels). Failures never fail the
 * read: the report then shows the older data with its checkedAt.
 */
export async function refreshStaleUsage(
  client: UsageRefreshClient,
  config: T3UsageLimitSource,
  options: { maxAgeMs: number; timeoutMs?: number; nowMs?: number },
): Promise<{ config: T3UsageLimitSource; refreshed: UsageRefresh[] }> {
  const nowMs = options.nowMs ?? Date.now();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const stale = (config.providers ?? []).filter((p) => {
    if (!isActive(p) || !hasT3Usage(p) || !p.instanceId) return false;
    const checked = Date.parse(p.usageLimits?.checkedAt ?? "");
    return !Number.isFinite(checked) || nowMs - checked > options.maxAgeMs;
  });
  if (stale.length === 0) return { config, refreshed: [] };

  const results = new Map<string, UsageRefresh>();
  const attempt = async (instanceId: string, refreshModels: boolean) => {
    try {
      await withTimeout(client.refreshProvider(instanceId, refreshModels), timeoutMs);
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  };

  let current = config;
  for (const method of ["status", "models"] as const) {
    const pending = stale
      .map((p) => p.instanceId as string)
      .filter((id) => !results.get(id)?.ok);
    if (pending.length === 0) break;
    const errors = await Promise.all(pending.map((id) => attempt(id, method === "models")));
    current = (await client.getConfig()) as T3UsageLimitSource;
    pending.forEach((id, index) => {
      const before = usageCheckedAt(config, id);
      const after = usageCheckedAt(current, id);
      results.set(id, { instanceId: id, method, ok: after !== null && after !== before, checkedAt: after, error: errors[index] });
    });
  }
  return { config: current, refreshed: [...results.values()] };
}
