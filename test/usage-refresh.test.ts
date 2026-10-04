import { describe, expect, it, vi } from "vitest";
import { refreshStaleUsage, type T3UsageLimitSource } from "../src/usage.js";

const now = Date.parse("2026-10-04T03:00:00.000Z");
const provider = (instanceId: string, checkedAt: string | undefined, extra: Record<string, unknown> = {}) => ({
  instanceId, driver: instanceId, enabled: true, status: "ready",
  usageLimits: checkedAt === undefined ? undefined : { checkedAt, windows: [] }, ...extra,
});

/** A fake T3 that advances a provider's usage timestamp on the refresh kinds it honors. */
function fakeT3(initial: T3UsageLimitSource, honors: Record<string, "status" | "models" | "never">) {
  let config = structuredClone(initial);
  const calls: Array<[string, boolean]> = [];
  return {
    calls,
    getConfig: vi.fn(async () => structuredClone(config)),
    refreshProvider: vi.fn(async (instanceId: string, refreshModels: boolean) => {
      calls.push([instanceId, refreshModels]);
      if (honors[instanceId] === "never") throw new Error("probe failed");
      if (honors[instanceId] === "status" || (honors[instanceId] === "models" && refreshModels)) {
        config = { providers: config.providers?.map((p) => p.instanceId === instanceId
          ? { ...p, usageLimits: { ...p.usageLimits, checkedAt: "2026-10-04T03:00:01.000Z" } } : p) };
      }
    }),
  };
}

describe("refreshStaleUsage", () => {
  it("refreshes only stale providers, escalating to a full refresh when needed", async () => {
    const config = { providers: [
      provider("codex", "2026-10-04T02:58:00.000Z"),
      provider("opencode", "2026-10-03T19:13:26.795Z"),
      provider("claudeAgent", "2026-10-03T19:33:39.019Z"),
      provider("antigravity", undefined),
      provider("cursor", "2026-10-01T00:00:00.000Z", { enabled: false }),
    ] };
    const t3 = fakeT3(config, { opencode: "status", claudeAgent: "models" });
    const { config: after, refreshed } = await refreshStaleUsage(t3, config, { maxAgeMs: 300_000, nowMs: now });
    expect(t3.calls).toEqual([["opencode", false], ["claudeAgent", false], ["claudeAgent", true]]);
    expect(refreshed).toEqual([
      { instanceId: "opencode", method: "status", ok: true, checkedAt: "2026-10-04T03:00:01.000Z", error: null },
      { instanceId: "claudeAgent", method: "models", ok: true, checkedAt: "2026-10-04T03:00:01.000Z", error: null },
    ]);
    expect(after.providers?.find((p) => p.instanceId === "claudeAgent")?.usageLimits?.checkedAt)
      .toBe("2026-10-04T03:00:01.000Z");
  });

  it("keeps the old data and reports the error when a refresh fails", async () => {
    const config = { providers: [provider("opencode", "2026-10-03T19:13:26.795Z")] };
    const t3 = fakeT3(config, { opencode: "never" });
    const { refreshed } = await refreshStaleUsage(t3, config, { maxAgeMs: 300_000, nowMs: now });
    expect(refreshed).toEqual([{ instanceId: "opencode", method: "models", ok: false,
      checkedAt: "2026-10-03T19:13:26.795Z", error: "probe failed" }]);
  });

  it("does nothing when every snapshot is fresh", async () => {
    const config = { providers: [provider("codex", "2026-10-04T02:59:00.000Z")] };
    const t3 = fakeT3(config, {});
    expect(await refreshStaleUsage(t3, config, { maxAgeMs: 300_000, nowMs: now })).toEqual({ config, refreshed: [] });
    expect(t3.getConfig).not.toHaveBeenCalled();
  });
});
