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

# The merge gate, run by hand.
#
# `.github/workflows/ci.yml` is correct but DORMANT: this GitHub Enterprise
# instance has no runner for `ubuntu-latest`, so the workflow has never
# executed — `gh run list` is empty and `main` carries zero check runs. Until
# the repo moves to github.com, nothing runs the gate unless a human does.
# This script is that human's tool.
#
# It mirrors ci.yml step for step ON PURPOSE. If you change one, change the
# other, or the thing that gates today and the thing that gates after the move
# will disagree — and the disagreement will surface as a surprise on the very
# PR that completes the migration.
#
#   ci.yml                         this script
#   ------                         -----------
#   actions/setup-node@v6          require_node
#   node-version: 24               NODE_MAJOR_MIN
#   npm ci                         npm ci        (skippable: --fast)
#   npm run check                  npm run check
#   npx vite build                 npx vite build
#   node scripts/bundle-budget.mjs node scripts/bundle-budget.mjs
#   node scripts/smoke.mjs         node scripts/smoke.mjs
#   node scripts/spa-check.mjs     node scripts/spa-check.mjs
#
# The last two steps need a real browser (Chrome; set CHROME_PATH if it is
# somewhere unusual). Neither is decoration: `npm run check` provably cannot
# catch a bug that only exists in minified, Worker-executing builds — see #30,
# where the view tester was broken in every release for weeks with the whole
# suite green — and it cannot express anything at all about SPA mode, where
# CORS, cross-site cookies and the page CSP apply and happy-dom has none of
# them (#37). See scripts/smoke.mjs and scripts/spa-check.mjs.
#
# The bundle-budget step measures the built output instead of running it: how
# many bytes a browser must fetch before first paint, and whether Monaco is
# among them. Nothing else here measures size, which is how a chunking rule sat
# in vite.config.ts putting 1.4 MB gzip on the critical path for the whole life
# of the project with every other gate green (#150).
#
# The spa-check step is credential-gated and SKIPS visibly when it is not
# configured, so this gate stays hermetic by default. Point it at a real
# CouchDB (see .env.example) to actually run it.
#
# Usage:
#   scripts/check.sh           full gate, exactly as CI would run it
#   scripts/check.sh --fast    skip `npm ci` when node_modules is already current
set -euo pipefail

# ci.yml pins node-version: 24. Anything older is not what will gate the repo
# after the move, so a green run here would not mean much.
NODE_MAJOR_MIN=24

cd "$(dirname "$0")/.."

FAST=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    # Line range: the comment block above, lines 19-63. Adding a line up there
    # moves the end of it; nothing else checks that these two agree.
    -h|--help) sed -n '19,63p' "$0"; exit 0 ;;
    *) printf 'check: unknown argument %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

step=0
say() { step=$((step + 1)); printf '\n\033[1m[%d/%d] %s\033[0m\n' "$step" "$TOTAL" "$*"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

TOTAL=7
[ "$FAST" = 1 ] && TOTAL=6

require_node() {
  command -v node >/dev/null || fail "node is not installed"
  local major
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -lt "$NODE_MAJOR_MIN" ]; then
    fail "node $major is older than ci.yml's node-version: $NODE_MAJOR_MIN"
  fi
  printf 'node %s\n' "$(node -v)"
}

say "node version (ci.yml pins $NODE_MAJOR_MIN)"
require_node

if [ "$FAST" = 0 ]; then
  # `npm ci` and not `npm install`: CI installs from the lockfile alone, and a
  # local `npm install` can silently resolve something the lockfile does not
  # pin. A worktree with no node_modules of its own also breaks the custom
  # eslint rules, which read WA's CSS by a worktree-relative path.
  say "npm ci"
  npm ci || fail "npm ci"
fi

say "npm run check (lint, test, typecheck)"
npm run check || fail "npm run check"

# ci.yml runs `npx vite build`, NOT `npm run build` — the latter re-runs the
# whole check first, doubling a slow step for no extra signal.
say "npx vite build"
npx vite build || fail "vite build"

# The only step that measures the build rather than running it: bytes before
# first paint, and Monaco's absence from them. Needs no browser (#150).
say "node scripts/bundle-budget.mjs (first-paint payload)"
node scripts/bundle-budget.mjs || fail "bundle budget"

# The only step that runs built, minified code in a real browser. Everything
# above it runs source.
say "node scripts/smoke.mjs (built bundle, real browser, real Worker)"
node scripts/smoke.mjs || fail "smoke check"

# The only step that exercises SPA mode — a cross-origin CouchDB, a real cookie
# jar, a real CSP. Credential-gated: with nothing configured it prints a skip
# and exits 0, which is why it can live in the default gate at all.
say "node scripts/spa-check.mjs (SPA mode: cross-origin CouchDB, cookies, CSP)"
node scripts/spa-check.mjs || fail "spa check"

printf '\n\033[32mAll gates green — same steps ci.yml will run once the repo moves.\033[0m\n'
