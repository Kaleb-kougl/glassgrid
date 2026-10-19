#!/usr/bin/env bash
# Checks a deployed web demo (Vercel production or preview) against the
# hosting contract in apps/web/vercel.json and docs/m4-web-demo.md:
#
#   - the app shell, /?sample=taxi and /gallery serve the SPA with the header CSP;
#   - DuckDB-WASM's .wasm is application/wasm, compressed (br or gzip) and immutable;
#   - the signed Parquet extension and the sample data are reachable, and
#     Parquet answers Range requests (DuckDB-WASM reads it by range);
#   - the sample workspace is served.
#
# Usage:
#   scripts/check-deploy.sh https://glassgrid.vercel.app
#   VERCEL_PROTECTION_BYPASS=<secret> scripts/check-deploy.sh https://<preview>.vercel.app
#   ALLOW_UNCOMPRESSED=1 scripts/check-deploy.sh http://127.0.0.1:4173   # local e2e/serve.ts does not compress
#
# Needs bash and curl (macOS and Linux). Exits 1 if any check fails.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <deployment-url>" >&2
  exit 2
fi
BASE="${1%/}"
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
    -D "$WORK/$name.raw" -o "$WORK/$name.body" -w '%{http_code}' "$BASE$path")" || status="000"
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

echo "Checking $BASE"

echo "App shell"
status="$(fetch root /)"
if expect_status "/" "$status" 200; then
  expect_header root "/" content-type '^text/html'
  expect_header root "/" content-security-policy "script-src 'self' 'wasm-unsafe-eval'"
  expect_header root "/" content-security-policy "frame-ancestors 'none'"
  if header root content-security-policy | grep -q -E "'unsafe-eval'|'unsafe-inline'"; then fail "/: CSP allows unsafe-eval or unsafe-inline"; fi
  expect_header root "/" x-content-type-options '^nosniff$'
  expect_header root "/" cross-origin-opener-policy '^same-origin$'
  expect_header root "/" cache-control 'max-age=0'
fi

status="$(fetch sample '/?sample=taxi')"
if expect_status "/?sample=taxi" "$status" 200; then
  expect_header sample "/?sample=taxi" content-type '^text/html'
  expect_header sample "/?sample=taxi" content-security-policy "wasm-unsafe-eval"
  if cmp -s "$WORK/root.body" "$WORK/sample.body"; then pass "/?sample=taxi: same SPA shell as /"; else fail "/?sample=taxi: body differs from /"; fi
fi

status="$(fetch gallery /gallery)"
if expect_status "/gallery" "$status" 200; then
  if cmp -s "$WORK/root.body" "$WORK/gallery.body"; then pass "/gallery: rewritten to the SPA shell"; else fail "/gallery: body differs from /"; fi
fi

echo "DuckDB-WASM"
# Follow the module graph from index.html to the worker's .wasm (hashed names change per build).
queue="$(grep -o -E '/assets/[A-Za-z0-9._-]+\.js' "$WORK/root.body" | sort -u || true)"
seen=""
wasm=""
depth=0
while [ -n "$queue" ] && [ -z "$wasm" ] && [ $depth -lt 4 ]; do
  next=""
  for asset in $queue; do
    case " $seen " in *" $asset "*) continue ;; esac
    seen="$seen $asset"
    curl -sS -L --max-time 60 -A "$UA" ${CURL_EXTRA[@]+"${CURL_EXTRA[@]}"} -o "$WORK/asset.js" "$BASE$asset" || continue
    found="$(grep -o -E 'duckdb-eh-[A-Za-z0-9_-]+\.wasm' "$WORK/asset.js" | head -n 1 || true)"
    if [ -n "$found" ]; then wasm="/assets/$found"; break; fi
    # Vite's hashed chunk names: <name>-<8 characters>.js.
    next="$next $(grep -o -E '[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.js' "$WORK/asset.js" | sed 's#^#/assets/#' | sort -u | tr '\n' ' ' || true)"
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

ext=/duckdb-extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm
status="$(fetch ext "$ext" -H 'Accept-Encoding: br, gzip')"
if expect_status "$ext" "$status" 200; then
  expect_header ext "$ext" content-type '^application/wasm'
  expect_header ext "$ext" cache-control 'immutable'
fi

echo "Samples"
status="$(fetch workspace /samples/taxi.glassgrid)"
if expect_status "/samples/taxi.glassgrid" "$status" 200; then
  expect_header workspace "/samples/taxi.glassgrid" content-type 'json'
  if grep -q '"formatVersion"' "$WORK/workspace.body"; then pass "/samples/taxi.glassgrid: a workspace file"; else fail "/samples/taxi.glassgrid: not a workspace file"; fi
fi

parquet=/samples/taxi-trips-2025h1.parquet
status="$(fetch parquet "$parquet" -H 'Range: bytes=0-3')"
if expect_status "$parquet (Range: bytes=0-3)" "$status" 206; then
  if [ "$(head -c 4 "$WORK/parquet.body")" = "PAR1" ]; then pass "$parquet: starts with PAR1"; else fail "$parquet: first bytes are not PAR1"; fi
  expect_header parquet "$parquet" content-type '^application/vnd\.apache\.parquet'
  expect_header parquet "$parquet" content-range '^bytes 0-3/[0-9]+'
  expect_header parquet "$parquet" cache-control 'immutable'
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
