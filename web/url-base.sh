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
#     the un-prefixed /api/... paths. The other, after the aonarr_starr log format, holds the http-level pieces
#     that block uses: the log format for the requests it turns away and the test for a ".." segment.
#   - the web root: index.html gets its /assets, /manifest.json, /icon.svg and /theme-init.js addresses prefixed
#     and a <script src=".../base-config.js"> (a real file: the page's CSP allows no inline script) that sets
#     window.__AONARR_BASE__ for the UI (src/utils/urlBase.ts); manifest.json gets start_url, scope and icons
#     under the base. Everything else in the bundle is address-independent (vite.config.ts renderBuiltUrl).
# The untouched index.html and manifest.json are kept in $STATE/orig, and every start works from those copies,
# so starting the same container again with the same, another or no base never prefixes twice. A checksum of each
# file as this script wrote it is kept in $STATE/sum: a copy in orig is only put back over a file that still matches
# it. A file that does not (a new build, because the image was upgraded under a state directory that outlived the
# container) is the new original and replaces the saved copy, so a stale index.html never comes back.
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

# "crc size" of a file. cksum is in coreutils and in BusyBox, so it is in both images; this only has to tell the file
# this script wrote from another file, nothing more.
fsum() {
  cksum < "$1"
}

# Back to the files as built: restore the saved originals, but only over the files this script wrote (saving the
# current file as the original on the first start with a base, and again when it is a new build), drop
# base-config.js and the nginx blocks a previous start of this container wrote.
mkdir -p "$STATE/orig" "$STATE/sum"
for f in index.html manifest.json; do
  if [ ! -f "$ROOT/$f" ]; then
    rm -f "$STATE/orig/$f"
  elif [ -f "$STATE/orig/$f" ] && [ -f "$STATE/sum/$f" ] && [ "$(fsum "$ROOT/$f")" = "$(cat "$STATE/sum/$f")" ]; then
    cp "$STATE/orig/$f" "$ROOT/$f"
  else
    cp "$ROOT/$f" "$STATE/orig/$f"
  fi
  rm -f "$STATE/sum/$f"
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
# 1 when a segment of the request's PATH (the part before any ?) is "..", also as %2e. A query such as
# ?path=/media/.. is data for the API and does not count.
map $request_uri $aonarr_dotdot {
    "~^([^?]*/)?(\.|%2[eE]){2}(/|\?|$)" 1;
    default 0;
}
# AONARR-URL-BASE-END
EOF

BLOCK="$STATE/nginx-block.conf"
cat > "$BLOCK" <<'EOF'
    # AONARR-URL-BASE-BEGIN: written by url-base.sh at container start from URL_BASE, taken out again when it is unset
    # AoNarr is served under @BASE@/. The prefix is cut off here, before a location is chosen, so every location
    # below (and the server behind it) sees the same paths as without a URL base. Anything outside the prefix gets
    # a 404 (the /__aonarr_outside location); / and @BASE@ without its slash redirect into it. The checks read
    # $request_uri, which stays the same through try_files' internal redirect to /index.html and the restore
    # upload's auth_request subrequest, while $uri does not. A ".." segment in the path (never in the query) is
    # refused too, so @BASE@/../x cannot get past the prefix check by way of the raw, un-normalised address.
    absolute_redirect off;
    if ($request_uri ~ "^/(\?.*)?$") { return 302 @BASE@/$is_args$args; }
    if ($request_uri ~ "^@BASE_RE@(\?.*)?$") { return 302 @BASE@/$is_args$args; }
    if ($request_uri !~ "^@BASE_RE@/") { rewrite ^ /__aonarr_outside last; }
    if ($aonarr_dotdot) { rewrite ^ /__aonarr_outside last; }
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

# Rewrites $ROOT/<file> with the sed expressions that follow. The result is written beside the file (same mode),
# its checksum goes on record, and only then does it take the file's place (a rename), so a stop at any moment
# leaves either the untouched file or one whose checksum is in $STATE/sum.
rewrite() {
  name=$1
  shift
  cp -p "$ROOT/$name" "$ROOT/$name.aonarr-tmp"
  sed -E "$@" "$ROOT/$name" > "$ROOT/$name.aonarr-tmp"
  fsum "$ROOT/$name.aonarr-tmp" > "$STATE/sum/$name"
  mv "$ROOT/$name.aonarr-tmp" "$ROOT/$name"
}
trap 'rm -f "$ROOT/index.html.aonarr-tmp" "$ROOT/manifest.json.aonarr-tmp"' EXIT

rewrite index.html \
  -e "s#(href|src)=\"/([^/\"])#\\1=\"$BASE/\\2#g" \
  -e "s#(href|src)=\"/\"#\\1=\"$BASE/\"#g" \
  -e "s#</head>#  <script src=\"$BASE/base-config.js\"></script>\\n  </head>#"
rewrite manifest.json \
  -e "s#(\"start_url\": )\"/\"#\\1\"$BASE/\", \"scope\": \"$BASE/\"#" \
  -e "s#(\"src\": )\"/#\\1\"$BASE/#g"
for expected in "$BASE/base-config.js" "$BASE/assets/" "\"scope\": \"$BASE/\""; do
  if ! cat "$ROOT/index.html" "$ROOT/manifest.json" | grep -qF "$expected"; then
    echo "aonarr: could not apply the URL base: $expected is missing from the rewritten index.html / manifest.json" >&2
    exit 1
  fi
done

printf '%s' "$BASE" > "$STATE/base"
echo "aonarr: serving under $BASE/"
