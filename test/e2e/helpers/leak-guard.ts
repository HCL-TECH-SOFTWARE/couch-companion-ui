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

import { Logger, Level } from '../../../src/services/log-service.js';

const LEVELS = [Level.TRACE, Level.DEBUG, Level.INFO, Level.WARN, Level.ERROR, Level.FATAL] as const;

type LogTargetFn = (...data: unknown[]) => void;

/**
 * Fails the run the instant a guarded secret (a real GitHub PAT, a real JWT) reaches a log line.
 *
 * This replaces every entry of `Logger.logTarget` (the object `Logger.<level>()` reads from on
 * every call — see `src/services/log-service.ts`'s `actualOutput`), not `console.debug` itself.
 * That distinction is load-bearing: Phase 5's final review found a *vacuous* version of this
 * assertion that `vi.spyOn(console, 'debug')`'d instead — `Logger.logTarget` had already captured
 * `console.debug` **by reference** at module load, so replacing the global `console.debug`
 * afterwards left the logger still calling the original function; the spy never saw a call and
 * the assertion "passed" without checking anything. `test/git-credential-store.test.ts`'s
 * `withStore failure handling` describe block is the verified-correct pattern this mirrors:
 * assign directly onto `Logger.logTarget[level]`.
 *
 * Secrets are registered via {@link LeakGuard.watch} rather than all up front, because the JWT
 * this suite guards isn't known until `beforeAll` fetches one from Keycloak — the git token is
 * watched the moment it's read from `process.env`, and the JWT is added right after it arrives.
 */
export interface LeakGuard {
  /** Registers a secret; every subsequent log line is scanned for it. A no-op for `''`/`undefined`
   *  so callers can pass a not-yet-known value without an `if` at every call site. */
  watch(secret: string | null | undefined): void;
  /** Restores every original `Logger.logTarget` entry this guard replaced. */
  restore(): void;
}

export function installLeakGuard(): LeakGuard {
  const secrets = new Set<string>();
  const originals = new Map<number, LogTargetFn | undefined>();

  for (const level of LEVELS) {
    originals.set(level, Logger.logTarget[level]);
    const original = Logger.logTarget[level];
    Logger.logTarget[level] = (...args: unknown[]) => {
      const rendered = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      for (const secret of secrets) {
        if (rendered.includes(secret)) {
          throw new Error(
            `Leak guard: a log line at level ${level} contained a guarded secret. The secret ` +
              'itself is not shown here; find the call site via the stack trace.',
          );
        }
      }
      original?.(...args);
    };
  }

  return {
    watch(secret) {
      if (secret) secrets.add(secret);
    },
    restore() {
      for (const level of LEVELS) {
        Logger.logTarget[level] = originals.get(level);
      }
    },
  };
}
