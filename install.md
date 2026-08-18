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

# Installing Couch Companion UI

## What you are installing

A directory of static files — HTML, JavaScript, CSS, fonts and SVG icons. There is no server
component, no database of its own, no background process, and nothing to keep running. The
browser talks to CouchDB's REST API directly, so "installing" means putting the files somewhere a
browser can fetch them and making sure that browser is allowed to call your CouchDB. Everything
below is either a file copy or a one-time CouchDB config change.

Three ways to host it:

- **Drop-in** — replace the contents of CouchDB's `share/www`. The UI is then served by CouchDB
  itself at `/_utils/`, same-origin, with **zero configuration**. This is the primary path.
- **Container image** — `couch-companion`, the official `couchdb` image with that same drop-in
  already applied. Nothing to install into and nothing to destroy: `docker run` it and `/_utils/`
  is this app. Best when you are standing up a *new* CouchDB rather than changing one you already
  run. See [Container image](#container-image).
- **SPA** — host the same files anywhere static (GitHub Pages, Cloudflare Pages, nginx, another
  port on the same host) and point them at a CouchDB. This one needs CORS, and — depending on
  where you host it — needs HTTPS. See [SPA install](#spa-install).

## Getting the bundle

Run the packaging script:

    ./scripts/package.sh

It produces two things from one build:

- `release/couch-companion-ui-<version>.tar.gz`. The tarball's members unpack **directly into
  `share/www`** — there is no wrapper directory to strip, so `tar -xzf … -C <share/www>` puts
  every file exactly where CouchDB looks for it.
- The `couch-companion` container image, tagged `<version>` and `latest`. Add `--no-docker` to
  skip it (the script otherwise requires a working Docker and fails without one).

Run it **on the host**, not from this repository's devcontainer: that container has no Docker
socket, so the image half cannot work there and the script stops at its first step rather than
half-finishing. `./scripts/package.sh --no-docker` is the devcontainer's path, and produces the
tarball exactly as before.

If you are working from a checkout and don't need a versioned artifact, `npx vite build` writes
the same layout to `dist/`, and you can copy `dist/` wherever the instructions below say to
unpack the tarball.

## Container image

The shortest path to a running instance, and the only one on this page that does not modify
something you already have:

    docker run -d --name couch-companion -p 5984:5984 \
      -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=<choose one> \
      -v couchdb_data:/opt/couchdb/data couch-companion:<version>

Open `http://127.0.0.1:5984/_utils/`. That is the whole install.

The image is `FROM couchdb:latest` with `share/www` replaced (see `docker/Dockerfile`), so it is
the official CouchDB in every other respect — same entrypoint, same `5984`, same
`/opt/couchdb/data` volume, same first-run `COUCHDB_USER`/`COUCHDB_PASSWORD` behaviour. Anything
you know about running the `couchdb` image applies unchanged, and databases in the named volume
outlive the container, so a later version is a `docker rm` and a `docker run` away.

Two things carry over from the drop-in, because the image *is* a drop-in:

- Fauxton is gone, including the bundled docs at `/_utils/docs/`. There is no backup kept inside
  the image — the base image is the backup. To see stock Fauxton again, run `couchdb:latest`.
- Git sync still needs a CSP change, for exactly the reason described in
  [the drop-in's CSP section](#git-sync-needs-one-more-change-couchdbs-content-security-policy).
  The image ships CouchDB's default policy untouched.

The packaging script does not push anywhere. To put the image in a registry:

    docker tag couch-companion:<version> <registry>/couch-companion:<version>
    docker push <registry>/couch-companion:<version>

If you build for a registry namespace regularly, `IMAGE_NAME` sets the name at build time:
`IMAGE_NAME=ghcr.io/acme/couch-companion ./scripts/package.sh`.

## Drop-in install (`/_utils`)

> **This destroys the Fauxton that shipped with your CouchDB.** `share/www` *is* Fauxton — and
> also the bundled documentation served at `/_utils/docs/`. Replacing its contents removes both.
> Nothing warns you and nothing keeps a copy. **Take the backup in step 1 before you go further**,
> or read [Getting Fauxton back](#getting-fauxton-back) first and decide you don't need one.

The directory to replace is `<couchdb prefix>/share/www` — `/opt/couchdb/share/www` in the
official Docker image and in a source install with the default prefix. If your CouchDB came from
a distribution package, find the directory holding Fauxton's `index.html` alongside a
`dashboard.assets/` directory; that is the one.

### Docker

Replace `couchdb` with your container name:

    # 1. Back up the Fauxton that is about to be destroyed
    docker cp couchdb:/opt/couchdb/share/www ./fauxton-backup

    # 2. Empty share/www (removes dotfiles too, which a shell glob would miss)
    docker exec couchdb sh -c 'rm -rf /opt/couchdb/share/www && mkdir -p /opt/couchdb/share/www'

    # 3. Unpack the tarball locally, then copy its contents in
    mkdir -p ./www && tar -xzf couch-companion-ui-<version>.tar.gz -C ./www
    docker cp ./www/. couchdb:/opt/couchdb/share/www/

No restart is needed — CouchDB reads these files from disk per request. Open
`http://<host>:5984/_utils/` and you should get Couch Companion.

The trailing `/.` in step 3 is what copies the *contents* of `./www` rather than the directory
itself. Files land owned by `root` and world-readable, which is what CouchDB (running as the
`couchdb` user) needs; this is how the official image ships Fauxton too.

### A directory on the server

For a non-container install, one `mv` both backs Fauxton up and clears the way:

    sudo mv /opt/couchdb/share/www /opt/couchdb/share/www.fauxton
    sudo mkdir -p /opt/couchdb/share/www
    sudo tar -xzf couch-companion-ui-<version>.tar.gz -C /opt/couchdb/share/www

If your CouchDB runs as a dedicated unprivileged user, confirm that user can read the extracted
files (they need to be world-readable, or owned by that user) before you call it done.

### Git sync needs one more change: CouchDB's Content-Security-Policy

Everything above works out of the box. **Design-doc git sync does not**, and the way it fails is
unhelpful enough to be worth a heading.

CouchDB serves `/_utils/` with its own CSP. On 3.5.2 the built-in default is:

    Content-Security-Policy: child-src 'self' data: blob:; default-src 'self'; img-src 'self' data:;
      font-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline';
      frame-src https://blog.couchdb.org;

There is no `connect-src`, so it inherits `default-src 'self'` — and the browser refuses every
cross-origin request from the page. Git sync talks to the GitHub REST API directly from your
browser (there is no backend to proxy it), so from the drop-in it cannot reach GitHub at all.

It surfaces as:

    Failed to connect account: Failed to fetch

with **nothing in the browser's network tab** — the request is never sent, so there is no failed
request to inspect. This is not a CORS problem and not a bad token; GitHub's CORS headers are
correct and unrelated. CORS is the server's permission to *be called*; CSP is the page's
permission to *call*. CouchDB grants the first and denies the second.

**The app can do this for you.** Open **Version control** as a server admin: it reads the policy
your server is actually sending, works out which hosts your connected git accounts need, and
offers a switch that adds them — and takes them back out again. It edits the header you already
have rather than replacing it with a canned one, which is the mistake the rest of this section
exists to warn you about. Everything below is the same change by hand, for a server you cannot
administer from the browser, or when you would rather see the string before it is written.

To allow it, extend the policy with a `connect-src` naming your git host:

    curl -u admin:password -X PUT \
      http://localhost:5984/_node/_local/_config/csp/utils_header_value \
      -H 'Content-Type: application/json' \
      --data-binary @- <<'JSON'
    "child-src 'self' data: blob:; default-src 'self'; img-src 'self' data:; font-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-src https://blog.couchdb.org; connect-src 'self' https://api.github.com;"
    JSON

For GitHub Enterprise, use your host instead of `https://api.github.com` — e.g.
`connect-src 'self' https://github.example.com;`. No restart is needed; the next request to
`/_utils/` carries the new header.

Three things to know before you run it:

- **It replaces the whole header, not just one directive.** Whatever your server currently sends is
  discarded and replaced by the string you PUT, so start from your own live header and add
  `connect-src` to it, rather than pasting the example above blind.
- **Copy the live header, not `default.ini`'s commented example.** The commented
  `utils_header_value` in `default.ini` does *not* match what 3.5.2 actually sends — it lacks
  `child-src` and has `font-src *`. Read your own server's header first:

      curl -s -i http://localhost:5984/_utils/ | grep -i content-security-policy

- **This widens your CSP.** You are allowing the admin UI to make requests to a third-party host.
  That is exactly what git sync does, and it is your decision to permit it — if you do not use git
  sync, leave the policy alone.

### About `script-src 'unsafe-eval'`

The example above keeps `script-src 'self' 'unsafe-eval'` because that is what CouchDB ships, and
because **one feature needs it: the view editor's "Run Test" button.** Testing a view means
actually running your map (and reduce) function, and there is no way to turn a string of JavaScript
into a running function without `eval`-class evaluation — the runner compiles it with
`new Function`. CouchDB 3 has no server-side substitute either: `POST /{db}/_temp_view` answers
`410 gone`.

Everything else works fine without it: with `script-src 'self'` the app loads, the document editor
renders and edits normally, and the browser reports no `script-src` violation (checked against
3.5.2).

Measured for Run Test, in Chrome, against a production build
(`node scripts/smoke.mjs --csp '<policy>'`):

| `script-src` | Run Test |
| --- | --- |
| `'self' 'unsafe-eval'` | works — rows come back |
| `'self'` | fails: *Could not compile the map function: Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self'* |

One wrinkle worth understanding, because it is not obvious: the map function runs in a Web Worker,
and a Worker takes its CSP from **the response that served the worker script**, not from the page
that started it — measured both ways. So whether `'unsafe-eval'` matters depends on whether your
server sends the header on the JavaScript under `/_utils/assets/` as well as on the page.

**CouchDB does.** Measured against 3.5.1, a `/_utils` asset carries the same policy as the page:

    $ curl -s -D - -o /dev/null https://couchdb.example/_utils/dashboard.assets/js/bundle.<hash>.js
    content-type: application/x-javascript
    content-security-policy: child-src 'self' data: blob:; default-src 'self'; img-src 'self' data:;
      font-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; …

So on a CouchDB drop-in the worker inherits whatever `script-src` you set, and **dropping
`'unsafe-eval'` breaks Run Test**. Keep it if anyone uses the view tester; drop it if nobody does,
and nothing else in the app changes.

If you serve the SPA from something other than CouchDB, check your own host — a static file server
that sends the CSP only on HTML leaves the worker unconstrained, and Run Test keeps working with
`script-src 'self'`:

    curl -s -D - -o /dev/null https://your-host/assets/<any-file>.js | grep -i content-security-policy

The view tester's worker itself needs only `child-src 'self'` (equivalently `worker-src 'self'`) —
it is a bundled, same-origin script. It used to be built from a `blob:` URL, which is what made
CouchDB's default `child-src 'self' data: blob:` load-bearing for this app; since #30 it is not.

**SPA installs are unaffected.** The policy comes from CouchDB serving the page, so a bundle hosted
anywhere else never sees it.

### Getting Fauxton back

There is no uninstaller. Pick whichever applies:

- **Docker, no backup taken** — recreate the container from the same image. `share/www` lives in
  the image, so a fresh container has the original Fauxton back. Your data lives in a volume and
  is unaffected; anything you changed inside the container's filesystem is not.
- **Docker, backup taken** — put step 1's copy back:

      docker exec couchdb sh -c 'rm -rf /opt/couchdb/share/www && mkdir -p /opt/couchdb/share/www'
      docker cp ./fauxton-backup/. couchdb:/opt/couchdb/share/www/

- **Directory install** — reverse the `mv`:

      sudo rm -rf /opt/couchdb/share/www
      sudo mv /opt/couchdb/share/www.fauxton /opt/couchdb/share/www

- **Package install** — reinstalling the CouchDB package restores its own `share/www`.
- **[Container image](#container-image)** — recreating the container is *not* enough here, since
  the replacement is baked into the image. Run `couchdb:latest` instead, pointed at the same data
  volume:

      docker rm -f couch-companion
      docker run -d --name couchdb -p 5984:5984 -v couchdb_data:/opt/couchdb/data couchdb:latest

## SPA install

Host the unpacked bundle on any static web server. The app uses relative asset paths and hash
routing, so it works from a sub-path (a GitHub Pages project page, for instance) and needs no
SPA 404-rewrite rule. Then point it at your CouchDB from the app's server picker.

What the CouchDB needs depends on **where** you host it, and there is no single snippet that
covers all three cases:

| Deployment | CORS | `[chttpd_auth] same_site` | HTTPS |
| --- | --- | --- | --- |
| `/_utils` drop-in (same origin) | not needed | leave unset | optional |
| SPA, same site (e.g. a different port on the same host) | needed | **leave unset** | optional |
| SPA, cross site (a different domain) | needed | `none` | **required, at CouchDB itself** |

"Same site" and "same origin" are not the same test. `http://localhost:5173` calling
`http://localhost:5984` is a *different origin* — so it needs CORS — but the *same site*, so the
session cookie is sent without any `SameSite` change. Only a genuinely different site
(`app.example.com` → `couch.example.net`, or a Pages domain calling your own server) needs
`same_site = none`, and that case needs HTTPS *on the connection CouchDB itself terminates* to
work at all.

### CORS (both SPA cases)

Three config keys, applied to a running CouchDB over its own API. No restart required — the
preflight starts answering immediately.

    COUCH=http://127.0.0.1:5984
    ADMIN=admin:password
    ORIGIN=https://couch-companion.example.com   # exact origin of the hosted app

    curl -s -u "$ADMIN" -X PUT "$COUCH/_node/_local/_config/httpd/enable_cors" \
      -H 'Content-Type: application/json' -d '"true"'

    curl -s -u "$ADMIN" -X PUT "$COUCH/_node/_local/_config/cors/origins" \
      -H 'Content-Type: application/json' -d "\"$ORIGIN\""

    curl -s -u "$ADMIN" -X PUT "$COUCH/_node/_local/_config/cors/credentials" \
      -H 'Content-Type: application/json' -d '"true"'

`ORIGIN` is scheme, host and port with **no trailing slash and no path** — `https://example.com`,
not `https://example.com/`. It must match what the browser sends, exactly.

`origins = *` is not an option here: browsers reject a wildcard
`Access-Control-Allow-Origin` on credentialed requests, and every request this app makes after
login is credentialed. That is a browser rule, not a CouchDB one — CouchDB will happily accept
the config and the failure will surface only in the browser.

Check it worked. A preflight should answer `204` and echo your origin back:

    curl -s -i -X OPTIONS "$COUCH/_session" \
      -H "Origin: $ORIGIN" \
      -H 'Access-Control-Request-Method: POST' \
      -H 'Access-Control-Request-Headers: content-type'

Expected, measured against CouchDB 3.5.2:

    HTTP/1.1 204 No Content
    Access-Control-Allow-Credentials: true
    Access-Control-Allow-Origin: https://couch-companion.example.com
    Access-Control-Allow-Methods: CONNECT, COPY, DELETE, GET, HEAD, OPTIONS, POST, PUT, TRACE

Without `httpd/enable_cors`, the same request answers `405 method_not_allowed` and no
`Access-Control-*` header appears at all — that is the signature of the missing first key.

### Cross-site only: `same_site = none`, and only over HTTPS

**Do not set this unless your app and your CouchDB are on different sites, and CouchDB itself
terminates TLS (or your proxy rewrites the cookie — see below).** On a cross-site deployment it
is required; anywhere else it is at best pointless and at worst breaks login outright.

    curl -s -u "$ADMIN" -X PUT "$COUCH/_node/_local/_config/chttpd_auth/same_site" \
      -H 'Content-Type: application/json' -d '"none"'

To remove it again (it takes effect immediately, no restart):

    curl -s -u "$ADMIN" -X DELETE "$COUCH/_node/_local/_config/chttpd_auth/same_site"

#### What goes wrong over plain HTTP

A login that reports success and is then forgotten. Measured on CouchDB 3.5.2:

    with same_site = none, over http://  ->  POST /_session  200 {"ok":true}
                                             GET  /_session  userCtx.name = null   <- dropped
    without same_site,      over http://  ->  GET  /_session  userCtx.name = "admin"

The app shows no error because there is no error: CouchDB authenticated you and said so. The
browser then **silently discarded the cookie**, because a cookie marked `SameSite=None` must also
carry `Secure`, and CouchDB emits `Secure` only when the request arrived over TLS. Same server,
same config, same moment — only the scheme differs:

    https://  Set-Cookie: AuthSession=…; Max-Age=600; Secure; Path=/; HttpOnly; SameSite=None
    http://   Set-Cookie: AuthSession=…; Max-Age=600;         Path=/; HttpOnly; SameSite=None

So `Secure` is not a setting anyone forgot to switch on. It is derived from the connection —
which means HTTPS is required **on the hop CouchDB itself terminates**, not merely on the hop the
browser sees.

#### Behind a TLS-terminating proxy, the address bar lies

The common way to expose CouchDB is behind an ingress or reverse proxy that terminates TLS and
forwards plain HTTP. The browser shows `https://`, so the requirement above looks satisfied. It
is not: CouchDB received the request over HTTP and emits no `Secure`. Measured against CouchDB
3.5.1 behind a TLS-terminating ingress, with `[chttpd_auth] same_site = none` applied:

    baseline                    …; Path=/; HttpOnly; SameSite=None
    X-Forwarded-Proto: https    …; Path=/; HttpOnly; SameSite=None
    X-Forwarded-Ssl: on         …; Path=/; HttpOnly; SameSite=None
    both                        …; Path=/; HttpOnly; SameSite=None

`SameSite=None` appears; `Secure` never does. Neither forwarded header recovers it — including
with `[chttpd] x_forwarded_proto` configured and the node restarted. There is no CouchDB setting
that makes it emit `Secure` for a connection it did not receive over TLS.

That leaves the server **worse off than the default**: Chrome rejects a `SameSite=None` cookie
that lacks `Secure` outright, whereas the plain `Lax` default at least worked same-site.

Fixes in this topology, best first:

1. **Rewrite the cookie at the proxy** — it is the component that knows the connection was
   secure. nginx ≥ 1.19.3:

        proxy_cookie_flags AuthSession secure samesite=none;

    CouchDB then needs no `same_site` setting at all.

2. **Let CouchDB terminate TLS itself** (`[ssl]`, port 6984), so it genuinely sees HTTPS.

3. **Avoid the cross-site cookie** — use the `/_utils` drop-in, or host the app on the same site
   as CouchDB. Then don't set `same_site`; it isn't needed.

**`curl` will not reproduce the browser half of this.** `curl` ignores `SameSite` entirely, so a
curl login round-trip succeeds against a configuration that is broken for every real browser. The
`Set-Cookie` measurements above are curl reading back a response header, which it reports
faithfully; confirming that a *fix* works has to happen in a browser.

Since #35 the app detects this for you: an SPA-mode login confirms the session round-trips before
reporting success, and names this section when it does not.

## Identity provider configuration (`[oidc]`)

Every identity provider the IdP admin screen registers is stored in
`_node/_local/_config`'s `[oidc]` section — the same node config CouchDB already uses for
`[jwt_keys]`, `[chttpd]`, `[cors]` and everything else. The section name is lowercase, like
every CouchDB built-in section (`[jwt_keys]`, `[jwt_auth]`, `[chttpd]`); section names are
case-sensitive.

**Key format: `rsa:<kid>`**, mirroring `[jwt_keys]` one-for-one:

```ini
[jwt_keys]
rsa:abc123 = -----BEGIN PUBLIC KEY-----\nMIIB…\n-----END PUBLIC KEY-----\n

[oidc]
log = false
rsa:abc123 = {"name":"Corporate Entra ID","issuer":"https://login.example.com/v2.0","client_id":"d3ad…","well_known_url":"https://login.example.com/v2.0/.well-known/openid-configuration","roles_claim":"roles","idp_only":false,"alg":"RS256","last_refreshed":"2026-08-11T09:00:00.000Z","created_at":"2026-08-11T09:00:00.000Z"}
```

That is the whole schema (#119): who the provider is, where its discovery document lives, the
client id we were issued, and the two decisions *this deployment* made — which claim carries
the roles, and whether `idp_only` hides the login screen's username/password form. Everything
the identity provider itself publishes — `authorization_endpoint`, `token_endpoint`,
`end_session_endpoint`, `jwks_uri`, the supported algorithms, the scopes it honours — is
deliberately **not** stored: it is re-read from `well_known_url` at the moment a login needs
it, so there is no second copy here to go stale when the provider rotates an endpoint. `alg`
is the exception, because it describes *this kid* rather than the provider. Entries written
before #119 still carry the dropped fields; they are ignored on read, so no migration is
needed.

That shared key is deliberate: a `[jwt_keys]` entry with no `[oidc]` twin is a signing key a
deleted identity provider left behind (deleting a provider never strips the key it installed,
so tokens already issued stay verifiable); an `[oidc]` entry with no `[jwt_keys]` twin is a
provider whose key was never installed, or was removed by hand. Either way it is a plain set
difference between the two sections, not something that has to be inferred. The IdP admin
screen surfaces the first case as a warning banner over the provider list.

The one cost of the literal correspondence: an identity provider that publishes **two signing
keys** is written twice, once under each kid, with otherwise identical metadata. The app
de-duplicates by `issuer` everywhere providers are shown, so this never renders as two login
buttons — but if you are reading `[oidc]` directly (a backup, a diff, `GET
/_node/_local/_config`), expect to see it.

Values are escaped JSON: CouchDB's config API rejects a literal newline in a value
(apache/couchdb#5091), so `\n` inside a PEM or a string field is the two-character escape,
not a real line break. Every field except `issuer` is treated as optional on read — a
hand-written entry that omits one, or nulls it out, gets the default (`roles_claim` → `roles`,
`alg` → `RS256`, `idp_only` → `false`) rather than crashing the screen that renders it. An
entry naming no issuer is skipped entirely: there is nothing to correlate or group it by.

**`[oidc] log`** — the IdP activity log, **default off**. With it off (the default, and what a
fresh install has), registering, applying, or deleting an identity provider writes nothing to
the `couchcompanion` database at all — consistent with that database never being created for
you unasked (see [derivate-creation.md §8](derivate-creation.md#8-couchcompanion-usage-rules-d13)).
Set it to enable the log:

    curl -u admin:password -X PUT $COUCH/_node/_local/_config/oidc/log -d '"true"'

Accepted affirmative values are `true`, `1`, `yes`, `on` (case-insensitive, whitespace
trimmed); anything else, including an absent key, means off. Turning it on is what creates the
`couchcompanion` database on the next IdP action, if nothing else has already created it.

**`GET /_idp`.** If your CouchDB ever answers this path natively with an `idps` array, the app
stops creating, securing, or writing the `idp` stopgap database entirely — the `[oidc]` section
above is the only thing it writes to. Every CouchDB shipping today answers 401 here, so this is
forward-looking, not something you need to plan around yet.

### Your identity provider must allow this origin

This is a public client (D8): there is no backend, so the browser itself POSTs the authorization
code to your IdP's token endpoint to finish the PKCE exchange. For the page to be allowed to read
that response, the IdP has to answer it with `Access-Control-Allow-Origin` for the app's own
origin — on Keycloak this is the client's **Web origins** setting; other IdPs call it "allowed
CORS origins" or similar. Registering the app's **redirect URI** is not enough by itself — that
only governs the authorize step, a full-page redirect that carries no CORS requirement of its
own.

Left unconfigured, sign-in looks like it works right up to the last step: the app redirects to
the IdP, you log in, the IdP redirects back with a code — and then you land back on the plain
login screen with no explanation. The token POST reached the IdP and got a real answer (confirm
with `curl -i -X POST <token_endpoint> -H "Origin: <app origin>" ...` and look for a missing
`Access-Control-Allow-Origin` in the response), but the browser refused to hand the response to
the page.

### CouchDB's own CSP has to allow the IdP too

CORS is the IdP's permission to be called. CSP is this page's permission to call it. Both have to
allow it, and on the [drop-in install](#drop-in-install-_utils) the second one is refused by
default — CouchDB serves `/_utils` with no `connect-src` at all, so the browser blocks the call
before it is made and nothing appears in the network tab.

You do not have to work this out by hand. The identity-provider screen reads the policy CouchDB is
actually serving and, when it refuses a host your providers need, offers a switch that adds it to
`connect-src` — the same offer [git sync makes](#git-sync-needs-one-more-change-couchdbs-content-security-policy)
above. Deleting a provider takes its origins back out again, minus any that another provider still
needs. Both are hidden entirely in SPA mode, where the policy belongs to whoever serves the page
rather than to CouchDB, so neither the diagnosis nor the fix would be true.

**Which hosts.** The ones the browser *fetches*: the discovery document, `jwks_uri` and
`token_endpoint`. They need not be the same host — Google's are three:

    issuer          https://accounts.google.com
    jwks_uri        https://www.googleapis.com
    token_endpoint  https://oauth2.googleapis.com

so a policy built from the issuer alone permits one of three and sign-in dies at the token
exchange. The three origins are therefore recorded on each provider when it is **registered or
refreshed**, which is when its discovery document is in hand.

The authorize and end-session endpoints are deliberately *not* added. Those are full-page
redirects, and no `connect-src` governs a navigation; listing them would widen the policy for
requests that never happen.

**A provider registered before this feature existed** contributes only the origin of its
well-known URL, because the other two cannot be recovered without re-reading discovery. Refresh it
once and all three are recorded. (An entry old enough to predate the slim `[oidc]` format recovers
all three immediately — it still carries the endpoints in its stored copy of the discovery
document.)

### Register two URIs, not one: sign-in and sign-out

Logging out offers to end the session at your identity provider too (#24), and that is a second
full-page redirect. Its return address — `post_logout_redirect_uri` — has to be **pre-registered
with the provider exactly like the sign-in `redirect_uri`**, and it is a *separate* setting on
every IdP worth the name. On Keycloak it is the client's **Valid post logout redirect URIs**;
leave it empty and Keycloak falls back to the sign-in redirect URIs, which is why this sometimes
appears to work without being configured.

Both URIs are the app's own base URL with any query and hash stripped, so they are the same
string as each other — but **not** the same between deployment modes:

| Deployment | Both `redirect_uri` and `post_logout_redirect_uri` |
| --- | --- |
| [Drop-in](#drop-in-install-_utils) at CouchDB's `/_utils` | `http://couchdb.example:5984/_utils/` |
| [SPA](#spa-install) on its own origin | `https://companion.example.com/` |

Note the trailing slash on the drop-in value, and note that the SPA's is *your app's* origin, not
CouchDB's — the two live on different hosts in that mode, and it is the page that gets redirected
back to, not the database. If you serve the SPA from a subpath, include it
(`https://example.com/companion/`). A wildcard registration such as
`http://localhost:5984/*` covers both, which is what `.devcontainer/keycloak-realm.json` does for
development; production registrations should be exact.

Get this wrong and sign-out fails *closed*, which is the safe direction but still worth
recognising: you are logged out of Couch Companion either way — the local session is torn down
before the redirect is issued, on purpose — but instead of landing back on the login screen you
stop at an IdP error page. Keycloak answers an unregistered value with a bare
**400 Bad Request**.

There is no `id_token_hint` on that request, and that is deliberate: retaining the ID token
purely to populate an optional parameter would mean holding a credential for no other purpose.
`client_id` is sent instead, which is what the spec provides for. One consequence to expect —
some providers respond by asking the user to confirm the sign-out rather than performing it
silently. Keycloak, given `client_id`, does not.

## Verifying the install

**Drop-in.** Note the trailing slash; `/_utils` redirects to `/_utils/`.

    curl -sL http://127.0.0.1:5984/_utils/ | grep -o '<title>[^<]*</title>'

A working drop-in prints `<title>Couch Companion</title>`. If it prints `<title>Project
Fauxton</title>`, the files did not land where you think they did — and the same command is how you
confirm a rollback worked.

Then open it in a browser and log in with a server admin. You should get the full nav — Home,
Topology, Databases, Setup, Active Tasks, Configuration, Design Docs, Version Control,
Replication, Identity Providers, Users, Banners — and the network tab should show **no request to
any other origin at all**. (There is no separate "Servers" entry: the server dashboard became
the Home page itself, D2/D3's single-server model having nothing left for a dedicated servers
screen to enumerate.) Nothing is fetched from a CDN; an off-origin request means something is
wrong.

Two errors during boot are expected and are not a broken install: `GET /_idp` answers **401** and
`GET /idp/config` answers **404** on a stock CouchDB. That is the IdP discovery chain finding no
identity provider and falling through to password login, which is the correct outcome. Console
errors should be zero.

**SPA.** Do the same checks, plus the one that matters:

1. Log in through the app's own form.
2. **Reload the page.** You must still be logged in.

In a cross-site SPA the login itself now catches a dropped cookie and says so on the form; the
reload check still earns its keep for everything else. If the reload logs you out, confirm from
the browser's own console, on the app's origin:

    await (await fetch(COUCH_URL + '/_session', { credentials: 'include' })).json()

`userCtx.name` must be your username. If it is `null` immediately after a login that returned
`{"ok":true}`, you are looking at the `same_site` trap described above. Read the actual
`Set-Cookie` header CouchDB emits — it has to carry **both** `SameSite=None` and `Secure`, and a
TLS-terminating proxy will strip the second one from you.
