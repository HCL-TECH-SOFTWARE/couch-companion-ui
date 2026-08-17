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
#
# Brings up the three-node development cluster (#123) and joins it.
#
# Usage:
#   scripts/cluster-up.sh          start the cluster and form it (idempotent)
#   scripts/cluster-up.sh down     destroy it — containers, network, RAM disks
#   scripts/cluster-up.sh --help   this text
#
# The single-node devcontainer on :5984 is untouched by either; this stack is a
# separate compose project on its own ports and network, and the two can run
# side by side.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
FILE="$REPO/.devcontainer/docker-compose.cluster.yml"
NODES=(couchdb1 couchdb2 couchdb3)

# Spelled out rather than sed'd back out of this file's own header: check.sh
# and package.sh print their usage with hardcoded line ranges, and inserting a
# line above them silently prints the wrong thing with no gate to catch it.
usage() {
  cat <<'EOF'
Brings up the three-node development cluster (#123) and joins it.

Usage:
  scripts/cluster-up.sh          start the cluster and form it (idempotent)
  scripts/cluster-up.sh down     destroy it — containers, network, RAM disks
  scripts/cluster-up.sh --help   this text

The single-node devcontainer on :5984 is untouched by either; this stack is a
separate compose project on its own ports and network, and the two can run
side by side.
EOF
}

case "${1:-up}" in
  -h | --help | help)
    usage
    exit 0
    ;;
  down)
    # `down -v`, never `stop`. The nodes keep their data on tmpfs: a stop/start
    # brings them back with empty RAM disks but surviving .ini files, which
    # leaves each one believing it is clustered while the shard map is gone.
    docker compose -f "$FILE" down -v
    echo "cluster-up: destroyed"
    exit 0
    ;;
  up) ;;
  *)
    echo "cluster-up: unknown argument '$1'" >&2
    usage >&2
    exit 2
    ;;
esac

# Two commands, not one, and NOT `up --wait` over the whole file: `--wait`
# treats any container leaving the running state as a failure, so the one-shot
# setup service exiting 0 still makes compose exit 1. Waiting only on the
# long-lived nodes, then running the one-shot separately, gives an exit code
# that means what it says — which is what makes this usable from CI.
docker compose -f "$FILE" up -d --wait "${NODES[@]}"
docker compose -f "$FILE" run --rm cluster-setup

cat <<'EOF'

cluster-up: ready
  node 1  http://localhost:15984/_utils/   couchdb@couchdb1.ccui.local
  node 2  http://localhost:25984/_utils/   couchdb@couchdb2.ccui.local
  node 3  http://localhost:35984/_utils/   couchdb@couchdb3.ccui.local  (log/level=debug)

  admin/password on every node. Each is published separately on purpose: it is
  the only way to check that a per-node read really came from that node.

  Tear down with `scripts/cluster-up.sh down` — not `docker compose stop`.
EOF
