#!/bin/bash
set -e

# Runs as root so it can create a matching user/group for PUID/PGID and fix ownership
# of /config, then drops the node process (the one that actually reads/writes /config,
# /downloads and /media) down to that user via gosu before starting it. nginx keeps
# running as root — it only serves the built-in web bundle and proxies to node, it
# never touches user-owned volumes.
PUID="${PUID:-99}"
PGID="${PGID:-100}"

if ! getent group "$PGID" >/dev/null 2>&1; then
  groupadd -o -g "$PGID" aonarr
fi
GROUP_NAME="$(getent group "$PGID" | cut -d: -f1)"

if ! getent passwd "$PUID" >/dev/null 2>&1; then
  useradd -o -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin aonarr
fi
USER_NAME="$(getent passwd "$PUID" | cut -d: -f1)"

# Recursive chown only runs when ownership is already wrong, so restarts on an
# already-correctly-owned /config are cheap.
if [ "$(stat -c '%u:%g' /config)" != "${PUID}:${PGID}" ]; then
  chown -R "${PUID}:${PGID}" /config
fi

gosu "${USER_NAME}:${GROUP_NAME}" node dist/index.js &
NODE_PID=$!

nginx -g 'daemon off;' &
NGINX_PID=$!

trap 'kill -TERM $NODE_PID $NGINX_PID 2>/dev/null' TERM INT

# Exit (and let Docker restart the container) as soon as either process dies —
# a lone surviving nginx serving a dead API, or vice versa, is worse than a restart.
wait -n $NODE_PID $NGINX_PID
EXIT_CODE=$?
kill -TERM $NODE_PID $NGINX_PID 2>/dev/null
wait
exit $EXIT_CODE
