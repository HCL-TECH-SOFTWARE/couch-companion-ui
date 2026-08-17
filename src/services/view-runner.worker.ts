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
 * The Worker entry point for the view tester: unpacks a {@link RunRequest}, runs it through
 * {@link runMapReduce}, and posts the {@link RunResult} back.
 *
 * This is a real bundler entry point, imported by `view-runner-host.ts` with Vite's `?worker`
 * suffix, so the runner reaches the Worker as a normal module graph. It replaces an earlier
 * scheme that built the Worker body by concatenating `Function.prototype.toString()` of each
 * helper and appending a hand-written string literal that called `runMapReduce` *by name*
 * (#30): minification renamed the functions but not the literal, so every production build's
 * Worker died on `ReferenceError: runMapReduce is not defined` — invisible to the unit suite,
 * which runs unminified and under a happy-dom that has no `Worker` at all.
 */

import { runMapReduce } from './view-runner.js';
import type { RunRequest, RunResult } from './view-runner.js';

/**
 * The two members of `DedicatedWorkerGlobalScope` this file uses. `lib.webworker.d.ts` is not on
 * tsconfig's `lib` list and cannot be added next to `DOM` without a wall of duplicate-global
 * errors, so the shape is declared structurally instead — narrowly, and typed on both ends:
 * `RunRequest` is the same interface `view-runner-host.ts` builds its `postMessage` payload
 * from, so a field renamed on either side is a compile error rather than a silent `undefined`
 * arriving here at runtime.
 */
interface ViewRunnerScope {
  onmessage: ((event: MessageEvent<RunRequest>) => void) | null;
  postMessage(result: RunResult): void;
}

const scope = self as unknown as ViewRunnerScope;

scope.onmessage = (event) => {
  const { mapSource, docs, reduceSource } = event.data;
  scope.postMessage(runMapReduce(mapSource, docs, reduceSource));
};
