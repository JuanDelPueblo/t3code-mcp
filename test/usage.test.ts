import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectUsageReport,
  formatUsageReport,
  parseAntigravityUsage,
  parseOpencodeGoUsage,
  usageProbeOptionsFromEnvironment,
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

const opencodeGoOutput = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-09-26T03:34:42.152Z" },
    weekly: { status: "ok", percent: 56, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "ok", percent: 28, resetsAt: "2026-10-20T15:36:40.000Z" },
  },
};

const t3Config = {
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
    { instanceId: "opencode", driver: "opencode", displayName: "OpenCode", status: "ready", enabled: true },
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

describe("parseOpencodeGoUsage", () => {
  it("reads percent as used quota", () => {
    const usage = parseOpencodeGoUsage(opencodeGoOutput, "opencode", checkedAt);
    expect(usage.available).toBe(true);
    expect(usage.pools[0].models).toBe("opencode-go/*");
    expect(usage.pools[0].windows.map((win) => [win.id, win.kind, win.usedPercent, win.remainingPercent])).toEqual([
      ["rolling", "session", 0, 100],
      ["weekly", "weekly", 56, 44],
      ["monthly", "monthly", 28, 72],
    ]);
  });

  it("reports unavailable when a window is not ok or the response is malformed", () => {
    const limited = {
      usage: { ...opencodeGoOutput.usage, weekly: { status: "rate_limited", percent: 100, resetsAt: null } },
    };
    expect(parseOpencodeGoUsage(limited, null, checkedAt)).toMatchObject({
      available: false,
      reason: "window status not ok: weekly=rate_limited",
      pools: [],
    });
    expect(parseOpencodeGoUsage({}, null, checkedAt).available).toBe(false);
  });
});

describe("usageProbeOptionsFromEnvironment", () => {
  it("defaults to agy and no OpenCode Go key", () => {
    const options = usageProbeOptionsFromEnvironment({});
    expect(options.antigravityCli).toBe("agy");
    expect(options.opencodeGoApiKey).toBeNull();
    expect(options.opencodeGoUsageUrl).toBe("https://opencode.ai/zen/go/v1/usage");
  });

  it("disables the Antigravity probe with off", () => {
    expect(usageProbeOptionsFromEnvironment({ T3_USAGE_ANTIGRAVITY_CLI: "off" }).antigravityCli).toBeNull();
  });
});

describe("collectUsageReport", () => {
  let dir: string;
  let agy: string;
  let keyFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "t3code-mcp-usage-"));
    agy = join(dir, "agy");
    writeFileSync(join(dir, "agy.json"), JSON.stringify(agyOutput));
    writeFileSync(agy, `#!/bin/sh\necho "log line before the JSON"\ncat "${join(dir, "agy.json")}"\n`);
    chmodSync(agy, 0o755);
    keyFile = join(dir, "key");
    writeFileSync(keyFile, "secret-key-value\n");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function options(overrides: Partial<UsageProbeOptions> = {}): UsageProbeOptions {
    return {
      ...usageProbeOptionsFromEnvironment({ T3_USAGE_ANTIGRAVITY_CLI: agy, OPENCODE_GO_API_KEY_FILE: keyFile }),
      ...overrides,
    };
  }

  it("merges T3 data with both probes and keeps secrets out of the report", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchStub = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(opencodeGoOutput), { status: 200 });
    }) as typeof fetch;

    const report = await collectUsageReport(t3Config, options(), fetchStub);
    expect(report.providers.map((p) => [p.provider, p.instanceId, p.source, p.available])).toEqual([
      ["codex", "codex", "t3", true],
      ["antigravity", "antigravity", "antigravity-cli", true],
      ["opencode-go", "opencode", "opencode-go-api", true],
    ]);
    expect(report.noUsageData).toEqual([]);
    expect(seen).toEqual([{ url: "https://opencode.ai/zen/go/v1/usage", auth: "Bearer secret-key-value" }]);

    const json = JSON.stringify(report);
    const text = formatUsageReport(report, nowMs);
    for (const output of [json, text]) {
      expect(output).not.toContain("secret-key-value");
      expect(output).not.toContain("someone@example.com");
    }
    expect(text).toContain("Codex (ChatGPT Plus Subscription)");
    expect(text).toContain("  Gemini Models (Gemini Flash, Gemini Pro):\n    Weekly: 168h window 36% used");
    expect(text).toContain("OpenCode Go\n  Rolling: 0% used");
  });

  it("reports a failed probe as unavailable with no response detail", async () => {
    const fetchStub = (async () => new Response("key secret-key-value is invalid", { status: 401 })) as typeof fetch;
    const report = await collectUsageReport(
      t3Config,
      options({ antigravityCli: join(dir, "missing-agy") }),
      fetchStub,
    );
    const antigravity = report.providers.find((p) => p.provider === "antigravity")!;
    const opencode = report.providers.find((p) => p.provider === "opencode-go")!;
    expect(antigravity.available).toBe(false);
    expect(antigravity.reason).toContain("missing-agy failed");
    expect(opencode).toMatchObject({ available: false, reason: "usage request failed (HTTP 401)" });
    expect(JSON.stringify(report)).not.toContain("secret-key-value");
  });

  it("skips disabled probes and lists those providers as having no usage data", async () => {
    const report = await collectUsageReport(t3Config, options({ antigravityCli: null, opencodeGoApiKey: null }));
    expect(report.providers.map((p) => p.provider)).toEqual(["codex"]);
    expect(report.noUsageData).toEqual(["OpenCode", "Antigravity"]);
  });
});
