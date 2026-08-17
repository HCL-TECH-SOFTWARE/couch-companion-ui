/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Unit tests for the CSP header parser/editor (#34).
 *
 * The load-bearing property is reversibility: the toggle has no durable place to keep a backup of
 * the previous header, so "off" must *derive* the original rather than restore it. Every
 * round-trip assertion below is `toBe` on the whole string — a normalised lookalike is a failure,
 * because it would silently rewrite directives the operator never asked us to touch.
 */

import { describe, it, expect } from 'vitest';
import {
  addConnectSrcOrigins,
  buildCspCurl,
  connectSources,
  connectSrcValues,
  isOriginAllowed,
  missingOrigins,
  parseCsp,
  removeConnectSrcOrigins,
  requiredGitOrigins,
  scriptSrcAllowsEval,
  serialiseCsp,
  setUnsafeEval
} from '../src/services/csp-policy';

/**
 * What CouchDB 3.5.2 actually sends on `/_utils/`, copied from a live server
 * (`curl -s -i http://localhost:5984/_utils/ | grep -i content-security-policy`). Note what it
 * does NOT have: a `connect-src`. That absence is the whole bug — `default-src 'self'` governs
 * instead and every cross-origin request is refused before it is dispatched.
 */
const COUCHDB_DEFAULT =
  "child-src 'self' data: blob:; default-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-src https://blog.couchdb.org;";

const GITHUB = 'https://api.github.com';

describe('csp-policy — parse/serialise', () => {
  it.each([
    ['the CouchDB 3.5.2 default', COUCHDB_DEFAULT],
    ['no trailing semicolon', "default-src 'self'; connect-src 'self' https://api.github.com"],
    ['a single directive', "default-src 'self'"],
    ['odd whitespace an operator left in', "default-src   'self' ;\n  script-src 'self';"],
    ['no space after the semicolons', "default-src 'self';script-src 'self';"],
    ['leading whitespace', "  default-src 'self';"],
    ['a stray double semicolon', "default-src 'self';; script-src 'self';"],
    ['an empty policy', '']
  ])('serialise(parse(x)) is byte-identical for %s', (_label, header) => {
    expect(serialiseCsp(parseCsp(header))).toBe(header);
  });

  it('folds an empty trailing directive into the previous one rather than inventing a third', () => {
    const parsed = parseCsp("default-src 'self'; script-src 'self';");
    expect(parsed.directives.map((d) => d.name)).toEqual(['default-src', 'script-src']);
    expect(parsed.directives[1].sep).toBe(';');
  });

  it('lower-cases the directive name for lookup but keeps the spelling for output', () => {
    const parsed = parseCsp("Default-Src 'self';");
    expect(parsed.directives[0].name).toBe('default-src');
    expect(parsed.directives[0].nameRaw).toBe('Default-Src');
    expect(serialiseCsp(parsed)).toBe("Default-Src 'self';");
  });
});

describe('csp-policy — add then remove round-trips', () => {
  it('parse -> add -> serialise -> remove is byte-identical to the input', () => {
    const extended = addConnectSrcOrigins(COUCHDB_DEFAULT, [GITHUB]);
    expect(extended).not.toBe(COUCHDB_DEFAULT);
    expect(removeConnectSrcOrigins(extended, [GITHUB])).toBe(COUCHDB_DEFAULT);
  });

  it('produces exactly the header docs/install.md tells operators to write', () => {
    // The docs and the toggle must not drift: an operator who follows install.md by hand and one
    // who flips the switch have to end up with the same server state.
    expect(addConnectSrcOrigins(COUCHDB_DEFAULT, [GITHUB])).toBe(
      "child-src 'self' data: blob:; default-src 'self'; img-src 'self' data:; font-src 'self'; " +
        "script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
        "frame-src https://blog.couchdb.org; connect-src 'self' https://api.github.com;"
    );
  });

  it.each([
    ['no trailing semicolon', "default-src 'self'; script-src 'self'"],
    ['a single directive', "default-src 'self'"],
    ['no space after the semicolons', "default-src 'self';script-src 'self';"],
    ['odd whitespace', "default-src   'self' ;\n  script-src 'self';"],
    ['an existing connect-src', "default-src 'self'; connect-src 'self' https://git.example.com;"],
    [
      'an existing connect-src with odd spacing',
      "default-src 'self'; connect-src  'self'   https://git.example.com ;"
    ],
    // The regression the positional half of `dropIfSynthetic` exists for: judged on redundancy
    // alone this loses its middle connect-src, a directive the operator wrote, to an operation
    // that promised to be reversible.
    ['a redundant connect-src the operator wrote', "default-src 'self'; connect-src 'self'; img-src *;"]
  ])('round-trips %s', (_label, header) => {
    const extended = addConnectSrcOrigins(header, [GITHUB]);
    expect(extended).toContain(GITHUB);
    expect(removeConnectSrcOrigins(extended, [GITHUB])).toBe(header);
  });

  it('round-trips several origins at once', () => {
    const origins = [GITHUB, 'https://ghe.example.com'];
    const extended = addConnectSrcOrigins(COUCHDB_DEFAULT, origins);
    expect(connectSrcValues(extended)).toEqual(["'self'", ...origins]);
    expect(removeConnectSrcOrigins(extended, origins)).toBe(COUCHDB_DEFAULT);
  });

  it('adding twice is idempotent, so a double click cannot duplicate an origin', () => {
    const once = addConnectSrcOrigins(COUCHDB_DEFAULT, [GITHUB]);
    expect(addConnectSrcOrigins(once, [GITHUB])).toBe(once);
    expect(removeConnectSrcOrigins(once, [GITHUB])).toBe(COUCHDB_DEFAULT);
  });

  it('removing an origin that is not there leaves the header alone', () => {
    expect(removeConnectSrcOrigins(COUCHDB_DEFAULT, [GITHUB])).toBe(COUCHDB_DEFAULT);
  });

  it('keeps a connect-src that still says something after the origins come out', () => {
    const header = "default-src 'self'; connect-src 'self' https://keep.example.com;";
    const extended = addConnectSrcOrigins(header, [GITHUB]);
    expect(removeConnectSrcOrigins(extended, [GITHUB])).toBe(header);
    // And the survivor is untouched, not re-derived from default-src.
    expect(connectSrcValues(removeConnectSrcOrigins(extended, [GITHUB]))).toEqual([
      "'self'",
      'https://keep.example.com'
    ]);
  });
});

describe('csp-policy — seeding an absent connect-src', () => {
  it('seeds the new directive from default-src rather than inventing one', () => {
    // A bare `connect-src https://api.github.com` would gain GitHub and silently LOSE CouchDB:
    // same-origin connections were only ever permitted through the default-src fallback.
    expect(connectSrcValues(addConnectSrcOrigins(COUCHDB_DEFAULT, [GITHUB]))).toEqual([
      "'self'",
      GITHUB
    ]);
  });

  it('carries a multi-source default-src across in full', () => {
    const header = "default-src 'self' https://cdn.example.com data:;";
    expect(connectSrcValues(addConnectSrcOrigins(header, [GITHUB]))).toEqual([
      "'self'",
      'https://cdn.example.com',
      'data:',
      GITHUB
    ]);
  });

  it('reports connect-src as ungoverned when neither directive is present', () => {
    expect(connectSources("script-src 'self';")).toBeNull();
    expect(missingOrigins("script-src 'self';", [GITHUB])).toEqual([]);
  });

  it('falls back to default-src when connect-src is absent', () => {
    expect(connectSources(COUCHDB_DEFAULT)).toEqual(["'self'"]);
    expect(connectSrcValues(COUCHDB_DEFAULT)).toBeNull();
  });
});

describe('csp-policy — a policy that already permits the host', () => {
  it.each([
    ['the exact origin', "default-src 'self'; connect-src 'self' https://api.github.com;"],
    ['a bare host', "connect-src 'self' api.github.com;"],
    ['a wildcard host', "connect-src 'self' https://*.github.com;"],
    ['a scheme source', "connect-src 'self' https:;"],
    ['a star', "connect-src *;"],
    ['default-src alone permitting it', "default-src 'self' https://api.github.com;"]
  ])('reports nothing missing for %s', (_label, header) => {
    expect(missingOrigins(header, [GITHUB])).toEqual([]);
  });

  it.each([
    ["CouchDB's default", COUCHDB_DEFAULT],
    ['a connect-src that names some other host', "connect-src 'self' https://gitlab.com;"],
    ['a wildcard for a different domain', "connect-src https://*.gitlab.com;"],
    ['http: when the origin is https', "connect-src http:;"],
    ['a port that does not match', "connect-src https://api.github.com:8443;"]
  ])('reports the origin missing for %s', (_label, header) => {
    expect(missingOrigins(header, [GITHUB])).toEqual([GITHUB]);
  });

  it("matches 'self' only against the page's own origin", () => {
    expect(isOriginAllowed(["'self'"], 'https://couch.example.com', 'https://couch.example.com')).toBe(true);
    expect(isOriginAllowed(["'self'"], GITHUB, 'https://couch.example.com')).toBe(false);
    // Without a stated page origin there is nothing to compare against, so it is not a match.
    expect(isOriginAllowed(["'self'"], GITHUB)).toBe(false);
  });

  it('never treats a nonce or hash as permission to connect somewhere', () => {
    expect(isOriginAllowed(["'nonce-abc'", "'sha256-xyz'", "'strict-dynamic'"], GITHUB)).toBe(false);
  });

  it('treats an unparseable origin as not allowed rather than throwing', () => {
    expect(isOriginAllowed(['*'], 'not a url')).toBe(false);
  });
});

describe("csp-policy — script-src 'unsafe-eval'", () => {
  it('reads what CouchDB ships', () => {
    expect(scriptSrcAllowsEval(COUCHDB_DEFAULT)).toBe(true);
    expect(scriptSrcAllowsEval("default-src 'self'; script-src 'self';")).toBe(false);
  });

  it('falls back to default-src, and calls an ungoverned policy permissive', () => {
    expect(scriptSrcAllowsEval("default-src 'self' 'unsafe-eval';")).toBe(true);
    expect(scriptSrcAllowsEval("default-src 'self';")).toBe(false);
    expect(scriptSrcAllowsEval("img-src 'self';")).toBe(true);
  });

  it('round-trips off and back on again', () => {
    const hardened = setUnsafeEval(COUCHDB_DEFAULT, false);
    expect(scriptSrcAllowsEval(hardened)).toBe(false);
    // Edited in place, not deleted and re-appended somewhere else: CouchDB's script-src is the
    // fifth of seven directives and has to stay there for the header to survive a round trip.
    expect(hardened).toContain("font-src 'self'; script-src 'self'; style-src");
    expect(setUnsafeEval(hardened, true)).toBe(COUCHDB_DEFAULT);
  });

  it('round-trips on and back off again when the server never sent it', () => {
    const header = "default-src 'self'; script-src 'self'; img-src *;";
    const relaxed = setUnsafeEval(header, true);
    expect(scriptSrcAllowsEval(relaxed)).toBe(true);
    expect(relaxed).toContain("script-src 'self' 'unsafe-eval'; img-src *;");
    expect(setUnsafeEval(relaxed, false)).toBe(header);
  });

  it('collapses a trailing directive that only ever restated default-src', () => {
    // The one corner `dropIfSynthetic` cannot call: a FINAL script-src identical to default-src is
    // indistinguishable from one this module synthesised. Documented rather than hidden — the
    // result is semantically the same policy, and the directive it drops said nothing.
    const header = "default-src 'self'; script-src 'self';";
    expect(setUnsafeEval(setUnsafeEval(header, true), false)).toBe("default-src 'self';");
    expect(scriptSrcAllowsEval("default-src 'self';")).toBe(false);
  });

  it('seeds an absent script-src from default-src, and drops it again on the way back', () => {
    const header = "default-src 'self';";
    const relaxed = setUnsafeEval(header, true);
    expect(relaxed).toBe("default-src 'self'; script-src 'self' 'unsafe-eval';");
    expect(setUnsafeEval(relaxed, false)).toBe(header);
  });

  it('leaves the connect-src decision entirely alone', () => {
    // The two offers are separate on purpose: neither may move the other's directive.
    expect(connectSrcValues(setUnsafeEval(COUCHDB_DEFAULT, false))).toBeNull();
    expect(addConnectSrcOrigins(COUCHDB_DEFAULT, [GITHUB])).toContain("script-src 'self' 'unsafe-eval'");
  });
});

describe('csp-policy — required origins are computed from the accounts', () => {
  it('maps a github.com account to the API host GitHubProvider actually calls', () => {
    expect(requiredGitOrigins([{ base_url: null }])).toEqual([GITHUB]);
    expect(requiredGitOrigins([{ base_url: '' }])).toEqual([GITHUB]);
    expect(requiredGitOrigins([{}])).toEqual([GITHUB]);
  });

  it('maps an Enterprise account to its own origin', () => {
    // GitHubProvider routes Enterprise through `{base_url}/api/v3` — same origin as the base URL.
    expect(requiredGitOrigins([{ base_url: 'https://ghe.example.com' }])).toEqual([
      'https://ghe.example.com'
    ]);
    expect(requiredGitOrigins([{ base_url: 'https://ghe.example.com/some/path' }])).toEqual([
      'https://ghe.example.com'
    ]);
  });

  it('deduplicates, preserving the order accounts were connected in', () => {
    expect(
      requiredGitOrigins([
        { base_url: null },
        { base_url: 'https://ghe.example.com' },
        { base_url: null },
        { base_url: 'https://ghe.example.com/' }
      ])
    ).toEqual([GITHUB, 'https://ghe.example.com']);
  });

  it('skips an unparseable base_url rather than putting nonsense in a security header', () => {
    expect(requiredGitOrigins([{ base_url: 'ghe.example.com' }])).toEqual([]);
    expect(requiredGitOrigins([])).toEqual([]);
  });
});

describe('csp-policy — the curl for someone who cannot write the config', () => {
  const curl = buildCspCurl('http://localhost:5984', addConnectSrcOrigins(COUCHDB_DEFAULT, [GITHUB]));

  it('targets the config key that actually holds the policy', () => {
    expect(curl).toContain('http://localhost:5984/_node/_local/_config/csp/utils_header_value');
  });

  it('uses a heredoc, because the policy contains apostrophes', () => {
    // `--data-binary '<policy>'` would end at the first `'self'` and paste as a broken command.
    expect(curl).toContain("--data-binary @- <<'JSON'");
    expect(curl).toContain(JSON.stringify(addConnectSrcOrigins(COUCHDB_DEFAULT, [GITHUB])));
  });

  it('falls back to a usable host when the deployment has no base URL to offer', () => {
    expect(buildCspCurl('', COUCHDB_DEFAULT)).toContain('http://localhost:5984/_node/_local/_config');
  });
});
