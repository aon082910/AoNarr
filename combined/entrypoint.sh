#!/bin/bash
set -e

node dist/index.js &
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
