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
import { toBase64Utf8, fromBase64Utf8 } from '../src/services/git/base64.js';
import { GitHubProvider, parseRepoUrl } from '../src/services/git/github-provider.js';
import { GitHttp } from '../src/services/git/git-http.js';

describe('base64 (UTF-8 safe)', () => {
  it('round-trips ASCII', () => {
    expect(fromBase64Utf8(toBase64Utf8('function(doc){ emit(doc._id, 1); }')))
      .toBe('function(doc){ emit(doc._id, 1); }');
  });

  it('round-trips non-ASCII that plain btoa would reject', () => {
    const src = 'function(doc){ if (doc.naïve) emit("日本語", "→"); }';
    expect(() => globalThis.btoa(src)).toThrow();          // documents WHY this module exists
    expect(fromBase64Utf8(toBase64Utf8(src))).toBe(src);
  });

  it('tolerates the newline-wrapped base64 the GitHub Contents API returns', () => {
    const wrapped = toBase64Utf8('hello world').replace(/(.{4})/g, '$1\n');
    expect(fromBase64Utf8(wrapped)).toBe('hello world');
  });
});

const REPO = 'https://github.com/acme/widgets';

const provider = (impl: (m: string, u: string) => unknown) => {
  const http = new GitHttp(() => 'tok');
  vi.spyOn(http, 'request').mockImplementation(
    async (m: string, u: string) => impl(m, u) as never,
  );
  return { provider: new GitHubProvider(http, null), http };
};

describe('GitHubProvider — repo URL parsing', () => {
  it('accepts the browser URL, the .git URL, and a trailing slash', async () => {
    const seen: string[] = [];
    const { provider: p } = provider((_m, u) => { seen.push(u); return { object: { sha: 'a' } }; });
    await p.headSha('https://github.com/acme/widgets', 'main');
    await p.headSha('https://github.com/acme/widgets.git', 'main');
    await p.headSha('https://github.com/acme/widgets/', 'main');
    expect(new Set(seen)).toEqual(
      new Set(['https://api.github.com/repos/acme/widgets/git/refs/heads/main']),
    );
  });

  it('routes an Enterprise host through /api/v3', async () => {
    const seen: string[] = [];
    const http = new GitHttp(() => 't');
    vi.spyOn(http, 'request').mockImplementation(async (_m, u) => {
      seen.push(u); return { object: { sha: 'a' } } as never;
    });
    await new GitHubProvider(http, 'https://github01.example.com').headSha(
      'https://github01.example.com/acme/widgets', 'main',
    );
    expect(seen[0]).toBe('https://github01.example.com/api/v3/repos/acme/widgets/git/refs/heads/main');
  });

  it('rejects a URL that is not a repository', async () => {
    const { provider: p } = provider(() => ({}));
    await expect(p.headSha('https://github.com/acme', 'main')).rejects.toThrow(/repository url/i);
  });

  // Regression coverage for the URL forms a user is realistically going to paste: GitHub's own
  // address bar while viewing a README (`?tab=readme-ov-file`), a heading anchor (`#readme`), and
  // the "Clone with SSH" button's copy target. Before the fix, each of these three leaked into the
  // slug and produced a confusing 404 from every derived API call instead of a clear error.
  it('strips a query string, so a README-view address-bar URL still resolves', async () => {
    const seen: string[] = [];
    const { provider: p } = provider((_m, u) => { seen.push(u); return { object: { sha: 'a' } }; });
    await p.headSha('https://github.com/acme/widgets?tab=readme-ov-file', 'main');
    expect(seen[0]).toBe('https://api.github.com/repos/acme/widgets/git/refs/heads/main');
  });

  it('strips a URL fragment', async () => {
    const seen: string[] = [];
    const { provider: p } = provider((_m, u) => { seen.push(u); return { object: { sha: 'a' } }; });
    await p.headSha('https://github.com/acme/widgets#readme', 'main');
    expect(seen[0]).toBe('https://api.github.com/repos/acme/widgets/git/refs/heads/main');
  });

  it('accepts the SCP-like SSH form that "Clone with SSH" copies', async () => {
    const seen: string[] = [];
    const { provider: p } = provider((_m, u) => { seen.push(u); return { object: { sha: 'a' } }; });
    await p.headSha('git@github.com:acme/widgets.git', 'main');
    expect(seen[0]).toBe('https://api.github.com/repos/acme/widgets/git/refs/heads/main');
  });

  // Regression: `.replace(/\.git$/, '')` used to run before the trailing-slash strip, so the
  // `$` anchor could never match while a slash still followed it — `.git/` survived untouched.
  it('strips both a .git suffix and a trailing slash together', async () => {
    const seen: string[] = [];
    const { provider: p } = provider((_m, u) => { seen.push(u); return { object: { sha: 'a' } }; });
    await p.headSha('https://github.com/acme/widgets.git/', 'main');
    expect(seen[0]).toBe('https://api.github.com/repos/acme/widgets/git/refs/heads/main');
  });

  it('still truncates extra path segments and ignores host case', async () => {
    const seen: string[] = [];
    const { provider: p } = provider((_m, u) => { seen.push(u); return { object: { sha: 'a' } }; });
    await p.headSha('https://github.com/acme/widgets/tree/main', 'main');
    await p.headSha('https://GITHUB.com/acme/widgets', 'main');
    expect(new Set(seen)).toEqual(
      new Set(['https://api.github.com/repos/acme/widgets/git/refs/heads/main']),
    );
  });
});

/**
 * Owner and repo case is load-bearing, and until now nothing pinned it (#6, item 23).
 *
 * `parseRepoUrl` lowercases `host` and *only* `host` (`github-provider.ts:45`), which is
 * deliberate on both counts: hostnames are case-insensitive, GitHub API **paths are not**.
 * `DesignMgmtService` (`design-mgmt-service.ts:230-233`) states the same contract from the
 * other side — the case "must survive untouched for the API calls that use it", while
 * `repoIdentity` lowercases separately, for comparison only.
 *
 * The whole existing suite uses lowercase `acme/widgets`, so every fixture in it survives a
 * `.toLowerCase()` added to the owner/repo path, and `:97` covers host case alone. These
 * three are the ones that fail: verified by temporarily returning
 * `{owner: parts[0].toLowerCase(), repo: parts[1].toLowerCase()}` from `parseRepoUrl`.
 */
describe('GitHubProvider — owner/repo case is preserved, host case is not', () => {
  it('returns owner and repo verbatim while lowercasing only the host', () => {
    expect(parseRepoUrl('https://GitHub.COM/Acme-Corp/Widgets-SDK')).toEqual({
      host: 'github.com',
      owner: 'Acme-Corp',
      repo: 'Widgets-SDK',
    });
  });

  it('carries that case into the API path, which GitHub matches case-sensitively', async () => {
    const seen: string[] = [];
    const { provider: p } = provider((_m, u) => { seen.push(u); return { object: { sha: 'a' } }; });

    await p.headSha('https://github.com/Acme-Corp/Widgets-SDK', 'main');

    expect(seen[0]).toBe('https://api.github.com/repos/Acme-Corp/Widgets-SDK/git/refs/heads/main');
  });

  // The Enterprise route builds the same slug onto a different root (`/api/v3`), so it is
  // the same invariant reached through the other branch of `apiRoot`.
  it('preserves it through the Enterprise /api/v3 root too', async () => {
    const seen: string[] = [];
    const http = new GitHttp(() => 't');
    vi.spyOn(http, 'request').mockImplementation(async (_m, u) => {
      seen.push(u); return { object: { sha: 'a' } } as never;
    });

    await new GitHubProvider(http, 'https://github01.example.com').headSha(
      'https://github01.example.com/Acme-Corp/Widgets-SDK', 'main',
    );

    expect(seen[0]).toBe(
      'https://github01.example.com/api/v3/repos/Acme-Corp/Widgets-SDK/git/refs/heads/main',
    );
  });
});

describe('GitHubProvider — reads', () => {
  it('decodes the Contents API base64 payload', async () => {
    const { provider: p } = provider(() => ({ content: toBase64Utf8('{"views":{}}'), encoding: 'base64' }));
    expect(await p.getFile(REPO, 'main', 'db/_design/x.json')).toBe('{"views":{}}');
  });

  it('returns null for a file that does not exist', async () => {
    const { provider: p } = provider(() => null);
    expect(await p.getFile(REPO, 'main', 'nope.json')).toBeNull();
  });

  it('filters the recursive tree to blobs under the directory', async () => {
    const { provider: p } = provider((_m, u) =>
      u.includes('/git/refs/')
        ? { object: { sha: 'head1' } }
        : {
            tree: [
              { path: 'root/db/_design/a.json', type: 'blob', sha: 'sa' },
              { path: 'root/db/_design', type: 'tree', sha: 'st' },
              { path: 'elsewhere/b.json', type: 'blob', sha: 'sb' },
            ],
          },
    );
    expect(await p.listTree(REPO, 'main', 'root')).toEqual([
      { path: 'root/db/_design/a.json', sha: 'sa' },
    ]);
  });

  it('treats an empty dirPath as the whole repository', async () => {
    const { provider: p } = provider((_m, u) =>
      u.includes('/git/refs/')
        ? { object: { sha: 'head1' } }
        : { tree: [{ path: 'a.json', type: 'blob', sha: 's1' }] },
    );
    expect(await p.listTree(REPO, 'main', '')).toEqual([{ path: 'a.json', sha: 's1' }]);
  });

  it('pages listRepos until a short page arrives', async () => {
    let page = 0;
    const { provider: p } = provider(() => {
      page += 1;
      return page === 1
        ? Array.from({ length: 100 }, (_, i) => ({
            full_name: `acme/r${i}`, clone_url: 'u', default_branch: 'main', private: false,
          }))
        : [{ full_name: 'acme/last', clone_url: 'u', default_branch: 'main', private: true }];
    });
    expect(await p.listRepos()).toHaveLength(101);
  });
});

// `getFile`'s null return means "git has no copy of this file" to every caller — most importantly
// Task 6's conflict classification. These pin down the cases that must NOT collapse into that
// same null, now that the encoding is inspected instead of just `content` truthiness.
describe('GitHubProvider — getFile encoding safety', () => {
  it('throws a clear "too large" error when the Contents API reports encoding: "none"', async () => {
    const { provider: p } = provider(() => ({ content: '', encoding: 'none' }));
    await expect(p.getFile(REPO, 'main', 'db/_design/huge.json'))
      .rejects.toThrow(/db\/_design\/huge\.json.*(too large|unsupported)/i);
  });

  it('still returns null for a genuine 404', async () => {
    const { provider: p } = provider(() => null);
    expect(await p.getFile(REPO, 'main', 'nope.json')).toBeNull();
  });

  it('still decodes a normal base64 payload', async () => {
    const { provider: p } = provider(() => ({ content: toBase64Utf8('{"ok":true}'), encoding: 'base64' }));
    expect(await p.getFile(REPO, 'main', 'db/_design/x.json')).toBe('{"ok":true}');
  });

  it('wraps malformed base64 in a clear error naming the path, not a raw DOMException', async () => {
    const { provider: p } = provider(() => ({ content: '%%%not-base64%%%', encoding: 'base64' }));
    await expect(p.getFile(REPO, 'main', 'db/_design/bad.json'))
      .rejects.toThrow(/db\/_design\/bad\.json/);
  });
});

/**
 * Mixed add + delete change sets in `commitFiles` (#7).
 *
 * Correct by inspection today, but the obvious "parallelise the blob uploads" refactor would
 * misalign paths to shas invisibly — every blob POST looks alike, so a `Promise.all` resolving
 * out of order would attach the wrong sha to the wrong path and still produce a valid-looking
 * commit. These pin the pairing, not just the call count.
 */
describe('GitHubProvider — commitFiles with mixed adds and deletes', () => {
  /** Records every request and answers each Git Data API step with a distinguishable sha. */
  function recordingProvider() {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const http = new GitHttp(() => 'tok');
    let blobCounter = 0;

    vi.spyOn(http, 'request').mockImplementation(
      async (method: string, url: string, opts?: { body?: unknown }) => {
        calls.push({ method, url, body: opts?.body });
        if (url.endsWith('/git/blobs')) return { sha: `blob${++blobCounter}` } as never;
        if (url.includes('/git/refs/heads/')) return { object: { sha: 'head-sha' } } as never;
        if (url.includes('/git/commits/')) return { tree: { sha: 'base-tree' } } as never;
        if (url.endsWith('/git/trees')) return { sha: 'new-tree' } as never;
        if (url.endsWith('/git/commits')) return { sha: 'new-commit' } as never;
        return {} as never;
      },
    );
    return { provider: new GitHubProvider(http, null), calls };
  }

  const treeBody = (calls: { url: string; body?: unknown }[]) =>
    calls.find((c) => c.url.endsWith('/git/trees'))!.body as {
      base_tree: string;
      tree: { path: string; sha: string | null }[];
    };

  it('uploads a blob for each add and none for the deletes', async () => {
    const { provider: p, calls } = recordingProvider();

    await p.commitFiles(REPO, 'main', 'msg', [
      { path: 'a/one.json', content: '{"one":1}' },
      { path: 'b/gone.json', content: null },
      { path: 'c/two.json', content: '{"two":2}' },
      { path: 'd/also-gone.json', content: null },
    ]);

    expect(calls.filter((c) => c.url.endsWith('/git/blobs'))).toHaveLength(2);
  });

  it('pairs each path with ITS OWN blob sha, and nulls only the deletes', async () => {
    const { provider: p, calls } = recordingProvider();

    await p.commitFiles(REPO, 'main', 'msg', [
      { path: 'a/one.json', content: '{"one":1}' },
      { path: 'b/gone.json', content: null },
      { path: 'c/two.json', content: '{"two":2}' },
    ]);

    // blob1 belongs to one.json and blob2 to two.json — swapping them would still be
    // "two blobs and one null", which is exactly why this asserts the pairing.
    expect(treeBody(calls).tree).toEqual([
      { path: 'a/one.json', mode: '100644', type: 'blob', sha: 'blob1' },
      { path: 'b/gone.json', mode: '100644', type: 'blob', sha: null },
      { path: 'c/two.json', mode: '100644', type: 'blob', sha: 'blob2' },
    ]);
  });

  it('sends each blob the content belonging to its own path', async () => {
    const { provider: p, calls } = recordingProvider();

    await p.commitFiles(REPO, 'main', 'msg', [
      { path: 'a/one.json', content: 'ONE' },
      { path: 'b/gone.json', content: null },
      { path: 'c/two.json', content: 'TWO' },
    ]);

    const blobs = calls
      .filter((c) => c.url.endsWith('/git/blobs'))
      .map((c) => fromBase64Utf8((c.body as { content: string }).content));
    expect(blobs).toEqual(['ONE', 'TWO']);
  });

  it('builds on the parent commit tree and the branch head', async () => {
    const { provider: p, calls } = recordingProvider();

    await p.commitFiles(REPO, 'main', 'the message', [{ path: 'x.json', content: '{}' }]);

    expect(treeBody(calls).base_tree).toBe('base-tree');
    const commit = calls.find((c) => c.url.endsWith('/git/commits') && c.method === 'POST')!;
    expect(commit.body).toEqual({ message: 'the message', tree: 'new-tree', parents: ['head-sha'] });
  });

  it('advances the branch ref without forcing', async () => {
    const { provider: p, calls } = recordingProvider();

    await p.commitFiles(REPO, 'main', 'msg', [{ path: 'x.json', content: '{}' }]);

    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('https://api.github.com/repos/acme/widgets/git/refs/heads/main');
    expect(patch.body).toEqual({ sha: 'new-commit', force: false });
  });

  it('commits a delete-only change set without uploading any blob', async () => {
    const { provider: p, calls } = recordingProvider();

    await p.commitFiles(REPO, 'main', 'msg', [{ path: 'b/gone.json', content: null }]);

    expect(calls.filter((c) => c.url.endsWith('/git/blobs'))).toHaveLength(0);
    expect(treeBody(calls).tree).toEqual([
      { path: 'b/gone.json', mode: '100644', type: 'blob', sha: null },
    ]);
  });

  it('refuses an empty change set rather than making an empty commit', async () => {
    const { provider: p } = recordingProvider();

    await expect(p.commitFiles(REPO, 'main', 'msg', [])).rejects.toThrow(/no changes/i);
  });
});
