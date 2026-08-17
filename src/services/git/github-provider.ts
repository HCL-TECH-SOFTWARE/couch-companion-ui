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

import { GitHttp } from './git-http.js';
import { fromBase64Utf8, toBase64Utf8 } from './base64.js';
import type {
  AccountInfo, CommitResult, FileChange, GitProvider, ProviderRepo, TreeEntry,
} from './git-provider.js';

const PAGE_SIZE = 100;

/**
 * `https://host/owner/repo(.git)(/)` -> `{host, owner, repo}`. Strips a query string or fragment
 * (GitHub's own address bar shows `?tab=readme-ov-file` while viewing a README, and a heading
 * anchor is a normal thing to paste) and accepts the SCP-like SSH form GitHub's "Clone with SSH"
 * button copies — `git@host:owner/repo.git`, or `ssh://git@host/owner/repo.git`. Extra path
 * segments (e.g. a pasted `/tree/<branch>` URL) still truncate to the first two.
 *
 * Exported (not just `GitHubProvider`-private) because `DesignMgmtService.registerRepo` needs the
 * same parsing to dedupe repositories by identity rather than by raw URL string equality — two
 * URLs differing only by a `.git` suffix or a trailing slash must resolve to one registration, not
 * two (Task 5, IMPORTANT 2).
 *
 * `host` is lowercased and stripped of any `user@` prefix — the SCP form's regex already captures
 * a bare host (`git@host:owner/repo` -> `host`), but the `scheme://user@host/...` form's does not
 * (`ssh://git@host/owner/repo` would otherwise yield `host === "git@host"`), and the two spellings
 * of the same host should still compare equal. Every real caller in this codebase only ever
 * registers the `https://` `clone_url` a provider's API returns, so this normalization matters
 * more for correctness-in-principle than for a case anything here actually exercises today.
 */
export function parseRepoUrl(repoUrl: string): { host: string; owner: string; repo: string } {
  const withoutQueryOrFragment = repoUrl.split(/[?#]/)[0];
  // The SCP-like form (`git@host:owner/repo.git`) has no `//` after a scheme for the strip
  // below to find — peel it off first, then fall through to the shared owner/repo extraction.
  const scpMatch = withoutQueryOrFragment.match(/^[^@\s/]+@([^:/]+):(.+)$/);
  const hostMatch = withoutQueryOrFragment.match(/^[a-z]+:\/\/([^/]+)\//i);
  const path = (scpMatch ? scpMatch[2] : withoutQueryOrFragment.replace(/^[a-z]+:\/\/[^/]+\//i, ''))
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Not a repository URL: ${repoUrl}`);
  }
  const rawHost = scpMatch?.[1] ?? hostMatch?.[1] ?? '';
  const host = rawHost.replace(/^[^@]+@/, '').toLowerCase();
  return { host, owner: parts[0], repo: parts[1] };
}

/**
 * GitHub for github.com and Enterprise. Reads use the Contents API for single files and the Git
 * Data API for trees; writes (Task 2) use the Git Data API throughout so a multi-file sync lands
 * as one commit rather than one commit per file.
 */
export class GitHubProvider implements GitProvider {
  /** @param baseUrl Enterprise host (`https://ghe.example.com`), or null for github.com. */
  constructor(
    private readonly http: GitHttp,
    private readonly baseUrl: string | null,
  ) {}

  private get apiRoot(): string {
    return this.baseUrl ? `${this.baseUrl.replace(/\/+$/, '')}/api/v3` : 'https://api.github.com';
  }

  private slug(repoUrl: string): string {
    const { owner, repo } = parseRepoUrl(repoUrl);
    return `${owner}/${repo}`;
  }

  private repoApi(repoUrl: string): string {
    return `${this.apiRoot}/repos/${this.slug(repoUrl)}`;
  }

  async whoami(): Promise<AccountInfo> {
    const user = await this.http.request<{ login: string; name: string | null }>(
      'GET', `${this.apiRoot}/user`,
    );
    return { login: user?.login ?? '', name: user?.name ?? null };
  }

  async listRepos(): Promise<ProviderRepo[]> {
    const all: ProviderRepo[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.http.request<ProviderRepo[]>(
        'GET', `${this.apiRoot}/user/repos?per_page=${PAGE_SIZE}&page=${page}&type=all`,
      );
      if (!batch?.length) break;
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return all;
  }

  async listBranches(repoUrl: string): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.http.request<{ name: string }[]>(
        'GET', `${this.repoApi(repoUrl)}/branches?per_page=${PAGE_SIZE}&page=${page}`,
      );
      if (!batch?.length) break;
      names.push(...batch.map((b) => b.name));
      if (batch.length < PAGE_SIZE) break;
    }
    return names;
  }

  async headSha(repoUrl: string, branch: string): Promise<string> {
    const ref = await this.http.request<{ object: { sha: string } }>(
      'GET', `${this.repoApi(repoUrl)}/git/refs/heads/${encodeURIComponent(branch)}`,
    );
    if (!ref?.object?.sha) throw new Error(`Branch not found: ${branch}`);
    return ref.object.sha;
  }

  async getFile(repoUrl: string, branch: string, path: string): Promise<string | null> {
    const file = await this.http.request<{ content?: string; encoding?: string }>(
      'GET',
      `${this.repoApi(repoUrl)}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
      { allowNotFound: true },
    );
    if (!file) return null;
    // The Contents API silently switches to `encoding: "none"` with an empty `content` for files
    // at or above ~1MB. That is "too large to read this way", not "the file does not exist" —
    // conflating the two would tell a caller (Task 6's conflict classification) that git has no
    // copy of a design doc it actually has, and risk overwriting it.
    if (file.encoding !== undefined && file.encoding !== 'base64') {
      throw new Error(
        `${path}: too large or unsupported for the GitHub Contents API (encoding: "${file.encoding}")`,
      );
    }
    if (!file.content) return null;
    try {
      return fromBase64Utf8(file.content);
    } catch (cause) {
      throw new Error(`${path}: could not decode base64 content returned by GitHub`, { cause });
    }
  }

  async listTree(repoUrl: string, branch: string, dirPath: string): Promise<TreeEntry[]> {
    const head = await this.headSha(repoUrl, branch);
    const tree = await this.http.request<{ tree: { path: string; type: string; sha: string }[] }>(
      'GET', `${this.repoApi(repoUrl)}/git/trees/${head}?recursive=1`,
    );
    const prefix = dirPath.replace(/^\/+|\/+$/g, '');
    return (tree?.tree ?? [])
      .filter((e) => e.type === 'blob' && (!prefix || e.path.startsWith(`${prefix}/`) || e.path === prefix))
      .map((e) => ({ path: e.path, sha: e.sha }));
  }

  /**
   * Commits every change as a single commit through the Git Data API.
   *
   * The six calls are the price of atomicity: the Contents API would need one commit per file,
   * so a five-document sync that failed halfway would leave a repository whose history claims a
   * sync happened that did not. Here the ref moves once, at the end, or not at all.
   *
   * `force: false` on the ref update means a branch that moved underneath us is rejected by
   * GitHub rather than overwritten.
   */
  async commitFiles(
    repoUrl: string,
    branch: string,
    message: string,
    changes: FileChange[],
  ): Promise<CommitResult> {
    if (!changes.length) throw new Error('Cannot commit: no changes were supplied.');

    const api = this.repoApi(repoUrl);
    const headSha = await this.headSha(repoUrl, branch);

    const fileShas: { path: string; blob_sha: string }[] = [];
    const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];

    for (const change of changes) {
      if (change.content === null) {
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const blob = await this.http.request<{ sha: string }>('POST', `${api}/git/blobs`, {
        body: { content: toBase64Utf8(change.content), encoding: 'base64' },
      });
      if (!blob?.sha) throw new Error(`GitHub did not return a blob sha for ${change.path}`);
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
      fileShas.push({ path: change.path, blob_sha: blob.sha });
    }

    const base = await this.http.request<{ tree: { sha: string } }>(
      'GET', `${api}/git/commits/${headSha}`,
    );
    if (!base?.tree?.sha) throw new Error('GitHub did not return the parent commit tree.');

    const newTree = await this.http.request<{ sha: string }>('POST', `${api}/git/trees`, {
      body: { base_tree: base.tree.sha, tree },
    });
    if (!newTree?.sha) throw new Error('GitHub did not return a tree sha.');

    const commit = await this.http.request<{ sha: string }>('POST', `${api}/git/commits`, {
      body: { message, tree: newTree.sha, parents: [headSha] },
    });
    if (!commit?.sha) throw new Error('GitHub did not return a commit sha.');

    await this.http.request('PATCH', `${api}/git/refs/heads/${encodeURIComponent(branch)}`, {
      body: { sha: commit.sha, force: false },
    });

    return { commit_sha: commit.sha, file_shas: fileShas };
  }
}

/** Percent-encodes each segment while leaving the separators intact. */
const encodePath = (path: string): string =>
  path.split('/').map(encodeURIComponent).join('/');
