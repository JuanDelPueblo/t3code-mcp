#!/usr/bin/env bash
#
# Shared environment resolution for t3code-mcp.
#
# Source this file. Do not run it. It sets every variable the server reads and
# keeps a value that the caller exported first, so each setting is overridable.
#
# Every message goes to stderr. A stdio MCP server uses stdout for JSON-RPC, so
# a single stray character on stdout breaks the protocol.

runtime_file="${T3_RUNTIME_FILE:-$HOME/.t3/userdata/server-runtime.json}"

t3note() { echo "  $*" >&2; }

# --- The T3 server URL ------------------------------------------------------
# Order: an exported T3_CODE_URL, then T3's runtime file, then the default.
# The T3 desktop application picks a new port at each start, so a fixed port
# fails after a restart. Read the port, do not assume it.
if [[ -z "${T3_CODE_URL:-}" && -r "$runtime_file" ]]; then
  T3_CODE_URL="$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
origin = data.get("origin")
port = data.get("port")
if origin:
    print(origin)
elif port:
    print(f"http://127.0.0.1:{port}")
' "$runtime_file" 2>/dev/null || true)"
fi
T3_CODE_URL="${T3_CODE_URL:-http://127.0.0.1:3000}"
export T3_CODE_URL

# --- Authentication ---------------------------------------------------------
# The server tries three modes in this order:
#   1. T3_CODE_ACCESS_TOKEN or T3_CODE_ACCESS_TOKEN_FILE — a bearer token.
#   2. T3_CODE_TOKEN or T3_CODE_TOKEN_FILE — a one-time pairing credential.
#   3. T3_CODE_BASE_DIR — local pairing through the T3 CLI.
# Local pairing stores no secret, so this file defaults to it.
T3_AUTH_MODE="local pairing (T3_CODE_BASE_DIR)"
if [[ -n "${T3_CODE_ACCESS_TOKEN:-}" || -n "${T3_CODE_ACCESS_TOKEN_FILE:-}" ]]; then
  T3_AUTH_MODE="access token"
elif [[ -n "${T3_CODE_TOKEN:-}" || -n "${T3_CODE_TOKEN_FILE:-}" ]]; then
  T3_AUTH_MODE="pairing credential"
else
  export T3_CODE_BASE_DIR="${T3_CODE_BASE_DIR:-$HOME/.t3}"
  export T3_CODE_CLI="${T3_CODE_CLI:-$(command -v t3 || echo t3)}"
  export T3_CODE_PAIRING_TTL="${T3_CODE_PAIRING_TTL:-5m}"
  export T3_CODE_PAIRING_LABEL="${T3_CODE_PAIRING_LABEL:-t3code-mcp}"
fi

# --- Optional Antigravity usage probe --------------------------------------
# T3 v0.0.44 owns OpenCode Go credentials and usage. Only Antigravity needs
# a fallback CLI probe when the server has no usage data.
export T3_USAGE_ANTIGRAVITY_CLI="${T3_USAGE_ANTIGRAVITY_CLI:-$(command -v agy || echo agy)}"

# --- Report the settings to stderr ------------------------------------------
t3code_report() {
  echo "t3code-mcp settings:" >&2
  t3note "T3_CODE_URL              $T3_CODE_URL"
  t3note "MCP_TRANSPORT            ${MCP_TRANSPORT:-stdio}"
  [[ "${MCP_TRANSPORT:-}" == "http" ]] &&
    t3note "MCP endpoint             http://${MCP_HTTP_HOST}:${MCP_HTTP_PORT}${MCP_HTTP_PATH}"
  t3note "authentication           $T3_AUTH_MODE"
  [[ -n "${T3_CODE_BASE_DIR:-}" ]] && t3note "T3_CODE_BASE_DIR         $T3_CODE_BASE_DIR"
  [[ -n "${T3_CODE_CLI:-}" ]] && t3note "T3_CODE_CLI              $T3_CODE_CLI"
  t3note "antigravity usage CLI    $T3_USAGE_ANTIGRAVITY_CLI"
  t3note "opencode go usage        provided by T3 Code"
  return 0
}

# --- Preflight, reported to stderr ------------------------------------------
t3code_preflight() {
  local status=0
  if ! curl -fsS -o /dev/null --max-time 5 "$T3_CODE_URL/" 2>/dev/null; then
    echo "warning: no answer from T3 at $T3_CODE_URL" >&2
    echo "         Start the T3 application first. The bridge needs it." >&2
    status=1
  fi
  if [[ "$T3_AUTH_MODE" == "local pairing (T3_CODE_BASE_DIR)" ]]; then
    [[ -d "$T3_CODE_BASE_DIR" ]] ||
      { echo "warning: no directory $T3_CODE_BASE_DIR" >&2; status=1; }
    command -v "$T3_CODE_CLI" >/dev/null 2>&1 ||
      { echo "warning: no T3 CLI at $T3_CODE_CLI" >&2; status=1; }
  fi
  return "$status"
}

# --- Build once, if needed --------------------------------------------------
t3code_build_if_absent() {
  local root="$1"
  if [[ ! -f "$root/dist/index.js" ]]; then
    echo "dist/index.js is absent. Building." >&2
    (cd "$root" && npm run --silent build >&2)
  fi
}
