#!/usr/bin/env bash
#
# Deploy this checkout as the t3code-mcp user service, next to T3 Code.
#
# Usage:
#   ./scripts/deploy.sh
#
# Runs as your user; no sudo. It type-checks, tests, and builds the checkout,
# installs it with production dependencies into
#   $T3CODE_MCP_ROOT/versions/<version>-<commit>/
# installs ~/.config/systemd/user/t3code-mcp.service from
# scripts/t3code-mcp.service.in, switches the `current` link, restarts the
# unit, and checks that it serves every tool of this build. If the check fails,
# it switches back to the previous version.
#
# Settings (environment overrides):
#   T3CODE_MCP_ROOT  install root (default: <apps>/t3code-mcp beside <apps>/t3code,
#                    else ~/.local/share/t3code-mcp)
#   T3CODE_HOME      T3's home (default: read from t3code.service)
#   T3CODE_PORT      T3's port (default: read from t3code.service, else 3773)
#   MCP_HTTP_PORT    bridge port (default 8732)
#   KEEP_VERSIONS    installed versions to keep (default 3)

set -euo pipefail

if [[ "$EUID" -eq 0 ]]; then
  echo "error: run deploy.sh as your own user, not with sudo." >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="t3code-mcp.service"

# Read a value from T3's own unit and drop-ins, which `t3 service install` writes.
t3_setting() {
  systemctl --user cat t3code.service 2>/dev/null |
    sed -n "s/^Environment=$1=//p" | tail -n 1
}

t3_home="${T3CODE_HOME:-$(t3_setting T3CODE_HOME)}"
t3_home="${t3_home:-$HOME/.t3}"
t3_port="${T3CODE_PORT:-$(t3_setting T3CODE_PORT)}"
t3_port="${t3_port:-3773}"
# Next to T3's app directory when T3 lives in <apps>/t3code/<home>, as on a
# server install; otherwise in the user's data directory.
if [[ -n "${T3CODE_MCP_ROOT:-}" ]]; then
  install_root="$T3CODE_MCP_ROOT"
elif [[ "$(basename "$(dirname "$t3_home")")" == "t3code" ]]; then
  install_root="$(dirname "$(dirname "$t3_home")")/t3code-mcp"
else
  install_root="${XDG_DATA_HOME:-$HOME/.local/share}/t3code-mcp"
fi
mcp_port="${MCP_HTTP_PORT:-8732}"
url="http://127.0.0.1:${mcp_port}/mcp"

cd "$root"
commit="$(git rev-parse --short HEAD)"
version="$(node -p 'require("./package.json").version')"
echo "==> Checking and building $version ($commit)$(git diff --quiet || echo ', uncommitted changes')" >&2
npm run --silent typecheck
npm test --silent
npm run --silent build

target="$install_root/versions/$version-$commit"
echo "==> Installing into $target" >&2
mkdir -p "$install_root/versions"
rm -rf "$target.tmp"
mkdir -p "$target.tmp"
cp -r dist package.json package-lock.json "$target.tmp/"
(cd "$target.tmp" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)
rm -rf "$target"
mv "$target.tmp" "$target"

echo "==> Installing $unit_dir/$unit" >&2
mkdir -p "$unit_dir"
sed -e "s|@INSTALL_ROOT@|$install_root|g" \
    -e "s|@T3_HOME@|$t3_home|g" \
    -e "s|@T3_PORT@|$t3_port|g" \
    -e "s|@MCP_PORT@|$mcp_port|g" \
    -e "s|@T3_CLI@|$(command -v t3 || echo "$HOME/.local/bin/t3")|g" \
    -e "s|@AGY_CLI@|$(command -v agy || echo "$HOME/.local/bin/agy")|g" \
    -e "s|@NODE@|$(command -v node)|g" \
    scripts/t3code-mcp.service.in >"$unit_dir/$unit.new"
mv "$unit_dir/$unit.new" "$unit_dir/$unit"
systemctl --user daemon-reload
systemctl --user reenable "$unit" >/dev/null 2>&1

previous="$(readlink "$install_root/current" 2>/dev/null || true)"
switch_to() {
  ln -sfn "$1" "$install_root/current.new"
  mv -T "$install_root/current.new" "$install_root/current"
}

check() {
  node --input-type=module - "$url" "$root" <<'EOF'
const [url, root] = process.argv.slice(2);
const sdk = `${root}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${sdk}/client/index.js`);
const { StreamableHTTPClientTransport } = await import(`${sdk}/client/streamableHttp.js`);
const { registerTools } = await import(`${root}/dist/tools.js`);
const expected = [];
registerTools({ registerTool: (name) => expected.push(name), server: { setRequestHandler() {} } }, {}, {});
let lastError;
for (let attempt = 0; attempt < 45; attempt += 1) {
  const client = new Client({ name: "t3code-mcp-deploy-check", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const served = (await client.listTools()).tools.map((tool) => tool.name);
    const version = client.getServerVersion()?.version;
    await client.close();
    const missing = expected.filter((name) => !served.includes(name));
    if (missing.length) throw new Error(`service does not list ${missing.join(", ")}`);
    console.error(`OK: t3code-mcp ${version} serves ${served.length} tools`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
console.error(`FAILED: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
process.exit(1);
EOF
}

echo "==> Switching current to $(basename "$target") and restarting $unit" >&2
switch_to "$target"
systemctl --user restart "$unit"
if ! check; then
  if [[ -n "$previous" && "$previous" != "$target" ]]; then
    echo "==> Rolling back to $(basename "$previous")" >&2
    switch_to "$previous"
    systemctl --user restart "$unit"
    check || true
  fi
  exit 1
fi

# Keep the newest versions, and never the one that is current.
keep="${KEEP_VERSIONS:-3}"
ls -1dt "$install_root"/versions/*/ 2>/dev/null | tail -n +"$((keep + 1))" | while read -r old; do
  [[ "$(readlink -f "$old")" == "$(readlink -f "$install_root/current")" ]] || rm -rf "$old"
done
echo "==> Deployed $version ($commit) at $install_root/current" >&2
