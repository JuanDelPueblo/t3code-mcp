#!/usr/bin/env node
/**
 * t3code-notify: Discord notification bridge for T3 Code threads.
 *
 * Watches T3's supported HTTP orchestration read model and posts a Discord
 * webhook message when a thread settles (turn finished, failed, or stopped)
 * or requests approval or user input. It discovers threads created by any
 * client and never reads T3's private database state.
 */

import { accessTokenProviderFromEnvironment } from "./auth.js";
import { NotifierState, observeThread } from "./notify-state.js";
import { T3Client } from "./t3client.js";

function fail(message: string): never {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

async function readSecretFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const value = (await readFile(path, "utf8")).trim();
  if (!value) fail(`Secret file is empty: ${path}`);
  return value;
}

const webhookUrl =
  process.env.T3CODE_DISCORD_WEBHOOK_URL ??
  (process.env.T3CODE_DISCORD_WEBHOOK_URL_FILE
    ? await readSecretFile(process.env.T3CODE_DISCORD_WEBHOOK_URL_FILE)
    : undefined);
if (!webhookUrl) fail("T3CODE_DISCORD_WEBHOOK_URL or T3CODE_DISCORD_WEBHOOK_URL_FILE is required");

const t3Url = readEnv("T3_CODE_URL") ?? "http://127.0.0.1:3000";
const publicUrl = readEnv("T3CODE_URL") ?? t3Url;

const pollMs = Number.parseInt(process.env.T3_NOTIFY_POLL_MS ?? "5000", 10);
if (!Number.isInteger(pollMs) || pollMs < 1000) {
  fail(`Invalid T3_NOTIFY_POLL_MS: ${process.env.T3_NOTIFY_POLL_MS}`);
}

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "t3code-notify",
};
if (process.env.T3CODE_DISCORD_WEBHOOK_URL && process.env.T3CODE_DISCORD_WEBHOOK_URL_FILE) {
  fail("Set only one of T3CODE_DISCORD_WEBHOOK_URL and T3CODE_DISCORD_WEBHOOK_URL_FILE");
}

const NOTIFICATION_TITLES: Record<string, string> = {
  "agent-finished": "T3 Code — agent finished",
  "agent-failed": "T3 Code — agent failed",
  "agent-stopped": "T3 Code — agent stopped",
  "approval-needed": "T3 Code — approval needed",
  "input-needed": "T3 Code — input needed",
};

async function deliver(notification: {
  kind: string;
  threadTitle: string;
  detail?: string;
}): Promise<void> {
  const title = NOTIFICATION_TITLES[notification.kind];
  if (!title) return;

  const lines = [`**${title}**`, notification.threadTitle];
  if (notification.detail) lines.push(notification.detail);
  lines.push(publicUrl);

  const response = await fetch(webhookUrl as string, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: lines.join("\n") }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Discord webhook failed (${response.status})`);
  }
}

const accessTokenProvider = await accessTokenProviderFromEnvironment(t3Url);
const client = new T3Client({ baseUrl: t3Url, accessTokenProvider });
const state = new NotifierState();

let stopped = false;

async function poll(): Promise<void> {
  const readModel = await client.getReadModel();
  const observations = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map(observeThread);

  for (const notification of state.ingest(observations)) {
    try {
      await deliver(notification);
      process.stderr.write(
        `notified ${notification.kind} thread=${notification.threadId}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `ERROR: delivery failed for ${notification.kind} thread=${notification.threadId}: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

async function run(): Promise<void> {
  while (!stopped) {
    try {
      await poll();
    } catch (error) {
      process.stderr.write(
        `ERROR: poll failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

const shutdown = () => {
  stopped = true;
  client.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.stderr.write(`t3code-notify watching ${t3Url} every ${pollMs}ms\n`);
await run();
