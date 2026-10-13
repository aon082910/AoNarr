#!/usr/bin/env bash
# Starts the seeded throwaway AoNarr instance used by the redesign test package.
#
#   web-e2e/seed/start.sh            fresh empty config -> container "aonarr-e2e" on 127.0.0.1:8989 -> seed
#   web-e2e/seed/start.sh --no-seed  start the container only (empty app, first-run state)
#
# Image   : allornothing/aonarr:combined (override with AONARR_E2E_IMAGE) - nginx + node in one container.
# Ports   : container 9876 (nginx, UI + /api proxy) -> host 127.0.0.1:8989. Node listens on 8989 INSIDE
#           the container only (nginx proxies /api/ to it); it is never published.
# Config  : web-e2e/.tmp/config (gitignored), wiped on every start. No media or downloads mounts.
# Creds   : random per start, written to web-e2e/.auth/test-creds.json (gitignored). Never printed.
# Network : the container's DNS is pointed at 127.0.0.1 so no hostname can resolve - nothing can reach a
#           real service even if a scheduler tried. Every indexer/client/list in the seed points at
#           http://127.0.0.1:9 (nothing listens there).
set -euo pipefail
export DO_NOT_TRACK=1
# Stop Git Bash rewriting container paths (/config, /run/secrets/...) into Windows paths.
export MSYS_NO_PATHCONV=1

SEED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(dirname "$SEED_DIR")"
NAME="aonarr-e2e"
IMAGE="${AONARR_E2E_IMAGE:-allornothing/aonarr:combined}"
HOST_PORT="${AONARR_E2E_PORT:-8989}"
CONFIG_DIR="$E2E_DIR/.tmp/config"
AUTH_DIR="$E2E_DIR/.auth"
SECRETS_DIR="$AUTH_DIR/secrets"
CREDS_FILE="$AUTH_DIR/test-creds.json"
DO_SEED=1
[ "${1:-}" = "--no-seed" ] && DO_SEED=0

# Windows-style absolute path for docker -v (pwd -W under Git Bash); plain pwd elsewhere.
abs() { if (cd "$1" && pwd -W >/dev/null 2>&1); then (cd "$1" && pwd -W); else (cd "$1" && pwd); fi; }

t0=$SECONDS
command -v docker >/dev/null || { echo "docker not found on PATH" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker daemon is not running" >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE is not present locally (this script never pulls)" >&2; exit 1; }

echo "[start] removing any previous $NAME container and its config"
docker rm -f "$NAME" >/dev/null 2>&1 || true
rm -rf "$CONFIG_DIR" "$SECRETS_DIR"
mkdir -p "$CONFIG_DIR" "$SECRETS_DIR"
# Host-native (Windows-style under Git Bash) paths for docker and node, which do not understand /d/... paths.
CONFIG_WIN="$(abs "$CONFIG_DIR")"
SECRETS_WIN="$(abs "$SECRETS_DIR")"
AUTH_WIN="$(abs "$AUTH_DIR")"
SEED_WIN="$(abs "$SEED_DIR")"

echo "[start] generating throwaway credentials -> web-e2e/.auth/test-creds.json (not printed)"
node -e '
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const [authDir, secretsDir, credsFile] = process.argv.slice(1);
const pw = () => crypto.randomBytes(18).toString("base64url");
const creds = { adminUsername: "e2e-admin", adminPassword: pw(), householdUsername: "e2e-household", householdPassword: pw() };
fs.writeFileSync(credsFile, JSON.stringify(creds, null, 2) + "\n");
fs.writeFileSync(path.join(secretsDir, "admin_username"), creds.adminUsername);
fs.writeFileSync(path.join(secretsDir, "admin_password"), creds.adminPassword);
' "$AUTH_WIN" "$SECRETS_WIN" "$AUTH_WIN/test-creds.json"

echo "[start] docker run $NAME ($IMAGE) on 127.0.0.1:$HOST_PORT"
docker run -d --name "$NAME" \
  --label aonarr-e2e=1 \
  --dns 127.0.0.1 \
  -p "127.0.0.1:${HOST_PORT}:9876" \
  -v "${CONFIG_WIN}:/config" \
  -v "${SECRETS_WIN}:/run/secrets/e2e:ro" \
  -e TZ=UTC \
  -e PUID=99 -e PGID=100 \
  -e AONARR_ADMIN_USERNAME_FILE=/run/secrets/e2e/admin_username \
  -e AONARR_ADMIN_PASSWORD_FILE=/run/secrets/e2e/admin_password \
  -e AONARR_QUEUE_POLL_SECONDS=86400 \
  -e AONARR_SEARCH_INTERVAL_MINUTES=43200 \
  "$IMAGE" >/dev/null

echo -n "[start] waiting for http://127.0.0.1:${HOST_PORT}/api/health "
ok=0
for _ in $(seq 1 120); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
    echo; echo "[start] container exited early; last logs:" >&2; docker logs --tail 40 "$NAME" >&2 || true; exit 1
  fi
  echo -n "."; sleep 1
done
echo
[ "$ok" = 1 ] || { echo "[start] health check timed out; last logs:" >&2; docker logs --tail 40 "$NAME" >&2 || true; exit 1; }
echo "[start] healthy after $((SECONDS - t0))s"

if [ "$DO_SEED" = 1 ]; then
  echo "[start] seeding"
  AONARR_E2E_URL="http://127.0.0.1:${HOST_PORT}" node "$SEED_WIN/seed.mjs"
fi
echo "[start] done in $((SECONDS - t0))s - UI http://127.0.0.1:${HOST_PORT}/"
