#!/usr/bin/env bash
#
# Run t3code-mcp as a stdio MCP server.
#
# Use this entry point for a harness that spawns the server itself, or for a
# harness that does not support Streamable HTTP. Antigravity supports stdio and
# SSE only, so Antigravity needs this script.
#
# Configure a harness with:
#   command: /home/ed/Projects/t3code-mcp/scripts/mcp-stdio.sh
#
# stdout carries JSON-RPC. Every message from this script goes to stderr.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=./t3code-env.sh
source "$root/scripts/t3code-env.sh"

export MCP_TRANSPORT=stdio

t3code_report
t3code_preflight || true   # Report a problem, then still try to serve.
t3code_build_if_absent "$root"

exec node "$root/dist/index.js"
