#!/usr/bin/env bash
#
# Start t3code-mcp as a loopback Streamable HTTP service.
#
# Usage:
#   ./scripts/serve-http.sh            # start the server
#   ./scripts/serve-http.sh --check    # print the resolved settings, start nothing
#
# Override any setting by exporting it first:
#   MCP_HTTP_PORT=9000 ./scripts/serve-http.sh
#
# Use scripts/mcp-stdio.sh instead for a harness that spawns the server itself.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./t3code-env.sh
source "$root/scripts/t3code-env.sh"

export MCP_TRANSPORT="${MCP_TRANSPORT:-http}"
export MCP_HTTP_HOST="${MCP_HTTP_HOST:-127.0.0.1}"
export MCP_HTTP_PORT="${MCP_HTTP_PORT:-8732}"
export MCP_HTTP_PATH="${MCP_HTTP_PATH:-/mcp}"

t3code_report

if [[ "${1:-}" == "--check" ]]; then
  t3code_preflight
  exit $?
fi

t3code_preflight || true   # Report a problem, then still try to serve.
t3code_build_if_absent "$root"

echo "Serving on http://${MCP_HTTP_HOST}:${MCP_HTTP_PORT}${MCP_HTTP_PATH}. Press Ctrl+C to stop." >&2
exec node "$root/dist/index.js"
