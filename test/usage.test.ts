import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { usageReportOutputSchema } from "../src/tools.js";
import {
  collectUsageReport,
  formatUsageReport,
  parseAntigravityUsage,
  usageProbeOptionsFromEnvironment,
  usageReportFromConfig,
  type T3UsageLimitSource,
  type UsageProbeOptions,
} from "../src/usage.js";

const checkedAt = "2026-09-25T23:30:00.000Z";
const nowMs = Date.parse(checkedAt);

const agyOutput = {
  status: "SUCCESS",
  command: {
    data: {
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.6376, reset_time: "2026-09-30T13:49:04Z" },
            { id: "gemini-5h", window: "5h", remaining_fraction: 0.79, reset_time: "2026-09-26T00:10:54Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            { id: "3p-weekly", window: "weekly", remaining_fraction: 0.753, reset_time: "2026-10-02T16:52:21Z" },
            { id: "3p-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-09-26T04:24:19Z" },
          ],
        },
      ],
    },
  },
};

// Native OpenCode Go snapshot from T3 v0.0.44's OpenCodeDriver.
const openCodeLimits = {
  checkedAt,
  windows: [
    { id: "go_rolling", kind: "session" as const, label: "Go · Session", usedPercent: 0,
      windowDurationMins: 300, resetsAt: "2026-09-26T03:34:42.152Z" },
    { id: "go_weekly", kind: "weekly" as const, label: "Go · Weekly", usedPercent: 56,
      windowDurationMins: 10080, resetsAt: "2026-09-28T00:00:00.000Z" },
    { id: "go_monthly", kind: "monthly" as const, label: "Go · Monthly", usedPercent: 28,
      resetsAt: "2026-10-20T15:36:40.000Z" },
  ],
};

const t3Config: T3UsageLimitSource = {
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      status: "ready",
      enabled: true,
      auth: { label: "ChatGPT Plus Subscription", email: "someone@example.com" },
      usageLimits: {
        checkedAt,
        windows: [
          { id: "primary", kind: "session" as const, usedPercent: 12, windowDurationMins: 300, resetsAt: "2026-09-26T04:21:23.000Z" },
          { id: "secondary", kind: "weekly" as const, usedPercent: 63, windowDurationMins: 10080, resetsAt: "2026-09-29T15:08:47.000Z" },
        ],
      },
    },
    { instanceId: "opencode", driver: "opencode", displayName: "OpenCode", status: "ready", enabled: true, usageLimits: openCodeLimits },
    { instanceId: "antigravity", driver: "antigravity", displayName: "Antigravity", status: "ready", enabled: true },
    { instanceId: "cursor", driver: "cursor", displayName: "Cursor", status: "disabled", enabled: false },
  ],
};

describe("parseAntigravityUsage", () => {
  it("keeps each group as one shared pool and converts remaining to used", () => {
    const usage = parseAntigravityUsage(agyOutput, "antigravity", checkedAt);
    expect(usage.available).toBe(true);
    expect(usage.pools.map((pool) => pool.name)).toEqual(["Gemini Models", "Claude and GPT models"]);
    expect(usage.pools[0].models).toBe("Gemini Flash, Gemini Pro");

    const session = usage.pools[0].windows.find((win) => win.id === "gemini-5h")!;
    expect(session).toMatchObject({ kind: "session", windowMinutes: 300, usedPercent: 21, remainingPercent: 79 });
    const weekly = usage.pools[1].windows.find((win) => win.id === "3p-weekly")!;
    expect(weekly).toMatchObject({ kind: "weekly", windowMinutes: 10080, usedPercent: 24.7, remainingPercent: 75.3 });
  });

  it("reports unavailable for a failed status or no groups", () => {
    expect(parseAntigravityUsage({ status: "ERROR" }, null, checkedAt)).toMatchObject({
      available: false,
      reason: "agy status is ERROR, not SUCCESS",
    });
    expect(parseAntigravityUsage({ status: "SUCCESS", command: { data: { groups: [] } } }, null, checkedAt))
      .toMatchObject({ available: false, reason: "agy returned no quota groups" });
    expect(parseAntigravityUsage(null, null, checkedAt).available).toBe(false);
  });
});

describe("usageProbeOptionsFromEnvironment", () => {
  it("defaults to only the Antigravity probe", () => {
    const options = usageProbeOptionsFromEnvironment({});
    expect(options.antigravityCli).toBe("agy");
    expect(options).toEqual({ antigravityCli: "agy", timeoutMs: 20000 });
    expect(usageProbeOptionsFromEnvironment({
      OPENCODE_GO_API_KEY: "unused-secret", OPENCODE_GO_API_KEY_FILE: "/missing/key",
      OPENCODE_GO_USAGE_URL: "https://example.invalid", CREDENTIALS_DIRECTORY: "/missing/credentials",
    })).toEqual(options);
  });

  it("disables the Antigravity probe with off", () => {
    expect(usageProbeOptionsFromEnvironment({ T3_USAGE_ANTIGRAVITY_CLI: "off" }).antigravityCli).toBeNull();
  });
});

describe("collectUsageReport", () => {
  let dir: string;
  let agy: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "t3code-mcp-usage-"));
    agy = join(dir, "agy");
    writeFileSync(join(dir, "agy.json"), JSON.stringify(agyOutput));
    writeFileSync(agy, `#!/bin/sh\necho "log line before the JSON"\ncat "${join(dir, "agy.json")}"\n`);
    chmodSync(agy, 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function options(overrides: Partial<UsageProbeOptions> = {}): UsageProbeOptions {
    return {
      ...usageProbeOptionsFromEnvironment({ T3_USAGE_ANTIGRAVITY_CLI: agy }),
      ...overrides,
    };
  }

  it("uses native OpenCode Go limits and merges only the Antigravity fallback", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No local HTTP probe allowed"));
    try {
      const report = await collectUsageReport(t3Config, options());
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(report.providers.map((p) => [p.provider, p.instanceId, p.source, p.available])).toEqual([
        ["codex", "codex", "t3", true],
        ["opencode", "opencode", "t3", true],
        ["antigravity", "antigravity", "antigravity-cli", true],
      ]);
      expect(report.noUsageData).toEqual([]);
      expect(() => z.object(usageReportOutputSchema).strict().parse(report)).not.toThrow();
      const openCode = report.providers.find((p) => p.provider === "opencode")!;
      expect(openCode.pools[0].models).toBe("opencode-go/*");
      expect(openCode.pools[0].windows.map((win) =>
        [win.id, win.kind, win.usedPercent, win.remainingPercent, win.windowMinutes])).toEqual([
        ["go_rolling", "session", 0, 100, 300],
        ["go_weekly", "weekly", 56, 44, 10080],
        ["go_monthly", "monthly", 28, 72, null],
      ]);
      expect(openCode.checkedAt).toBe(checkedAt);
      expect(openCode.pools[0].windows[0].resetsAt).toBe(openCodeLimits.windows[0].resetsAt);
      const json = JSON.stringify(report);
      const text = formatUsageReport(report, nowMs);
      for (const output of [json, text]) expect(output).not.toContain("someone@example.com");
      expect(text).toContain("Codex (ChatGPT Plus Subscription)");
      expect(text).toContain("  Gemini Models (Gemini Flash, Gemini Pro):\n    Weekly: 168h window 36% used");
      expect(text).toContain("Go · Session: 5h window 0% used");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reports a failed Antigravity probe without replacing native OpenCode limits", async () => {
    const report = await collectUsageReport(t3Config, options({ antigravityCli: join(dir, "missing-agy") }));
    const antigravity = report.providers.find((p) => p.provider === "antigravity")!;
    expect(antigravity.available).toBe(false);
    expect(antigravity.reason).toContain("missing-agy failed");
    expect(report.providers.find((p) => p.provider === "opencode")?.available).toBe(true);
  });

  it("skips disabled providers and lists missing usage sources", async () => {
    const report = await collectUsageReport(t3Config, options({ antigravityCli: null }));
    expect(report.providers.map((p) => p.provider)).toEqual(["codex", "opencode"]);
    expect(report.noUsageData).toEqual(["Antigravity"]);
  });

  it.each(["unsupported", "probeFailed"])("preserves native %s without probing or fabricating quota", async (reason) => {
    const config: T3UsageLimitSource = { providers: [{
      instanceId: "remote-opencode", driver: "opencode", enabled: true,
      usageLimits: { checkedAt, windows: [], unavailable: { reason } },
    }] };
    const report = await collectUsageReport(config, options());
    expect(report.providers).toEqual([expect.objectContaining({
      provider: "opencode", instanceId: "remote-opencode", source: "t3",
      checkedAt, available: false, reason, unavailableReason: reason, pools: [],
    })]);
    expect(report.noUsageData).toEqual([]);
  });

  it("keeps separate native instances, labels, empty snapshots, and external usage links", async () => {
    const config: T3UsageLimitSource = { providers: [
      { instanceId: "local", driver: "opencode", displayName: "Local Go", usageLimits: openCodeLimits },
      { instanceId: "remote", driver: "opencode", displayName: "Remote", usageLimits: {
        checkedAt, windows: [], unavailable: { reason: "unsupported" },
      } },
      { instanceId: "empty", driver: "opencode", usageLimits: { checkedAt, windows: [] } },
      { instanceId: "external", driver: "cursor", usageLimits: { checkedAt, windows: [],
        externalUsage: { label: "Dashboard", url: "https://example.com/usage" },
      } },
      { instanceId: "disabled", driver: "opencode", enabled: false, usageLimits: openCodeLimits },
      { instanceId: "missing", driver: "opencode", enabled: true },
    ] };
    const report = await collectUsageReport(config, options());
    expect(report.providers.map((p) => p.instanceId)).toEqual(["local", "remote", "empty", "external"]);
    expect(report.providers[0].displayName).toBe("Local Go");
    expect(report.providers[2]).toMatchObject({ available: false, reason: "No usage windows reported", checkedAt });
    expect(report.providers[3].externalUsage).toEqual({ label: "Dashboard", url: "https://example.com/usage" });
    expect(report.noUsageData).toEqual(["missing"]);
    expect(() => z.object(usageReportOutputSchema).strict().parse(report)).not.toThrow();
  });

  it("does not mark retained windows current after a failed native probe", () => {
    const report = usageReportFromConfig({ providers: [{ instanceId: "opencode", driver: "opencode",
      usageLimits: { ...openCodeLimits, unavailable: { reason: "probeFailed", message: "OpenCode Go could not read usage." } },
    }] });
    expect(report.providers[0]).toMatchObject({ available: false, unavailableReason: "probeFailed", reason: "OpenCode Go could not read usage." });
    expect(report.providers[0].pools[0].windows).toHaveLength(3);
  });

  it("uses all native data before attempting any fallback", async () => {
    const report = await collectUsageReport({ providers: [{ instanceId: "antigravity", driver: "antigravity",
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
    }] }, options({ antigravityCli: join(dir, "missing-agy") }));
    expect(report.providers[0]).toMatchObject({ source: "t3", reason: "unsupported" });
  });
});
