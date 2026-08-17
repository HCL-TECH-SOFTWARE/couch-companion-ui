# Couch Companion UI

A backend-less admin UI for a single Apache CouchDB server — a modern
**Fauxton drop-in replacement** served from `/_utils`, or a static SPA hosted
anywhere (GitHub Pages, Cloudflare Pages). Derived from the Couch Companion
(CCA) frontend: [Lit web components](https://lit.dev/), [Web Awesome](https://webawesome.com/),
[Monaco](https://microsoft.github.io/monaco-editor/), [d3](https://d3js.org/) — talking
**directly** to CouchDB's REST API. No server of its own, no credential vault, no background tasks.

## Status

What runs today covers databases and documents, Mango queries and indexes, permissions, users,
configuration, active tasks, replication and topology, design documents with optional
GitHub sync, and OIDC login together with the IdP admin screen that configures it — served
either from CouchDB's own `/_utils` or as a static SPA, talking to nothing but CouchDB
(and, if you switch sync on, GitHub).

The design was verified against a live CouchDB 3.5.2 and Keycloak rather than against a mock.

Rough edges to know about before you judge the repo:

- **No end-to-end suite gates a merge.** `npm test` is hermetic on purpose — an unmocked `fetch`
  fails loudly rather than reaching the network. The one real-network suite, `npm run test:e2e`,
  covers design-doc GitHub sync only and skips visibly unless you copy `.env.example` to
  `.env.local` and fill it in. Everything else described as "verified" was verified by hand against
  real servers, and written down in the phase plans.

## What you get

- **Drop-in at `/_utils`**: replace the contents of CouchDB's `share/www` and the UI answers on
  the database's own origin — no CORS, nothing to configure. Loaded in a real browser against
  CouchDB 3.5.2 it makes **zero off-origin requests**; that claim was measured, not assumed.
- **Auth discovery**: the login screen probes `GET /_idp` (a native endpoint that does not exist
  yet — a stock CouchDB answers 401 and the app moves on) and then the `idp/config` document. With
  an IdP configured it runs OIDC authorization-code + PKCE entirely in the browser and sends the
  resulting JWT as `Authorization: Bearer`; with none, it is the ordinary `_session` password
  login. Logging out asks first, and on an IdP session it offers **Full logout from IdP** —
  checked by default, and your answer is remembered — which redirects through the provider's
  `end_session_endpoint` so the session ends there too, not just here. Providers that publish no
  such endpoint simply do not get the option. No ID token is retained to power it, so some
  providers will ask you to confirm the sign-out; that is the trade for not keeping a credential
  around for one optional parameter. `post_logout_redirect_uri` must be registered with your IdP —
  see [install.md](install.md#register-two-uris-not-one-sign-in-and-sign-out).
- **IdP admin without a backend**: OIDC discovery and JWKS fetch, JWK→SPKI PEM conversion in the
  browser via WebCrypto, written to CouchDB's own `_node/_local/_config` — `[jwt_keys]` for the
  signing key, `[oidc]` for the provider's metadata, both under the same `rsa:<kid>` key so an
  orphan on either side is a plain set difference (the IdP list surfaces it). When the IdP's JWKS
  endpoint is not CORS-readable, you paste the JWKS instead and everything downstream is
  identical. Deleting an IdP deliberately leaves its `jwt_keys` entry in place — tidying a list
  should not invalidate every token already issued — so remove the key yourself if that is what you
  meant. The optional activity log is opt-in (`[oidc] log = true`, default off) — see
  [docs/install.md](docs/install.md#identity-provider-configuration-oidc).
- **Usable as a non-admin.** CouchDB's `GET /_all_dbs` is server-admin-only by default, so an
  ordinary member gets a 401 and no database list at all. Rather than dead-ending, every database
  picker degrades to a "type the name" field with the reason stated in place, and the per-database
  screens work from there — documents, design docs, and `?database=` deep links all function for a
  plain member. Whole-server aggregates (the storage tiles) still say plainly that they need a
  server admin, because there is no per-database equivalent to offer. To open enumeration up, the
  CouchDB setting is `[chttpd] admin_only_all_dbs = false` — note the section; `[couchdb]` is
  accepted and silently ignored.
- **Design-doc git sync** via the GitHub REST API, manual trigger only, with credential storage as
  an explicit user choice (none / IndexedDB / CouchDB). See
  [Design-doc sync with GitHub](#design-doc-sync-with-github) below.
- **Topology** read from `_replicator` + `_scheduler/docs` — shows the replication constellation,
  live state and errors included, without ever contacting a remote server. Credentials in
  replication documents are masked and never handed back.
- **Real view testing**: your map function executes in your browser, not a preview of it.

## Install

Two supported deployments, both from the same `dist/`:

- **Drop-in** — replace the contents of CouchDB's `share/www`; the UI answers at `/_utils`, same
  origin as the database, with nothing to configure. This is the primary target (D4). It also
  destroys the Fauxton your server shipped with, so read the rollback before you need it.
- **Static SPA** — host `dist/` anywhere (GitHub Pages, Cloudflare Pages, a bucket) and point it at
  a CouchDB. This one needs CORS on CouchDB. If the app and the database are on different *sites*
  — not merely different ports — it additionally needs `[chttpd_auth] same_site = none` **and**
  HTTPS. Over plain HTTP that setting makes the browser discard the session cookie *silently*: the
  login reports success and the very next request is anonymous.

[docs/install.md](docs/install.md) has the actual steps for each case, the CouchDB config snippets,
and the Fauxton rollback; `scripts/package.sh` builds the drop-in tarball.

## Development

Open in the devcontainer (VS Code: "Reopen in Container"). It starts
CouchDB (:5984, admin/password) and Keycloak (:8080, realm `couch`,
users `hariseldon`/`password` = `_admin`, `gaaldornick`/`password` = user)
and seeds both via `scripts/seed-dev.sh` (idempotent — rerun any time).

    npm run dev         # vite on :5173
    npm run check       # lint + tests + typecheck (what ci.yml runs)
    ./scripts/check.sh  # the merge gate: npm ci + npm run check + build
    npx vite build      # production bundle in dist/

At :5173 the app is in **SPA mode** — it detects CouchDB by probing its own origin, finds none, and
asks you for a server URL. Log in there with `admin`/`password` (server admin) or `demo`/`password`
(a CouchDB-native non-admin — the account to reach for when checking the degraded paths above).

The Keycloak sign-in button will *not* appear at :5173: IdP discovery runs once, at boot, against
the app's own origin — which is the dev server, not CouchDB. To exercise it — and the drop-in
generally — build and copy `dist/` into the CouchDB container, then open
<http://localhost:5984/_utils/>:

    npx vite build && docker compose -f .devcontainer/docker-compose.yml cp dist/. couchdb:/opt/couchdb/share/www/

Recreate the container to get Fauxton back. For a real server use the tarball from
`scripts/package.sh` and follow [docs/install.md](docs/install.md) instead of copying by hand.

**Packaging from inside the devcontainer is tarball-only.** `scripts/package.sh` also builds the
`couch-companion` container image, and that half cannot run in here: the devcontainer has no Docker
socket and no docker-in-docker feature, so `docker` is simply absent. The script checks for it up
front and stops rather than half-finishing. Either run the script **on the host**, or pass
`--no-docker` in here to produce the tarball alone.

That CouchDB is a single node, so anything comparing configuration *across* nodes has nothing to
show. `scripts/cluster-up.sh` brings up a separate three-node cluster on 15984/25984/35984 for
those screens — opt-in, alongside `:5984` rather than instead of it. See
[CONTRIBUTING.md](CONTRIBUTING.md#a-multi-node-cluster).

## Design-doc sync with GitHub

Design documents are always read and edited directly against CouchDB; git sync is an optional,
manual, admin-only extra on top. There is no backend and no proxy — the browser calls the GitHub
REST API directly.

**On a `/_utils` drop-in this needs one CouchDB config change first.** Because the browser calls
GitHub itself, and CouchDB serves `/_utils` with a Content-Security-Policy that has no
`connect-src`, the request is blocked before it is sent — it shows up as `Failed to fetch` with
nothing in the network tab. See
[Git sync needs one more change](docs/install.md#git-sync-needs-one-more-change-couchdbs-content-security-policy)
in the install guide. SPA installs are unaffected.

### Connecting an account

1. On GitHub, create a **fine-grained personal access token** scoped to the target repository,
   with the **Contents: Read and write** repository permission. That one permission is everything
   sync needs: it covers reading trees and blobs (to detect what changed) and writing
   blobs/trees/commits/refs (to push a sync as a single atomic commit).
2. From a database's design-doc list, choose "Connect Git Account" (visible to server
   administrators only — see [Who can do what](#who-can-do-what)). For **GitHub Enterprise**,
   enter the Enterprise host (e.g. `https://ghe.example.com`) in the "Base URL (for self-hosted)"
   field; leave it blank to use github.com.
3. Choose where the access token is stored. None of the three options are encrypted — once
   there's no backend, there is no key custodian left to hold an encryption key, so pretending
   otherwise would be security theater, not security. This is the exact copy the UI shows for each
   choice (`CREDENTIAL_MODE_COPY` in `src/services/git/git-credential-store.ts` — kept as the
   single source so this table cannot drift from what the app actually says):

   | Option | Label shown in the UI | What it means |
   |---|---|---|
   | `none` (default) | Do not store (recommended) | Held in memory for this tab only. You re-enter the token each session. |
   | `indexeddb` | This browser | Stored in plain text in this browser profile, for this origin. Anyone with the profile — or any script injected into this origin — can read it. |
   | `couchdb` | On the CouchDB server | Stored in plain text in the `couchcompanion` database, so it follows you between browsers and is readable by every server admin. |

### Who can do what

- **Git sync is server-admin-only** (CouchDB's `_admin` role) — connecting an account, registering
  a repository, and running a sync all write the `couchcompanion` database, which is admin-only by
  CouchDB's own default `_security` (never anything this app sets explicitly).
- **Editing a design document** (create, save, delete) needs only **database-admin** rights — being
  named in that specific database's `{db}/_security.admins`, by user or by role — exactly the rule
  CouchDB itself applies to a `PUT`/`DELETE` on `_design/*`. A database admin who is not a server
  admin can edit design docs freely but will not see the sync/connect-account controls.
- Anyone who can read a database can browse and open its design documents and run the view tester;
  neither needs any admin right at all.
- `couchcompanion` (where accounts, repositories, sync state, and conflicts live) is **never
  created at login** — only the first time a git-sync action actually needs it: connecting an
  account, registering a repository, or running a sync.

### Behavior worth knowing about before you rely on it

- **Sync is manual.** Nothing syncs on its own; a sync only happens when you click "Sync to Repo"
  or "Sync to CouchDB". There is no background watcher and no schedule.
- **Deleting a design doc in CouchDB does not delete it from git — and syncing from the repository
  will bring it back.** If you delete a design document in CouchDB while it still exists in the
  linked repository, sync sees a document that git has and CouchDB (as far as the last recorded
  sync knows) should still have — it reads as "newer in git," not as "deleted on purpose." Clicking
  "Sync to CouchDB" will **silently resurrect it.** If you actually want a design document gone,
  delete it from the git repository as well.
- **Sync refuses to overwrite in the direction that would lose data.** A document changed only in
  CouchDB since the last sync will not be overwritten by a pull from git; a document changed only
  in git will not be overwritten by a push to CouchDB. Only when *both* sides changed does sync
  stop and record a conflict for you to resolve — it never guesses which side should win.
- **The repository-side listing caps at 50 design documents.** Each file it reads is its own
  GitHub API call against a rate limit the app doesn't control, so a repository with more than 50
  design docs under the synced path shows only the first 50. When that happens the design-doc list
  says so above the table — how many of how many, and which documents were left out — rather than
  silently reading as "that's everything the repository has."

### View tester

The view tester runs your **actual** map function in the browser — a Web Worker where the
environment provides one, an in-page fallback where `Worker` is undefined (which is what makes it
testable under happy-dom) — not a preview or a heuristic; a syntax error in your
map function is reported as a real `SyntaxError`, not brace-counted. Reduce functions run the same
way, but only three of CouchDB's builtin reduces are actually simulated: `_count`, `_sum`, and
`_stats`. Any other valid builtin — `_approx_count_distinct`, or the
`_first`/`_last`/`_top_*`/`_bottom_*` family — is recognized and reported honestly as "a valid
CouchDB builtin reduce function, but this in-browser preview does not simulate it," rather than
being silently run against live CouchDB or misreported as a broken design document.

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, the merge gate, and the conventions this
  repo enforces mechanically.
- [BUGS.md](BUGS.md) — how to report a bug, and the private path for security issues.
- [COMMITTERS.md](COMMITTERS.md) — who has write access and whose review a PR needs.