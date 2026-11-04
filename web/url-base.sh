#!/bin/sh
# Serves AoNarr under a sub-path (https://host/aonarr/) when the container is started with URL_BASE, without
# rebuilding the image. Runs at every container start, before nginx:
#   - the split web image: as /docker-entrypoint.d/35-aonarr-url-base.sh, after the stock script has rendered
#     the nginx template into /etc/nginx/conf.d/default.conf
#   - the combined image: from combined/entrypoint.sh, on /etc/nginx/conf.d/aonarr.conf
# Usage: url-base.sh [nginx server config] [web root]
#
# URL_BASE unset or "/": nothing is changed, byte for byte (and a base applied by an earlier start of this same
# container is taken back out). URL_BASE=/aonarr (also "aonarr", "/aonarr/", "//aonarr"):
#   - nginx: two small blocks of directives, marked AONARR-URL-BASE-BEGIN/END, go into the config. One sits in the
#     server { } right after `index index.html;` and cuts the prefix off before any location is chosen, so the API,
#     the Starr mounts, the event streams and the restore upload keep their locations and the server still receives
#     the un-prefixed /api/... paths. The other, after the aonarr_starr log format, is the log format for the
#     requests that block turns away.
#   - the web root: index.html gets its /assets, /manifest.json, /icon.svg and /theme-init.js addresses prefixed
#     and a <script src=".../base-config.js"> (a real file: the page's CSP allows no inline script) that sets
#     window.__AONARR_BASE__ for the UI (src/utils/urlBase.ts); manifest.json gets start_url, scope and icons
#     under the base. Everything else in the bundle is address-independent (vite.config.ts renderBuiltUrl).
# The untouched index.html and manifest.json are kept in $STATE/orig, and every start works from those copies,
# so starting the same container again with the same, another or no base never prefixes twice.
# The normalised base is written to $STATE/base for the image health checks.
set -eu

CONF="${1:-/etc/nginx/conf.d/default.conf}"
ROOT="${2:-/usr/share/nginx/html}"
STATE="${AONARR_URL_BASE_STATE:-/var/lib/aonarr-url-base}"
RAW="${URL_BASE:-}"

# "aonarr", "/aonarr/", "//aonarr" -> "/aonarr"; "" and "/" -> ""; a character other than letters, digits and
# . _ ~ - inside a segment, or a "." / ".." segment, is an error. Same rules as normalizeAppUrlBase() in
# server/src/services/urlBase.ts and in web/src/utils/urlBase.ts.
normalize() {
  trimmed=$(printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's#//*#/#g' -e 's#^/##' -e 's#/$##')
  [ -n "$trimmed" ] || return 0
  case "$trimmed" in
    *[!A-Za-z0-9._~/-]*) return 1 ;;
  esac
  old_ifs=$IFS
  IFS=/
  for segment in $trimmed; do
    case "$segment" in
      . | ..) IFS=$old_ifs; return 1 ;;
    esac
  done
  IFS=$old_ifs
  printf '/%s' "$trimmed"
}

if ! BASE=$(normalize "$RAW"); then
  echo "aonarr: URL_BASE=\"$RAW\" is not a usable path: use letters, digits and . _ ~ - between slashes, for example /aonarr" >&2
  exit 1
fi

# No base and none ever applied here: nothing to do, and nothing is created.
if [ -z "$BASE" ] && [ ! -d "$STATE" ]; then
  exit 0
fi

# Back to the files as built: restore the saved originals (saving them first on the first start with a base),
# drop base-config.js and the nginx blocks a previous start of this container wrote.
mkdir -p "$STATE/orig"
for f in index.html manifest.json; do
  if [ -f "$STATE/orig/$f" ]; then
    cp "$STATE/orig/$f" "$ROOT/$f"
  elif [ -f "$ROOT/$f" ]; then
    cp "$ROOT/$f" "$STATE/orig/$f"
  fi
done
rm -f "$ROOT/base-config.js"
sed -i '/AONARR-URL-BASE-BEGIN/,/AONARR-URL-BASE-END/d' "$CONF"

if [ -z "$BASE" ]; then
  rm -rf "$STATE"
  echo "aonarr: no URL base"
  exit 0
fi

ANCHOR='^[[:space:]]*index[[:space:]]+index\.html;[[:space:]]*$'
LOG_ANCHOR='^log_format[[:space:]]+aonarr_starr[[:space:]]'
for anchor in "$ANCHOR" "$LOG_ANCHOR"; do
  if [ "$(grep -cE "$anchor" "$CONF")" != 1 ]; then
    echo "aonarr: $CONF has no single line matching $anchor to put the URL base next to" >&2
    exit 1
  fi
done
for f in index.html manifest.json; do
  if [ ! -f "$ROOT/$f" ]; then
    echo "aonarr: $ROOT/$f is missing" >&2
    exit 1
  fi
done

# The base inside an nginx regular expression: the dot is the only character of the allowed set that has a meaning.
# Its backslash is written twice because the value goes through a sed replacement below, which eats one.
BASE_RE=$(printf '%s' "$BASE" | sed 's/[.]/\\\\./g')

LOG_BLOCK="$STATE/nginx-log.conf"
cat > "$LOG_BLOCK" <<'EOF'
# AONARR-URL-BASE-BEGIN: written by url-base.sh at container start from URL_BASE, taken out again when it is unset
# What is logged for a request outside the URL base: its path, not its query. A Starr-style tool that was not told
# about the base still sends its API key in the query string, and the default format would write that to the log.
map $request_uri $aonarr_outside_path {
    "~^(?<outside_path>[^?]*)" $outside_path;
    default "";
}
log_format aonarr_outside '$remote_addr - [$time_local] "$request_method $aonarr_outside_path" $status $body_bytes_sent "outside the URL base"';
# AONARR-URL-BASE-END
EOF

BLOCK="$STATE/nginx-block.conf"
cat > "$BLOCK" <<'EOF'
    # AONARR-URL-BASE-BEGIN: written by url-base.sh at container start from URL_BASE, taken out again when it is unset
    # AoNarr is served under @BASE@/. The prefix is cut off here, before a location is chosen, so every location
    # below (and the server behind it) sees the same paths as without a URL base. Anything outside the prefix gets
    # a 404 (the /__aonarr_outside location); / and @BASE@ without its slash redirect into it. The checks read
    # $request_uri, which stays the same through try_files' internal redirect to /index.html and the restore
    # upload's auth_request subrequest, while $uri does not.
    absolute_redirect off;
    if ($request_uri ~ "^/(\?.*)?$") { return 302 @BASE@/$is_args$args; }
    if ($request_uri ~ "^@BASE_RE@(\?.*)?$") { return 302 @BASE@/$is_args$args; }
    if ($request_uri !~ "^@BASE_RE@/") { rewrite ^ /__aonarr_outside last; }
    if ($request_uri ~ "(^|/)(\.|%2[eE]){2}(/|\?|$)") { rewrite ^ /__aonarr_outside last; }
    rewrite ^@BASE_RE@/$ /index.html break;
    rewrite ^@BASE_RE@/(.*)$ /$1 break;
    location = /__aonarr_outside {
        internal;
        access_log /var/log/nginx/access.log aonarr_outside;
        return 404;
    }
    location = /base-config.js { expires -1; }
    # AONARR-URL-BASE-END
EOF
sed -i -e "s#@BASE_RE@#$BASE_RE#g" -e "s#@BASE@#$BASE#g" "$BLOCK"
sed -i -E -e "/$LOG_ANCHOR/r $LOG_BLOCK" -e "/$ANCHOR/r $BLOCK" "$CONF"
rm -f "$BLOCK" "$LOG_BLOCK"

printf 'window.__AONARR_BASE__ = "%s";\n' "$BASE" > "$ROOT/base-config.js"

sed -i -E \
  -e "s#(href|src)=\"/([^/\"])#\\1=\"$BASE/\\2#g" \
  -e "s#(href|src)=\"/\"#\\1=\"$BASE/\"#g" \
  -e "s#</head>#  <script src=\"$BASE/base-config.js\"></script>\\n  </head>#" \
  "$ROOT/index.html"
sed -i -E \
  -e "s#(\"start_url\": )\"/\"#\\1\"$BASE/\", \"scope\": \"$BASE/\"#" \
  -e "s#(\"src\": )\"/#\\1\"$BASE/#g" \
  "$ROOT/manifest.json"
for expected in "$BASE/base-config.js" "$BASE/assets/" "\"scope\": \"$BASE/\""; do
  if ! cat "$ROOT/index.html" "$ROOT/manifest.json" | grep -qF "$expected"; then
    echo "aonarr: could not apply the URL base: $expected is missing from the rewritten index.html / manifest.json" >&2
    exit 1
  fi
done

printf '%s' "$BASE" > "$STATE/base"
echo "aonarr: serving under $BASE/"
