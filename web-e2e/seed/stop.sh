#!/usr/bin/env bash
# Stops and removes the throwaway AoNarr instance (container "aonarr-e2e" only - no other container or
# image is touched). Pass --purge to also delete the generated config and credentials.
set -euo pipefail
export DO_NOT_TRACK=1
SEED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(dirname "$SEED_DIR")"

docker rm -f aonarr-e2e >/dev/null 2>&1 && echo "[stop] aonarr-e2e removed" || echo "[stop] aonarr-e2e was not running"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$E2E_DIR/.tmp/config" "$E2E_DIR/.auth/secrets" "$E2E_DIR/.auth/test-creds.json" "$E2E_DIR/.auth/seed-manifest.json"
  echo "[stop] purged web-e2e/.tmp/config and generated .auth files"
fi
