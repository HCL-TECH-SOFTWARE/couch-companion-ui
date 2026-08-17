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

# Joins the three nodes of docker-compose.cluster.yml into one cluster, wires
# CORS on each of them, and seeds the deliberate config divergence the node
# comparison screen exists to show (#123).
#
# Runs INSIDE the compose network as the one-shot `cluster-setup` service, so
# it can address the nodes by their Erlang names. Set COUCH_URL to run it from
# the host instead (http://localhost:15984) — `add_node` names the peers, and
# the coordinator resolves those itself, so both work.
#
# Idempotent: safe to re-run, and re-running is also the documented repair for
# a cluster damaged by `docker compose stop && start`.
set -euo pipefail

COORD=${COUCH_URL:-http://couchdb1.ccui.local:5984}
ADMIN=${COUCH_ADMIN:-admin:password}

COORD_HOST=couchdb1.ccui.local
PEER_HOSTS=(couchdb2.ccui.local couchdb3.ccui.local)
NODES=(couchdb@couchdb1.ccui.local couchdb@couchdb2.ccui.local couchdb@couchdb3.ccui.local)
DIVERGENT_NODE=couchdb@couchdb3.ccui.local

# Origin the vite dev server runs on, matching scripts/seed-dev.sh.
CORS_ORIGIN=${CORS_ORIGIN:-http://localhost:5173}

say() { printf 'cluster-setup: %s\n' "$*"; }

wait_for() {
  local url=$1 name=$2 i
  for i in $(seq 1 60); do
    curl -sf "$url" >/dev/null && { say "$name is up"; return 0; }
    sleep 2
  done
  say "ERROR: $name never came up ($url)"
  exit 1
}

# POST an action to /_cluster_setup on the coordinator.
#
# Deliberately NOT `curl -f`. With COUCHDB_USER/COUCHDB_PASSWORD set the node
# already has an admin, so it boots straight into `cluster_enabled` and the
# very first enable_cluster answers HTTP 400 "Cluster is already enabled".
# That is expected and benign — but blanket-ignoring errors instead would let a
# genuine add_node failure pass silently, so match the body and fail on
# anything not recognised.
setup_action() {
  local desc=$1 body=$2 resp
  resp=$(curl -sS -u "$ADMIN" -X POST "$COORD/_cluster_setup" \
    -H 'Content-Type: application/json' -d "$body")
  case "$resp" in
    *'"ok":true'*) say "$desc — ok" ;;
    *'already enabled'*) say "$desc — already enabled (expected)" ;;
    *'"error":"conflict"'*) say "$desc — already present (expected on a repair run)" ;;
    *)
      say "ERROR: $desc failed: $resp"
      exit 1
      ;;
  esac
}

# Write one config key on one named node. `-f` here on purpose: unlike the
# cluster_setup actions above, a config PUT has no benign failure mode.
cfg() {
  local node=$1 key=$2 value=$3
  curl -sSf -u "$ADMIN" -X PUT "$COORD/_node/$node/_config/$key" \
    -H 'Content-Type: application/json' -d "$value" >/dev/null
}

# True when _membership lists every expected node in BOTH of its arrays.
# Checking the state string instead would not do: after a stop/start the nodes
# still report `cluster_enabled` while _membership has collapsed to one.
membership_complete() {
  local body node count
  body=$(curl -sS -u "$ADMIN" "$COORD/_membership")
  for node in "${NODES[@]}"; do
    count=$(printf '%s' "$body" | grep -o "\"$node\"" | wc -l || true)
    [ "$count" -ge 2 ] || return 1
  done
  return 0
}

wait_for "$COORD/_up" "coordinator ($COORD)"

if membership_complete; then
  say "cluster already formed — skipping the join"
else
  say "forming the cluster"

  setup_action "enable_cluster (coordinator $COORD_HOST)" \
    '{"action":"enable_cluster","bind_address":"0.0.0.0",
      "username":"admin","password":"password","node_count":"3"}'

  for peer in "${PEER_HOSTS[@]}"; do
    setup_action "enable_cluster ($peer)" \
      "{\"action\":\"enable_cluster\",\"bind_address\":\"0.0.0.0\",
        \"username\":\"admin\",\"password\":\"password\",\"port\":5984,\"node_count\":\"3\",
        \"remote_node\":\"$peer\",
        \"remote_current_user\":\"admin\",\"remote_current_password\":\"password\"}"
    setup_action "add_node ($peer)" \
      "{\"action\":\"add_node\",\"host\":\"$peer\",\"port\":5984,
        \"username\":\"admin\",\"password\":\"password\"}"
  done

  # Creates _users and _replicator at n=3. Anything created BEFORE this lands
  # at n=1, which is why no database is created above.
  setup_action "finish_cluster" '{"action":"finish_cluster"}'
fi

if ! membership_complete; then
  say "ERROR: _membership does not list all three nodes:"
  curl -sS -u "$ADMIN" "$COORD/_membership"
  echo
  exit 1
fi
say "_membership lists all three nodes"

# CORS, so the vite dev server can reach the cluster in SPA mode. seed-dev.sh
# writes these through _node/_local/_config, which configures only whichever
# node answered the request — here that would break the app the moment it
# talked to a different node, so every key goes to every node by name.
for node in "${NODES[@]}"; do
  cfg "$node" "chttpd/enable_cors" '"true"'
  cfg "$node" "cors/origins" "\"$CORS_ORIGIN\""
  cfg "$node" "cors/credentials" '"true"'
  cfg "$node" "cors/methods" '"GET, PUT, POST, HEAD, DELETE, OPTIONS"'
  cfg "$node" "cors/headers" '"accept, authorization, content-type, origin, referer"'
done
say "CORS configured on all three nodes for $CORS_ORIGIN"

# The deliberate divergence (#123). Two shapes, because a comparison screen has
# two cases to get right and they are not the same case:
#
#   log/level   set on ALL nodes, `debug` on node 3 -> a DIFFERING VALUE, which
#               is what "copy value to other nodes" is for. `info` is CouchDB's
#               own default, so writing it on nodes 1 and 2 changes nothing; it
#               only makes the key visible, since this image's default.ini sets
#               no [log] keys at all and the config API reports only what is set.
#   log/writer  set on node 3 ONLY -> PRESENT vs ABSENT, the other case.
#               `stderr` is already what the container does, so this too is inert.
for node in "${NODES[@]}"; do
  cfg "$node" "log/level" '"info"'
done
cfg "$DIVERGENT_NODE" "log/level" '"debug"'
cfg "$DIVERGENT_NODE" "log/writer" '"stderr"'
say "seeded divergence on $DIVERGENT_NODE: log/level=debug, log/writer set here only"

say "done — cluster ready"
curl -sS -u "$ADMIN" "$COORD/_membership"
echo
