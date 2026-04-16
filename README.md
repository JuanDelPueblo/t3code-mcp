# t3code-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that wraps [T3 Code](https://github.com/pingdotgg/t3code)'s WebSocket RPC API, letting any MCP-compatible client (Claude Desktop, opencode, etc.) delegate coding tasks to a running T3 Code instance.

## Prerequisites

- A running T3 Code instance (desktop app or server)
- A bootstrap/pairing credential token from T3 Code

## Installation

### From source

```bash
git clone https://github.com/JulianBeaulieu/t3code-mcp.git
cd t3code-mcp
npm install
npm run build
```

### Via npx (once published to npm)

```bash
npx t3code-mcp
```

## Configuration

| Environment variable | Required | Default                  | Description                                                   |
|----------------------|----------|--------------------------|---------------------------------------------------------------|
| `T3_CODE_TOKEN`      | **Yes**  | —                        | Your T3 Code bootstrap/pairing credential token               |
| `T3_CODE_URL`        | No       | `http://localhost:3000`  | Base URL of your T3 Code server                               |

### Getting your token

1. Open T3 Code
2. Go to **Settings → API / Pairing**
3. Generate a pairing token — this is your `T3_CODE_TOKEN`

## MCP client setup

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "t3code": {
      "command": "node",
      "args": ["/path/to/t3code-mcp/dist/index.js"],
      "env": {
        "T3_CODE_URL": "http://localhost:3000",
        "T3_CODE_TOKEN": "your-pairing-token-here"
      }
    }
  }
}
```

### opencode (`~/.config/opencode/config.json`)

```json
{
  "mcp": {
    "t3code": {
      "type": "local",
      "command": ["node", "/path/to/t3code-mcp/dist/index.js"],
      "environment": {
        "T3_CODE_URL": "http://localhost:3000",
        "T3_CODE_TOKEN": "your-pairing-token-here"
      }
    }
  }
}
```

### Running directly for development

```bash
T3_CODE_URL=http://localhost:3000 T3_CODE_TOKEN=your-token npm run dev
```

## Available tools

| Tool              | Description                                                                           |
|-------------------|---------------------------------------------------------------------------------------|
| `t3_send_prompt`  | Send a coding task to T3 Code. Creates a thread, starts a turn, and collects events. |
| `t3_get_status`   | Poll an existing thread for recent events / progress.                                 |
| `t3_interrupt`    | Interrupt the currently running turn in a thread.                                     |
| `t3_stop_session` | Fully stop the provider session for a thread.                                         |
| `t3_get_config`   | Retrieve server configuration (available providers, models, settings).                |

## Typical workflow

```
1. t3_get_config          → discover available providers and models
2. t3_send_prompt         → start a coding task (returns threadId + initial response)
3. t3_get_status          → poll for more output (repeat as needed)
4. t3_interrupt           → cancel if needed
5. t3_stop_session        → clean up the session when done
```

## Architecture

```
MCP Client (Claude / opencode)
        │  stdio (JSON-RPC 2.0)
        ▼
  t3code-mcp (this server)
        │  WebSocket RPC (Effect unstable/rpc NDJSON protocol)
        ▼
  T3 Code server  ws://localhost:3000/ws
```

### Auth flow

1. POST `/api/auth/bootstrap/bearer` with `{ credential: T3_CODE_TOKEN }` → bearer session token
2. POST `/api/auth/ws-token` with `Authorization: Bearer <session-token>` → short-lived WS token
3. Open WebSocket at `ws://host/ws?token=<ws-token>`

### Wire protocol

T3 Code uses [Effect](https://effect.website)'s `unstable/rpc` over WebSocket with NDJSON framing:

```jsonc
// Request (client → server)
{ "_tag": "Request", "id": "<uuid>", "tag": "<method>", "payload": {} }

// Unary response
{ "_tag": "Exit", "id": "<uuid>", "exit": { "_tag": "Success", "value": {} } }

// Streaming chunk
{ "_tag": "Chunk", "id": "<uuid>", "value": {} }

// Stream end
{ "_tag": "End", "id": "<uuid>" }
```

## Development

```bash
npm install
npm run typecheck   # type-check without emitting
npm run build       # compile to dist/
npm run dev         # run from source with tsx
```

## License

MIT
