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
 * Pure execution core for CouchDB view map/reduce functions — no DOM, no Worker, no I/O. Every
 * export here is synchronous and its only side effects are the array pushes inside `emit`, which
 * is why this file is directly unit-testable under vitest/happy-dom (see `test/view-runner.test.ts`)
 * even though happy-dom implements no `Worker` at all.
 *
 * CouchDB 3 answers `POST /{db}/_temp_view` with `410 gone` ("Temporary views are not supported in
 * CouchDB"), so there is no server-side way to try a map function — this runs the real thing in
 * the browser instead. The backend this fork replaces never ran the function either: it checked
 * that the source started with `function`, contained `emit`, and had balanced braces, then
 * returned a canned "[preview] doc N would be processed" string. Users have never seen a real
 * result before this.
 *
 * `src/services/view-runner.worker.ts` imports {@link runMapReduce} from here as an ordinary
 * module, so this file has no special authoring rules: it reaches the Worker through the bundler's
 * module graph like any other import. Until #30 the Worker body was instead reconstructed from
 * `Function.prototype.toString()` of each helper, which imposed several (no arrow `const`s, no
 * module-scope references from anything stringified) — and broke in every minified build anyway,
 * because a bundler renames the functions but not the string literal that called them.
 */

/** One key/value pair emitted by a map function, or produced by a reduce group. */
export interface RunResultRow {
  key: unknown;
  value: unknown;
  id: string;
}

export interface RunResult {
  rows: RunResultRow[];
  error: string | null;
}

/**
 * The message `view-runner-host.ts` posts to `view-runner.worker.ts`.
 *
 * Declared here, in the module both of them already import, so the two ends are pinned to one
 * another by the type checker: rename a field on either side and the build fails, instead of
 * `runMapReduce` quietly receiving `undefined` for the map source on every real Worker run. (That
 * hazard used to be guarded by a test that executed the hand-written glue against a fake `self`;
 * with the glue gone, the compiler covers it.)
 */
export interface RunRequest {
  mapSource: string;
  docs: unknown[];
  reduceSource: string | null;
}

type EmitFn = (key?: unknown, value?: unknown) => void;

/** Renders any thrown value into a readable message — map/reduce source can throw a non-Error. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Deep-clones a document before it is handed to a map function, so a map function that mutates
 * its `doc` argument cannot corrupt the caller's copy. This is real CouchDB behavior — each map
 * invocation runs against its own copy of the document — not just defensive cloning.
 */
export function cloneDoc(doc: unknown): unknown {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(doc);
    } catch {
      // Falls through to the JSON round-trip — structuredClone rejects values (functions, etc.)
      // that a CouchDB document, being plain JSON, never actually contains anyway.
    }
  }
  return JSON.parse(JSON.stringify(doc));
}

/**
 * Approximates CouchDB's view-collation type ordering — null/undefined < boolean < number <
 * string < array < object — well enough for a preview's row order. This is NOT a reimplementation
 * of CouchDB's real (ICU-based) collation: in particular, string comparisons here will not always
 * agree with a live view's actual row order.
 */
export function typeRank(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 2;
  if (typeof value === 'string') return 3;
  if (Array.isArray(value)) return 4;
  return 5;
}

/** Comparator backing the row sort — see {@link typeRank} for what "approximates" means here. */
export function compareCouchKeys(a: unknown, b: unknown): number {
  const rankA = typeRank(a);
  const rankB = typeRank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (rankA === 0) return 0;
  if (rankA === 1) return Number(a) - Number(b);
  if (rankA === 2) return (a as number) - (b as number);
  if (rankA === 3) {
    const sa = a as string;
    const sb = b as string;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  if (rankA === 4) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    const len = Math.min(aa.length, bb.length);
    for (let i = 0; i < len; i++) {
      const cmp = compareCouchKeys(aa[i], bb[i]);
      if (cmp !== 0) return cmp;
    }
    return aa.length - bb.length;
  }
  // Objects: no ordering opinion beyond same-rank grouping — good enough for a preview.
  return 0;
}

/** Groups rows by their emitted key, exact-value (via JSON serialization), preserving first-seen order. */
export function groupRowsByKey(rows: RunResultRow[]): { key: unknown; rows: RunResultRow[] }[] {
  const order: string[] = [];
  const byKey = new Map<string, { key: unknown; rows: RunResultRow[] }>();
  for (const row of rows) {
    const groupKey = JSON.stringify(row.key);
    let group = byKey.get(groupKey);
    if (!group) {
      group = { key: row.key, rows: [] };
      byKey.set(groupKey, group);
      order.push(groupKey);
    }
    group.rows.push(row);
  }
  return order.map((k) => byKey.get(k) as { key: unknown; rows: RunResultRow[] });
}

/** CouchDB's `_stats` builtin reduce shape. Non-numeric values are ignored rather than coerced. */
export function statsFor(values: unknown[]): { sum: number; count: number; min: number; max: number; sumsqr: number } {
  const numeric = values.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));
  return {
    sum: numeric.reduce((acc, v) => acc + v, 0),
    count: numeric.length,
    min: numeric.length ? Math.min(...numeric) : 0,
    max: numeric.length ? Math.max(...numeric) : 0,
    sumsqr: numeric.reduce((acc, v) => acc + v * v, 0)
  };
}

/**
 * Applies a reduce step to already-map()ped, key-sorted rows.
 *
 * Builtins (`_count`, `_sum`, `_stats`) group by the emitted key and need no compilation. A
 * custom reduce source is compiled once and invoked ONCE PER KEY GROUP as `(keys, values,
 * false)` — `keys` is the CouchDB-shaped array of `[key, id]` pairs for that group. **Rereduce is
 * never simulated** (`rereduce` is always `false`); a reduce function that relies on being
 * re-invoked over its own prior output — CouchDB's actual batching behavior — will not see that
 * second pass here, only the single per-group call a small in-browser preview can offer.
 *
 * Also recognizes, but does not implement, the rest of CouchDB's builtin reduces —
 * `_approx_count_distinct` (every 3.x server) and the `_first`/`_last`/`_top_*`/`_bottom_*` family
 * (3.5+), exactly what the reduce picker's dropdown (`view-editor.ts`'s `BUILTINS_35`) offers and
 * persists onto the document. None of those are ordinary JavaScript — `new Function('return (' +
 * reduceSource + ')')` on a bare `_approx_count_distinct` throws `ReferenceError:
 * _approx_count_distinct is not defined` the instant the factory runs, which would read as "Could
 * not compile the reduce function" — i.e. *your design doc is broken*. It is not: it is a valid,
 * server-side-only builtin this small preview does not simulate, so it is checked for and named
 * honestly before the compile attempt ever sees it, with the map rows passed through unreduced.
 *
 * On a genuine reduce failure — grouping (see below), compile, or runtime — the ORIGINAL map rows
 * are returned unchanged, with `error` naming the problem: a broken reduce must not hide an
 * otherwise-working map. This is also what keeps {@link runMapReduce} itself genuinely
 * never-throwing: every exit out of this function is a `return`, never an unwind.
 */
export function applyReduce(mapRows: RunResultRow[], reduceSource: string): RunResult {
  // Grouping is not exempt from that "never throws" guarantee even though it runs before any
  // reduce-specific logic: it calls JSON.stringify on whatever the map function emitted as a key,
  // and a circular reference (or a BigInt) throws there uncaught. Without this try/catch, that
  // throw would unwind straight out of applyReduce (and runMapReduce) with the already-computed
  // map rows lost — the two-path host (view-runner-host.ts) would then have nothing to recover,
  // and a user with a perfectly working map function would see no rows at all over one exotic key.
  let groups: { key: unknown; rows: RunResultRow[] }[];
  try {
    groups = groupRowsByKey(mapRows).sort((a, b) => compareCouchKeys(a.key, b.key));
  } catch (err) {
    return { rows: mapRows, error: `Could not group rows for reduce: ${describeError(err)}` };
  }

  if (reduceSource === '_count') {
    return { rows: groups.map((g) => ({ key: g.key, value: g.rows.length, id: '' })), error: null };
  }
  if (reduceSource === '_sum') {
    // Non-numeric values are ignored (substituted with 0) rather than coerced or rejected — real
    // CouchDB's _sum throws on a non-numeric value, and sums arrays elementwise. Both are
    // deliberately not reproduced here; this is a preview simplification, not a reimplementation.
    return {
      rows: groups.map((g) => ({
        key: g.key,
        value: g.rows.reduce((acc, r) => acc + (typeof r.value === 'number' ? r.value : 0), 0),
        id: ''
      })),
      error: null
    };
  }
  if (reduceSource === '_stats') {
    return {
      rows: groups.map((g) => ({ key: g.key, value: statsFor(g.rows.map((r) => r.value)), id: '' })),
      error: null
    };
  }
  const unsimulatedBuiltins = new Set([
    '_approx_count_distinct',
    '_first',
    '_last',
    '_top_1',
    '_top_10',
    '_top_100',
    '_bottom_1',
    '_bottom_10',
    '_bottom_100'
  ]);
  if (unsimulatedBuiltins.has(reduceSource)) {
    return {
      rows: mapRows,
      error:
        `"${reduceSource}" is a valid CouchDB builtin reduce function, but this in-browser preview ` +
        'does not simulate it — showing the unreduced map rows below.'
    };
  }

  let reduceFn: (keys: [unknown, string][], values: unknown[], rereduce: boolean) => unknown;
  try {
    const factory = new Function('return (' + reduceSource + ');') as unknown as () => unknown;
    const compiled = factory();
    if (typeof compiled !== 'function') {
      return { rows: mapRows, error: 'The reduce source must evaluate to a function, or one of _count/_sum/_stats.' };
    }
    reduceFn = compiled as unknown as typeof reduceFn;
  } catch (err) {
    return { rows: mapRows, error: `Could not compile the reduce function: ${describeError(err)}` };
  }

  const reduced: RunResultRow[] = [];
  for (const group of groups) {
    try {
      const keys: [unknown, string][] = group.rows.map((r) => [r.key, r.id]);
      const values = group.rows.map((r) => r.value);
      const value = reduceFn(keys, values, false);
      reduced.push({ key: group.key, value: value === undefined ? null : value, id: '' });
    } catch (err) {
      return { rows: mapRows, error: `Reduce function threw: ${describeError(err)}` };
    }
  }
  return { rows: reduced, error: null };
}

/**
 * Compiles and runs a map function (and, optionally, a reduce step) against sample documents.
 *
 * The map source is compiled as `new Function('emit', 'return (' + source + ')')` so that a bare
 * `function(doc) {...}` expression parses — a plain `new Function(source)` treats its body as
 * statements, not an expression, and throws on exactly this shape — and so `emit` is a real
 * parameter of that wrapper, not a global the user's own source could shadow.
 *
 * A per-document error is caught and named by that document's `_id`; the remaining documents
 * still run (mirroring CouchDB itself, which drops only the one document a map function fails on,
 * not the whole view) — only the first such error is reported, since a preview only needs to say
 * which map function is broken, not enumerate every document it fails on.
 */
export function runMapReduce(mapSource: string, docs: unknown[], reduceSource?: string | null): RunResult {
  const rows: RunResultRow[] = [];
  let currentId = '';
  const emit: EmitFn = (key, value) => {
    rows.push({ key: key === undefined ? null : key, value: value === undefined ? null : value, id: currentId });
  };

  let mapFn: (doc: unknown) => void;
  try {
    const factory = new Function('emit', 'return (' + mapSource + ');') as unknown as (fn: EmitFn) => unknown;
    const compiled = factory(emit);
    if (typeof compiled !== 'function') {
      return { rows: [], error: 'The map source must evaluate to a function, e.g. function(doc) { ... }.' };
    }
    mapFn = compiled as (doc: unknown) => void;
  } catch (err) {
    return { rows: [], error: `Could not compile the map function: ${describeError(err)}` };
  }

  let firstError: string | null = null;
  for (const doc of docs) {
    const rawId = (doc as { _id?: unknown } | null)?._id;
    currentId = typeof rawId === 'string' ? rawId : '';
    try {
      mapFn(cloneDoc(doc));
    } catch (err) {
      if (!firstError) {
        firstError = `Map function threw on document "${currentId || '(unknown id)'}": ${describeError(err)}`;
      }
    }
  }

  rows.sort((a, b) => compareCouchKeys(a.key, b.key));

  if (firstError) {
    // Considered and deliberately left as-is: real CouchDB would still reduce over whatever rows
    // the surviving documents produced. Skipping that here (a broken map is terminal, even with a
    // reduce configured) is a cosmetic simplification for a preview tool — reporting a reduce
    // result computed over a row set the map function itself is known to have failed on seemed
    // more likely to confuse than help, but it is a real, intentional gap from "mirrors CouchDB."
    return { rows, error: firstError };
  }
  if (!reduceSource) {
    return { rows, error: null };
  }
  return applyReduce(rows, reduceSource);
}
