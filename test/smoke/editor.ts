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
 * Browser-side half of the editor smoke check (`scripts/smoke.mjs`).
 *
 * WHY IT EXISTS. #148 replaced `import 'monaco-editor'` — which registers every language and every
 * editor contribution Microsoft ships — with an explicit list of 0.56's granular entry points. The
 * entire failure mode of that change is silence. A contribution that is not imported does not
 * throw, does not warn and does not appear anywhere: the suggest widget simply never opens, the
 * folding chevron is simply not there, the icons are simply blank boxes. `npm run check` cannot see
 * any of it — `test/cca-monaco-editor.test.ts` mocks `monaco-editor/editor` away precisely so the
 * component is testable at all, and every other suite mocks the component itself.
 *
 * So each check below stands for one decision in #148 that would otherwise be unfalsifiable:
 *
 *   suggest-widget-opens     `features/suggest/register` contains only suggestInlineCompletions.
 *                            The widget is `suggestController`, one of eight deep paths that no
 *                            feature register covers. Without it view-editor.ts's CouchDB field
 *                            completion renders nothing at all. This is also the gate on dropping
 *                            `inlineCompletions`: the two live in the same area of Monaco, and
 *                            "they are separable" was a claim about the module graph, not about
 *                            behaviour.
 *
 *   codicons-render          The shadow-root stylesheet no longer carries the codicon @font-face,
 *                            because a shadow root ignores one. What renders our icons is the
 *                            document-level face that `features/codicon/register` pulls in. Both
 *                            halves of that are asserted here, by measuring a glyph rather than by
 *                            trusting the mechanism.
 *
 *   json-tokenised /         The two languages we still register, one from a rich language service
 *   javascript-tokenised     (there is no languages/definitions/json) and one from a monarch
 *                            grammar. Everything else was dropped.
 *
 *   json-worker-reports      A round trip through json.worker: markers only appear if the worker
 *                            starts, loads and answers. The workers come from `language/<x>/`,
 *                            0.56's compatibility shim for the `languages/features/<x>/` registers
 *                            this file's editor is built from.
 *
 *   diff-editor-renders      Two panes. The weakest check here, and knowingly so: the diff widget
 *                            comes with the API, so this stays green even with every registration
 *                            removed. It guards the component's own diff path, not the registry.
 *
 *   folding-available        A contribution with no visible widget until used — the shape of thing
 *                            a denylist loses silently, and one that goes red the moment the
 *                            registrations do not run.
 *
 * Verified red, not merely written: with `import '../monaco-registrations.js'` taken out of the
 * component, seven of these fail by name — both tokenisers, the worker, both codicon checks, the
 * suggest widget and folding.
 *
 * Results are published on `window.__smokeResult` for the driver to read over CDP.
 */

import '../../src/components/cca-monaco-editor.js';
import type { CcaMonacoEditor } from '../../src/components/cca-monaco-editor.js';
import * as monaco from 'monaco-editor/editor';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
let providerCalls = 0;
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `read` returns something truthy or the budget runs out.
 *
 * The budget is deliberately modest. Everything here answers in well under a second when it works,
 * and the budgets only ever add up on the failing path — where four of them in series once
 * outran `waitForResult`'s 30 s window in scripts/smoke.mjs, so a genuinely broken editor reported
 * "the page did not finish" instead of naming the checks that failed.
 */
async function until<T>(read: () => T | undefined, budgetMs = 5000): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(100);
  }
}

/**
 * The live Monaco instance behind a mounted component.
 *
 * Reaching past the element's public surface on purpose: what is under test is what Monaco was
 * given the ability to do, and that is not observable from the outside without typing at it.
 */
function editorOf(el: CcaMonacoEditor): monaco.editor.IStandaloneCodeEditor {
  return (el as unknown as { editor: monaco.editor.IStandaloneCodeEditor }).editor;
}

async function mount(props: Partial<CcaMonacoEditor>): Promise<CcaMonacoEditor> {
  const el = document.createElement('cca-monaco-editor');
  // The editor needs a real box or it lays out to nothing and renders no lines.
  el.style.cssText = 'display:block;width:900px;height:320px';
  Object.assign(el, props);
  document.body.append(el);
  await el.updateComplete;
  await until(() => el.shadowRoot?.querySelector('.monaco-editor'));
  return el;
}

const tokenClasses = (root: ParentNode): Set<string> => {
  const classes = new Set<string>();
  for (const span of root.querySelectorAll('.view-line span span')) {
    for (const cls of span.classList) if (cls.startsWith('mtk')) classes.add(cls);
  }
  return classes;
};

async function run(): Promise<void> {
  /* ---- JSON: the language every screen but the view editor uses ------------------------- */

  const json = await mount({ language: 'json', value: '{\n  "_id": "smoke",\n  "n": 12\n}' });
  const jsonRoot = json.shadowRoot!;

  add(
    'editor-mounts',
    jsonRoot.querySelector('.monaco-editor') !== null,
    `.monaco-editor in shadow root: ${jsonRoot.querySelector('.monaco-editor') !== null}`
  );

  const inlined = jsonRoot.querySelector('style')?.textContent ?? '';
  add(
    'shadow-stylesheet-inlined',
    inlined.includes('.monaco-editor') && inlined.length > 100_000,
    `${inlined.length} chars of Monaco CSS inside the shadow root`
  );
  add(
    'shadow-stylesheet-has-no-font',
    !inlined.includes('@font-face') && !inlined.includes('data:font'),
    'the codicon @font-face is stripped from the shadow copy (a shadow root ignores one anyway)'
  );

  await until(() => tokenClasses(jsonRoot).size > 1);
  const jsonTokens = tokenClasses(jsonRoot);
  add(
    'json-tokenised',
    jsonTokens.size > 1,
    `${jsonTokens.size} distinct token classes: ${[...jsonTokens].sort().join(', ') || 'none'}`
  );

  /* ---- json.worker: markers are proof of a round trip ------------------------------------ */

  const jsonModel = editorOf(json).getModel()!;
  jsonModel.setValue('{ "unclosed": ');
  const markers = await until(() => {
    const found = monaco.editor.getModelMarkers({ resource: jsonModel.uri });
    return found.length > 0 ? found : undefined;
  });
  add(
    'json-worker-reports',
    markers !== undefined,
    markers
      ? `json.worker returned ${markers.length} marker(s): ${markers[0].message}`
      : 'no markers within the poll budget — json.worker may not be starting'
  );
  jsonModel.setValue('{\n  "_id": "smoke"\n}');

  /* ---- codicons: the document-level @font-face is the only one that renders --------------- */

  await document.fonts.ready;
  await document.fonts.load('16px codicon').catch(() => []);
  const faces = [...document.fonts].filter((face) => face.family.replace(/["']/g, '') === 'codicon');
  add(
    'codicon-face-in-document',
    faces.length > 0,
    `${faces.length} codicon @font-face in the document, status ${faces.map((f) => f.status).join('/') || 'n/a'}`
  );

  // U+EAB6 is a real codicon glyph; a font that does not exist gives the fallback advance width.
  // Equal widths mean the face never applied, which is what a missing codicon register looks like.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:100px';
  probe.innerHTML =
    '<span id="glyph" style="font-family:codicon"></span>' +
    '<span id="fallback" style="font-family:no-such-family-xyz"></span>';
  document.body.append(probe);
  await sleep(100);
  const glyphWidth = probe.querySelector<HTMLElement>('#glyph')!.getBoundingClientRect().width;
  const fallbackWidth = probe.querySelector<HTMLElement>('#fallback')!.getBoundingClientRect().width;
  add(
    'codicons-render',
    glyphWidth > 0 && glyphWidth !== fallbackWidth,
    `codicon glyph ${glyphWidth.toFixed(2)}px vs fallback ${fallbackWidth.toFixed(2)}px`
  );

  /* ---- JavaScript, and the suggest widget view-editor.ts depends on ----------------------- */

  const js = await mount({
    language: 'javascript',
    value: 'function (doc) {\n  emit(doc.name, 1);\n}',
    completionProvider: {
      // The same shape view-editor.ts registers: plain items, no trigger characters.
      provideCompletionItems: (model, position) => {
        providerCalls++;
        const word = model.getWordUntilPosition(position);
        return {
          suggestions: ['smokeFieldOne', 'smokeFieldTwo'].map((label) => ({
            label,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: label,
            range: {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn
            }
          }))
        };
      }
    }
  });
  const jsRoot = js.shadowRoot!;

  await until(() => tokenClasses(jsRoot).size > 1);
  const jsTokens = tokenClasses(jsRoot);
  add(
    'javascript-tokenised',
    jsTokens.size > 1,
    `${jsTokens.size} distinct token classes: ${[...jsTokens].sort().join(', ') || 'none'}`
  );

  const jsEditor = editorOf(js);
  // The component runs Prettier over the initial JavaScript on a 200 ms timer and calls setValue()
  // with the result, which would replace the model out from under the widget. Let that land first.
  await sleep(600);
  // A prefix only our own suggestions match. Two reasons, both discovered the hard way: Monaco
  // filters by the word under the cursor, so triggering next to `emit` hides `smokeFieldOne` for
  // matching nothing — and the suggest list is virtualized, so on an empty word the TypeScript
  // service's few hundred globals fill the rendered rows and ours are real but off-screen. With
  // `smoke` typed, what the DOM shows is exactly what our provider contributed.
  jsEditor.getModel()!.setValue('function (doc) {\n  smoke\n}');
  jsEditor.focus();
  jsEditor.setPosition({ lineNumber: 2, column: 8 });
  jsEditor.trigger('smoke', 'editor.action.triggerSuggest', {});
  // Our own provider's items specifically, not merely "a widget appeared": the TypeScript service
  // contributes suggestions of its own here, so a widget full of `const name: void` would pass a
  // laxer check while `registerCompletionItemProvider` — the thing view-editor.ts depends on — was
  // going nowhere.
  const ours = await until(() => {
    const widget = jsRoot.querySelector('.suggest-widget');
    if (!widget || !widget.classList.contains('visible')) return undefined;
    const rows = [...widget.querySelectorAll('.monaco-list-row')];
    const mine = rows.filter((row) => row.textContent?.includes('smokeField'));
    return mine.length > 0 ? { rows: rows.length, mine: mine.length } : undefined;
  });
  // Enough state in the failure line to tell the three ways this can break apart without a second
  // run: the widget never opened (suggestController), it opened but the provider was never asked
  // (registration), or it was asked and its items did not survive (filtering, ranges).
  const widgetNow = jsRoot.querySelector('.suggest-widget');
  const seen = [...(widgetNow?.querySelectorAll('.monaco-list-row') ?? [])]
    .map((row) => row.textContent?.trim().slice(0, 20))
    .slice(0, 6);
  add(
    'suggest-widget-opens',
    ours !== undefined,
    ours
      ? `${ours.rows} suggestion row(s), ${ours.mine} of them from registerCompletionItemProvider`
      : `no completion from our own provider appeared (widget visible: ` +
        `${widgetNow?.classList.contains('visible')}, provider set: ${Boolean(js.completionProvider)}, ` +
        `rows: ${JSON.stringify(seen)}, providerCalls: ${providerCalls}) — suggestController may be missing (#148)`
  );

  add(
    'folding-available',
    jsEditor.getAction('editor.foldAll') !== null,
    `editor.foldAll action registered: ${jsEditor.getAction('editor.foldAll') !== null}`
  );

  /* ---- the diff editor ------------------------------------------------------------------- */

  const diff = await mount({
    language: 'json',
    diffMode: true,
    value: '{\n  "a": 1\n}',
    originalValue: '{\n  "a": 2\n}'
  });
  const diffRoot = diff.shadowRoot!;
  const panes = await until(() => {
    const found = diffRoot.querySelectorAll('.monaco-diff-editor .editor');
    return found.length >= 2 ? found : undefined;
  });
  add(
    'diff-editor-renders',
    panes !== undefined,
    panes ? `${panes.length} panes inside .monaco-diff-editor` : 'fewer than two panes'
  );
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (error) {
    add('threw', false, String(error));
  }
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  const out = document.getElementById('out');
  if (out) out.textContent = checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n');
  (window as unknown as { __smokeResult: unknown }).__smokeResult = { checks, failed };
}

void main();
