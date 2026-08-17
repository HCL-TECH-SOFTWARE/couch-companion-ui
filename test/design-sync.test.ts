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
import {
  designDocRepoPath, ddocIdFromPath, serializeDdoc, sameContent, classify, resolveUnknown, canApply,
} from '../src/services/git/design-sync.js';

describe('designDocRepoPath', () => {
  it('builds <root>/<db>/_design/<name>.json', () => {
    expect(designDocRepoPath('ddocs', 'sales', '_design/reports'))
      .toBe('ddocs/sales/_design/reports.json');
  });
  it('omits the root when it is empty', () => {
    expect(designDocRepoPath('', 'sales', '_design/reports')).toBe('sales/_design/reports.json');
  });
  it('tolerates leading and trailing slashes on the root', () => {
    expect(designDocRepoPath('/ddocs/', 'sales', 'reports')).toBe('ddocs/sales/_design/reports.json');
  });
});

describe('ddocIdFromPath', () => {
  it('recovers the ddoc id', () => {
    expect(ddocIdFromPath('ddocs/sales/_design/reports.json')).toBe('_design/reports');
  });
  it('ignores a file that is not a design doc', () => {
    expect(ddocIdFromPath('ddocs/sales/README.md')).toBeNull();
  });
  it('round-trips with designDocRepoPath', () => {
    expect(ddocIdFromPath(designDocRepoPath('r', 'db', '_design/x'))).toBe('_design/x');
  });
});

describe('serializeDdoc', () => {
  it('strips CouchDB metadata so a rev bump is not a content change', () => {
    const json = serializeDdoc({ _id: '_design/x', _rev: '3-c', _revisions: {}, views: {} });
    expect(JSON.parse(json)).toEqual({ views: {} });
  });
  it('pretty-prints, so a repo diff is readable', () => {
    expect(serializeDdoc({ views: { a: { map: 'f' } } })).toContain('\n  ');
  });
  it('orders keys stably, so re-serializing the same doc yields the same bytes', () => {
    expect(serializeDdoc({ b: 1, a: 2 })).toBe(serializeDdoc({ a: 2, b: 1 }));
  });
});

describe('sameContent', () => {
  it('ignores _id, _rev and _revisions on both sides', () => {
    expect(sameContent(
      { _id: 'x', _rev: '1-a', views: { v: { map: 'f' } } },
      { _id: 'x', _rev: '9-z', _revisions: {}, views: { v: { map: 'f' } } },
    )).toBe(true);
  });
  it('is insensitive to key order', () => {
    expect(sameContent({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
  it('sees a changed map function', () => {
    expect(sameContent({ views: { v: { map: 'f' } } }, { views: { v: { map: 'g' } } })).toBe(false);
  });
  it('is sensitive to array order, which matters in a design doc', () => {
    expect(sameContent({ list: [1, 2] }, { list: [2, 1] })).toBe(false);
  });
});

describe('classify', () => {
  const base = { couchRev: '2-b', gitSha: 'sha2', syncedRev: '2-b', syncedSha: 'sha2', contentEqual: true };

  it('says synced when neither side moved', () => {
    expect(classify(base)).toBe('synced');
  });
  it('says newer_in_couch when only the document moved', () => {
    expect(classify({ ...base, couchRev: '3-c', contentEqual: false })).toBe('newer_in_couch');
  });
  it('says newer_in_git when only the file moved', () => {
    expect(classify({ ...base, gitSha: 'sha3', contentEqual: false })).toBe('newer_in_git');
  });
  it('says conflict when both moved and the content differs', () => {
    expect(classify({ ...base, couchRev: '3-c', gitSha: 'sha3', contentEqual: false }))
      .toBe('conflict');
  });
  it('does NOT call it a conflict when both moved to the same content', () => {
    expect(classify({ ...base, couchRev: '3-c', gitSha: 'sha3', contentEqual: true })).toBe('synced');
  });
  it('says unknown when there is no sync record yet', () => {
    expect(classify({ ...base, syncedRev: null, syncedSha: null })).toBe('unknown');
  });
  it('says newer_in_couch for a document that git has never seen', () => {
    expect(classify({ couchRev: '1-a', gitSha: null, syncedRev: null, syncedSha: null, contentEqual: false }))
      .toBe('newer_in_couch');
  });
  it('says newer_in_git for a file CouchDB has never seen', () => {
    expect(classify({ couchRev: null, gitSha: 'sha1', syncedRev: null, syncedSha: null, contentEqual: false }))
      .toBe('newer_in_git');
  });
  // Documents classify()'s dual meaning for 'unknown': it also covers a document present on
  // NEITHER side, not just "both sides have a version, no history". resolveUnknown must never be
  // handed this case directly (fix round 2, NEW-1) — callers gate on presence first.
  it('also says unknown when the document exists on neither side and there is no sync record', () => {
    expect(classify({ couchRev: null, gitSha: null, syncedRev: null, syncedSha: null, contentEqual: false }))
      .toBe('unknown');
  });
});

describe('resolveUnknown', () => {
  it('folds unknown + agreeing content into synced — safe either way, nothing to write', () => {
    expect(resolveUnknown('unknown', true)).toBe('synced');
  });
  it('folds unknown + disagreeing content into conflict — no basis to pick a winner', () => {
    expect(resolveUnknown('unknown', false)).toBe('conflict');
  });
  it('leaves every other status untouched regardless of contentEqual', () => {
    expect(resolveUnknown('synced', false)).toBe('synced');
    expect(resolveUnknown('newer_in_couch', true)).toBe('newer_in_couch');
    expect(resolveUnknown('newer_in_git', true)).toBe('newer_in_git');
    expect(resolveUnknown('conflict', true)).toBe('conflict');
  });
});

describe('canApply', () => {
  it('synced may be applied in either direction', () => {
    expect(canApply('synced', 'toRepo')).toBe(true);
    expect(canApply('synced', 'toCouch')).toBe(true);
  });
  it('conflict may never be applied', () => {
    expect(canApply('conflict', 'toRepo')).toBe(false);
    expect(canApply('conflict', 'toCouch')).toBe(false);
  });
  it('newer_in_couch may only push to the repo, not pull from it', () => {
    expect(canApply('newer_in_couch', 'toRepo')).toBe(true);
    expect(canApply('newer_in_couch', 'toCouch')).toBe(false);
  });
  it('newer_in_git may only pull into CouchDB, not push over it', () => {
    expect(canApply('newer_in_git', 'toCouch')).toBe(true);
    expect(canApply('newer_in_git', 'toRepo')).toBe(false);
  });
  it('defensively refuses a raw unknown in either direction', () => {
    expect(canApply('unknown', 'toRepo')).toBe(false);
    expect(canApply('unknown', 'toCouch')).toBe(false);
  });
});
