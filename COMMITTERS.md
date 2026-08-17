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

# Committers

These are the people with write access to Couch Companion UI, and the people
whose review a pull request needs. Copyright ownership of their contributions
is recorded in [NOTICE](NOTICE).

The Apache ID column is empty on purpose: this project is not yet an Apache
Software Foundation project, and Apache IDs are assigned when a donation is
accepted and the initial committer list is established. Nobody here holds one
by virtue of this project today.

| Name | GitHub | Apache ID | Focus |
| --- | --- | --- | --- |
| Stephan H. Wissel | [@stephan-wissel](https://github.com/stephan-wissel) | — | Project lead; original author. Architecture, CouchDB integration, auth and OIDC, replication and topology, design-doc git sync, packaging. |
| Catherine Barrientos | [@catherine-barrientos](https://github.com/catherine-barrientos) | — | UI components, review. |

## Provenance of the code

Couch Companion UI is a derivative of the Couch Companion (CCA) frontend,
rebuilt as a backend-less admin UI for a single CouchDB server. The full
history is in this repository's git log; the design and decision record that
accompanies it is in
[docs/derivate-creation.md](docs/derivate-creation.md) and
[docs/plans/](docs/plans/).

All contributions to date were made by the people listed above in the course of
work for HCL America Inc., which holds copyright in the original work. See
[NOTICE](NOTICE) for the full statement and for how it changes on donation.

## What a committer does

- **Reviews and merges pull requests.** Every change reaches `main` through a
  pull request with at least one committer's approval. This includes changes
  written by committers — self-merging without review is not the norm here.
- **Runs the gate.** CI has never executed on the current GitHub Enterprise
  host, which has no runner for it, so until the repository moves to a host
  with runners a committer's own `scripts/check.sh` run *is* the merge gate.
  Merging on an unverified tree is the one thing that would quietly undo the
  test suite's value.
- **Keeps the decision record honest.** When implementation disagrees with a
  recorded decision, the record gets updated rather than silently outvoted.
  Much of what makes this codebase reviewable by someone who did not write it
  lives in `docs/`, and it only stays true if committers maintain it.
- **Answers bug reports** and triages what comes in through
  [BUGS.md](BUGS.md), including the private security path.

## Becoming a committer

Merit, demonstrated over time, in the ordinary Apache sense: sustained,
good-quality contribution, and enough engagement with review and discussion
that the existing committers can judge the work. There is no application form
and no fixed commit count. Contributions are not only code — documentation,
triage, testing against real CouchDB deployments, and thoughtful review all
count.

Existing committers propose and decide new committers. Start with
[CONTRIBUTING.md](CONTRIBUTING.md).

After the donation to the Apache Software Foundation, this becomes the
foundation's process: the project's PMC votes on new committers, committers
sign an [Individual Contributor License Agreement][icla], and this file
tracks the roster the PMC maintains.

[icla]: https://www.apache.org/licenses/contributor-agreements.html

## Contact

Today: through issues and pull requests on the repository. Security reports go
privately to the maintainers above rather than to the tracker — see
[BUGS.md](BUGS.md).

After the move, the project's `dev@` mailing list becomes the place where
decisions are made and where committers can be reached in public.
