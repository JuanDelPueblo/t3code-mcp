#!/usr/bin/env bash
#
# Deploy this checkout to the Fedora host's t3code-mcp user service.
#
# Usage:
#   ./scripts/deploy.sh
#
# It type-checks, tests, and builds the checkout, stages it with production
# dependencies only, installs it into $T3CODE_MCP_DIR (sudo), restarts the user
# unit, and checks that the restarted service lists every tool of this build.
#
# Overrides: T3CODE_MCP_DIR (default /opt/t3code-mcp),
# T3CODE_MCP_UNIT (default t3code-mcp.service), MCP_HTTP_PORT (default 8732).

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${T3CODE_MCP_DIR:-/opt/t3code-mcp}"
unit="${T3CODE_MCP_UNIT:-t3code-mcp.service}"
url="http://127.0.0.1:${MCP_HTTP_PORT:-8732}/mcp"

cd "$root"
echo "==> Checking and building $(git rev-parse --short HEAD)$(git diff --quiet || echo ' (uncommitted changes)')" >&2
npm run --silent typecheck
npm test --silent
npm run --silent build

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -r dist package.json package-lock.json "$stage/"
echo "==> Installing production dependencies in a staging directory" >&2
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)

echo "==> Installing into $target (sudo)" >&2
sudo install -d -o root -g root -m 0755 "$target"
sudo rsync -a --delete --chown=root:root --chmod=D755,F644 "$stage/dist/" "$target/dist/"
sudo rsync -a --delete --chown=root:root --chmod=D755,F644 "$stage/node_modules/" "$target/node_modules/"
sudo install -o root -g root -m 0644 "$stage/package.json" "$target/package.json"

echo "==> Restarting $unit" >&2
systemctl --user restart "$unit"

echo "==> Checking $url" >&2
node --input-type=module - "$url" "$root" <<'EOF'
const [url, root] = process.argv.slice(2);
const sdk = `${root}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${sdk}/client/index.js`);
const { StreamableHTTPClientTransport } = await import(`${sdk}/client/streamableHttp.js`);
const { registerTools } = await import(`${root}/dist/tools.js`);

const expected = [];
registerTools({ registerTool: (name) => expected.push(name), server: { setRequestHandler() {} } }, {}, {});

let lastError;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const client = new Client({ name: "t3code-mcp-deploy-check", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const served = (await client.listTools()).tools.map((tool) => tool.name);
    const missing = expected.filter((name) => !served.includes(name));
    await client.close();
    if (missing.length) throw new Error(`service does not list ${missing.join(", ")}`);
    console.error(`OK: ${client.getServerVersion()?.name} ${client.getServerVersion()?.version} serves ${served.length} tools`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
console.error(`FAILED: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
process.exit(1);
EOF
