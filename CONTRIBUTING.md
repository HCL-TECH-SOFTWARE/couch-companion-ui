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

# Contributing to Couch Companion UI

Thanks for wanting to help. This file covers how to get a change in: what the
project expects of a patch, how to run the same gate a reviewer will run, and
the conventions this codebase enforces mechanically so you don't discover them
in review.

Reporting a bug rather than fixing one? [BUGS.md](BUGS.md).

> **Project status.** Couch Companion UI is being prepared for donation to the
> Apache Software Foundation. It is not yet an ASF project. The parts of this
> document that describe ASF process — the CLA, the mailing lists, the issue
> tracker — describe where things are heading, and each one says plainly what
> is true today.

## Contributor licensing

Every contribution is accepted under the Apache License, Version 2.0 — the
terms in [LICENSE](LICENSE), specifically section 5. By opening a pull request
you assert that you wrote the patch, or otherwise have the right to submit it
under that license, and that you are willing to have it redistributed under it.

Two things follow, and both matter more than usual for a project heading into
the ASF:

- **Do not paste code you did not write** into a patch — not from Stack
  Overflow, not from another project, not from a model that reproduced
  something verbatim. Provenance that cannot be established has to be removed,
  and finding it late is expensive.
- **If your patch does incorporate third-party work** deliberately, say so in
  the pull request, name the upstream license, and add it to
  [NOTICE](NOTICE) and to the subcomponents section of [LICENSE](LICENSE). Only
  licenses in the ASF's [Category A][cat-a] list can be accepted.

Once the donation completes, substantial contributions will additionally
require an [Individual Contributor License Agreement][icla] on file. Nothing to
sign today.

[cat-a]: https://www.apache.org/legal/resolved.html#category-a
[icla]: https://www.apache.org/licenses/contributor-agreements.html

## Getting set up

The repository ships a devcontainer that starts everything the app talks to.
In VS Code: **Reopen in Container**. It brings up CouchDB on `:5984`
(`admin`/`password`) and Keycloak on `:8080` (realm `couch`), and seeds both
with `scripts/seed-dev.sh`, which is idempotent — rerun it whenever you want.

```
npm install
npm run dev      # vite on :5173
```

At `:5173` the app runs in **SPA mode**: it probes its own origin for CouchDB,
finds a dev server instead, and asks you for a server URL. Log in as
`admin`/`password` for a server admin, or `demo`/`password` for a CouchDB-native
non-admin — reach for `demo` whenever you touch a screen that has to degrade
for members, because a server admin will not show you the path that breaks.

The OIDC sign-in button will not appear at `:5173`. IdP discovery runs once at
boot against the app's own origin, which in dev is Vite, not CouchDB. To
exercise OIDC — or the `/_utils` drop-in generally — build and copy the bundle
into the CouchDB container:

```
npx vite build && docker compose -f .devcontainer/docker-compose.yml cp dist/. couchdb:/opt/couchdb/share/www/
```

Then open <http://localhost:5984/_utils/>. Recreate the container to get
Fauxton back.

### A multi-node cluster

The devcontainer's CouchDB is a single node — `_membership` reports one
`nonode@nohost` — so anything that compares configuration *across nodes* has
nothing to show there, and a screen that is broken looks exactly like a screen
that is correctly hiding itself. A separate three-node stack exists for that:

```
scripts/cluster-up.sh          # ~7s from cold, idempotent
scripts/cluster-up.sh down     # destroy it
```

It is **additive and opt-in**. `devcontainer.json` never references it, it is
its own compose project on its own network, and it publishes 15984/25984/35984
— so it runs alongside the single-node stack on `:5984` rather than replacing
it. Admin is `admin`/`password` on every node, as usual.

Each node is published on **its own port on purpose**. The mistake this stack
exists to catch is reading `_node/_local/_config`, which answers from whichever
node received the request: do that for three columns and you get three
identical ones that look like agreement. Reading a node by name gives the same
answer whichever port you ask, and `_local` does not — which is exactly the
difference you can check by hand:

```
:15984/_node/couchdb@couchdb3.ccui.local/_config/log/level   -> "debug"
:35984/_node/_local/_config/log/level                        -> "debug"
:15984/_node/_local/_config/log/level                        -> "info"
```

That difference is seeded deliberately, in both of the shapes a comparison has
to handle: `log/level` is set on every node but reads `debug` on node 3 (a
differing *value*, which is what "copy to the other nodes" is for), and
`log/writer` is set on node 3 only (*present vs absent*). Both values are what
the container already does, so neither changes its behaviour.

**Tear it down with `cluster-up.sh down`, never `docker compose stop`.** The
nodes keep their data on tmpfs, so a stop/start returns them with empty RAM
disks but surviving `.ini` files: each one still believes it is clustered while
the shard map is gone, and `_membership` silently collapses to a single node —
which reads like a frontend bug. Re-running `cluster-up.sh` repairs that if it
happens to you.

`seed-dev.sh` is *not* run against this stack: it wires Keycloak and writes
through `_node/_local/_config`, both single-node concerns. The cluster script
configures CORS for `:5173` on all three nodes by name, which is what SPA mode
needs; JWT sign-in against the cluster is not set up.

## The gate

One command decides whether a patch is mergeable:

```
npm run check      # eslint + vitest + tsc --noEmit
```

`.github/workflows/ci.yml` runs exactly that, plus `npx vite build` and
`node scripts/smoke.mjs`. `scripts/check.sh` is the full local equivalent —
`npm ci`, `npm run check`, `npx vite build`, `node scripts/smoke.mjs` — and it
mirrors the workflow step for step **on purpose**. If you change one, change the
other.

`npm run check` alone is not enough, and that is not a style opinion: it runs
*source*, unminified, under happy-dom, which implements no `Worker`. #30 was a
view tester broken in every single production build for weeks with that command
green. `scripts/smoke.mjs` is the answer — it builds with the repo's real Vite
config and drives the result in headless Chrome. It needs a Chrome on the
machine; set `CHROME_PATH` if yours is somewhere unusual.

Run the gate before you open a pull request. Do not open one against a red
tree, including breakage you inherited from `main`: fix that first, or say
plainly in the description that it is pre-existing and out of scope.

Individual pieces, when you want a faster loop:

```
npm run lint
npm run test           # vitest, single pass
npm run test:watch
npm run typecheck
npm run test:coverage
```

## Tests

- **Tests live in `test/`**, not beside the source. A new module gets
  `test/<name>.test.ts`.
- **The suite is hermetic, and enforced to be.** `test/setup.ts` replaces
  `fetch` with one that throws on any unmocked call, so a test that forgets to
  mock the network fails with a message naming the URL instead of quietly
  reaching a real server. Mock with a plain assignment
  (`globalThis.fetch = vi.fn()...`) or a `vi.spyOn` **that has an
  implementation**. A bare `vi.spyOn(globalThis, 'fetch')` leaves a
  call-through wrapper that later reassignment does not displace — it is the
  one form that defeats the guard.
- **The one network suite is opt-in.** `npm run test:e2e` covers design-doc
  GitHub sync only, reads `test/e2e/**`, and skips visibly unless you copy
  `.env.example` to `.env.local` and fill it in. It does not gate a merge.
- Web Awesome formatter elements (`wa-format-*`) render into their own shadow
  DOM. Assert on the `value` attribute, not on `textContent`.

New behavior needs a test. A bug fix needs a test that fails before it and
passes after.

## Code conventions

Most of these are enforced by ESLint, including four rules custom to this repo
in `eslint-rules/`. The rule exists in each case because the mistake it catches
is invisible in review and loud in production.

| Rule | What it enforces |
| --- | --- |
| `cca/no-undefined-wa-token` | Every `--wa-*` custom property you reference must actually be defined by the Web Awesome entry stylesheets. |
| `cca/no-hardcoded-typography` | No literal `font-family`, `font-size`, or `line-height` values — use the tokens. (`letter-spacing` is exempt; Web Awesome ships no token for it.) |
| `cca/no-cca-custom-property` | The retired `--cca-*` namespace stays retired. |
| `cca/max-ternary-lines` | Warns past ten lines of ternary; extract instead. |

Beyond the linter:

- **Use Web Awesome design tokens. No hardcoded colors.** Pick the family by
  role, the tier by contrast.
- **Watch out for backticks in comments inside `` css`` `` and `` html`` ``
  templates.** A backtick in a `/* comment */` inside a tagged template closes
  the template, and the resulting TypeScript error names some identifier far
  from the actual line.
- **Match the surrounding code.** Comment density, naming, and idiom vary by
  area; follow the file you are in rather than importing a house style from
  elsewhere.
- **Every new file needs the Apache license header**, in the comment syntax of
  that file type. Copy it from any neighbouring file.

## Pull requests

1. **Branch from `main`**, named for the issue it closes — `123-short-summary`.
2. **Keep the change scoped.** A patch that fixes one thing gets reviewed;
   a patch that fixes one thing and reformats four files does not.
3. **Write the description for the reviewer.** What changed, why, and how you
   convinced yourself it works. If you verified against a live CouchDB or IdP
   rather than a mock, say so and say which versions — that is worth more than
   a green tick, and this project has a habit of writing it down.
4. **Run the gate.** See above.
5. **Expect review.** At least one committer approves before merge; see
   [COMMITTERS.md](COMMITTERS.md).

Commit messages: a short imperative subject (`fix: reject empty selector in
Mango editor`), a blank line, then the reasoning. Reference the issue.

## Design documentation

This project keeps its reasoning in the tree rather than in a wiki:

- [docs/derivate-creation.md](docs/derivate-creation.md) — the design and
  decision log, D1–D19, with the per-phase decisions that corrected it where
  implementation disagreed with the plan.
- [docs/plans/](docs/plans/) — each phase's plan and its record of what was
  verified against live servers.
- [docs/install.md](docs/install.md) — deployment, both modes.

A change that contradicts a recorded decision should say so and update the
record. That log is the reason a reviewer can tell an intentional constraint
from an accident, and it is a large part of what makes this codebase
transferable.

## Code of conduct

Contributors are expected to follow the [Apache Software Foundation Code of
Conduct](https://www.apache.org/foundation/policies/conduct.html). Be
respectful, assume good faith, and take disagreements to the technical merits.

## Where to ask

Today: open an issue on the repository, or ask in the pull request itself.

After the move to the ASF this section is replaced by the project's `dev@`
mailing list, which becomes the place where decisions are made — the ASF norm
being that if it did not happen on the list, it did not happen.
