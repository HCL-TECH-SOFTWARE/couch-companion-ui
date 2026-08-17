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

# Idempotent dev seed: single-node system DBs, the world-readable idp/config
# discovery doc (docs/derivate-creation.md section 5), and CouchDB jwt_auth
# wired to the devcontainer Keycloak. Safe to re-run on every container start.
set -euo pipefail

COUCH=${COUCH_URL:-http://couchdb:5984}
KC=${KEYCLOAK_URL:-http://keycloak:8080}
KC_PUBLIC=${KEYCLOAK_PUBLIC_URL:-http://localhost:8080}   # issuer as the BROWSER sees it
ADMIN="admin:password"

say() { printf 'seed-dev: %s\n' "$*"; }
wait_for() {
  local url=$1 name=$2 i
  for i in $(seq 1 60); do
    curl -sf "$url" >/dev/null && { say "$name is up"; return 0; }
    sleep 2
  done
  say "ERROR: $name never came up ($url)"; exit 1
}

wait_for "$COUCH/_up" couchdb
wait_for "$KC/realms/couch/.well-known/openid-configuration" keycloak

# Single-node system databases (couchdb:3 does not create them on its own)
curl -s -u "$ADMIN" -X PUT "$COUCH/_users" >/dev/null || true
curl -s -u "$ADMIN" -X PUT "$COUCH/_replicator" >/dev/null || true

# idp database, world-readable so discovery works before login (spec A8/D8)
curl -s -u "$ADMIN" -X PUT "$COUCH/idp" >/dev/null || true
curl -sf -u "$ADMIN" -X PUT "$COUCH/idp/_security" \
  -H 'Content-Type: application/json' \
  -d '{"admins":{"names":[],"roles":[]},"members":{"names":[],"roles":[]}}' >/dev/null

# Discovery document (spec section 5 shape); idempotent create-or-update
REV=$(curl -s -u "$ADMIN" "$COUCH/idp/config" | sed -n 's/.*"_rev":"\([^"]*\)".*/\1/p')
curl -sf -u "$ADMIN" -X PUT "$COUCH/idp/config${REV:+?rev=$REV}" \
  -H 'Content-Type: application/json' -d @- <<JSON >/dev/null
{
  "idps": [
    {
      "name": "Dev Keycloak",
      "issuer": "$KC_PUBLIC/realms/couch",
      "client_id": "couch-companion-ui",
      "well_known_url": "$KC_PUBLIC/realms/couch/.well-known/openid-configuration",
      "roles_claim": "roles",
      "idp_only": false
    }
  ]
}
JSON

# JWT auth wiring (mirrors what the parent's IdP applier writes)
cfg() {
  curl -sf -u "$ADMIN" -X PUT "$COUCH/_node/_local/_config/$1" \
    -H 'Content-Type: application/json' -d "$2" >/dev/null
}
cfg "chttpd/authentication_handlers" \
  '"{chttpd_auth, jwt_authentication_handler}, {chttpd_auth, cookie_authentication_handler}, {chttpd_auth, default_authentication_handler}"'

# chttpd builds its handler pipeline once at startup; a config PUT alone
# does not re-wire it (confirmed against CouchDB 3.5.2). /_restart reloads
# the application in place — no container restart needed. It is documented
# as an integration-testing facility, which is exactly this use case.
curl -sf -u "$ADMIN" -X POST "$COUCH/_node/_local/_restart" >/dev/null
wait_for "$COUCH/_up" couchdb

cfg "jwt_auth/required_claims" '"exp"'
cfg "jwt_auth/roles_claim_name" '"roles"'
cfg "jwt_auth/roles_claim_path" '"roles"'

while IFS=$'\t' read -r kid pem; do
  cfg "jwt_keys/rsa:$kid" "$pem"
  say "installed jwt key rsa:$kid"
done < <(node "$(dirname "$0")/jwks-to-pem.mjs" "$KC/realms/couch/protocol/openid-connect/certs")

# CORS so the vite dev server (:5173) can talk to CouchDB directly (SPA mode).
# localhost:5173 -> localhost:5984 is cross-origin but SAME-SITE, so the
# AuthSession cookie flows without same_site=none.
cfg "chttpd/enable_cors" '"true"'
cfg "cors/origins" '"http://localhost:5173"'
cfg "cors/credentials" '"true"'
cfg "cors/methods" '"GET, PUT, POST, HEAD, DELETE, OPTIONS"'
cfg "cors/headers" '"accept, authorization, content-type, origin, referer"'

# Non-admin CouchDB-native user for role-gating tests (spec D9)
DEMO_REV=$(curl -s -u "$ADMIN" "$COUCH/_users/org.couchdb.user:demo" | sed -n 's/.*"_rev":"\([^"]*\)".*/\1/p')
curl -sf -u "$ADMIN" -X PUT "$COUCH/_users/org.couchdb.user:demo${DEMO_REV:+?rev=$DEMO_REV}" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","password":"password","roles":[],"type":"user"}' >/dev/null
say "demo/password (non-admin CouchDB-native user) ready"

say "done — hariseldon/password (_admin) and gaaldornick/password (user) via Keycloak"
