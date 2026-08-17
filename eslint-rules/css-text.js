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

// Shared by the CSS-in-JS lint rules. This codebase writes stylesheets four ways — `css` tagged
// templates, `<style>` blocks inside `html` render templates, `style="…"` attribute strings, and
// plain template literals assigned to a `style` property. Every one of them reaches the AST as a
// string Literal or a TemplateElement, so a rule that visits both sees all the CSS.
//
// The offset arithmetic below is the subtle part, and it lives here once on purpose: a
// `static styles = css`…`` block is a single template literal spanning hundreds of lines, so a
// rule that reports on the node rather than the match points every violation at line 1.

/**
 * The stylesheet text a node contributes, and the absolute source index that text starts at.
 *
 * `TemplateElement.range` spans its delimiters (`` ` ``, `${`, `}`), so the raw text begins one
 * character in. `Literal.range` spans the quotes, and `getText()` hands back source, so its offsets
 * already line up.
 *
 * Never scan `Literal.value`: that is the *cooked* string, where an escape sequence collapses to
 * one character and shifts every offset after it. `test/no-undefined-wa-token.test.ts` pins this.
 *
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Node} node a TemplateElement, or a string Literal
 * @returns {{ text: string, base: number }}
 */
export function cssTextOf(sourceCode, node) {
  return node.type === 'TemplateElement'
    ? { text: node.value.raw, base: node.range[0] + 1 }
    : { text: sourceCode.getText(node), base: node.range[0] };
}

/**
 * A visitor that hands `check` every node CSS can live in.
 *
 * @param {(node: import('estree').Node) => void} check
 */
export function visitCssText(check) {
  return {
    TemplateElement: check,
    Literal(node) {
      if (typeof node.value === 'string') check(node);
    },
  };
}
