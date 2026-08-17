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

import { defineConfig, loadEnv, type Plugin } from 'vite';
import path from 'path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { icons as waSystemIcons } from '@awesome.me/webawesome/dist/components/icon/library.system.js';
// Monaco 0.56's exports map hides its own stylesheet; monaco-css.ts explains and resolves it.
import { monacoCssAlias, monacoCssPlugin } from './monaco-css.js';
import { assertMonacoImports } from './monaco-imports.js';

/*
 * Fails the build — and `vite dev` — if src/monaco-registrations.ts has drifted from what
 * monaco-editor actually ships: a specifier that no longer resolves, or a feature the package
 * added that we neither register nor deny. Both are silent at runtime, which is why they are
 * checked here rather than trusted. See monaco-imports.ts and #148.
 */
assertMonacoImports();

/**
 * Web Awesome's `themes/awesome.css` fetches Quicksand and Crimson Pro from fonts.bunny.net.
 * Couch Companion ships on-prem and may run air-gapped, so no third-party request may survive
 * into the bundle. Web Awesome documents no way to opt out, and overriding the
 * `--wa-font-family-*` tokens does not help — the `@import` fires regardless of whether anything
 * uses the fonts. Drop it here; `src/styles/awesome-fonts.css` serves the same two families from
 * `@fontsource-variable/*` instead. See #738.
 */
const stripRemoteImports = {
  postcssPlugin: 'cca-strip-remote-imports',
  AtRule: {
    import: (rule: { params: string; remove: () => void }) => {
      if (/^(url\(\s*)?['"]?(https?:)?\/\//i.test(rule.params.trim())) {
        rule.remove();
      }
    }
  }
};

/**
 * Web Awesome ships no SVG files, so its default icon library fetches every `<wa-icon>` from
 * `ka-f.fontawesome.com` at runtime. Couch Companion ships on-prem and may run air-gapped, so no
 * third-party request may survive into the bundle. Unlike the font `@import` above, Web Awesome
 * offers a supported opt-out — `setIconPath()`, called in `src/icons.ts` — which points its stock
 * resolver at `{path}/{folder}/{name}.svg`. This plugin puts the Font Awesome Free SVGs there:
 * copied into the build output, and served from node_modules in dev so both behave alike.
 *
 * We ship the whole set rather than the icons we can find in source, because icon names are runtime
 * data: an admin types any Font Awesome name into the banner icon field, `wa-page` renders `bars`
 * inside its own shadow DOM, and names like `tasks`/`x` are FA5 aliases. A curated allowlist would
 * miss all three — and it would fail silently, since the server's SPA fallback answers a missing
 * icon with index.html and HTTP 200 rather than a 404. See #741.
 */
const require = createRequire(import.meta.url);
const FA_SVG_DIR = path.join(
  path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json')),
  'svgs'
);
const ICON_ROUTE = 'icons';

/**
 * Web Awesome's *system* library — the icons its own components render: the `wa-select` chevron,
 * the tick on a selected `wa-option`, the eye on a password `wa-input`, the × on `wa-dialog` — is
 * a second, separate problem from the default library above, and the fix above does not touch it.
 * `setIconPath()` only redirects the *default* resolver. The system resolver hard-codes its SVGs
 * as `data:` URIs, and `<wa-icon>` retrieves every icon with `fetch` — including those. A `fetch`
 * of a `data:` URI is governed by `connect-src`, falling back to `default-src`, and CouchDB serves
 * `/_utils` with `default-src 'self'` and no `connect-src` at all. So on the drop-in — the primary
 * deployment target (D4) — every internal Web Awesome icon is blocked, silently: no console error
 * that reads as an icon problem, no broken-image placeholder, just controls with no icons. See
 * #140.
 *
 * Web Awesome's documented escape hatch is to re-register the `system` library with a resolver of
 * one's own, and then "it's your responsibility to provide all of the icons that are required by
 * components". So we serve them as files from our own origin, the same way and from the same route
 * as the default library's, and `src/icons.ts` points a `system` resolver at them.
 *
 * PROVIDING ALL OF THEM IS THE WHOLE JOB, so the set is not transcribed — it is read out of the
 * vendored package itself, from the very object the stock resolver looks names up in. A Web
 * Awesome upgrade that adds, renames or re-partitions a system icon therefore changes what this
 * build emits, with no list here to fall out of date. One file per entry, at the same
 * `{variant}/{name}` coordinates the resolver uses, so `src/icons.ts` needs no manifest: the URL
 * it derives from that same object always names a file this emitted.
 */
const SYSTEM_ICON_DIR = 'system';

function systemIconFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const [variant, collection] of Object.entries(waSystemIcons)) {
    for (const [name, svg] of Object.entries(collection)) {
      files.set(`${variant}/${name}.svg`, svg);
    }
  }
  // An upgrade that reshapes this export must break the build, not quietly ship an app whose
  // internal icons are all blank — which is the failure mode being fixed and is invisible.
  if (!files.has('regular/circle-question.svg') || files.size < 20) {
    throw new Error(
      "@awesome.me/webawesome's system icon library is not the shape this build expects: got " +
        `${files.size} icons in variants [${Object.keys(waSystemIcons).join(', ')}]. ` +
        'Re-read dist/components/icon/library.system.js and update systemIconFiles(). See #140.'
    );
  }
  // These are written into the same tree as the Font Awesome SVGs, so a `system` family appearing
  // upstream would have half its icons silently overwritten by ours.
  if (fs.existsSync(path.join(FA_SVG_DIR, SYSTEM_ICON_DIR))) {
    throw new Error(
      `@fortawesome/fontawesome-free now ships svgs/${SYSTEM_ICON_DIR}/, which collides with the ` +
        "Web Awesome system icons served under the same route. Move one of them. See #140."
    );
  }
  return files;
}

const SYSTEM_ICONS = systemIconFiles();

const localIcons: Plugin = {
  name: 'cca-local-icons',

  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0];
      if (!url.startsWith(`/${ICON_ROUTE}/`)) return next();
      const rel = decodeURIComponent(url.slice(ICON_ROUTE.length + 2));

      // Served from memory, not from disk: in dev nothing has written them anywhere.
      if (rel.startsWith(`${SYSTEM_ICON_DIR}/`)) {
        const svg = SYSTEM_ICONS.get(rel.slice(SYSTEM_ICON_DIR.length + 1));
        if (svg === undefined) return next();
        res.setHeader('Content-Type', 'image/svg+xml');
        res.end(svg);
        return;
      }

      // path.resolve normalizes away `..`; the prefix check keeps the request inside FA_SVG_DIR.
      const file = path.resolve(FA_SVG_DIR, rel);
      if (!file.startsWith(FA_SVG_DIR + path.sep) || !fs.existsSync(file)) return next();

      res.setHeader('Content-Type', 'image/svg+xml');
      fs.createReadStream(file).pipe(res);
    });
  },

  writeBundle(options) {
    const outDir = options.dir;
    if (!outDir) return;
    fs.cpSync(FA_SVG_DIR, path.join(outDir, ICON_ROUTE), { recursive: true });
    for (const [rel, svg] of SYSTEM_ICONS) {
      const file = path.join(outDir, ICON_ROUTE, SYSTEM_ICON_DIR, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, svg);
    }
  }
};

/**
 * Opt-in dev forwarder: serve the app from Vite, send everything else to a CouchDB.
 *
 *     CCA_DEV_COUCH=https://couchdb.example.net npm run dev
 *
 * Unset — the default — nothing here runs and `npm run dev` behaves as before: the
 * app talks to a CouchDB cross-origin, which is **SPA mode, a shipped deployment**
 * (D5). That path must keep working and must keep being exercised; this forwarder
 * is a convenience for working on unrelated features without a CORS-configured
 * server, never a substitute for making SPA mode correct.
 *
 * With it set, `localhost:5173` answers for both the app and the database, so the
 * app detects **same-origin** mode (`GET /_up` now succeeds) and takes the `/_utils`
 * drop-in code path — the primary target (D4) — while HMR keeps working.
 *
 * "Forward whatever Vite 404s" is not implementable: Vite's SPA fallback answers
 * any request accepting `*​/*` with `index.html`, so an unknown path never reaches
 * a later middleware — it comes back as HTML, which is how `GET /_idp` produced
 * `SyntaxError: Unexpected token '<'`. So this runs *before* Vite's middlewares and
 * inverts the test: it forwards everything except the URLs Vite owns.
 */
function couchForward(origin: string | undefined): Plugin | false {
  if (!origin) return false;

  // A wrong value must not fail silently: the app would simply stay in SPA mode and
  // the only symptom is the login screen still asking for a server, which looks like
  // the forwarder is unsupported rather than misconfigured.
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(
      `CCA_DEV_COUCH must be a full CouchDB URL, got ${JSON.stringify(origin)} — ` +
        `for example CCA_DEV_COUCH=https://couchdb.example.net`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`CCA_DEV_COUCH must be http(s), got ${JSON.stringify(origin)}`);
  }

  // Anything Vite serves itself. `/@` covers @vite/client, @id/, @fs/; `/__` covers
  // the internal endpoints. Public files are read from disk so adding one to
  // `public/` does not silently start forwarding it to CouchDB.
  const VITE_PREFIXES = [/^\/@/, /^\/src\//, /^\/node_modules\//, /^\/__/, /^\/icons\//];
  const publicDir = path.join(import.meta.dirname, 'public');
  const viteFiles = new Set([
    '/index.html',
    '/global.css',
    ...(fs.existsSync(publicDir) ? fs.readdirSync(publicDir).map((f) => `/${f}`) : [])
  ]);

  /**
   * `/` is the one genuinely ambiguous path: it is both the app's HTML entry point
   * and CouchDB's welcome document, which `ServerMgmtService` reads for the version
   * and vendor tiles. The real drop-in has no such clash — the app is served from
   * `/_utils/` and CouchDB's root is `/` — so this collision is created by the
   * forwarder and has to be resolved by it.
   *
   * Resolve on intent, not path: a browser navigation asks for a document, an
   * `ApiClient` call does not. `Sec-Fetch-Dest` is the direct signal; the `Accept`
   * sniff is a fallback for clients that omit it (curl, older browsers).
   */
  const wantsDocument = (req: { headers: Record<string, unknown> }) =>
    req.headers['sec-fetch-dest'] === 'document' ||
    String(req.headers.accept ?? '').includes('text/html');

  return {
    name: 'cca-dev-couch-forward',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '/';
        const pathOnly = url.split('?')[0];
        // WebSocket upgrades never reach connect middleware, but if one ever did,
        // forwarding it would break HMR silently.
        if (req.headers.upgrade) return next();
        if (pathOnly === '/') {
          if (wantsDocument(req as { headers: Record<string, unknown> })) return next();
        } else if (viteFiles.has(pathOnly) || VITE_PREFIXES.some((re) => re.test(pathOnly))) {
          return next();
        }

        void (async () => {
          const target = new URL(url, origin);
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined || key.startsWith(':')) continue;
            headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          // The target is usually a virtual host behind an ingress that routes on Host.
          headers.set('host', target.host);

          const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
          const upstream = await fetch(target, {
            method: req.method,
            headers,
            redirect: 'manual',
            ...(hasBody ? { body: req as unknown as ReadableStream, duplex: 'half' } : {})
          } as RequestInit);

          res.statusCode = upstream.status;
          upstream.headers.forEach((value, key) => {
            // fetch has already decompressed; forwarding the original framing headers
            // would describe a body that no longer exists.
            if (key === 'content-encoding' || key === 'content-length') return;
            if (key === 'set-cookie') return;
            res.setHeader(key, value);
          });

          // The page is plain http on localhost, so a cookie marked Secure — or
          // SameSite=None, which browsers reject without Secure — would be dropped
          // silently, i.e. login succeeds and the next request is anonymous.
          // Same-origin needs neither attribute, so strip both.
          const cookies = upstream.headers
            .getSetCookie()
            .map((c) =>
              c
                .split(';')
                .filter((part) => !/^\s*(secure|samesite\s*=)/i.test(part))
                .join(';')
            );
          if (cookies.length > 0) res.setHeader('set-cookie', cookies);

          const body = Buffer.from(await upstream.arrayBuffer());
          res.end(body);
        })().catch((err: unknown) => {
          server.config.logger.error(
            `[cca-dev-couch-forward] ${req.method} ${req.url} -> ${String(err)}`
          );
          if (!res.headersSent) res.statusCode = 502;
          res.end();
        });
      });
    }
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  // `loadEnv` with an empty prefix so the variable can live in `.env.local` next to
  // the E2E settings. `process.env` alone would only see it when passed inline,
  // which is not where anyone looks first. It is read here, not in the plugin, so
  // the plugin stays a pure function of its argument.
  plugins: [
    localIcons,
    monacoCssPlugin,
    couchForward(loadEnv(mode, import.meta.dirname, '').CCA_DEV_COUCH || process.env.CCA_DEV_COUCH)
  ],
  css: {
    postcss: {
      plugins: [stripRemoteImports]
    }
  },
  resolve: {
    alias: [...monacoCssAlias]
  },
  optimizeDeps: {
    // The API entry, which is what the app imports — `monaco-editor` itself is no longer imported
    // anywhere, so prebundling it would optimize a module nothing loads. Everything else Monaco
    // needs arrives through src/monaco-registrations.ts and is picked up by Vite's own crawl of
    // the source, into the same optimize pass, which is what keeps one shared copy of the editor
    // registry in dev. Two copies would mean the registrations landing on a registry the editor
    // does not read — features silently absent, in dev only.
    include: ['monaco-editor/editor']
  },
  worker: {
    format: 'es'
  },
  /*
   * DELIBERATELY NO `manualChunks`. This carried one from the initial commit —
   *
   *     manualChunks: (id) => id.includes('monaco-editor') ? 'monaco-editor' : undefined
   *
   * — and it cost 1,405,570 B gzip on every first paint, three ways at once (#150):
   *
   *   - `id.includes('monaco-editor')` also matches `src/components/cca-monaco-editor.ts`, so our
   *     own component landed in the vendor chunk and dragged prettier (597 kB) in with it.
   *   - One forced chunk defeats Monaco's own lazy loading: every grammar is registered as
   *     `loader: () => import('./javascript.js')`, and jsonMode/tsMode load the same way. Named
   *     into one chunk, all of it becomes eager.
   *   - That chunk then held shared modules (Lit among them), so the *entry* chunk statically
   *     imported it and index.html modulepreloaded 1.39 MB gzip of Monaco — on the login screen,
   *     on every screen with no editor on it.
   *
   * Left to itself the bundler hoists shared modules into shared chunks and leaves Monaco behind
   * a dynamic import, reached only when a screen that has an editor opens. Total dist/ size is
   * unchanged either way: nothing was being deduplicated that is not deduplicated now.
   *
   * `scripts/bundle-budget.mjs` gates the result, so a re-added chunking rule fails the build
   * instead of quietly costing a megabyte again.
   */
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    host: true,
  },
}));
