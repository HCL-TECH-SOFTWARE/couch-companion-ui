#!/usr/bin/env node
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
 * Post-build budget gate: what a browser must download before it can paint anything.
 *
 * WHY THIS EXISTS. `vite.config.ts` carried a `manualChunks` rule from the initial commit that
 * put the whole Monaco editor — 1,388,409 B gzip — into the entry graph, so every visitor
 * downloaded and executed it before the login screen, on every screen with no editor on it. It
 * survived the entire life of the project because nothing here measures shipped bytes: `npm run
 * check` compiles and tests source, and `scripts/smoke.mjs` asserts behaviour, not size. A
 * regression of that shape is invisible to every other gate we have (#150).
 *
 * WHAT IT ASSERTS. Two things, because a byte ceiling on its own is a weak signal — it says
 * something got bigger, never what:
 *
 *   1. The eager set stays under its ceiling, raw and gzipped.
 *   2. No Monaco chunk is in the eager set at all. That is the specific regression, stated
 *      directly: reinstate any rule that names Monaco into a shared chunk and this fails by name
 *      rather than by arithmetic.
 *
 * WHAT COUNTS AS EAGER. Exactly what `dist/index.html` tells the browser to fetch up front: the
 * module `<script>`, every `<link rel=modulepreload>` (Vite emits those for the entry's static
 * import graph and nothing else), and every `<link rel=stylesheet>`. Lazily imported chunks —
 * route plugins, Monaco, its grammars — are reached through `import()` and appear in none of
 * those, which is the entire point.
 *
 * BASELINE. Measured on the build that removed the chunking rule: 779,775 B raw / 167,059 B gzip
 * across four files. The ceilings below sit above that with room for ordinary growth; they are
 * not a target to grow into. Moving one is a decision to ship more bytes to every visitor, so
 * move it deliberately, in a commit that says why, and not to make a red gate green.
 *
 * USAGE
 *   node scripts/bundle-budget.mjs           assert against dist/
 *   node scripts/bundle-budget.mjs --dir X   assert against another build directory
 *   node scripts/bundle-budget.mjs --report  print the numbers and exit 0, asserting nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fail, usageFrom } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Measured 167,059 B on the build that removed the chunking rule. Read the header before moving. */
const EAGER_GZIP_MAX = 220_000;
/** Measured 779,775 B on the same build. Parse and compile cost, which gzip does not describe. */
const EAGER_RAW_MAX = 1_000_000;

/**
 * Chunk names that must never appear in the eager set. Vite names a chunk after the module it is
 * anchored on, so all three spellings this has been seen under — the old manual chunk
 * (`monaco-editor-*.js`), Monaco's own API entry (`editor.api-*.js`) and our component
 * (`cca-monaco-editor-*.js`) — match.
 */
const FORBIDDEN_EAGER = /monaco|editor\.api/i;

function parseArgs(argv) {
  const opts = { dir: path.join(ROOT, 'dist'), report: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dir':
        opts.dir = path.resolve(argv[++i] ?? fail('--dir needs a directory'));
        break;
      case '--report':
        opts.report = true;
        break;
      case '-h':
      case '--help':
        // Anchored on the text, not on line numbers — see scripts/smoke.mjs for why.
        process.stdout.write(usageFrom(import.meta.url));
        process.exit(0);
        break;
      default:
        fail(`unknown argument ${argv[i]} (try --help)`);
    }
  }
  return opts;
}

/**
 * The entry document's own references, in document order and de-duplicated.
 *
 * A regex and not a parser: the file is Vite's own output, every reference it emits is a plain
 * double-quoted attribute, and a dependency for this would be a dependency in the merge gate.
 */
function eagerRefs(html) {
  const refs = new Set();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) refs.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\brel="(modulepreload|stylesheet)"[^>]*>/g)) {
    const href = /\bhref="([^"]+)"/.exec(m[0]);
    if (href) refs.add(href[1]);
  }
  return [...refs].filter((r) => !/^(https?:)?\/\//.test(r));
}

const opts = parseArgs(process.argv.slice(2));
const indexHtml = path.join(opts.dir, 'index.html');
if (!fs.existsSync(indexHtml)) fail(`${path.relative(ROOT, indexHtml)} is missing — run \`npx vite build\` first`);

const html = fs.readFileSync(indexHtml, 'utf8');
const files = [];
for (const ref of eagerRefs(html)) {
  const file = path.join(opts.dir, ref.replace(/^\.?\//, ''));
  if (!fs.existsSync(file)) fail(`index.html references ${ref}, which is not in the build`);
  const bytes = fs.readFileSync(file);
  files.push({ ref, raw: bytes.length, gz: zlib.gzipSync(bytes, { level: 6 }).length });
}
if (files.length === 0) fail('index.html references no scripts or stylesheets at all — is this a build?');

files.sort((a, b) => b.gz - a.gz);
const totalRaw = files.reduce((n, f) => n + f.raw, 0);
const totalGz = files.reduce((n, f) => n + f.gz, 0);
const n = (v) => v.toLocaleString('en-US').padStart(11);

process.stdout.write(`\neager set — what ${path.relative(ROOT, indexHtml)} fetches before first paint\n\n`);
for (const f of files) process.stdout.write(`${n(f.raw)} raw ${n(f.gz)} gz  ${f.ref}\n`);
process.stdout.write(`${n(totalRaw)} raw ${n(totalGz)} gz  ${files.length} files\n\n`);

if (opts.report) process.exit(0);

const forbidden = files.filter((f) => FORBIDDEN_EAGER.test(path.basename(f.ref)));
if (forbidden.length > 0) {
  fail(
    `Monaco is in the eager set again: ${forbidden.map((f) => f.ref).join(', ')}.\n` +
      'The editor must stay behind a dynamic import, reached when a screen that has one opens.\n' +
      'The usual cause is a `manualChunks` rule naming it into a shared chunk — see #150 and the\n' +
      'comment above `build:` in vite.config.ts.'
  );
}
if (totalGz > EAGER_GZIP_MAX || totalRaw > EAGER_RAW_MAX) {
  fail(
    `the eager set is over budget: ${totalRaw.toLocaleString('en-US')} raw / ` +
      `${totalGz.toLocaleString('en-US')} gz, against a ceiling of ` +
      `${EAGER_RAW_MAX.toLocaleString('en-US')} raw / ${EAGER_GZIP_MAX.toLocaleString('en-US')} gz.\n` +
      'Something now loads before first paint that should load when it is needed. Find what joined\n' +
      'the entry graph before raising the ceiling — see the header of scripts/bundle-budget.mjs.'
  );
}

process.stdout.write(
  `\x1b[32mwithin budget: ${totalGz.toLocaleString('en-US')} B gzip of a permitted ` +
    `${EAGER_GZIP_MAX.toLocaleString('en-US')}, and no Monaco on the critical path.\x1b[0m\n`
);
