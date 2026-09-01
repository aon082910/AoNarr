#!/bin/bash
set -e

# Runs as root so it can create a matching user/group for PUID/PGID and fix ownership
# of /config, then drops the node process down to that user via gosu before exec'ing it.
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

exec gosu "${USER_NAME}:${GROUP_NAME}" node dist/index.js
