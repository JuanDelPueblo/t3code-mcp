# t3code-mcp

MCP server for orchestrating [T3 Code](https://github.com/pingdotgg/t3code).

This fork targets the current T3 Code authentication and orchestration protocol used by
T3 v0.0.42 and supports both local stdio clients and a long-running Streamable HTTP service.

## MCP tools

- `t3_get_config` — inspect configured provider instances and model catalogs
- `t3_get_usage_limits` — provider subscription usage (Codex/ChatGPT, Claude Code): 5 hour session and weekly quota used, with reset times
- `t3_list_threads` — discover existing threads with their current state, including threads started from the T3 UI or another client
- `t3_get_thread` — immediate current snapshot of one thread: state, latest turn, messages, activities
- `t3_send_prompt` — create a project/thread and start a coding turn
- `t3_get_status` — immediate thread snapshot plus optional live event tail
- `t3_interrupt` — interrupt a running turn
- `t3_stop_session` — stop a provider session

`t3_list_threads` and `t3_get_thread` use T3's supported HTTP orchestration API, so they
work for threads created by any client and return the current state without waiting for
new events. `t3_send_prompt` uses T3's native `instanceId + model` model selection with
`modelSelection.options` for reasoning/effort choices. Call
`t3_get_config` first instead of assuming a provider or model name.

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
