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

// A ternary is an expression, and an expression is meant to be read in one breath. Past a certain
// height it stops being one: the `?` and the `:` drift so far apart that you have to scroll to see
// which branch you are in, and a reader landing in the middle cannot tell whether the code above
// them is the consequent or the alternate. The usual shapes are a Lit `render()` returning
// `cond ? html`…` : html`…`` with two large templates inline, and a chain of `? :` used as a
// switch.
//
// This does not say ternaries are bad, and it does not fire on the short ones that read cleanly.
// It says a *tall* one has outgrown the form. The fixes are ordinary: lift each branch into a
// named method (`_renderEmpty()` / `_renderRows()`), hoist the condition into an early return, or
// — for a chain — use a lookup object or a `switch`.
//
// Reported at `warn`, not `error`: this is a smell, not a defect, and the existing violations are
// not a backlog anyone has agreed to pay down. Raise it to `error` once the count is zero.
//
// Only the OUTERMOST ternary of a nest is reported. A nested one is contained by its parent, so it
// can never be taller than it — reporting both would mean two warnings for one expression, both
// pointing at the same region of the file.

const DEFAULT_MAX_LINES = 10;

/** True when `node` sits anywhere inside another ternary, at any depth. */
function isNestedInTernary(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'ConditionalExpression') return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Warn when a ternary expression spans more lines than it can be read across.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          maxLines: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      longTernary:
        'This ternary spans {{lines}} lines (limit {{maxLines}}). At that height the `?` and the ' +
        '`:` are too far apart to read as one expression. Lift each branch into a named method, ' +
        'hoist the condition into an early return, or — for a `? :` chain — use a lookup object ' +
        'or a switch.',
    },
  },

  create(context) {
    const maxLines = context.options[0]?.maxLines ?? DEFAULT_MAX_LINES;

    return {
      ConditionalExpression(node) {
        if (isNestedInTernary(node)) return;

        const lines = node.loc.end.line - node.loc.start.line + 1;
        if (lines <= maxLines) return;

        context.report({
          node,
          messageId: 'longTernary',
          data: { lines, maxLines },
        });
      },
    };
  },
};

export default rule;
