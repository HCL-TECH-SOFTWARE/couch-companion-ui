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

// Body typography is already token-driven: Web Awesome's native.css sets the body font from
// --wa-font-* tokens, global.css restates the family unlayered so a theme can change the typeface
// (#738), and font properties inherit across shadow roots. A component that hardcodes
// `font-size: 0.875rem` does not just diverge locally — it severs the only path a theme switch
// has into its shadow root. #774 migrated every such literal onto the Web Awesome typography
// tokens; this rule keeps them out.
//
// Covered: font-family, font-size, font-weight, line-height, and the `font` shorthand. A value is
// legal if it derives from a --wa- token — `var(--wa-...)` anywhere in the value, so fallbacks and
// calc() both pass; no-undefined-wa-token vouches for the name being real — or if it is a CSS-wide
// keyword, `inherit` above all: inheriting IS the token-driven cascade.
//
// letter-spacing is deliberately not covered. Web Awesome declares no letter-spacing token, so
// this rule could name no fix; and the em values in use are computed against the element's
// font-size, which is token-driven, so they already scale with the theme.
//
// Same known limitation as the sibling rules: a value cut by template interpolation
// (`font-size: ${size}`) is skipped rather than judged — the literal half tells us nothing about
// what the expression contributes. No such typography call site exists.

import { cssTextOf, visitCssText } from './css-text.js';

/**
 * A typography declaration and its value.
 *
 * The lookbehind keeps custom-property declarations out: `--wa-form-control-value-line-height: 1.2`
 * sets a Web Awesome component token, which is legal and none of this rule's business. The bare
 * `font` alternative demands the `:` right after it, so font-style/font-variant/font-stretch —
 * tokenless and out of scope — never match. The value capture runs to the `;` or `}` that ends
 * the declaration, which in a style="…" attribute means it can overrun the closing quote; the
 * clip below deals with that.
 */
const DECLARATION = /(?<![-\w])(font-(?:family|size|weight)|line-height|font)\s*:\s*([^;}]*)/gi;

const CSS_WIDE_KEYWORD = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const WA_TOKEN_REFERENCE = /var\(\s*--wa-/i;

/** What the message tells the author to reach for, keyed by lowercased property name. */
const HINTS = {
  'font-family': '--wa-font-family-{body, heading, code, longform}',
  'font-size':
    '--wa-font-size-{3xs…5xl}, or --wa-font-size-smaller/-larger to size relative to the parent',
  'font-weight':
    '--wa-font-weight-{light, normal, semibold, bold}, or a role token such as ' +
    '--wa-font-weight-heading',
  'line-height': '--wa-line-height-{condensed, normal, expanded}',
  font: "'font: inherit', or the longhand properties each set from their token",
};

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hardcoded typography values; text must derive from --wa- font tokens so theme ' +
        'switching can restyle it.',
    },
    schema: [],
    messages: {
      hardcodedTypography:
        "'{{property}}: {{value}}' is a literal, so switching the wa-theme-* class can never " +
        'restyle this text — a theme reaches into shadow roots through tokens alone. Use ' +
        '{{hint}}. A literal belongs only inside a var() fallback, e.g. ' +
        'var(--wa-font-size-s, 0.875rem).',
    },
  },

  create(context) {
    const { sourceCode } = context;

    const check = (node) => {
      const isQuasi = node.type === 'TemplateElement';
      const { text, base } = cssTextOf(sourceCode, node);

      for (const match of text.matchAll(DECLARATION)) {
        // A value that runs to the end of a non-final quasi is cut by the interpolation that
        // follows; the literal half alone cannot be judged.
        if (isQuasi && !node.tail && match.index + match[0].length === text.length) continue;

        // A commented-out declaration is prose, not a stylesheet. The sibling rules skip this
        // guard because `--cca-` reads like nothing else; `font-size:` shows up in commentary.
        if (text.lastIndexOf('/*', match.index) > text.lastIndexOf('*/', match.index)) continue;

        // In a style="…" attribute nothing ends the last declaration, so the capture overruns
        // the closing quote into markup. Clip at the first quote: everything a legal value needs
        // (`var(--wa-`, a keyword) lives before it. A capture that STARTS with a quote is a
        // hardcoded family stack — clipping empties it, so fall back to the raw capture, which
        // by construction is neither a var() nor a keyword and reports below.
        const raw = match[2];
        const clipAt = raw.search(/["']/);
        const clipped = (clipAt === -1 ? raw : raw.slice(0, clipAt)).trim();
        const value = clipped || raw.trim();

        if (!value) continue;
        if (WA_TOKEN_REFERENCE.test(value)) continue;
        if (CSS_WIDE_KEYWORD.test(value)) continue;

        const property = match[1].toLowerCase();
        context.report({
          node,
          loc: sourceCode.getLocFromIndex(base + match.index),
          messageId: 'hardcodedTypography',
          data: { property, value, hint: HINTS[property] },
        });
      }
    };

    return visitCssText(check);
  },
};

export default rule;
