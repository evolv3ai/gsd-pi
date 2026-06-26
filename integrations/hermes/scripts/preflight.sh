#!/usr/bin/env bash
# Local preflight before Slack/Telegram gateway checklist (no Hermes required).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXTURE="$ROOT/integrations/hermes/tests/fixtures/minimal-project"
GSD="${GSD_CLI_PATH:-gsd}"
LOADER="${GSD_LOADER_PATH:-$ROOT/dist/loader.js}"

pass=0
fail=0

ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== GSD Hermes integration preflight ==="
echo

echo "1. gsd version"
if ver="$($GSD --version 2>/dev/null | tail -1)"; then
  ok "gsd --version → $ver"
else
  bad "gsd not found (set GSD_CLI_PATH or install gsd)"
fi

echo
echo "2. gsd-mcp-server"
MCP="${GSD_MCP_SERVER_PATH:-gsd-mcp-server}"
if command -v "$MCP" >/dev/null 2>&1; then
  ok "$MCP on PATH"
else
  bad "$MCP not on PATH (configure mcp_server_path in ~/.hermes/gsd.yaml)"
fi

echo
echo "3. gsd read progress (fixture)"
if [[ -f "$LOADER" ]]; then
  READ_CMD=(node "$LOADER" read progress --json --project "$FIXTURE")
elif command -v "$GSD" >/dev/null 2>&1; then
  READ_CMD=("$GSD" read progress --json --project "$FIXTURE")
else
  READ_CMD=()
fi

if [[ ${#READ_CMD[@]} -gt 0 ]]; then
  if out="$("${READ_CMD[@]}" 2>/dev/null)"; then
    if echo "$out" | grep -q '"integration_version": 1'; then
      ok "read CLI returns integration_version 1"
    else
      bad "read CLI missing integration_version envelope"
    fi
    if echo "$out" | grep -q '"id": "M001"'; then
      ok "fixture milestone M001 parsed"
    else
      bad "fixture milestone M001 not found in read output"
    fi
  else
    bad "gsd read progress failed (run npm run build:core if using dist/loader.js)"
  fi
else
  bad "no gsd binary available for read CLI check"
fi

echo
echo "4. Python contract tests"
if command -v python3 >/dev/null 2>&1; then
  export GSD_LOADER_PATH="$LOADER"
  if (cd "$ROOT/integrations/hermes" && python3 -m pytest tests/ -q); then
    ok "pytest contract suite passed"
  else
    bad "pytest failed (pip install -e integrations/hermes[dev])"
  fi
else
  bad "python3 not found"
fi

echo
echo "5. Plugin package"
if [[ -f "$ROOT/integrations/hermes/pyproject.toml" ]]; then
  ok "integrations/hermes present"
else
  bad "integrations/hermes missing"
fi

echo
echo "=== Summary: $pass passed, $fail failed ==="
if [[ "$fail" -gt 0 ]]; then
  echo "Fix failures above before running the Slack/Telegram gateway checklist."
  exit 1
fi
echo "Preflight OK — proceed to gateway setup in docs/setup.md"
exit 0
