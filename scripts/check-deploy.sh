#!/usr/bin/env bash
# Checks a deployed web demo against the hosting contract in apps/web/hosting.ts
# (vercel.json at a domain root, glassgrid-hosting.json in a subfolder) and
# docs/m4-web-demo.md:
#
#   - the app shell, ?sample=taxi and the gallery route serve the SPA with the header CSP;
#   - DuckDB-WASM's .wasm is application/wasm, compressed (br or gzip) and immutable;
#   - the signed Parquet extension and the sample data are reachable, and
#     Parquet answers Range requests (DuckDB-WASM reads it by range);
#   - the sample workspace is served;
#   - in a subfolder: glassgrid-hosting.json names that base (and the version).
#
# Usage:
#   scripts/check-deploy.sh <url> [base-path]
#
#   scripts/check-deploy.sh https://kalebkougl-portfolio.vercel.app/glassgrid/    # the portfolio's subfolder
#   scripts/check-deploy.sh https://kalebkougl-portfolio.vercel.app /glassgrid/   # the same
#   GLASSGRID_BASE=/glassgrid/ scripts/check-deploy.sh http://127.0.0.1:4173      # the same, base from the environment
#   scripts/check-deploy.sh https://glassgrid.vercel.app                         # a standalone deploy at the root
#   VERCEL_PROTECTION_BYPASS=<secret> scripts/check-deploy.sh https://<preview>.vercel.app/glassgrid/
#   ALLOW_UNCOMPRESSED=1 scripts/check-deploy.sh http://127.0.0.1:4173   # local e2e/serve.ts does not compress
#
# The base path is the URL's path, or the second argument, or GLASSGRID_BASE
# (default /). Needs bash and curl (macOS and Linux). Exits 1 if any check fails.
set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <deployment-url> [base-path]" >&2
  exit 2
fi
URL="$1"
if ! printf '%s' "$URL" | grep -Eq '^https?://[^/?#]+'; then
  echo "not an http(s) URL: $URL" >&2
  exit 2
fi
ORIGIN="$(printf '%s' "$URL" | sed -E 's#^(https?://[^/?#]+).*$#\1#')"
URL_PATH="${URL#"$ORIGIN"}"
URL_PATH="${URL_PATH%%[?#]*}"
ARG_BASE="${2:-${GLASSGRID_BASE:-}}"
if [ -n "$URL_PATH" ] && [ "$URL_PATH" != "/" ]; then
  PREFIX="$URL_PATH"
  if [ -n "$ARG_BASE" ] && [ "${ARG_BASE%/}/" != "${PREFIX%/}/" ]; then
    echo "the URL's path ($URL_PATH) and the base path ($ARG_BASE) differ" >&2
    exit 2
  fi
else
  PREFIX="${ARG_BASE:-/}"
fi
# The base path, with both slashes: / or /glassgrid/.
case "$PREFIX" in /*) ;; *) PREFIX="/$PREFIX" ;; esac
PREFIX="${PREFIX%/}/"
UA="glassgrid-check-deploy"
FAILURES=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CURL_EXTRA=()
if [ -n "${VERCEL_PROTECTION_BYPASS:-}" ]; then
  # Previews behind Vercel Deployment Protection: Settings → Deployment Protection → Protection Bypass for Automation.
  CURL_EXTRA=(-H "x-vercel-protection-bypass: ${VERCEL_PROTECTION_BYPASS}")
fi

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  warn  %s\n' "$1"; }

# fetch <name> <path> [curl args...]: GET into $WORK/<name>.body, headers (lower-cased names) into $WORK/<name>.headers.
fetch() {
  local name="$1" path="$2"
  shift 2
  local status
  status="$(curl -sS -L --max-time 120 -A "$UA" ${CURL_EXTRA[@]+"${CURL_EXTRA[@]}"} "$@" \
    -D "$WORK/$name.raw" -o "$WORK/$name.body" -w '%{http_code}' "$ORIGIN$path")" || status="000"
  # Keep the last response's headers (after redirects), strip CR, lower-case the names.
  tr -d '\r' < "$WORK/$name.raw" \
    | awk '/^HTTP\//{out=""} {out = out $0 "\n"} END{printf "%s", out}' \
    | awk '{i = index($0, ":"); if (i > 0) print tolower(substr($0, 1, i - 1)) substr($0, i); else print}' > "$WORK/$name.headers" || true
  echo "$status"
}

# header <name> <header-name>: the header's value (empty if absent).
header() {
  grep -i "^$2: " "$WORK/$1.headers" | tail -n 1 | sed -E "s/^[^:]+: ?//" || true
}

expect_status() { # <label> <actual> <expected...>
  local label="$1" actual="$2"
  shift 2
  for want in "$@"; do
    if [ "$actual" = "$want" ]; then pass "$label: HTTP $actual"; return 0; fi
  done
  fail "$label: HTTP $actual (expected $*)"
  return 1
}

expect_header() { # <name> <label> <header> <extended regex>
  local value
  value="$(header "$1" "$3")"
  if printf '%s' "$value" | grep -q -E "$4"; then pass "$2: $3: $value"; else fail "$2: $3 is '${value:-<missing>}' (expected /$4/)"; fi
}

echo "Checking $ORIGIN$PREFIX"

echo "App shell"
# In a subfolder, Next.js (trailingSlash: false) answers /glassgrid/ with a 308 to /glassgrid; curl follows it.
status="$(fetch root "$PREFIX")"
if expect_status "$PREFIX" "$status" 200; then
  expect_header root "$PREFIX" content-type '^text/html'
  expect_header root "$PREFIX" content-security-policy "script-src 'self' 'wasm-unsafe-eval'"
  expect_header root "$PREFIX" content-security-policy "frame-ancestors 'none'"
  if header root content-security-policy | grep -q -E "'unsafe-eval'|'unsafe-inline'"; then fail "$PREFIX: CSP allows unsafe-eval or unsafe-inline"; fi
  expect_header root "$PREFIX" x-content-type-options '^nosniff$'
  expect_header root "$PREFIX" cross-origin-opener-policy '^same-origin$'
  expect_header root "$PREFIX" cache-control 'max-age=0'
  if grep -q "\"${PREFIX}assets/" "$WORK/root.body"; then pass "$PREFIX: scripts load from ${PREFIX}assets/"; else fail "$PREFIX: index.html does not load ${PREFIX}assets/ (built for another base?)"; fi
fi

if [ "$PREFIX" != "/" ]; then
  status="$(fetch bare "${PREFIX%/}")"
  if expect_status "${PREFIX%/}" "$status" 200; then
    expect_header bare "${PREFIX%/}" content-security-policy "wasm-unsafe-eval"
    if cmp -s "$WORK/root.body" "$WORK/bare.body"; then pass "${PREFIX%/}: same SPA shell as $PREFIX"; else fail "${PREFIX%/}: body differs from $PREFIX"; fi
  fi
fi

status="$(fetch sample "${PREFIX}?sample=taxi")"
if expect_status "${PREFIX}?sample=taxi" "$status" 200; then
  expect_header sample "${PREFIX}?sample=taxi" content-type '^text/html'
  expect_header sample "${PREFIX}?sample=taxi" content-security-policy "wasm-unsafe-eval"
  if cmp -s "$WORK/root.body" "$WORK/sample.body"; then pass "${PREFIX}?sample=taxi: same SPA shell as $PREFIX"; else fail "${PREFIX}?sample=taxi: body differs from $PREFIX"; fi
fi

status="$(fetch gallery "${PREFIX}gallery")"
if expect_status "${PREFIX}gallery" "$status" 200; then
  expect_header gallery "${PREFIX}gallery" content-security-policy "wasm-unsafe-eval"
  if cmp -s "$WORK/root.body" "$WORK/gallery.body"; then pass "${PREFIX}gallery: rewritten to the SPA shell"; else fail "${PREFIX}gallery: body differs from $PREFIX"; fi
fi

echo "DuckDB-WASM"
# Follow the module graph from index.html to the worker's .wasm (hashed names change per build).
queue="$(grep -o -E "${PREFIX}assets/[A-Za-z0-9._-]+\\.js" "$WORK/root.body" | sort -u || true)"
seen=""
wasm=""
depth=0
while [ -n "$queue" ] && [ -z "$wasm" ] && [ $depth -lt 4 ]; do
  next=""
  for asset in $queue; do
    case " $seen " in *" $asset "*) continue ;; esac
    seen="$seen $asset"
    curl -sS -L --max-time 60 -A "$UA" ${CURL_EXTRA[@]+"${CURL_EXTRA[@]}"} -o "$WORK/asset.js" "$ORIGIN$asset" || continue
    found="$(grep -o -E 'duckdb-eh-[A-Za-z0-9_-]+\.wasm' "$WORK/asset.js" | head -n 1 || true)"
    if [ -n "$found" ]; then wasm="${PREFIX}assets/$found"; break; fi
    # Vite's hashed chunk names: <name>-<8 characters>.js.
    next="$next $(grep -o -E '[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.js' "$WORK/asset.js" | sed "s#^#${PREFIX}assets/#" | sort -u | tr '\n' ' ' || true)"
  done
  queue="$next"
  depth=$((depth + 1))
done

if [ -z "$wasm" ]; then
  fail "could not find duckdb-eh-*.wasm from index.html's scripts"
else
  status="$(fetch wasm "$wasm" -H 'Accept-Encoding: br, gzip')"
  if expect_status "$wasm" "$status" 200; then
    expect_header wasm "$wasm" content-type '^application/wasm'
    expect_header wasm "$wasm" cache-control 'immutable'
    encoding="$(header wasm content-encoding)"
    bytes="$(wc -c < "$WORK/wasm.body" | tr -d ' ')"
    if printf '%s' "$encoding" | grep -q -E '^(br|gzip)$'; then
      pass "$wasm: content-encoding: $encoding ($bytes bytes on the wire)"
    elif [ "${ALLOW_UNCOMPRESSED:-}" = "1" ]; then
      warn "$wasm: not compressed ($bytes bytes); allowed by ALLOW_UNCOMPRESSED=1"
    else
      fail "$wasm: not compressed (content-encoding '${encoding:-<none>}', $bytes bytes): first visit downloads ~34 MB instead of ~8 MB"
    fi
  fi
fi

ext="${PREFIX}duckdb-extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm"
status="$(fetch ext "$ext" -H 'Accept-Encoding: br, gzip')"
if expect_status "$ext" "$status" 200; then
  expect_header ext "$ext" content-type '^application/wasm'
  expect_header ext "$ext" cache-control 'immutable'
fi

echo "Samples"
workspace="${PREFIX}samples/taxi.glassgrid"
status="$(fetch workspace "$workspace")"
if expect_status "$workspace" "$status" 200; then
  expect_header workspace "$workspace" content-type 'json'
  if grep -q '"formatVersion"' "$WORK/workspace.body"; then pass "$workspace: a workspace file"; else fail "$workspace: not a workspace file"; fi
fi

parquet="${PREFIX}samples/taxi-trips-2025h1.parquet"
status="$(fetch parquet "$parquet" -H 'Range: bytes=0-3')"
if expect_status "$parquet (Range: bytes=0-3)" "$status" 206; then
  if [ "$(head -c 4 "$WORK/parquet.body")" = "PAR1" ]; then pass "$parquet: starts with PAR1"; else fail "$parquet: first bytes are not PAR1"; fi
  expect_header parquet "$parquet" content-type '^application/vnd\.apache\.parquet'
  expect_header parquet "$parquet" content-range '^bytes 0-3/[0-9]+'
  expect_header parquet "$parquet" cache-control 'immutable'
fi

if [ "$PREFIX" != "/" ]; then
  echo "Hosting manifest"
  hosting="${PREFIX}glassgrid-hosting.json"
  status="$(fetch hosting "$hosting")"
  if [ "$status" = "200" ]; then
    if grep -q -E "\"base\": *\"${PREFIX}\"" "$WORK/hosting.body"; then pass "$hosting: base $PREFIX"; else fail "$hosting: base is not $PREFIX"; fi
    version="$(grep -o -E '"version": *"[^"]+"' "$WORK/hosting.body" | head -n 1 | sed -E 's/.*"([^"]+)"$/\1/' || true)"
    pass "$hosting: version ${version:-<missing>}"
  else
    warn "$hosting: HTTP $status (the host does not publish it; the version is unknown)"
  fi
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
