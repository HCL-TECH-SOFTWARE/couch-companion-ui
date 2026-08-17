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

# Reporting bugs in Couch Companion UI

## Security vulnerabilities do not go here

**Do not open a public issue for a security problem.** Report it privately, and
give the project time to ship a fix before disclosing.

- **Today**, while the project is still pre-donation: mail the maintainers
  listed in [COMMITTERS.md](COMMITTERS.md) directly.
- **After the donation to the Apache Software Foundation completes**: mail
  <security@apache.org>, which is the ASF-wide address and the correct one for
  any Apache project. The ASF's process is described at
  <https://www.apache.org/security/>.

This applies to anything that would let someone read data, act as another user,
or escalate privilege that they should not have — including the credential
storage paths described in the README, where the threat model is deliberately
explicit rather than reassuring.

## Everything else

Open an issue on the repository.

Before you do, two quick checks that save everyone a round trip:

1. **Search the existing issues.** Including closed ones — a fix may already be
   on `main` and not yet released.
2. **Read the "rough edges" section of the [README](README.md).** Several
   behaviors that look like bugs are recorded, deliberate decisions: sync will
   resurrect a design document you deleted only in CouchDB, logging out of an
   IdP session may make the provider ask you to confirm the sign-out (no ID
   token is retained to skip that prompt), the repository-side design-doc
   listing caps at 50, and whole-server storage tiles require a server admin.
   If your report is one of those, it is still worth filing as a design
   complaint — just say that is what it is, so it gets triaged as one.

## What to put in the report

The single most useful thing is **the smallest sequence of steps that
reproduces it**. After that, in rough order of how often it turns out to
matter:

- **Which deployment mode.** Drop-in at CouchDB's `/_utils`, or a standalone
  SPA pointed at a CouchDB elsewhere? A large share of bugs are only reachable
  in one of the two, because the SPA path involves CORS, cookie `SameSite`, and
  a cross-origin login that the drop-in never touches.
- **CouchDB version**, and whether the account you used is a **server admin, a
  database admin, or a plain member**. Screens degrade deliberately for
  non-admins; "the database list is empty" is expected for a member on a stock
  server, because `GET /_all_dbs` is admin-only unless
  `[chttpd] admin_only_all_dbs = false` is set — note the section, `[couchdb]`
  is accepted and silently ignored.
- **Couch Companion UI version** — from `package.json`, or the release tarball
  name.
- **Browser and version.** This is a web-components application; behavioral
  differences between engines are real.
- **Console output and failing network requests.** Open devtools, reproduce,
  and paste what appears. A 401 or a CORS error in the console usually names
  the problem outright.
- **Whether an IdP is configured**, and which one, if the report touches login.
- **What you expected instead.** Sometimes the disagreement is about intended
  behavior, and that is a legitimate thing to file.

Screenshots are welcome for anything visual. **Redact credentials, tokens, and
hostnames you would rather not publish** — issue trackers are public and
indexed, and replication documents in particular carry credentials in their
source even though the UI masks them.

## What happens next

A maintainer will triage the report, and may ask for more detail before
anything else happens — usually because the reproduction depends on a CouchDB
configuration that has to be matched exactly.

Note that CI has never executed on the current GitHub Enterprise host, which
has no runner for it; `scripts/check.sh` is the human-run gate in the meantime.
That is a known gap, not a reason to hold back a report.

If you want to fix the bug yourself, [CONTRIBUTING.md](CONTRIBUTING.md) has
what you need. Fixes come with a test that fails before the change.
