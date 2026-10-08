<!--
 Licensed to the Apache Software Foundation (ASF) under one
 or more contributor license agreements.  See the NOTICE file
 distributed with this work for additional information
 regarding copyright ownership.  The ASF licenses this file
 to you under the Apache License, Version 2.0 (the
 "License"); you may not use this file except in compliance
 with the License.  You may obtain a copy of the License at

   https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing,
 software distributed under the License is distributed on an
 "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 KIND, either express or implied.  See the License for the
 specific language governing permissions and limitations
 under the License.
-->

# CORS: when Couch Companion browses another server

Replication in CouchDB runs server-to-server: the server hosting the `_replicator` document fetches
from the source itself, and no browser is involved — so replication never needs CORS. What needs
CORS is this app *browsing* a remote server on your behalf. The database picker, the replication
preview and document verification are requests your **browser** makes directly to that other
server, and browsers only allow that when the other server opts in via CORS.

In short: a replication can work perfectly while the **Browse…** button next to it fails. They are
different network paths, and only the second one is subject to the browser's rules.

## When you will see the failure

In the replication editor, each endpoint (Source and Target) has a server URL, authentication and a
database field with a **Browse…** button. Browse asks the server you entered for its list of
databases. If the browser refuses the request, the app shows a **Could not reach the server**
dialog that links to this page.

A browser cannot tell you *why* it refused. A server with CORS switched off and a server that is
down or unreachable both surface to the page as the same opaque network error, so the dialog says
both are possible rather than guessing. You can tell them apart yourself in ten seconds: open

```
https://that-server:5984/_up
```

in a new browser tab, using the server's real scheme, host and port. If it answers
(`{"status":"ok"}`), the server is up and reachable from your machine, and the missing piece is
CORS. If the tab cannot connect either, the problem is the network, a firewall or the URL, and no
CORS setting will help.

A different dialog, **The server refused the request**, means the server did answer with 401 or 403.
That is a credentials problem, not CORS; fix it in the endpoint's Authentication dialog.

## Enabling CORS on CouchDB

CORS is configured on the server you are *browsing* (the remote one), not on the machine running
Couch Companion. In `local.ini` (or a file under `local.d/`):

```ini
[chttpd]
enable_cors = true

[cors]
origins = https://your-couch-companion-host
credentials = true
methods = GET, PUT, POST, HEAD, DELETE
headers = accept, authorization, content-type, origin, referer
```

Notes:

- `origins` must list the origin the app is **served from**: scheme, host and port, with no path
  and no trailing slash — `https://tools.example.com`, `http://localhost:8080`. Separate several
  origins with commas.
- `origins = *` is handy for a quick test but is not a production setting. It also cannot be
  combined with `credentials = true`: browsers refuse a wildcard origin on requests that carry
  credentials, and Couch Companion sends yours. If you use `*`, expect sign-in-protected servers
  to keep failing. List the origin explicitly instead.
- `credentials = true` and the `authorization` header are what let the browser send your session
  or Basic credentials to that server.

You do not have to edit files or restart anything. CouchDB applies configuration changes made
through its HTTP API immediately and persists them to its own config file. As an administrator
(replace `admin:password` and the host):

```bash
COUCH=https://that-server:5984
curl -X PUT "$COUCH/_node/_local/_config/chttpd/enable_cors" -u admin:password -d '"true"'
curl -X PUT "$COUCH/_node/_local/_config/cors/origins"       -u admin:password -d '"https://your-couch-companion-host"'
curl -X PUT "$COUCH/_node/_local/_config/cors/credentials"   -u admin:password -d '"true"'
curl -X PUT "$COUCH/_node/_local/_config/cors/methods"       -u admin:password -d '"GET, PUT, POST, HEAD, DELETE"'
curl -X PUT "$COUCH/_node/_local/_config/cors/headers"       -u admin:password -d '"accept, authorization, content-type, origin, referer"'
```

Each call answers with the previous value. In a cluster, repeat it per node, or use the node name
instead of `_local`. The setting is documented in the
[CouchDB configuration reference](https://docs.couchdb.org/en/stable/config/http.html#cross-origin-resource-sharing).

## The two deployment modes

Which servers need CORS depends on how Couch Companion itself is deployed (see
[Installing](install.md)).

- **Same-origin (drop-in at `/_utils`).** The app is served by its own CouchDB, so the page and
  that server share an origin and no CORS is involved for them. CORS is needed only for **other**
  servers you browse from the replication editor, and the app's origin goes into *their*
  `[cors] origins`.
- **SPA mode (static hosting).** The app is served from a web host and you choose the CouchDB URL
  at sign-in. The page's origin is the web host, so even "its own" CouchDB is a cross-origin
  server and needs the web host's origin in `[cors] origins`. This is the standalone and
  repository-setup case: if sign-in itself fails, this is the first thing to check, and it applies
  to every server you use, not just replication endpoints.

## Localhost gotchas

- **`localhost` and `127.0.0.1` are different origins.** `http://localhost:5984` and
  `http://127.0.0.1:5984` are the same machine but different origins to a browser, and CORS is
  evaluated per origin, so `origins` must list the one the app is actually opened from. (The app
  treats the two as the same server and reuses your session for both; the browser's CORS check
  does not.) Different ports are different origins too.
- **Mixed content.** A page served over `https` cannot call an `http` CouchDB; the browser blocks
  it before CORS is even considered. Serve both over `https`, or open the app over `http` while
  you test against a plain `http` server.
- **A `localhost` source cannot be reached from the other side.** If you want the *remote* server
  to replicate from your laptop's `localhost:5984`, it will fail: from the remote server,
  `localhost` is itself. That is what the pull setup is for. Enter the **remote** server as the
  **source** in the editor and your local server as the target, and your local server, which
  hosts the `_replicator` document, pulls from the remote. Only Browse, preview and verification
  then need CORS on the remote server; the replication does not.
