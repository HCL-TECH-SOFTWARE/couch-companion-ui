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
 * Reading and editing a `Content-Security-Policy` header string (#34).
 *
 * Pure: no `fetch`, no DOM, no context. Everything here is string in, string out, so the parse
 * and the round-trip can be tested exhaustively without a browser or a server.
 *
 * WHY A PARSER AND NOT A TEMPLATE. CouchDB's `[csp] utils_header_value` replaces the **whole**
 * header, not one directive — whatever the server was sending is discarded and replaced by the
 * string that is PUT. `docs/install.md` warns operators about that by hand ("start from your own
 * live header and add connect-src to it, rather than pasting the example blind"); a toggle that
 * writes a hardcoded policy would be that exact mistake, automated. Every directive the server
 * shipped has to survive the edit.
 *
 * WHY THE RAW TEXT IS KEPT PER DIRECTIVE. The toggle has to be reversible, and there is nowhere
 * durable to keep a backup of the previous header — so "off" cannot restore, it has to *derive*
 * the original. That only works if the edit is the sole difference: parse keeps each directive's
 * exact source text and the exact separator that followed it, so {@link serialiseCsp} of an
 * unedited parse is byte-identical to its input by construction, and add-then-remove round-trips
 * to the original string rather than to a normalised lookalike.
 *
 * THE EMPTY-SECTION TRAP. An empty `[csp]` section does **not** mean "no policy" — it means
 * CouchDB's built-in default, which is exactly the one missing `connect-src`. Nothing in this
 * module reads config; callers hand it the live response header. See `CspService`.
 */

/** One directive, plus enough of its source text to put the header back together unchanged. */
export interface CspDirective {
  /** Lower-cased directive name — CSP directive names are case-insensitive. */
  name: string;
  /** The name exactly as the server spelled it, so a re-serialise does not "correct" it. */
  nameRaw: string;
  /** This directive's exact source text, e.g. `script-src 'self' 'unsafe-eval'`. */
  raw: string;
  /**
   * The exact text that separated this directive from the next one — `"; "`, `";"`, `";\n  "`,
   * or `""` for a policy with no trailing semicolon. Carrying it here (rather than assuming a
   * canonical `"; "`) is what makes {@link serialiseCsp} an identity on an unedited parse.
   */
  sep: string;
}

/** A parsed policy. {@link serialiseCsp} of an unedited value reproduces its input exactly. */
export interface CspPolicy {
  /** Whitespace (and any empty leading directives) before the first real directive. */
  lead: string;
  directives: CspDirective[];
}

/** The origin every github.com account talks to — `GitHubProvider.apiRoot` with no `base_url`. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/** The `script-src` source expression the view tester needs. See {@link scriptSrcAllowsEval}. */
export const UNSAFE_EVAL = "'unsafe-eval'";

const CONNECT_SRC = 'connect-src';
const DEFAULT_SRC = 'default-src';
const SCRIPT_SRC = 'script-src';

/**
 * Splits a header into directives while remembering every byte between them.
 *
 * An empty directive (a trailing `;`, or a stray `;;`) is not a directive at all — its separator
 * is folded into the previous one, so `a; b;` parses as two directives with the final `;` living
 * on `b` rather than as a phantom third entry that a re-serialise would have to invent a name for.
 */
export function parseCsp(header: string): CspPolicy {
  let lead = /^\s*/.exec(header)?.[0] ?? '';
  const directives: CspDirective[] = [];
  let i = lead.length;

  while (i < header.length) {
    const semi = header.indexOf(';', i);
    const end = semi === -1 ? header.length : semi;
    const chunk = header.slice(i, end);
    const body = chunk.replace(/\s+$/, '');

    let sep = chunk.slice(body.length);
    if (semi === -1) {
      i = header.length;
    } else {
      const after = /^\s*/.exec(header.slice(semi + 1))?.[0] ?? '';
      sep += `;${after}`;
      i = semi + 1 + after.length;
    }

    if (body === '') {
      if (directives.length > 0) directives[directives.length - 1].sep += sep;
      else lead += sep;
      continue;
    }

    const nameRaw = body.split(/\s+/)[0];
    directives.push({ name: nameRaw.toLowerCase(), nameRaw, raw: body, sep });
  }

  return { lead, directives };
}

/** Byte-identical to the input of {@link parseCsp} when nothing has been edited. */
export function serialiseCsp(policy: CspPolicy): string {
  return policy.lead + policy.directives.map((d) => d.raw + d.sep).join('');
}

/** The source expressions of one directive — its raw text minus the directive name. */
export function directiveValues(directive: CspDirective): string[] {
  return directive.raw.split(/\s+/).slice(1);
}

function findDirective(policy: CspPolicy, name: string): CspDirective | undefined {
  return policy.directives.find((d) => d.name === name);
}

/**
 * The separator to use when appending a directive: whatever this policy already uses between
 * directives, so the result reads like the rest of the header rather than like our house style.
 * The last directive's separator is the header's *trailing* text (often `";"`), which is why it
 * is excluded here — it is not an example of how two directives are joined.
 */
function separatorStyle(policy: CspPolicy): string {
  for (const d of policy.directives.slice(0, -1)) {
    if (d.sep !== '') return d.sep;
  }
  return '; ';
}

/**
 * Appends a directive, taking over the trailing text so removing it again restores the original.
 *
 * The previous last directive owned the header's trailing separator (`";"`); the newcomer takes
 * that over and the old owner gets an ordinary between-directives separator. {@link removeDirective}
 * hands the separator back the same way, which is the whole reversibility trick — no stored backup,
 * just a rule that is its own inverse.
 */
function appendDirective(policy: CspPolicy, directive: CspDirective): void {
  const style = separatorStyle(policy);
  const last = policy.directives[policy.directives.length - 1];
  if (last) {
    directive.sep = last.sep;
    last.sep = style;
  }
  policy.directives.push(directive);
}

/** The inverse of {@link appendDirective}: the predecessor inherits the removed separator. */
function removeDirective(policy: CspPolicy, directive: CspDirective): void {
  const index = policy.directives.indexOf(directive);
  if (index < 0) return;
  if (index > 0) policy.directives[index - 1].sep = directive.sep;
  policy.directives.splice(index, 1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Drops one source expression from a directive's raw text, taking the whitespace in front of it
 * with it. A textual edit rather than a re-join of the token list, so every *other* byte of the
 * directive — a double space, an odd indent an operator left in — survives untouched, and an
 * add-then-remove is exactly a no-op.
 */
function dropValue(directive: CspDirective, value: string): void {
  directive.raw = directive.raw.replace(
    new RegExp(`\\s+${escapeRegExp(value)}(?=\\s|$)`, 'g'),
    ''
  );
}

function sameValues(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((value, i) => value === sortedB[i]);
}

/**
 * Undoes {@link appendDirective} when — and only when — this directive looks like something it
 * created: it sits **last**, where an append puts things, and what is left in it is exactly what
 * `default-src` already provides, which is exactly the seed an append starts from.
 *
 * The position test is the load-bearing half, and dropping it is a bug I shipped once here. Judged
 * on redundancy alone, `default-src 'self'; connect-src 'self'; img-src *;` loses its middle
 * `connect-src` the first time the toggle is switched on and off again — a directive the operator
 * wrote, deleted by an operation that promised to be reversible. Likewise CouchDB's own
 * `script-src 'self' 'unsafe-eval'`, which sits fifth of seven: hardening it would have deleted it
 * outright, and re-allowing would have re-appended it at the end, so a policy could never survive
 * a round trip through the two switches.
 *
 * What stays ambiguous, honestly: a header whose *final* directive is a `connect-src` (or
 * `script-src`) that already merely restates `default-src`. Nothing in the string distinguishes
 * that from one this module synthesised, and it is a directive that means nothing either way.
 */
function dropIfSynthetic(policy: CspPolicy, directive: CspDirective): void {
  if (policy.directives[policy.directives.length - 1] !== directive) return;
  const fallback = findDirective(policy, DEFAULT_SRC);
  const remaining = directiveValues(directive);
  const redundant = fallback
    ? sameValues(remaining, directiveValues(fallback))
    : remaining.length === 0;
  if (redundant) removeDirective(policy, directive);
}

/**
 * The source list that governs `connect-src`, or `null` when nothing does.
 *
 * CSP's fallback chain is the entire point of this issue: CouchDB's default header has no
 * `connect-src`, so `default-src 'self'` governs instead and every cross-origin request is
 * refused before it is dispatched. `null` (neither directive present) means connections are
 * unrestricted and there is nothing to fix.
 */
export function connectSources(header: string): string[] | null {
  const policy = parseCsp(header);
  const directive = findDirective(policy, CONNECT_SRC) ?? findDirective(policy, DEFAULT_SRC);
  return directive ? directiveValues(directive) : null;
}

/** The literal source expressions of `connect-src`, or `null` when the directive is absent. */
export function connectSrcValues(header: string): string[] | null {
  const directive = findDirective(parseCsp(header), CONNECT_SRC);
  return directive ? directiveValues(directive) : null;
}

function hostSourceMatches(source: string, target: URL): boolean {
  // `scheme:` — matches any host on that scheme.
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return source.toLowerCase() === target.protocol;

  const withoutScheme = source.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(source);
  if (schemeMatch && `${schemeMatch[1].toLowerCase()}:` !== target.protocol) return false;

  const [hostPart, portPart] = withoutScheme.replace(/\/.*$/, '').split(':');
  if (portPart !== undefined && portPart !== '*' && portPart !== target.port) return false;

  const host = hostPart.toLowerCase();
  const targetHost = target.hostname.toLowerCase();
  if (host === '*') return true;
  if (host.startsWith('*.')) return targetHost.endsWith(host.slice(1));
  return host === targetHost;
}

/**
 * Whether a policy's source list already permits connections to `origin`.
 *
 * Deliberately conservative about the exotic corners of the grammar (nonces, hashes and
 * `'strict-dynamic'` mean nothing for `connect-src` and are simply not matches): the cost of a
 * false "not allowed" is one offer the operator declines, while a false "allowed" is the silent
 * "Failed to fetch" with an empty network tab that this whole feature exists to prevent.
 *
 * @param sources - from {@link connectSources}; `null` means no directive governs, so anything goes
 * @param selfOrigin - the page's own origin, so `'self'` can be judged rather than guessed
 */
export function isOriginAllowed(
  sources: string[] | null,
  origin: string,
  selfOrigin?: string
): boolean {
  if (sources === null) return true;
  let target: URL;
  try {
    target = new URL(origin);
  } catch {
    return false;
  }
  return sources.some((source) => {
    if (source === '*') return true;
    if (source === "'self'") return selfOrigin !== undefined && selfOrigin === target.origin;
    if (source.startsWith("'")) return false;
    return hostSourceMatches(source, target);
  });
}

/** The required origins this policy would refuse — the ones worth offering to add. */
export function missingOrigins(header: string, origins: string[], selfOrigin?: string): string[] {
  const sources = connectSources(header);
  return origins.filter((origin) => !isOriginAllowed(sources, origin, selfOrigin));
}

/**
 * Adds origins to `connect-src`, creating the directive **seeded from `default-src`** when it is
 * absent.
 *
 * Seeded, not invented: a header with `default-src 'self'` and no `connect-src` is already
 * allowing same-origin connections through the fallback, and writing a bare
 * `connect-src https://api.github.com` would silently take that away — the page would gain GitHub
 * and lose CouchDB. When there is no `default-src` either, connections were never restricted, so
 * there is nothing to seed from and nothing this function should be asked to do.
 */
export function addConnectSrcOrigins(header: string, origins: string[]): string {
  const policy = parseCsp(header);
  let directive = findDirective(policy, CONNECT_SRC);
  if (!directive) {
    const seed = findDirective(policy, DEFAULT_SRC);
    const seeded = seed ? directiveValues(seed) : [];
    directive = {
      name: CONNECT_SRC,
      nameRaw: CONNECT_SRC,
      raw: [CONNECT_SRC, ...seeded].join(' '),
      sep: ''
    };
    appendDirective(policy, directive);
  }
  const present = new Set(directiveValues(directive));
  for (const origin of origins) {
    if (present.has(origin)) continue;
    directive.raw += ` ${origin}`;
    present.add(origin);
  }
  return serialiseCsp(policy);
}

/**
 * Removes exactly those origins again, and — per {@link dropIfSynthetic} — drops a `connect-src`
 * that this module must have created, so the two functions compose to the identity on the header
 * the server was actually sending.
 */
export function removeConnectSrcOrigins(header: string, origins: string[]): string {
  const policy = parseCsp(header);
  const directive = findDirective(policy, CONNECT_SRC);
  if (!directive) return header;

  for (const origin of origins) dropValue(directive, origin);
  dropIfSynthetic(policy, directive);
  return serialiseCsp(policy);
}

/**
 * Whether `script-src` permits `new Function` / `eval`.
 *
 * `true` when no `script-src` and no `default-src` govern scripts at all — an unrestricted policy
 * does not forbid it. Measured, not assumed: see {@link scriptSrcAllowsEval}'s callers and
 * `scripts/smoke.mjs`, which fails the view tester outright under `script-src 'self'`.
 */
export function scriptSrcAllowsEval(header: string): boolean {
  const policy = parseCsp(header);
  const directive = findDirective(policy, SCRIPT_SRC) ?? findDirective(policy, DEFAULT_SRC);
  if (!directive) return true;
  return directiveValues(directive).includes(UNSAFE_EVAL);
}

/**
 * Adds or removes `'unsafe-eval'` on `script-src`, seeding the directive from `default-src` on the
 * same terms — and by the same rule — as {@link addConnectSrcOrigins}.
 *
 * A separate entry point on purpose. It is a separate decision with a separate consequence, and
 * folding it into the connect-src change would widen an operator's script policy without ever
 * saying so.
 */
export function setUnsafeEval(header: string, allow: boolean): string {
  const policy = parseCsp(header);
  let directive = findDirective(policy, SCRIPT_SRC);

  if (!directive) {
    if (!allow) return header;
    const seed = findDirective(policy, DEFAULT_SRC);
    directive = {
      name: SCRIPT_SRC,
      nameRaw: SCRIPT_SRC,
      raw: [SCRIPT_SRC, ...(seed ? directiveValues(seed) : [])].join(' '),
      sep: ''
    };
    appendDirective(policy, directive);
  }

  const present = directiveValues(directive).includes(UNSAFE_EVAL);
  if (allow && !present) {
    directive.raw += ` ${UNSAFE_EVAL}`;
  } else if (!allow && present) {
    dropValue(directive, UNSAFE_EVAL);
    dropIfSynthetic(policy, directive);
  }

  return serialiseCsp(policy);
}

/**
 * The origins git sync needs `connect-src` to permit — computed from the accounts that are
 * actually configured, never guessed.
 *
 * `GitHubProvider` routes an Enterprise account through `{base_url}/api/v3` and a github.com
 * account through `https://api.github.com` (`github-provider.ts`), so the origin is the account's
 * `base_url` origin, or GitHub's API host when it has none. An unparseable `base_url` is skipped
 * rather than guessed at: the account cannot work either way, and a bogus entry in a CSP is worse
 * than a missing one.
 */
export function requiredGitOrigins(accounts: { base_url?: string | null }[]): string[] {
  const origins: string[] = [];
  for (const account of accounts) {
    const configured = account.base_url?.trim();
    let origin: string;
    if (!configured) {
      origin = GITHUB_API_ORIGIN;
    } else {
      try {
        origin = new URL(configured).origin;
      } catch {
        continue;
      }
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * The `curl` from `docs/install.md`, filled in with the computed header — what a user who cannot
 * write the config hands to someone who can.
 *
 * A heredoc, exactly as the docs have it, and not `--data-binary '<json>'`: the policy contains
 * `'self'`, so a shell-single-quoted argument would end at the first apostrophe and paste as a
 * broken command. The body is `JSON.stringify`d because CouchDB's config API takes the value as a
 * bare JSON string.
 */
export function buildCspCurl(baseUrl: string, header: string): string {
  const root = baseUrl.replace(/\/+$/, '') || 'http://localhost:5984';
  return [
    'curl -u admin:password -X PUT \\',
    `  ${root}/_node/_local/_config/csp/utils_header_value \\`,
    "  -H 'Content-Type: application/json' \\",
    "  --data-binary @- <<'JSON'",
    JSON.stringify(header),
    'JSON'
  ].join('\n');
}
