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

/** One file in a repository tree. */
export interface TreeEntry {
  path: string;
  sha: string;
}

/** One file to write in a commit. `content: null` deletes the path. */
export interface FileChange {
  path: string;
  content: string | null;
}

export interface CommitResult {
  commit_sha: string;
  /** Per-path blob SHAs. GitHub returns these; other providers may not. */
  file_shas: { path: string; blob_sha: string }[];
}

export interface AccountInfo {
  login: string;
  name: string | null;
}

export interface ProviderRepo {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  description?: string;
}

/**
 * Provider-neutral git operations. GitHub is the only implementation in v1 (D11); the interface
 * exists so GitLab/Bitbucket can return without touching the sync flows that consume it.
 */
export interface GitProvider {
  whoami(): Promise<AccountInfo>;
  listRepos(): Promise<ProviderRepo[]>;
  listBranches(repoUrl: string): Promise<string[]>;
  headSha(repoUrl: string, branch: string): Promise<string>;
  /** `null` when the path does not exist on that branch. */
  getFile(repoUrl: string, branch: string, path: string): Promise<string | null>;
  listTree(repoUrl: string, branch: string, dirPath: string): Promise<TreeEntry[]>;
  commitFiles(
    repoUrl: string,
    branch: string,
    message: string,
    changes: FileChange[],
  ): Promise<CommitResult>;
}
