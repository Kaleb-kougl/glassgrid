#!/usr/bin/env bash
# Builds the web demo for a subfolder of another site and packages it as a
# release tarball: the contents of apps/web/dist (index.html, assets/,
# samples/, duckdb-extensions/, glassgrid-hosting.json) at the archive root,
# without dist/.vite. Writes, in apps/web/release/ (gitignored):
#
#   glassgrid-web-<version>.tar.gz
#   glassgrid-web-<version>.tar.gz.sha256   ("<sha256>  glassgrid-web-<version>.tar.gz")
#
# Usage:
#   scripts/package-web.sh [--no-build] [version]
#   pnpm package:web 0.1.0
#
#   version      X.Y.Z or X.Y.Z-pre. Default: $GLASSGRID_VERSION, else apps/web/package.json's version.
#   --no-build   package the existing dist/ (the release workflow builds and tests it first); it must
#                have been built for the same base and version (checked against glassgrid-hosting.json).
#   GLASSGRID_BASE  the path the build is served under. Default: /glassgrid/ (the portfolio).
#
# Needs bash, node, pnpm, tar, gzip and sha256sum or shasum (Linux and macOS).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/apps/web"
DIST="$WEB/dist"
OUT="$WEB/release"

BUILD=1
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) VERSION="$arg" ;;
  esac
done
VERSION="${VERSION:-${GLASSGRID_VERSION:-$(node -p "require('$WEB/package.json').version")}}"
VERSION="${VERSION#web-v}"
VERSION="${VERSION#v}"
BASE="${GLASSGRID_BASE:-/glassgrid/}"

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "not a release version: '$VERSION' (expected X.Y.Z or X.Y.Z-pre)" >&2
  exit 2
fi

if [ "$BUILD" = 1 ]; then
  echo "Building apps/web for $BASE, version $VERSION"
  (cd "$ROOT" && GLASSGRID_BASE="$BASE" GLASSGRID_VERSION="$VERSION" pnpm --filter @glassgrid/web build)
fi

MANIFEST="$DIST/glassgrid-hosting.json"
if [ ! -f "$MANIFEST" ] || [ ! -f "$DIST/index.html" ]; then
  echo "no build in $DIST (run without --no-build)" >&2
  exit 1
fi
built="$(node -p "const m = require('$MANIFEST'); m.base + ' ' + m.version")"
if [ "$built" != "$BASE $VERSION" ]; then
  echo "$DIST was built for '$built', not '$BASE $VERSION': rebuild with GLASSGRID_BASE=$BASE GLASSGRID_VERSION=$VERSION" >&2
  exit 1
fi

NAME="glassgrid-web-$VERSION.tar.gz"
mkdir -p "$OUT"
rm -f "$OUT/$NAME" "$OUT/$NAME.sha256"

# Top-level entries of dist/ except dot-folders (.vite: Vite's build manifest, used only by scripts/size.ts).
entries=()
while IFS= read -r entry; do entries+=("$entry"); done < <(cd "$DIST" && find . -mindepth 1 -maxdepth 1 ! -name '.*' | sed 's#^\./##' | LC_ALL=C sort)

# Same bytes for the same dist/ where GNU tar allows it: sorted names, no owner, every file dated
# SOURCE_DATE_EPOCH (default: the commit's time); gzip without a timestamp.
TAR_FLAGS=()
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  epoch="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || date +%s)}"
  TAR_FLAGS=(--sort=name --owner=0 --group=0 --numeric-owner --mtime=@"$epoch")
fi
(cd "$DIST" && tar ${TAR_FLAGS[@]+"${TAR_FLAGS[@]}"} -cf - "${entries[@]}") | gzip -n -9 > "$OUT/$NAME"

if command -v sha256sum >/dev/null 2>&1; then
  sha="$(sha256sum "$OUT/$NAME" | awk '{print $1}')"
else
  sha="$(shasum -a 256 "$OUT/$NAME" | awk '{print $1}')"
fi
printf '%s  %s\n' "$sha" "$NAME" > "$OUT/$NAME.sha256"

bytes="$(wc -c < "$OUT/$NAME" | tr -d ' ')"
echo "Packaged $OUT/$NAME"
echo "  base     $BASE"
echo "  version  $VERSION"
echo "  bytes    $bytes"
echo "  sha256   $sha"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "file=$OUT/$NAME"
    echo "name=$NAME"
    echo "sha256=$sha"
  } >> "$GITHUB_OUTPUT"
fi
