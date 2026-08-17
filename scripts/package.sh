#!/usr/bin/env bash
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# The release packager, run by hand.
#
# Couch Companion is a drop-in replacement for the Fauxton bundle CouchDB
# serves at /_utils/: replace the contents of `share/www` and the new UI is
# there. `vite build` already emits exactly that layout — `base: './'` so every
# asset URL is relative, the Font Awesome SVGs copied into `dist/icons/`, and
# no third-party host left anywhere in the bundle. Packaging therefore needs no
# build system of its own. It needs a version number, a tarball, and one
# invariant:
#
#   THE ARCHIVE MEMBERS ARE `index.html`, `assets/…`, `icons/…` AT THE ROOT.
#
# Not `dist/index.html`. Installing means `tar xzf … -C .../share/www`, so an
# extra `dist/` level inside the archive lands every file one directory too
# deep: CouchDB serves `share/www/dist/index.html`, and /_utils/ answers 404
# for the app it is supposedly hosting. Nothing else in this script can fail as
# quietly, which is why it packs from *inside* `dist/` and then re-reads the
# archive it just wrote before printing anything encouraging.
#
# Like scripts/check.sh, this is driven by hand: this GitHub Enterprise
# instance has no runner for `ubuntu-latest`, so no workflow has ever executed
# here. A human ships releases until the repo moves to github.com.
#
# One build, two artifacts, <version> straight from package.json:
#
#   release/couch-companion-ui-<version>.tar.gz   unpack into share/www
#   couch-companion:<version>, couch-companion:latest   a CouchDB serving it
#
# The tarball lands in `release/` (gitignored). The image is that same bundle
# with a database around it — `FROM couchdb:latest` with share/www replaced,
# built from `dist/` via docker/Dockerfile — for the operator whose question is
# "give me a CouchDB that already has this UI" rather than "let me patch mine".
#
# Docker is therefore a hard dependency of a release. If it is missing this
# script fails; it does not skip the image and print something encouraging
# anyway, which would ship a half release nobody noticed was half. `--no-docker`
# is how you say you meant it.
#
# Usage:
#   scripts/package.sh              build the way CI would, then package
#   scripts/package.sh --fast       skip lint/test/typecheck and the browser smoke
#                                   check — for when scripts/check.sh has just run
#                                   green, since it runs all of them
#   scripts/package.sh --no-docker  tarball only, skip the image and its check
#
# IMAGE_NAME overrides the image name for a registry namespace, e.g.
#   IMAGE_NAME=ghcr.io/acme/couch-companion scripts/package.sh
# Nothing is ever pushed; the tags are local and the summary prints the push.
set -euo pipefail

cd "$(dirname "$0")/.."

DIST=dist
OUT=release

FAST=0
DOCKER=1
IMAGE_NAME=${IMAGE_NAME:-couch-companion}
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --no-docker) DOCKER=0 ;;
    # Line range: the comment block above, lines 19-66.
    -h|--help) sed -n '19,66p' "$0"; exit 0 ;;
    *) printf 'package: unknown argument %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

# version, build, pack, verify archive — plus the smoke check unless --fast, plus
# build-image and verify-image unless --no-docker.
TOTAL=4
[ "$FAST" = 0 ] && TOTAL=$((TOTAL + 1))
[ "$DOCKER" = 1 ] && TOTAL=$((TOTAL + 2))
step=0
say() { step=$((step + 1)); printf '\n\033[1m[%d/%d] %s\033[0m\n' "$step" "$TOTAL" "$*"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

say "version from package.json"
VERSION=$(node -p 'require("./package.json").version' 2>/dev/null) ||
  fail "cannot read version from package.json"
[ -n "$VERSION" ] && [ "$VERSION" != "undefined" ] || fail "package.json has no version"
printf 'couch-companion-ui %s\n' "$VERSION"

# Check Docker here, at second one, rather than at step six where it is used.
# By then a full lint/test/typecheck/vite/smoke run has already gone by, and
# "docker: command not found" after several minutes of green output is a poor
# way to learn that this machine was never going to finish a release.
if [ "$DOCKER" = 1 ]; then
  command -v docker >/dev/null 2>&1 ||
    fail "docker not found — install it, or run with --no-docker for the tarball alone"
  docker info >/dev/null 2>&1 ||
    fail "the Docker daemon is not responding (\`docker info\` failed) — start it, or run with --no-docker"
  [ -f docker/Dockerfile ] ||
    fail "docker/Dockerfile is missing — the image cannot be built from this checkout"
fi

# Always build. Packaging a `dist/` left over from an earlier checkout is the
# one way to ship code nobody reviewed, and `vite build` empties the directory
# first (build.emptyOutDir), so what follows is only ever this commit.
if [ "$FAST" = 1 ]; then
  say "npx vite build (--fast: lint/test/typecheck skipped)"
  npx vite build || fail "vite build"
else
  say "npm run build (lint, test, typecheck, vite build)"
  npm run build || fail "npm run build"

  # `npm run build` runs the whole unit suite and still cannot tell you whether
  # the app works, because it runs source: #30 shipped a view tester that was
  # broken in every tarball this script has ever produced, with every gate
  # above green. This is the step that would have stopped it, so it belongs on
  # the path that hands an artifact to an operator.
  say "node scripts/smoke.mjs (built bundle, real browser, real Worker)"
  node scripts/smoke.mjs || fail "smoke check"
fi

# `set -e` already aborts on a failed build, but a build can also succeed at
# writing not very much. These are the three things share/www must contain:
# the entry document, the hashed bundles it loads, and the icon tree that
# `setIconPath()` resolves <wa-icon> against. A missing icon directory is the
# nastiest of the three — icons fail silently in the UI, one blank square at a
# time, with nothing in the console.
[ -s "$DIST/index.html" ] || fail "$DIST/index.html missing or empty after the build"
[ -d "$DIST/assets" ] || fail "$DIST/assets missing after the build"
[ -s "$DIST/icons/solid/circle-info.svg" ] ||
  fail "$DIST/icons is missing or incomplete after the build"

# Web Awesome's own internal icons — the wa-select chevron, the tick on a selected option, the
# eye on a password field, the dialog close × — are a second tree with a second failure mode
# (#140). They are not copied from a directory but generated into `icons/system/` out of the
# vendored package, so "the icon tree exists" above says nothing about them, and re-registering
# the `system` library made providing ALL of them our responsibility: one missing file is one
# permanently blank control, with nothing in the console. Count them against the package the
# running app resolves names out of, so a Web Awesome upgrade cannot drop one quietly.
SYSTEM_EXPECTED=$(node --input-type=module -e \
  'import { icons } from "@awesome.me/webawesome/dist/components/icon/library.system.js";
   console.log(Object.values(icons).reduce((n, c) => n + Object.keys(c).length, 0));') ||
  fail "cannot read the Web Awesome system icon set from node_modules"
[ -d "$DIST/icons/system" ] ||
  fail "$DIST/icons/system is missing — every Web Awesome component icon would be blank"
SYSTEM_BUILT=$(find "$DIST/icons/system" -name '*.svg' | wc -l | tr -d ' ')
[ "$SYSTEM_BUILT" = "$SYSTEM_EXPECTED" ] ||
  fail "$DIST/icons/system has $SYSTEM_BUILT SVGs, but Web Awesome defines $SYSTEM_EXPECTED"

say "pack $OUT/couch-companion-ui-$VERSION.tar.gz"
mkdir -p "$OUT"
TARBALL="$OUT/couch-companion-ui-$VERSION.tar.gz"
rm -f "$TARBALL"

# Members are listed from inside `dist` and passed by bare name, so the archive
# root *is* dist's contents. (`tar -C dist .` would unpack the same, but writes
# every member as `./index.html`, which reads like a directory level to anyone
# eyeballing `tar tzf` output — and the point of this script is that nobody has
# to wonder.)
#
# The two macOS guards matter because the archive is written on a Mac and
# unpacked by GNU tar inside a Linux container: COPYFILE_DISABLE stops bsdtar
# adding a `._` AppleDouble twin beside every entry (CouchDB would serve those
# as junk files), and --no-xattrs stops it recording `com.apple.provenance`,
# which GNU tar answers with "Ignoring unknown extended header keyword" once
# per file — 2,900 lines of alarming noise across an install that is fine.
# Both are understood by GNU tar too, so packaging on Linux behaves the same.
members=()
while IFS= read -r entry; do members+=("$entry"); done < <(cd "$DIST" && ls -A)
[ ${#members[@]} -gt 0 ] || fail "$DIST is empty — nothing to package"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TARBALL" -C "$DIST" "${members[@]}" ||
  fail "tar failed"

say "verify archive layout"
listing=$(tar tzf "$TARBALL") || fail "cannot read back $TARBALL"
# Here-string, not `printf | grep`: `grep -q` stops at the first match, and the
# SIGPIPE that kills the writer would come back through `pipefail` as a failed
# check — a layout verifier that fails on a *matching* archive.
has() { grep -Eq "$1" <<<"$listing"; }
has '^index\.html$' ||
  fail "index.html is not at the archive root — it would unpack into a subdirectory of share/www, and /_utils/ would 404"
has '^assets/' || fail "no assets/ at the archive root"
has '^icons/solid/circle-info\.svg$' || fail "the icon tree is not at the archive root"
has '^icons/system/regular/eye\.svg$' ||
  fail "the Web Awesome system icons are not at the archive root — every component icon would be blank"
if has '^(\./|dist/)'; then
  fail "archive members are nested — they must sit at the archive root"
fi

BYTES=$(wc -c <"$TARBALL" | tr -d ' ')
[ "$BYTES" -gt 100000 ] || fail "$TARBALL is only $BYTES bytes — that is not a whole app"
COUNT=$(printf '%s\n' "$listing" | grep -c .)

if [ "$DOCKER" = 1 ]; then
  say "docker build $IMAGE_NAME:$VERSION and :latest"
  # The build context is `$DIST`, not `.` — docker/Dockerfile explains why at
  # length, and it is the one argument here that must not be "improved". Both
  # tags are applied in the single build, so :latest and :<version> are always
  # the same image ID rather than two builds that drifted apart.
  docker build \
    -f docker/Dockerfile \
    --build-arg "VERSION=$VERSION" \
    -t "${IMAGE_NAME}:${VERSION}" \
    -t "${IMAGE_NAME}:latest" \
    "$DIST" || fail "docker build"

  # A built image is not a working one. `COPY . /opt/couchdb/share/www/` cannot
  # fail loudly — it will happily create the directory one level too deep, or
  # merge over a Fauxton that was never removed — and both mistakes produce an
  # image that starts, answers /_up, and serves the wrong application. So ask
  # the running container what it is, with the same request docs/install.md
  # gives operators for verifying their own install.
  say "verify image (run it, ask /_utils/ what it answers)"
  CID=""
  cleanup_container() { [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1; return 0; }
  trap cleanup_container EXIT
  # Port 0 lets Docker pick a free one. Hardcoding 5984 would collide with the
  # devcontainer's CouchDB — and worse, a *successful* collision would verify
  # that other server instead of the image just built.
  CID=$(docker run -d -p 127.0.0.1:0:5984 \
    -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=verify \
    "${IMAGE_NAME}:${VERSION}") || fail "cannot start a container from the image just built"
  # Parsed with shell expansion rather than `… | head -1`: first line, then the
  # part after the last colon, so an IPv6 binding on a second line cannot hand
  # us a port that is not the one bound to 127.0.0.1.
  PUBLISHED=$(docker port "$CID" 5984/tcp) || fail "the container published no port for 5984"
  PUBLISHED=${PUBLISHED%%$'\n'*}
  PORT=${PUBLISHED##*:}
  [ -n "$PORT" ] || fail "cannot read the published port from '$PUBLISHED'"
  BASE="http://127.0.0.1:$PORT"

  ready=0
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE/_up" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" = 1 ] ||
    fail "the container never answered /_up within 60s — $(docker logs "$CID" 2>&1 | tail -5)"

  # Matched whole, against the response body: no `grep -o | head` pipeline to
  # take a SIGPIPE through `pipefail` and report a passing image as a failure.
  body=$(curl -fsSL "$BASE/_utils/") ||
    fail "/_utils/ in the image did not answer — share/www is empty, or the bundle landed a directory too deep inside it"
  case "$body" in
    *'<title>Couch Companion</title>'*) : ;;
    *'<title>Project Fauxton</title>'*)
      fail "/_utils/ in the image still serves Fauxton — share/www was not replaced" ;;
    *) fail "/_utils/ in the image served something else entirely — share/www holds the wrong files" ;;
  esac
  # index.html could be right while everything beside it landed a directory too
  # deep. One asset from the tree that fails most quietly if it is missing.
  curl -fsS -o /dev/null "$BASE/_utils/icons/system/regular/eye.svg" ||
    fail "the icon tree is not served under /_utils/ — every Web Awesome component icon would be blank"

  IMAGE_MB=$(docker image inspect "${IMAGE_NAME}:${VERSION}" --format '{{.Size}}' |
    awk '{ printf "%.0f", $1 / 1048576 }')
  cleanup_container
  trap - EXIT
fi

printf '\n\033[32mPackaged %s — %s files, %s MB.\033[0m\n' \
  "$TARBALL" "$COUNT" "$(awk -v b="$BYTES" 'BEGIN { printf "%.1f", b / 1048576 }')"
if [ "$DOCKER" = 1 ]; then
  printf '\033[32mBuilt %s:%s and %s:latest — %s MB, /_utils/ verified.\033[0m\n' \
    "$IMAGE_NAME" "$VERSION" "$IMAGE_NAME" "$IMAGE_MB"
fi

NAME=$(basename "$TARBALL")

# The image first: it is the only one of the three that needs no existing
# CouchDB and destroys nothing.
if [ "$DOCKER" = 1 ]; then
cat <<EOF

Run — the image just built, a CouchDB already serving this UI at /_utils/:

  docker run -d --name couch-companion -p 5984:5984 \\
    -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=<choose one> \\
    -v couchdb_data:/opt/couchdb/data $IMAGE_NAME:$VERSION

Then open http://127.0.0.1:5984/_utils/. Databases live in the named volume,
so a later version replaces the container without touching the data.

Nothing was pushed. To publish:

  docker tag $IMAGE_NAME:$VERSION <registry>/$IMAGE_NAME:$VERSION
  docker push <registry>/$IMAGE_NAME:$VERSION
EOF
fi

cat <<EOF

Install into an existing CouchDB on this host (stop CouchDB first; adjust the prefix):

  mv /opt/couchdb/share/www /opt/couchdb/share/www.fauxton    # keep the original
  mkdir -p /opt/couchdb/share/www
  tar xzf $PWD/$TARBALL -C /opt/couchdb/share/www

Install into an existing CouchDB in a container named \`couchdb\`:

  docker cp $TARBALL couchdb:/tmp/$NAME
  docker exec couchdb sh -c 'mv /opt/couchdb/share/www /opt/couchdb/share/www.fauxton && mkdir -p /opt/couchdb/share/www'
  docker exec couchdb tar xzf /tmp/$NAME -C /opt/couchdb/share/www

Either way the app is then at http://<host>:5984/_utils/ — no restart needed,
CouchDB serves share/www off disk. To roll back, delete share/www and move
share/www.fauxton back. See docs/install.md for the full story.
EOF
