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

# The `couch-companion` image: the official CouchDB, with Couch Companion in
# place of Fauxton at /_utils/. Built by scripts/package.sh, which is the only
# supported way to build it — see the note on the build context below.
#
# Nothing else about the base image changes. The entrypoint, the exposed 5984,
# the /opt/couchdb/data volume, and the COUCHDB_USER / COUCHDB_PASSWORD
# first-run setup are all inherited, so anything that knows how to run
# `couchdb:latest` already knows how to run this. One directory differs.

FROM couchdb:latest

ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="Couch Companion" \
      org.opencontainers.image.description="Apache CouchDB with the Couch Companion admin UI at /_utils/" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="docker.io/library/couchdb:latest"

# share/www *is* Fauxton — and the bundled docs served at /_utils/docs/. Copying
# over it would merge, not replace: Fauxton's dashboard.assets/, docs/ and
# favicon.ico would survive underneath ours, served from the same tree. So the
# directory is removed outright first. `rm -rf` on the directory itself, not a
# glob inside it, because a glob misses dotfiles.
#
# There is deliberately no share/www.fauxton backup kept here. In an image the
# rollback is the base image itself — `docker run couchdb:latest` has the
# original Fauxton, and carrying a second copy in a layer buys nothing.
RUN rm -rf /opt/couchdb/share/www && mkdir -p /opt/couchdb/share/www

# THE BUILD CONTEXT IS `dist/`, NOT THE REPOSITORY ROOT.
#
#   docker build -f docker/Dockerfile ... dist
#
# That is what makes this `COPY .` exactly the built bundle — index.html, the
# hashed assets/, and the icons/ tree — with no .dockerignore standing between
# a 400 MB node_modules and the daemon. Run it from the repo root instead and
# you ship the whole checkout into share/www, source and all.
COPY . /opt/couchdb/share/www/
