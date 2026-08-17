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

// `global.css` used to declare fourteen `--cca-*` custom properties on `:root`. They were plain
// light-mode hex literals: they never responded to `wa-dark`, and `theme-service.ts` defaults to a
// `system` preference that follows the OS, so anyone on a dark desktop saw them. #729 retired all
// fourteen — eight were already dead — and this rule keeps them retired.
//
// Both directions are reported. A reference, `var(--cca-primary)`, is the visible bug; a
// declaration, `--cca-primary: #0f3460`, is how the bug gets reintroduced. Catching only the
// former would let a fresh `:root` block land unchallenged.
//
// This is the sibling of no-undefined-wa-token: that rule says "the --wa- name you used must be
// real", this one says "there is no other palette to fall back on".

import { cssTextOf, visitCssText } from './css-text.js';

/** Matches a declaration (`--cca-x:`) and a reference (`var(--cca-x)`) alike. */
const CCA_PROPERTY = /--cca-[a-z0-9-]*/g;

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow --cca- custom properties. They were light-mode-only literals, retired in #729.',
    },
    schema: [],
    messages: {
      ccaProperty:
        "'{{property}}' is a --cca- custom property. Those were plain light-mode literals that " +
        'never responded to wa-dark, and #729 retired every one of them. Use the Web Awesome ' +
        'token whose role matches the property you are setting — border-* for borders, fill-* ' +
        'for backgrounds, on-*/text-* for text, surface-* for surfaces. For a build-time asset ' +
        'URL, use lit unsafeCSS() rather than bridging it through a custom property.',
    },
  },

  create(context) {
    const { sourceCode } = context;

    const check = (node) => {
      const { text, base } = cssTextOf(sourceCode, node);

      for (const match of text.matchAll(CCA_PROPERTY)) {
        context.report({
          node,
          loc: sourceCode.getLocFromIndex(base + match.index),
          messageId: 'ccaProperty',
          data: { property: match[0] },
        });
      }
    };

    return visitCssText(check);
  },
};

export default rule;
