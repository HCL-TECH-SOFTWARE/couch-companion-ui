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

import { defineConfig, coverageConfigDefaults } from 'vitest/config';
// This config deliberately does not extend vite.config.ts, so the one alias the app cannot build
// without has to be repeated here. monaco-css.ts holds the single definition and the reason.
import { monacoCssAlias, monacoCssPlugin } from './monaco-css.js';

export default defineConfig({
  // The same stylesheet transform the app builds with, so what the tests read is what ships:
  // test/cca-monaco-editor.test.ts asserts the codicon @font-face is gone and the real rules are
  // not. Without the plugin here that assertion would be about a string nobody sends.
  plugins: [monacoCssPlugin],
  resolve: {
    alias: [...monacoCssAlias]
  },
  // lit's `node` condition hardcodes isServer=true, disabling Web Awesome's interactive listeners under tests;
  // `browser` picks the interactive build, the mode placeholder keeps lit's dev diagnostics.
  ssr: {
    resolve: {
      conditions: ['browser', 'development|production']
    }
  },
  test: {
    environment: 'happy-dom',
    /*
     * Vitest stubs CSS imports to the empty string unless told otherwise, which would make
     * test/cca-monaco-editor.test.ts's stylesheet assertions vacuously green — "no @font-face" is
     * trivially true of "". Just Monaco's own sheet is processed, the one monacoCssPlugin strips
     * the codicon font out of, so those assertions are about the string the component really
     * inlines. Everything else stays stubbed, which is what keeps the suite fast.
     */
    css: { include: [/editor\.main\.css/] },
    include: ['test/**/*.test.ts'],
    // The on-demand real-GitHub/real-CouchDB E2E suite (test/e2e/**, run via `npm run test:e2e`,
    // config in vitest.e2e.config.ts) must never run as part of the default `npm test` gate —
    // it needs real credentials and does real network I/O, and `npm test` is the merge gate
    // every contributor (and CI) runs with none. Without this, `test/e2e/*.e2e.test.ts` would
    // still match the `include` glob above and run twice: once here (uncredentialed, skipping
    // itself) and once under its own config.
    exclude: ['test/e2e/**'],
    globals: false,
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      // text -> job logs, json-summary -> parsed for the GitHub step summary,
      // html -> full report uploaded as a workflow artifact
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      exclude: [...coverageConfigDefaults.exclude, 'src/transports/**'],
      thresholds: {
        // Ratchet floor just under the current baseline to block regressions.
        // Raise toward 70% as coverage improves. branches/functions are not
        // gated yet (branch coverage is still ~55%).
        lines: 65,
        statements: 65
      }
    }
  }
});
