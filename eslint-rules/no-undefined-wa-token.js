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

// A `var()` on a custom property the theme never declares resolves to the guaranteed-invalid
// value: `border-radius` is dropped and the corner renders square; `border-color` becomes
// `currentcolor` and silently tracks the text. With a fallback it is quieter and worse — the
// literal renders in both themes while the valid tokens beside it flip with `wa-dark`. That is
// the mechanism behind #580.
//
// A regex over the stylesheet cannot catch this: "--wa-color-danger-border" reads exactly like a
// real token. The only way to tell a token from a typo is to resolve it against the theme.
//
// Known limitation: a fully dynamic, prefix-less name, `var(${name})`, is not reported. No such
// call site exists, and the name could belong to any custom property — a Web Awesome component
// token set locally, say — which this rule has no opinion about. A name that starts with `--wa-`
// and is then cut by interpolation, with or without characters in between, IS reported; see
// CUT_TOKEN below.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cssTextOf, visitCssText } from './css-text.js';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WA_STYLES = resolve(FRONTEND, 'node_modules/@awesome.me/webawesome/dist/styles');

/**
 * The tokens component code may safely reference: those declared by *every* theme. Not, despite
 * appearances, "every stylesheet the app loads" — see the exclusion below.
 *
 * `themes/default.css` alone does not declare every token available at runtime —
 * `--wa-color-danger`, `--wa-color-fill-quiet` and six others live in `color/variants/*.css` and
 * `utilities/variants.css`, reached only through these imports. The three Web Awesome themes
 * declare the same token *names* and differ only in values, so which of them is active never
 * changes this set. All three are listed anyway, so that drift against `src/webawesome.ts` shows
 * up here.
 *
 * `src/themes/enchanted.css` is loaded by the app and is deliberately NOT listed. It breaks the
 * name-identical assumption: it declares 93 tokens no Web Awesome theme has — the `teal`, `lime`,
 * `hcl-blue`, `cool-gray`, `black` and `white` ramps — inside `.wa-palette-enchanted`, so they
 * exist only while enchanted is the active theme. This function unions its entries, so listing it
 * would put those 93 names on the allow-list, and a component could then reference
 * `--wa-color-teal-50`, pass lint, and resolve to the guaranteed-invalid value under the other
 * three themes. That is #580, which this rule exists to prevent. A token that is not in every
 * theme is not safe in component code, and the point of leaving enchanted out is that the rule
 * says so. `test/no-undefined-wa-token.test.ts` fails if anyone adds it.
 */
export const ENTRY_STYLESHEETS = [
  resolve(WA_STYLES, 'native.css'),
  resolve(WA_STYLES, 'themes/default.css'),
  resolve(WA_STYLES, 'themes/shoelace.css'),
  resolve(WA_STYLES, 'themes/awesome.css'),
  resolve(WA_STYLES, 'webawesome.css'),
];

const IMPORT_URL = /@import\s+url\(\s*['"]([^'"]+)['"]\s*\)/g;
const DECLARATION = /(--wa-[a-z0-9-]+)\s*:/g;
const TOKEN_REFERENCE = /var\(\s*(--wa-[a-z0-9-]+)/g;
/** A `--wa` name left dangling at the end of a quasi, i.e. cut by the interpolation that follows. */
const CUT_TOKEN = /var\(\s*--wa[a-z0-9-]*$/;

/**
 * Every `--wa-*` custom property declared anywhere in the `@import` closure of `entries`.
 *
 * Throws if a stylesheet is missing. That is deliberate: swallowing the error would yield an empty
 * set, and an empty set makes every token in the tree look undefined.
 */
export function collectDeclaredTokens(entries = ENTRY_STYLESHEETS) {
  const declared = new Set();
  const visited = new Set();

  const visit = (file) => {
    if (visited.has(file)) return;
    visited.add(file);

    const css = readFileSync(file, 'utf-8');
    for (const [, token] of css.matchAll(DECLARATION)) declared.add(token);
    for (const [, specifier] of css.matchAll(IMPORT_URL)) {
      if (!/^https?:/.test(specifier)) visit(resolve(dirname(file), specifier));
    }
  };

  entries.forEach(visit);
  return declared;
}

let cachedTokens;
const declaredTokens = () => (cachedTokens ??= collectDeclaredTokens());

// No "did you mean ...?" here on purpose. Edit distance over the declared names recommends
// --wa-font-family-body over -code, --wa-color-danger-border-loud over -quiet, and
// --wa-color-brand-fill-loud where the answer is --wa-color-text-link. The nearest *name* is
// routinely the wrong *token*; suggesting it would reinforce the mistake this rule catches.

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow referencing a --wa- custom property that the Web Awesome theme does not declare.',
    },
    schema: [],
    messages: {
      undefinedToken:
        "'{{token}}' is not declared by the Web Awesome theme. var() on an undefined custom " +
        'property resolves to the guaranteed-invalid value: the declaration is dropped, or a ' +
        'colour silently becomes currentcolor. Pick a declared token whose role matches the ' +
        'property you are setting — border-* for borders, fill-* for backgrounds, on-*/text-* ' +
        'for text, surface-* for surfaces.',
      interpolatedToken:
        'A --wa- token name must appear whole in the source. This one is assembled by ' +
        'interpolation, so it cannot be checked against the theme. Move the ${...} outside the ' +
        'token name — build the whole var(...) expression per branch instead.',
    },
  },

  create(context) {
    const { sourceCode } = context;
    const declared = declaredTokens();

    const check = (node) => {
      const isQuasi = node.type === 'TemplateElement';
      const { text, base } = cssTextOf(sourceCode, node);

      for (const match of text.matchAll(TOKEN_REFERENCE)) {
        // A name that runs to the end of a non-final quasi is cut by the interpolation that
        // follows; CUT_TOKEN reports it below, and more precisely than a token name can.
        if (isQuasi && !node.tail && match.index + match[0].length === text.length) continue;

        const token = match[1];
        if (declared.has(token)) continue;

        context.report({
          node,
          loc: sourceCode.getLocFromIndex(base + match.index),
          messageId: 'undefinedToken',
          data: { token },
        });
      }

      // `var(--wa-color-${palette}-fill-quiet)` and `var(--wa-${palette}-fill-quiet)` both leave a
      // partial name at the end of the quasi. The second form has no name characters after the
      // prefix at all, so TOKEN_REFERENCE cannot see it.
      if (isQuasi && !node.tail) {
        const cut = text.match(CUT_TOKEN);
        if (cut) {
          context.report({
            node,
            loc: sourceCode.getLocFromIndex(base + cut.index),
            messageId: 'interpolatedToken',
          });
        }
      }
    };

    return visitCssText(check);
  },
};

export default rule;
