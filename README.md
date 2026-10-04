# t3code-mcp

MCP server for orchestrating [T3 Code](https://github.com/pingdotgg/t3code).

This fork targets the current T3 Code authentication and orchestration protocol used by
T3 v0.0.44 and v0.0.45 and supports both local stdio clients and a long-running Streamable HTTP service.

## MCP tools

- `t3_get_config` — inspect configured provider instances and model catalogs under `config.providers`
- `t3_get_usage_limits` — native T3 subscription usage, including OpenCode Go; optional Antigravity CLI fallback
- `t3_list_threads` — discover existing threads with their current state, including threads started from the T3 UI or another client
- `t3_get_thread` — immediate current snapshot of one thread: state, latest turn, messages, activities, and the provider's native session
- `t3_wait` — block until watched threads need attention (turn ended, approval or input requested, session error), without polling
- `t3_respond` — answer an open approval (accept, decline, …) or question of a thread
- `t3_rename_thread` — change an existing thread's title
- `t3_send_prompt` — create a project/thread and start a coding turn
- `t3_send_message` — start another turn on an existing thread, in the same provider session
- `t3_get_status` — immediate thread snapshot plus optional live event tail
- `t3_interrupt` — interrupt a running turn
- `t3_stop_session` — stop a provider session
- `t3_settle_thread` — mark a thread settled, or active again with `settled: false`

`t3_list_threads` and `t3_get_thread` use T3's supported HTTP orchestration API, so they
work for threads created by any client and return the current state without waiting for
new events. `t3_send_prompt` uses T3's native `instanceId + model` model selection with
`modelSelection.options` for reasoning/effort choices. Call
`t3_get_config` first instead of assuming a provider or model name.

## Structured output

Every tool advertises an object `outputSchema` and returns its result in
`structuredContent`. The single `content` text block is a JSON serialization
of exactly that object, so clients receive the same fields on either path.
Message and event text stays complete.

| Tool | Success fields |
| --- | --- |
| `t3_get_config` | `config`, preserving the complete server configuration and model catalogs |
| `t3_list_threads` | `projects`, `threads` |
| `t3_get_thread` | Thread summary, snapshot sequence, messages, activities, `lastAssistantMessage` |
| `t3_get_status` | Same detail fields as `t3_get_thread`, plus `events`, `waitMs` |
| `t3_send_prompt`, `t3_send_message` | Thread/project IDs, placement, turn/session state, `sequence`, `events`, `snapshotAvailable`, `snapshotSequence` |
| `t3_rename_thread` | `threadId`, `title`, `previousTitle`, `sequence` |
| `t3_interrupt`, `t3_stop_session`, `t3_settle_thread` | `threadId`, `action` (T3 command type), `sequence` |
| `t3_get_usage_limits` | `checkedAt`, normalized `providers`, `noUsageData` |

Lifecycle results acknowledge command dispatch; read the thread again to confirm
its state. Status snapshot fields describe the state before the optional event
tail. Turn-start results describe the snapshot read after the wait. If that read
fails, events and the dispatch sequence remain available, `snapshotAvailable`
is false, `snapshotSequence` is null, and turn/session state is `unknown`.
Compare `snapshotSequence` with the dispatch `sequence` to detect a snapshot
that has not yet caught up to the accepted command.

Every tool failure, including argument validation and unknown-tool errors,
returns `isError: true` and this object in both output paths:

```json
{ "error": { "message": "Description of the failure" } }
```

Check `isError` before interpreting the success schema.

Version 0.3.0 changes text-only responses to JSON, wraps the configuration in
`config`, and adds structured fields to the previously text-only tools. Clients
that parsed prose should switch to `structuredContent` or parse the JSON block.

## Sending prompts

`t3_send_prompt` creates a thread and starts a coding turn. With `workspaceRoot`
and no `projectId`, it reuses the active T3 project for that folder, or creates
one if none exists. It accepts
two option groups beyond the prompt, model, and project.

Pass `title` to give a new thread a name. Without `title`, the tool uses the
first 80 characters of the prompt. Use `t3_rename_thread` with a thread ID and
`title` to change the name of an existing thread.

Model options: pass `modelOptions` as an object keyed by option ID. Read the
valid IDs and values from the model's `capabilities.optionDescriptors` in
`t3_get_config`. Common IDs are:

- Reasoning: `reasoningEffort` (Codex), `effort` (Claude), `variant` (OpenCode)
- `serviceTier` (Codex), `fastMode` and `contextWindow` (Claude), `agent` (OpenCode)

Example: `{"effort": "high", "fastMode": true}`. Omit `modelOptions` to use
T3 defaults.

Worktrees: pass `baseBranch` (for example `main`) to create an isolated git
worktree for the thread. T3 checks out the worktree from the project
repository and reports the claimed path in the result. Optional refinements:

- `branch` — name the new branch (create mode), record the branch of a reused
  worktree (reuse mode), or record a branch on the project checkout
- `worktreePath` — reuse an existing worktree instead of creating one; it
  cannot combine with `baseBranch`
- `startFromOrigin` — fetch `baseBranch` from origin before creating
- `runSetupScript` — run the project setup script in a created worktree;
  defaults to true

`t3_list_threads` and `t3_get_thread` report each thread's branch and
worktree, so a later prompt can reuse the reported `worktreePath`. T3 leaves
created worktrees on disk after the thread settles. Remove them with
`git worktree remove` when done.

## Waiting without polling

A coordinator should never poll its workers. `t3_wait` blocks on T3's live
shell stream (`orchestration.subscribeShell`) and returns when the watched
threads need attention:

```json
{ "threadIds": ["worker-1", "reviewer-2"], "mode": "any", "until": "attention", "timeoutMs": 600000 }
```

- `mode`: `any` (default) returns when one thread is ready; `all` waits for every thread.
- `until`: `attention` (default) also wakes on a pending approval or user-input
  request; `turn-end` wakes only when the turn ends.
- `afterSequence`: ignore thread state older than this orchestration sequence.
  Pass the `sequence` from a send result to be sure the wait sees the new turn.
- `timeoutMs`: 1000 to 3600000; default 600000.

The check is level-triggered: a thread that already needs attention returns at
once, and a newer user message than the latest turn counts as a queued turn,
not an ended one. The result lists `ready` threads with a `reason`
(`turn-completed`, `turn-error`, `turn-interrupted`, `turn-ended`, `idle`,
`approval-requested`, `user-input-requested`, `session-error`, `not-found`) and
their `lastAssistantMessage`, plus the `pending` threads. T3 may report an
interrupted turn as `completed`.

`status` is `ready`, `timeout` (call `t3_wait` again), or `cancelled` (the
client cancelled the request). If T3 never answers during the wait, the tool
returns an error instead of a timeout. A dropped stream is resubscribed; the
new snapshot restores the full state.

`t3_send_prompt` and `t3_send_message` accept the same wait as `waitUntil`
(`attention` or `turn-end`) and `waitTimeoutMs`. The call then starts the turn
and returns only when that thread needs attention, with the result in `wait`.

While it waits, the server sends MCP progress notifications every 30 seconds
when the request carries a `progressToken`, and it stops when the client
cancels. Clients still apply their own tool timeout; set it above
`timeoutMs`:

| Client | Setting |
| --- | --- |
| Claude Code | `MCP_TOOL_TIMEOUT` environment variable, in milliseconds |
| Codex CLI | `tool_timeout_sec` under `[mcp_servers.t3code]` (default 60) |
| Hermes | `timeout` under `mcp_servers.t3code` |

## Answering approvals and questions

When a thread waits for a permission decision or asks a question, `t3_wait`
and `t3_get_thread` list it in `pendingRequests`:

- `requestId`, `kind` (`approval` or `user-input`), `summary`, `createdAt`
- approvals: `detail` (the command or tool call) and the offered `decisions`
- questions: `questions` with `id`, `question`, `options`, `allowCustomAnswer`

`t3_respond` answers one request:

```json
{ "threadId": "…", "requestId": "…", "decision": "acceptForSession" }
{ "threadId": "…", "requestId": "…", "answers": { "scope": "README.md" } }
{ "threadId": "…", "requestId": "…", "dismiss": true }
```

Decisions are `accept` (this request), `acceptForSession`, `acceptAlways`
(persists in the provider's own settings), `decline`, and `cancel`. The tool
refuses a request that is no longer open, a decision the provider did not
offer, and an unknown question ID. It dispatches T3's
`thread.approval.respond`, `thread.user-input.respond`, or
`thread.user-input.dismiss` command and returns its sequence. What an agent may
approve is a policy question for the caller, not for this server.

## Native sessions

T3's APIs do not report the provider's own session ID. `t3_get_thread` reads
it read-only from T3's local state database
(`<T3 home>/userdata/state.sqlite`, table `provider_session_runtime`) and
returns `nativeSession`:

- `nativeSessionId`: the Claude session ID, the Codex thread ID, or the
  OpenCode or Antigravity session ID
- `resumeCursor`: T3's raw resume cursor
- `provider`, `instanceId`, `status`, `lastSeenAt`

This is a private schema, so the lookup returns `null` instead of failing when
the database, table, or row is missing. The path comes from `T3_STATE_DB`, or
`T3CODE_HOME` / `T3_CODE_BASE_DIR` plus `userdata/state.sqlite`. Set
`T3_STATE_DB=""` to turn it off.

## Follow-up messages

`t3_send_message` starts another turn on an existing thread. The agent
continues in the same provider session, so it keeps its context, and the turn
uses the model, runtime mode, interaction mode, and worktree of the thread.
It never creates a new project, thread, branch, or worktree. Use it to wake
or reuse a worker thread, to wake an idle orchestrator thread, or to send
review findings back to the agent that did the work.

The tool refuses a thread with a running turn. Wait for the turn to settle, or
call `t3_interrupt` first.

`waitMs` sets how long the call collects response events before it returns;
default 30000. `structuredContent` gives the turn state after that wait.

Intended usage:

```text
t3_send_prompt → create worker thread
t3_wait([workerThreadId]) → blocks until the worker needs attention
t3_send_message(workerThreadId, "...", waitUntil: "attention") → revise and wait

t3_send_message(orchestratorThreadId, "WORKER_DONE ...")
→ wake an existing orchestrator thread
```

## Usage limits

T3 updates a provider's usage only while that provider is in use, so an idle
provider can report windows that are hours old. By default,
`t3_get_usage_limits` first asks T3 to refresh every provider whose usage is
older than `maxAgeMs` (default 300000). It tries a status refresh, then, for a
provider whose timestamp did not move (Claude reads usage at agent start), one
full refresh with `refreshModels`. `refreshed` lists each attempt with
`instanceId`, `method` (`status` or `models`), `ok`, `checkedAt`, and `error`.
A failed refresh never fails the read; check each provider's `checkedAt`. Pass
`refresh: false` to read T3's snapshot as is.

`t3_get_usage_limits` returns this object as `structuredContent` and JSON text:

```json
{
  "checkedAt": "2026-09-25T23:30:00.000Z",
  "providers": [
    {
      "provider": "antigravity",
      "instanceId": "antigravity",
      "displayName": "Antigravity",
      "plan": null,
      "source": "antigravity-cli",
      "available": true,
      "reason": null,
      "unavailableReason": null,
      "checkedAt": "2026-09-25T23:30:00.000Z",
      "resetCredits": null,
      "externalUsage": null,
      "pools": [
        {
          "id": "gemini-models",
          "name": "Gemini Models",
          "models": "Gemini Flash, Gemini Pro",
          "windows": [
            {
              "id": "gemini-5h",
              "kind": "session",
              "label": "Session",
              "usedPercent": 21,
              "remainingPercent": 79,
              "resetsAt": "2026-09-26T00:10:54Z",
              "windowMinutes": 300
            }
          ]
        }
      ]
    }
  ],
  "noUsageData": []
}
```

Every model in one pool shares the windows of that pool. `kind` is `session`
(a 5 hour or rolling window), `weekly`, `monthly`, or `other`. A provider with
`available: false` gives the cause in `reason`. The report never holds account
emails or API keys.

T3 v0.0.44 provides OpenCode Go quota directly in each OpenCode instance's
`usageLimits`. The MCP uses that snapshot with `source: "t3"`, preserving the
`go_rolling`, `go_weekly`, and `go_monthly` window IDs, labels, durations, reset
times, and checked time. `provider` identifies the driver; `instanceId`
identifies the configured instance. Different instances remain separate.

Native snapshots are authoritative, including empty windows, `unsupported`,
and `probeFailed`. `unavailableReason` preserves the server's machine-readable
reason; `reason` carries its message when present. Retained windows may appear
with `available: false` after a failed probe. `externalUsage` preserves any
provider dashboard link. Disabled instances are excluded. `noUsageData` lists
enabled instances with no native snapshot and no configured fallback.

T3 reads OpenCode Go credentials in its own environment. Remote OpenCode
servers report unsupported limits; the MCP does not read local credentials for
them. The quota covers only `opencode-go/*` models, reflected in the pool's
`models` field. See the [v0.0.44 implementation](https://github.com/pingdotgg/t3code/blob/v0.0.44/apps/server/src/provider/Layers/openCodeUsageLimits.ts).

Only Antigravity has a fallback probe: `agy --print /usage --output-format json`
uses the authentication of the user running the MCP server, and runs only for an
enabled Antigravity instance with no native usage snapshot. Configure
`T3_USAGE_ANTIGRAVITY_CLI` (default `agy`, `off` disables) and
`T3_USAGE_PROBE_TIMEOUT_MS` (default `20000`).

The MCP no longer reads `OPENCODE_GO_API_KEY`, `OPENCODE_GO_API_KEY_FILE`,
`OPENCODE_GO_USAGE_URL`, or the `opencode-go-api-key` systemd credential. Remove
these from bridge settings; configure credentials in T3's OpenCode environment.
The Nix option `services.t3code-mcp.opencodeGoApiKeyFile` has been removed.

## Authentication

The server accepts three authentication modes, in this order:

1. `T3_CODE_ACCESS_TOKEN` or `T3_CODE_ACCESS_TOKEN_FILE` — an existing bearer access token.
2. `T3_CODE_TOKEN` or `T3_CODE_TOKEN_FILE` — a one-time pairing/bootstrap credential.
3. `T3_CODE_BASE_DIR` — local mode. The server runs the T3 CLI to mint a short-lived,
   one-time pairing credential and exchanges it for a normal bearer session.

Local mode is intended for a system service running on the same machine as T3. It does not
store a long-lived MCP credential. If the bearer session expires, the server can mint a fresh
pairing credential automatically.

Optional local-mode variables:

- `T3_CODE_CLI` — T3 CLI executable, default `t3`
- `T3_CODE_PAIRING_TTL` — pairing credential TTL, default `5m`
- `T3_CODE_PAIRING_LABEL` — label shown in T3 auth state, default `t3code-mcp`

The T3 server URL is configured with `T3_CODE_URL` and defaults to
`http://127.0.0.1:3000`.

## Transports

### stdio

stdio remains the default for clients that spawn the MCP server themselves:

```bash
T3_CODE_URL=http://127.0.0.1:3000 \
T3_CODE_TOKEN='pairing-credential' \
t3code-mcp
```

### Streamable HTTP

For a persistent local service:

```bash
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_HTTP_PORT=8732 \
MCP_HTTP_PATH=/mcp \
T3_CODE_URL=http://127.0.0.1:8731 \
T3_CODE_BASE_DIR=/var/lib/t3code \
T3_CODE_CLI=/path/to/t3 \
t3code-mcp
```

The endpoint is then `http://127.0.0.1:8732/mcp`.

### The start script

`scripts/serve-http.sh` sets every variable above and starts the HTTP service:

```bash
./scripts/serve-http.sh            # start
./scripts/serve-http.sh --check    # print the resolved settings, start nothing
```

The script keeps any value you export first, so each setting stays
overridable:

```bash
MCP_HTTP_PORT=9000 ./scripts/serve-http.sh
```

It reads the T3 port from `~/.t3/userdata/server-runtime.json`. The T3 desktop
application picks a new port at each start, so a fixed `T3_CODE_URL` fails
after a restart. Set `T3_RUNTIME_FILE` to use a different runtime file.

The script defaults to local pairing. OpenCode Go usage and authentication
are managed by T3 Code.

`--check` reports a warning and exit code 1 when T3 does not answer, or when
the T3 CLI or the base directory is absent. It never prints a token or a key.

## Harness configuration

A T3 worker can call the HTTP bridge through a project script.
A harness can also load this MCP server directly.
Each harness keeps its own MCP configuration.

| Harness | Transport | Where |
| --- | --- | --- |
| Claude Code | streamable HTTP | `.mcp.json` in the project |
| Codex CLI | streamable HTTP | `~/.codex/config.toml`, `[mcp_servers.t3code]` |
| OpenCode | streamable HTTP | `opencode.json` in the project, `mcp.t3code` |
| Antigravity | stdio | `~/.gemini/config/mcp_config.json` |

Antigravity supports stdio and SSE only. It cannot use streamable HTTP, so it
runs `scripts/mcp-stdio.sh` instead of the shared HTTP service.

Commands that write these entries:

```bash
codex mcp add t3code --url http://127.0.0.1:8732/mcp
```

Put the project files in Git. T3 runs a worker in a new worktree, and a
worktree gets only the files that Git holds. A configuration outside Git
leaves the worker with no way to send a message.

Check each harness:

```bash
codex mcp get t3code
opencode mcp list
```

## Deployment on Fedora

The Fedora host runs the bridge as the user unit `t3code-mcp.service` from
`/opt/t3code-mcp`. `scripts/deploy.sh` type-checks, tests, and builds the
checkout, installs it there with production dependencies (sudo), restarts the
unit, and checks that the new tool list is served:

```bash
scripts/deploy.sh
```

## Nix

The repository carries a native package and NixOS module:

- `nix/package.nix`
- `nix/module.nix`

Example NixOS usage when the repository is available as a source path:

```nix
{
  imports = [ /path/to/t3code-mcp/nix/module.nix ];

  services.t3code-mcp = {
    enable = true;
    user = "t3";
    group = "t3";
    createUser = false;

    listenAddress = "127.0.0.1";
    port = 8732;

    t3Url = "http://127.0.0.1:8731";
    t3BaseDir = "/var/lib/t3code";
    t3Command = "/path/to/t3";
    after = [ "t3code.service" ];
    requires = [ "t3code.service" ];

    # Optional Antigravity fallback for t3_get_usage_limits.
    antigravityCommand = null;  # the service user needs its own agy login
  };
}
```

The service uses Streamable HTTP and is hardened with systemd. Only the MCP service needs
write access to the T3 base directory for local pairing; MCP clients do not.

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## Protocol notes

T3 v0.0.44 uses:

- OAuth token exchange at `/oauth/token`
- WebSocket tickets at `/api/auth/websocket-ticket`
- `/ws?wsTicket=...` (the old `orchestrationProtocol` parameter is gone)
- Effect RPC JSON messages with `requestId` on responses
- batched stream `Chunk.values` with client acknowledgements
- `orchestration.subscribeThread` streams `{kind: "snapshot"}`, `{kind: "synchronized"}`,
  and `{kind: "event"}` items
- `orchestration.subscribeShell` streams `{kind: "snapshot"}` (every project and thread
  summary) and then `{kind: "thread-upserted" | "project-upserted", sequence, ...}` items;
  thread summaries carry `hasPendingApprovals`, `hasPendingUserInput`, and `latestUserMessageAt`
- HTTP orchestration API with bearer auth:
  - `GET /api/orchestration/snapshot` — full read model of projects and threads
  - `GET /api/orchestration/threads/:threadId` — one thread's detail snapshot
  - `POST /api/orchestration/dispatch` — command dispatch

Thread discovery and status tools use the HTTP API instead of private state, so upgrades
of T3 do not silently break the integration.

## License

MIT
