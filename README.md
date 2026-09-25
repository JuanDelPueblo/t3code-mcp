# t3code-mcp

MCP server for orchestrating [T3 Code](https://github.com/pingdotgg/t3code).

This fork targets the current T3 Code authentication and orchestration protocol used by
T3 v0.0.42 and supports both local stdio clients and a long-running Streamable HTTP service.

## MCP tools

- `t3_get_config` — inspect configured provider instances and model catalogs
- `t3_get_usage_limits` — provider subscription usage: Codex/ChatGPT and Claude Code from T3, plus Antigravity and OpenCode Go from their own usage sources. Text plus `structuredContent`
- `t3_list_threads` — discover existing threads with their current state, including threads started from the T3 UI or another client
- `t3_get_thread` — immediate current snapshot of one thread: state, latest turn, messages, activities
- `t3_send_prompt` — create a project/thread and start a coding turn
- `t3_send_message` — start a follow-up turn in an existing thread, in the same provider session
- `t3_get_status` — immediate thread snapshot plus optional live event tail
- `t3_interrupt` — interrupt a running turn
- `t3_stop_session` — stop a provider session

`t3_list_threads` and `t3_get_thread` use T3's supported HTTP orchestration API, so they
work for threads created by any client and return the current state without waiting for
new events. `t3_send_prompt` uses T3's native `instanceId + model` model selection with
`modelSelection.options` for reasoning/effort choices. Call
`t3_get_config` first instead of assuming a provider or model name.

## Sending prompts

`t3_send_prompt` creates a project/thread and starts a coding turn. It accepts
two option groups beyond the prompt, model, and project.

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

## Follow-up messages

`t3_send_message` sends a new message to an existing thread. The agent
continues in the same provider session, so it keeps its context, and the turn
uses the model, runtime mode, interaction mode, and worktree of the thread.
Use it to send review findings back to the agent that did the work.

The tool refuses a thread with a running turn. Wait for the turn to settle, or
call `t3_interrupt` first.

## Usage limits

`t3_get_usage_limits` returns readable text and the same data as
`structuredContent`:

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
      "checkedAt": "2026-09-25T23:30:00.000Z",
      "resetCredits": null,
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

T3 reports the limits for Codex and Claude Code. For an enabled T3 instance
that has no T3 usage data, the server runs a probe:

| T3 driver | Probe | Configuration |
|---|---|---|
| `antigravity` | `agy --print /usage --output-format json` (read-only) | `T3_USAGE_ANTIGRAVITY_CLI`, default `agy`. Set `off` to disable. |
| `opencode` | `GET https://opencode.ai/zen/go/v1/usage` (read-only) | `OPENCODE_GO_API_KEY_FILE` or `OPENCODE_GO_API_KEY`. With no key, the probe does not run. |

The Antigravity probe uses the Antigravity authentication of the user that
runs the server. The OpenCode Go probe reads the key file on each call, so a
rotated key takes effect with no restart. It sends the key only in the
`Authorization` header, and it never copies the response body of a failed
request into the report.

Other probe variables:

- `T3_USAGE_PROBE_TIMEOUT_MS` — timeout for each probe, default `20000`
- `OPENCODE_GO_USAGE_URL` — usage endpoint, default `https://opencode.ai/zen/go/v1/usage`

The OpenCode Go quota covers only the `opencode-go/*` models. Other providers
in the same OpenCode instance, for example API-billed providers, have no quota
in this report.

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
OPENCODE_GO_API_KEY_FILE=/run/secrets/opencode-zen-api-key \
t3code-mcp
```

The endpoint is then `http://127.0.0.1:8732/mcp`.

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

    # Optional usage probes for t3_get_usage_limits.
    opencodeGoApiKeyFile = "/run/secrets/opencode-zen-api-key";  # passed with LoadCredential
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

T3 v0.0.42 uses:

- OAuth token exchange at `/oauth/token`
- WebSocket tickets at `/api/auth/websocket-ticket`
- `/ws?wsTicket=...` (the old `orchestrationProtocol` parameter is gone)
- Effect RPC JSON messages with `requestId` on responses
- batched stream `Chunk.values` with client acknowledgements
- `orchestration.subscribeThread` streams `{kind: "snapshot"}`, `{kind: "synchronized"}`,
  and `{kind: "event"}` items
- HTTP orchestration API with bearer auth:
  - `GET /api/orchestration/snapshot` — full read model of projects and threads
  - `GET /api/orchestration/threads/:threadId` — one thread's detail snapshot
  - `POST /api/orchestration/dispatch` — command dispatch

Thread discovery and status tools use the HTTP API instead of private state, so upgrades
of T3 do not silently break the integration.

## License

MIT
