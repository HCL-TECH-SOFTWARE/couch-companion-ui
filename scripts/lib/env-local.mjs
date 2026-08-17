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

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads `.env.local` (gitignored, human-created) into `process.env`.
 *
 * Deliberately not Node's `--env-file` flag: CI sets real env vars and has no `.env.local` to
 * point at, and wiring the flag into the npm script would make a credential-gated suite fail
 * outright on a machine without the file rather than degrading to the (correct) skip.
 * Deliberately not a dependency (e.g. `dotenv`) either — this repo takes no new runtime or dev
 * dependencies for a dozen lines of `KEY=value` parsing.
 *
 * A variable already present in `process.env` (a real CI secret, or the shell) wins over the
 * file — `.env.local` only fills gaps, never overrides.
 *
 * Shared by both credential-gated harnesses: `test/e2e/global-setup.ts` (vitest `globalSetup`,
 * which runs this before test files are spawned so its `process.env` mutations are inherited) and
 * `scripts/spa-check.mjs`, which is plain Node with no vitest around it at all. One parser,
 * because two would drift and the second one's drift would look like a missing credential.
 *
 * @param cwd - directory to look in; defaults to the process's own
 */
export function loadEnvLocal(cwd = process.cwd()) {
  const path = resolve(cwd, '.env.local');
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
