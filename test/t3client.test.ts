import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { T3Client, type T3ReadModel } from "../src/t3client.js";
import type { AccessTokenProvider } from "../src/auth.js";

class StubTokenProvider implements AccessTokenProvider {
  issueCount = 0;
  invalidateCount = 0;

  async getAccessToken(): Promise<string> {
    return `token-${this.issueCount++}`;
  }

  invalidate(): boolean {
    this.invalidateCount++;
    return true;
  }
}

const readModelPayload: T3ReadModel = {
  snapshotSequence: 42,
  updatedAt: "2026-09-21T12:00:00.000Z",
  projects: [
    {
      id: "project-1",
      title: "Parser",
      workspaceRoot: "/srv/work/parser",
      createdAt: "2026-09-21T11:00:00.000Z",
      updatedAt: "2026-09-21T11:00:00.000Z",
    },
  ],
  threads: [
    {
      id: "thread-1",
      projectId: "project-1",
      title: "Fix the parser",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-09-21T11:00:00.000Z",
      updatedAt: "2026-09-21T11:30:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      activities: [],
      session: null,
    },
  ],
};

const threadSnapshotPayload = {
  snapshotSequence: 43,
  thread: { ...readModelPayload.threads[0], title: "Fix the parser (detail)" },
};

describe("T3Client HTTP orchestration API", () => {
  let server: Server;
  let baseUrl: string;
  let seenRequests: Array<{ path: string; authorization: string | undefined }> = [];
  let respondWith: (req: { path: string; authorization: string | undefined }) => {
    status: number;
    body: unknown;
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const record = {
        path: req.url ?? "/",
        authorization: req.headers.authorization,
      };
      seenRequests.push(record);
      const { status, body } = respondWith(record);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches the read model with a bearer token", async () => {
    seenRequests = [];
    respondWith = () => ({ status: 200, body: readModelPayload });
    const provider = new StubTokenProvider();
    const client = new T3Client({ baseUrl, accessTokenProvider: provider });

    const readModel = await client.getReadModel();

    expect(readModel.snapshotSequence).toBe(42);
    expect(readModel.threads[0].title).toBe("Fix the parser");
    expect(seenRequests).toEqual([
      { path: "/api/orchestration/snapshot", authorization: "Bearer token-0" },
    ]);
    client.close();
  });

  it("fetches a thread detail snapshot with an encoded thread ID and turnLimit", async () => {
    seenRequests = [];
    respondWith = () => ({ status: 200, body: threadSnapshotPayload });
    const client = new T3Client({
      baseUrl,
      accessTokenProvider: new StubTokenProvider(),
    });

    const snapshot = await client.getThreadSnapshot("thread/1 ?", 3);

    expect(snapshot.snapshotSequence).toBe(43);
    expect(snapshot.thread.title).toBe("Fix the parser (detail)");
    expect(seenRequests).toEqual([
      {
        path: "/api/orchestration/threads/thread%2F1%20%3F?turnLimit=3",
        authorization: "Bearer token-0",
      },
    ]);
    client.close();
  });

  it("mints a new token and retries once when the API returns 401", async () => {
    seenRequests = [];
    respondWith = ({ authorization }) => ({
      status: authorization === "Bearer token-0" ? 401 : 200,
      body: authorization === "Bearer token-0" ? { error: "stale token" } : readModelPayload,
    });
    const provider = new StubTokenProvider();
    const client = new T3Client({ baseUrl, accessTokenProvider: provider });

    const readModel = await client.getReadModel();

    expect(readModel.snapshotSequence).toBe(42);
    expect(provider.invalidateCount).toBe(1);
    expect(seenRequests.map((request) => request.authorization)).toEqual([
      "Bearer token-0",
      "Bearer token-1",
    ]);
    client.close();
  });

  it("surfaces non-auth HTTP errors without retrying", async () => {
    seenRequests = [];
    respondWith = () => ({ status: 500, body: { error: "boom" } });
    const provider = new StubTokenProvider();
    const client = new T3Client({ baseUrl, accessTokenProvider: provider });

    await expect(client.getReadModel()).rejects.toThrow(/500/);
    expect(provider.invalidateCount).toBe(0);
    expect(seenRequests).toHaveLength(1);
    client.close();
  });
});
