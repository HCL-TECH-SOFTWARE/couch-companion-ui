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

import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../src/services/git/github-provider.js';
import { GitHttp } from '../src/services/git/git-http.js';
import { fromBase64Utf8 } from '../src/services/git/base64.js';

const REPO = 'https://github.com/acme/widgets';

/** Records every call and answers each Git Data endpoint with a plausible response. */
const recorder = () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const http = new GitHttp(() => 'tok');
  vi.spyOn(http, 'request').mockImplementation(async (method, url, opts) => {
    calls.push({ method, url, body: opts?.body });
    if (url.includes('/git/refs/heads/') && method === 'GET') return { object: { sha: 'HEAD1' } } as never;
    if (url.endsWith('/git/blobs')) return { sha: `blob-${calls.length}` } as never;
    if (url.includes('/git/commits/HEAD1')) return { tree: { sha: 'TREE0' } } as never;
    if (url.endsWith('/git/trees')) return { sha: 'TREE1' } as never;
    if (url.endsWith('/git/commits')) return { sha: 'COMMIT1' } as never;
    if (method === 'PATCH') return { object: { sha: 'COMMIT1' } } as never;
    return null as never;
  });
  return { http, calls, provider: new GitHubProvider(http, null) };
};

describe('GitHubProvider.commitFiles', () => {
  it('walks ref -> blob -> base commit -> tree -> commit -> ref update, in order', async () => {
    const { provider, calls } = recorder();
    const result = await provider.commitFiles(REPO, 'main', 'msg', [
      { path: 'db/_design/a.json', content: '{"a":1}' },
    ]);
    expect(calls.map((c) => `${c.method} ${c.url.split('/git/')[1] ?? c.url}`)).toEqual([
      'GET refs/heads/main', 'POST blobs', 'GET commits/HEAD1', 'POST trees', 'POST commits',
      'PATCH refs/heads/main',
    ]);
    expect(result).toEqual({
      commit_sha: 'COMMIT1',
      file_shas: [{ path: 'db/_design/a.json', blob_sha: 'blob-2' }],
    });
  });

  it('puts every change in ONE tree, so N docs make ONE commit', async () => {
    const { provider, calls } = recorder();
    await provider.commitFiles(REPO, 'main', 'msg', [
      { path: 'a.json', content: '{"a":1}' },
      { path: 'b.json', content: '{"b":2}' },
      { path: 'c.json', content: '{"c":3}' },
    ]);
    expect(calls.filter((c) => c.url.endsWith('/git/commits') && c.method === 'POST')).toHaveLength(1);
    const tree = calls.find((c) => c.url.endsWith('/git/trees'))?.body as { tree: unknown[] };
    expect(tree.tree).toHaveLength(3);
  });

  it('encodes content as UTF-8 base64 and marks the tree entry as a 100644 blob', async () => {
    const { provider, calls } = recorder();
    await provider.commitFiles(REPO, 'main', 'msg', [{ path: 'a.json', content: '{"k":"日本語"}' }]);
    const blob = calls.find((c) => c.url.endsWith('/git/blobs'))?.body as
      { content: string; encoding: string };
    expect(blob.encoding).toBe('base64');
    expect(fromBase64Utf8(blob.content)).toBe('{"k":"日本語"}');
    const tree = calls.find((c) => c.url.endsWith('/git/trees'))?.body as
      { tree: { mode: string; type: string; sha: string }[] };
    expect(tree.tree[0]).toMatchObject({ mode: '100644', type: 'blob' });
  });

  it('expresses a deletion as a null tree sha and creates no blob for it', async () => {
    const { provider, calls } = recorder();
    await provider.commitFiles(REPO, 'main', 'msg', [{ path: 'gone.json', content: null }]);
    expect(calls.filter((c) => c.url.endsWith('/git/blobs'))).toHaveLength(0);
    const tree = calls.find((c) => c.url.endsWith('/git/trees'))?.body as
      { tree: { path: string; sha: string | null }[] };
    expect(tree.tree[0]).toEqual({ path: 'gone.json', mode: '100644', type: 'blob', sha: null });
  });

  it('bases the new tree on the parent commit tree so untouched files survive', async () => {
    const { provider, calls } = recorder();
    await provider.commitFiles(REPO, 'main', 'msg', [{ path: 'a.json', content: '{}' }]);
    const tree = calls.find((c) => c.url.endsWith('/git/trees'))?.body as { base_tree: string };
    expect(tree.base_tree).toBe('TREE0');
  });

  it('parents the commit on the previous HEAD and never force-updates the ref', async () => {
    const { provider, calls } = recorder();
    await provider.commitFiles(REPO, 'main', 'my message', [{ path: 'a.json', content: '{}' }]);
    const commit = calls.find((c) => c.url.endsWith('/git/commits') && c.method === 'POST')?.body as
      { message: string; parents: string[]; tree: string };
    expect(commit).toEqual({ message: 'my message', tree: 'TREE1', parents: ['HEAD1'] });
    const patch = calls.find((c) => c.method === 'PATCH')?.body as { sha: string; force: boolean };
    expect(patch).toEqual({ sha: 'COMMIT1', force: false });
  });

  it('refuses an empty change set rather than creating an empty commit', async () => {
    const { provider, calls } = recorder();
    await expect(provider.commitFiles(REPO, 'main', 'msg', [])).rejects.toThrow(/no changes/i);
    expect(calls).toHaveLength(0);
  });
});
