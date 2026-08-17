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

import { describe, it, expect } from 'vitest';
import { runMapReduce } from '../src/services/view-runner.js';

describe('runMapReduce — map', () => {
  it('collects emitted key/value pairs', () => {
    const r = runMapReduce('function(doc){ emit(doc.name, doc.age); }',
      [{ _id: 'a', name: 'Ada', age: 36 }, { _id: 'b', name: 'Bob', age: 41 }]);
    expect(r.error).toBeNull();
    expect(r.rows).toEqual([
      { id: 'a', key: 'Ada', value: 36 },
      { id: 'b', key: 'Bob', value: 41 },
    ]);
  });

  it('keeps every emit from a document that emits more than once', () => {
    const r = runMapReduce('function(doc){ for (const t of doc.tags) emit(t, 1); }',
      [{ _id: 'a', tags: ['x', 'y', 'z'] }]);
    expect(r.rows).toHaveLength(3);
  });

  it('skips documents the function chooses not to emit for', () => {
    const r = runMapReduce('function(doc){ if (doc.ok) emit(doc._id, 1); }',
      [{ _id: 'a', ok: true }, { _id: 'b', ok: false }]);
    expect(r.rows).toEqual([{ id: 'a', key: 'a', value: 1 }]);
  });

  it('defaults a missing emit value to null, as CouchDB does', () => {
    expect(runMapReduce('function(doc){ emit(doc._id); }', [{ _id: 'a' }]).rows[0].value).toBeNull();
  });

  it('sorts rows by key, as a real view does', () => {
    const r = runMapReduce('function(doc){ emit(doc.n, 1); }',
      [{ _id: 'a', n: 3 }, { _id: 'b', n: 1 }, { _id: 'c', n: 2 }]);
    expect(r.rows.map((row) => row.key)).toEqual([1, 2, 3]);
  });

  it('reports a syntax error instead of throwing', () => {
    const r = runMapReduce('function(doc){ emit(', [{ _id: 'a' }]);
    expect(r.rows).toEqual([]);
    expect(r.error).toMatch(/unexpected|syntax/i);
  });

  it('names the offending document when the function throws at runtime', () => {
    const r = runMapReduce('function(doc){ emit(doc.missing.deep, 1); }', [{ _id: 'boom' }]);
    expect(r.error).toContain('boom');
  });

  it('rejects a source that is not a function', () => {
    expect(runMapReduce('42', [{ _id: 'a' }]).error).toMatch(/function/i);
  });

  it('leaves the input documents untouched even if the function mutates its argument', () => {
    const docs = [{ _id: 'a', n: 1 }];
    runMapReduce('function(doc){ doc.n = 999; emit(doc._id, doc.n); }', docs);
    expect(docs[0].n).toBe(1);
  });
});

describe('runMapReduce — reduce', () => {
  it('supports the _count builtin', () => {
    const r = runMapReduce('function(doc){ emit(doc.g, 1); }',
      [{ _id: 'a', g: 'x' }, { _id: 'b', g: 'x' }, { _id: 'c', g: 'y' }], '_count');
    expect(r.rows).toEqual([{ id: '', key: 'x', value: 2 }, { id: '', key: 'y', value: 1 }]);
  });

  it('supports the _sum builtin', () => {
    const r = runMapReduce('function(doc){ emit(doc.g, doc.n); }',
      [{ _id: 'a', g: 'x', n: 5 }, { _id: 'b', g: 'x', n: 7 }], '_sum');
    expect(r.rows[0].value).toBe(12);
  });

  // `_stats` had exactly one test, and it lived in view-runner-host.test.ts as a side effect of
  // proving that the old Worker-blob reconstruction included `statsFor`. That reconstruction is
  // gone (#30); the behaviour it incidentally covered is not, so it is asserted here directly.
  it('supports the _stats builtin', () => {
    const r = runMapReduce('function(doc){ emit(doc.g, doc.n); }',
      [{ _id: 'a', g: 'x', n: 2 }, { _id: 'b', g: 'x', n: 4 }], '_stats');
    expect(r.error).toBeNull();
    expect(r.rows[0].value).toEqual({ sum: 6, count: 2, min: 2, max: 4, sumsqr: 20 });
  });

  it('runs a custom reduce function grouped by key', () => {
    const r = runMapReduce('function(doc){ emit(doc.g, doc.n); }',
      [{ _id: 'a', g: 'x', n: 2 }, { _id: 'b', g: 'x', n: 3 }],
      'function(keys, values, rereduce){ return Math.max.apply(null, values); }');
    expect(r.rows[0].value).toBe(3);
  });

  it('reports a broken reduce without losing the map result', () => {
    const r = runMapReduce('function(doc){ emit(doc._id, 1); }', [{ _id: 'a' }], 'function(){ throw new Error("nope"); }');
    expect(r.error).toMatch(/reduce/i);
    expect(r.rows).toHaveLength(1);
  });

  it('keeps the map rows when a circular emit key breaks reduce grouping, instead of losing them', () => {
    // groupRowsByKey (inside applyReduce) groups by JSON.stringify(key); a circular key throws
    // there. That must not unwind out of applyReduce/runMapReduce and discard the already-computed
    // map rows — a working map paired with an exotic reduce key should still show its map output.
    const r = runMapReduce('function(doc){ var o={}; o.self=o; emit(o,1); }', [{ _id: 'a' }], '_count');
    expect(r.error).toMatch(/circular/i);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ id: 'a', value: 1 });
  });

  // Fix round 2, IMPORTANT: _approx_count_distinct (every 3.x server) and the _first/_last/
  // _top_*/_bottom_* family (3.5+, offered by view-editor.ts's own reduce dropdown) are real
  // CouchDB builtins this preview does not implement. Before this fix they fell through to
  // `new Function('return (_approx_count_distinct)')`, which throws a bare ReferenceError the
  // instant it runs — reported as "Could not compile the reduce function," telling the user their
  // valid design doc is broken. It is not.
  describe('recognized-but-unsimulated builtins', () => {
    const cases = [
      '_approx_count_distinct',
      '_first',
      '_last',
      '_top_1',
      '_top_10',
      '_top_100',
      '_bottom_1',
      '_bottom_10',
      '_bottom_100'
    ];

    for (const builtin of cases) {
      it(`names "${builtin}" as an unsimulated builtin, not a compile error, and keeps the map rows`, () => {
        const r = runMapReduce('function(doc){ emit(doc._id, 1); }', [{ _id: 'a' }, { _id: 'b' }], builtin);
        expect(r.rows).toHaveLength(2);
        expect(r.error).toContain(builtin);
        expect(r.error).not.toMatch(/could not compile/i);
        expect(r.error).not.toMatch(/is not defined/i);
      });
    }
  });
});
