#!/usr/bin/env bash
# Pack dist/ and packages/*/dist for CI artifact upload.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="${1:-ci-build-artifacts.tar.gz}"

if [ ! -d dist ]; then
  echo "::error::dist/ missing — run npm run build:core first"
  exit 1
fi

paths=(dist)
for pkg_dist in packages/*/dist; do
  [ -d "$pkg_dist" ] && paths+=("$pkg_dist")
done
# dist/web is produced by build:web-host (required for validate-pack / npm pack).
if [ -d dist/web ]; then
  paths+=(dist/web)
fi

tar czf "$OUT" "${paths[@]}"
echo "ci-pack-build-artifacts: packed ${#paths[@]} path(s) into ${OUT} ($(du -h "$OUT" | cut -f1))"
