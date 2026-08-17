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
 * `readOnly` reaching **Monaco**, not just the element (#6, item 15).
 *
 * Every other suite in this repo mocks `cca-monaco-editor` away entirely
 * (`vi.mock('../src/components/cca-monaco-editor.js', () => ({}))`) because the real
 * monaco-editor crashes in happy-dom, so nothing anywhere exercised this component. The
 * closest coverage — `test/view-editor.test.ts:477`/`:527` — asserts the *element property*
 * `editor.readOnly`, which is set by the template regardless of what the editor does with
 * it, and so stayed green while the diff editor hardcoded `readOnly: false`.
 *
 * This file mocks the `monaco-editor` module instead of the component, so the component is
 * the real one and the assertions are on the options Monaco was actually handed.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

type Options = Record<string, unknown>;

/** Recorded editors, with both the creation options and the running effective options. */
interface Recorded {
  /** Exactly what was passed to `create`/`createDiffEditor`, never mutated afterwards. */
  created: Options;
  /** Creation options with every later `updateOptions()` merged in — what Monaco is running. */
  effective: Options;
  updates: Options[];
  /** Set by the fake `dispose()`, so a torn-down editor can be told from a live one. */
  disposed: boolean;
}

/** One `monaco.languages.registerCompletionItemProvider()` call and its fate. */
interface RecordedCompletion {
  language: string;
  provider: unknown;
  /** Set by disposing the returned `IDisposable` — a disposed provider offers no completions. */
  disposed: boolean;
}

const monacoState = vi.hoisted(() => ({
  editors: [] as Recorded[],
  diffEditors: [] as Recorded[],
  completions: [] as RecordedCompletion[],
}));

/*
 * Monaco's own language and feature registrations, which the component imports for their side
 * effects (#148). Every one of them reaches into the real editor internals this file is mocking
 * away, so they must not run here — and there is nothing for them to register onto in any case.
 * What they register is asserted in a real browser instead, by test/smoke/editor.ts.
 */
vi.mock('../src/monaco-registrations.js', () => ({}));

/*
 * The specifier has to match the component's exactly: since #148 it imports `monaco-editor/editor`,
 * the API-only entry, and a mock of `monaco-editor` would simply not intercept — happy-dom would
 * load the real editor and the failure would look like anything but a stale mock.
 */
vi.mock('monaco-editor/editor', () => {
  const codeEditor = () => ({
    onDidChangeModelContent: () => ({ dispose() {} }),
    onDidPaste: () => ({ dispose() {} }),
    onDidBlurEditorText: () => ({ dispose() {} }),
    getValue: () => '',
    setValue: () => {},
    getModel: () => null,
    getAction: () => null,
    updateOptions: () => {},
    layout: () => {},
    focus: () => {},
    dispose: () => {},
  });

  const record = (options: Options): Recorded => ({
    created: { ...options },
    effective: { ...options },
    updates: [],
    disposed: false,
  });

  return {
    editor: {
      create: (_container: HTMLElement, options: Options) => {
        const rec = record(options);
        monacoState.editors.push(rec);
        return {
          ...codeEditor(),
          updateOptions: (next: Options) => {
            rec.updates.push(next);
            Object.assign(rec.effective, next);
          },
          dispose: () => {
            rec.disposed = true;
          },
        };
      },
      createDiffEditor: (_container: HTMLElement, options: Options) => {
        const rec = record(options);
        monacoState.diffEditors.push(rec);
        const modified = codeEditor();
        return {
          setModel: () => {},
          getModifiedEditor: () => modified,
          getOriginalEditor: () => codeEditor(),
          updateOptions: (next: Options) => {
            rec.updates.push(next);
            Object.assign(rec.effective, next);
          },
          dispose: () => {
            rec.disposed = true;
          },
        };
      },
      createModel: () => ({
        getValue: () => '',
        setValue: () => {},
        dispose: () => {},
      }),
      setModelLanguage: () => {},
      defineTheme: () => {},
      setTheme: () => {},
    },
    languages: {
      registerCompletionItemProvider: (language: string, provider: unknown) => {
        const rec: RecordedCompletion = { language, provider, disposed: false };
        monacoState.completions.push(rec);
        return {
          dispose() {
            rec.disposed = true;
          },
        };
      },
    },
  };
});

/**
 * Records every `ResizeObserver` the component builds, so a test can tell "observing the
 * container" from "constructed, then disconnected and dropped on the floor".
 *
 * happy-dom supplies a real (inert) `ResizeObserver`; this stands in for it for the duration
 * of the file so the instances are reachable.
 */
class RecordingResizeObserver {
  static instances: RecordingResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(readonly callback: ResizeObserverCallback) {
    RecordingResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

const realResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;

import '../src/components/cca-monaco-editor.js';
import type { CcaMonacoEditor } from '../src/components/cca-monaco-editor.js';

async function mount(props: Partial<CcaMonacoEditor>): Promise<CcaMonacoEditor> {
  const el = document.createElement('cca-monaco-editor');
  Object.assign(el, props);
  document.body.append(el);
  await el.updateComplete;
  return el;
}

/**
 * The editor the component is actually driving — the **last** one recorded.
 *
 * A mount now records exactly one (#23), so this is index 0 for every mount-only test; it
 * stays "the last" because a `diffMode` toggle legitimately builds a second one of the other
 * kind, and only the survivor is reachable through `this.editor`/`this.diffEditor`.
 *
 * It used to be the last because mounting built *two*: `firstUpdated()` built one, then the
 * first `updated()` — whose `changedProperties` contains every class-field initializer,
 * `diffMode` among them — rebuilt on top of it. See the `#23` describes below.
 */
const liveEditor = () => monacoState.editors[monacoState.editors.length - 1];
const liveDiffEditor = () => monacoState.diffEditors[monacoState.diffEditors.length - 1];

/** Registrations Monaco would still consult — a disposed one contributes no completions. */
const liveCompletions = () => monacoState.completions.filter((c) => !c.disposed);

const liveResizeObservers = () =>
  RecordingResizeObserver.instances.filter((o) => !o.disconnected);

const containerOf = (el: HTMLElement) =>
  el.shadowRoot!.querySelector('.editor-container') as HTMLElement;

beforeEach(() => {
  RecordingResizeObserver.instances.length = 0;
});

afterEach(() => {
  document.body.innerHTML = '';
  monacoState.editors.length = 0;
  monacoState.diffEditors.length = 0;
  monacoState.completions.length = 0;
});

afterAll(() => {
  globalThis.ResizeObserver = realResizeObserver;
});

describe('cca-monaco-editor — readOnly reaches the diff editor', () => {
  it('creates the diff editor read-only when the host says the user cannot write', async () => {
    await mount({ diffMode: true, readOnly: true, value: 'a', originalValue: 'b' });

    // The whole of item 15: this used to be a hardcoded `false`, so "Show Diff" handed a
    // user without write access an editable pane whose contents can never be saved.
    expect(liveDiffEditor().created.readOnly).toBe(true);
  });

  it('still leaves the diff editor writable for a user who can write', async () => {
    await mount({ diffMode: true, readOnly: false, value: 'a', originalValue: 'b' });

    expect(liveDiffEditor().effective.readOnly).toBe(false);
  });

  it('never makes the original pane editable, whatever readOnly says', async () => {
    await mount({ diffMode: true, readOnly: false, value: 'a', originalValue: 'b' });

    expect(liveDiffEditor().effective.originalEditable).toBe(false);
  });

  it('propagates a later readOnly change to the live diff editor', async () => {
    // The realistic sequence: the editor mounts before `canWriteDb` has resolved, so the
    // property flips after creation. Nothing re-created the diff editor for that.
    const el = await mount({ diffMode: true, readOnly: false, value: 'a', originalValue: 'b' });

    el.readOnly = true;
    await el.updateComplete;

    expect(liveDiffEditor().effective.readOnly).toBe(true);
  });

  it('propagates readOnly turning back off', async () => {
    const el = await mount({ diffMode: true, readOnly: true, value: 'a', originalValue: 'b' });

    el.readOnly = false;
    await el.updateComplete;

    expect(liveDiffEditor().effective.readOnly).toBe(false);
  });
});

/**
 * The plain-editor half already worked. It is pinned here because the fix moves the
 * `readOnly` handler out of the `if (!this.diffMode && this.editor)` branch it lived in.
 */
describe('cca-monaco-editor — readOnly reaches the plain editor', () => {
  it('creates the plain editor read-only', async () => {
    await mount({ readOnly: true, value: 'a' });

    expect(liveEditor().created.readOnly).toBe(true);
  });

  it('propagates a later readOnly change to the live plain editor', async () => {
    const el = await mount({ readOnly: false, value: 'a' });

    el.readOnly = true;
    await el.updateComplete;

    expect(liveEditor().effective.readOnly).toBe(true);
  });

  it('does not build a diff editor when diffMode is off', async () => {
    await mount({ readOnly: true, value: 'a' });

    expect(monacoState.diffEditors).toHaveLength(0);
  });
});

/**
 * Switching modes tears the old editor down and builds the other one, so the newly built
 * editor has to be handed `readOnly` at creation — `updated()` early-returns on a `diffMode`
 * change and never reaches the property handlers.
 */
describe('cca-monaco-editor — readOnly survives a diffMode toggle', () => {
  it('carries readOnly into the diff editor built by turning diffMode on', async () => {
    const el = await mount({ readOnly: true, value: 'a' });

    el.diffMode = true;
    await el.updateComplete;

    expect(liveDiffEditor().created.readOnly).toBe(true);
  });

  it('carries readOnly into the plain editor built by turning diffMode off', async () => {
    const el = await mount({ diffMode: true, readOnly: true, value: 'a', originalValue: 'b' });

    el.diffMode = false;
    await el.updateComplete;

    expect(liveEditor().created.readOnly).toBe(true);
  });
});

/**
 * #23 — one editor per mount.
 *
 * Monaco is the heaviest thing this app instantiates, and the component used to build it
 * twice: `firstUpdated()` built one, then Lit's first `updated()` ran with a
 * `changedProperties` holding every class-field initializer — `diffMode` among them, since
 * Lit records an initializer as a change from `undefined` — and `_rebuildEditor()` disposed
 * the fresh editor to build a replacement.
 *
 * Note that Lit sets `hasUpdated = true` *before* calling `firstUpdated()`, so it is already
 * true inside `updated()` and cannot tell the two cycles apart.
 */
describe('cca-monaco-editor — exactly one editor per mount (#23)', () => {
  it('builds one plain editor and keeps it', async () => {
    await mount({ value: 'a' });

    expect(monacoState.editors).toHaveLength(1);
    expect(monacoState.editors[0].disposed).toBe(false);
  });

  it('builds one diff editor and keeps it', async () => {
    await mount({ diffMode: true, value: 'a', originalValue: 'b' });

    expect(monacoState.diffEditors).toHaveLength(1);
    expect(monacoState.editors).toHaveLength(0);
    expect(monacoState.diffEditors[0].disposed).toBe(false);
  });

  it('builds one of each across a diffMode toggle, not two of each', async () => {
    const el = await mount({ value: 'a' });

    el.diffMode = true;
    await el.updateComplete;

    expect(monacoState.editors).toHaveLength(1);
    expect(monacoState.diffEditors).toHaveLength(1);
    // The plain one is genuinely gone — a toggle *should* dispose what it replaces.
    expect(monacoState.editors[0].disposed).toBe(true);
    expect(monacoState.diffEditors[0].disposed).toBe(false);
  });

  it('does not rebuild for an unrelated property change', async () => {
    const el = await mount({ value: 'a' });

    el.readOnly = true;
    await el.updateComplete;

    expect(monacoState.editors).toHaveLength(1);
  });
});

/**
 * #23 — the user-visible half. The second build's `_teardown()` disposed the completion
 * provider the first build had registered, and then `updated()` returned early on the
 * `diffMode` branch without ever reaching the re-registration path. Net effect in production:
 * the view editor offered no completions at all.
 */
describe('cca-monaco-editor — completion provider survives the mount (#23)', () => {
  const provider = { provideCompletionItems: () => ({ suggestions: [] }) };

  it('registers the provider it was mounted with, and leaves it live', async () => {
    await mount({ value: 'a', language: 'javascript', completionProvider: provider });

    expect(liveCompletions()).toHaveLength(1);
    expect(liveCompletions()[0].provider).toBe(provider);
    expect(liveCompletions()[0].language).toBe('javascript');
  });

  it('registers a provider handed over after mount', async () => {
    const el = await mount({ value: 'a' });

    el.completionProvider = provider;
    await el.updateComplete;

    expect(liveCompletions()).toHaveLength(1);
    expect(liveCompletions()[0].provider).toBe(provider);
  });

  it('registers the provider in diff mode too', async () => {
    await mount({ diffMode: true, value: 'a', originalValue: 'b', completionProvider: provider });

    expect(liveCompletions()).toHaveLength(1);
  });

  it('keeps exactly one live registration across a diffMode toggle', async () => {
    const el = await mount({ value: 'a', completionProvider: provider });

    el.diffMode = true;
    await el.updateComplete;

    expect(liveCompletions()).toHaveLength(1);
    expect(liveCompletions()[0].provider).toBe(provider);
  });

  it('re-registers against the new language when language changes', async () => {
    const el = await mount({ value: 'a', language: 'javascript', completionProvider: provider });

    el.language = 'json';
    await el.updateComplete;

    expect(liveCompletions()).toHaveLength(1);
    expect(liveCompletions()[0].language).toBe('json');
  });

  it('disposes the registration when the element leaves the DOM', async () => {
    const el = await mount({ value: 'a', completionProvider: provider });

    el.remove();

    expect(liveCompletions()).toHaveLength(0);
  });
});

/**
 * #23 — the other casualty of the second build: the `ResizeObserver` was attached in
 * `firstUpdated()` only, so the rebuild's `_teardown()` disconnected it and nothing put it
 * back. The narrow-viewport `renderSideBySide` switch and the explicit `layout()` call never
 * fired again.
 */
describe('cca-monaco-editor — ResizeObserver survives the mount (#23)', () => {
  it('leaves one observer watching the editor container', async () => {
    const el = await mount({ value: 'a' });

    expect(liveResizeObservers()).toHaveLength(1);
    expect(liveResizeObservers()[0].observed).toContain(containerOf(el));
  });

  it('leaves one observer watching the container in diff mode', async () => {
    const el = await mount({ diffMode: true, value: 'a', originalValue: 'b' });

    expect(liveResizeObservers()).toHaveLength(1);
    expect(liveResizeObservers()[0].observed).toContain(containerOf(el));
  });

  it('reattaches an observer after a diffMode toggle', async () => {
    const el = await mount({ value: 'a' });

    el.diffMode = true;
    await el.updateComplete;

    expect(liveResizeObservers()).toHaveLength(1);
    expect(liveResizeObservers()[0].observed).toContain(containerOf(el));
  });

  it('disconnects the observer when the element leaves the DOM', async () => {
    const el = await mount({ value: 'a' });

    el.remove();

    expect(liveResizeObservers()).toHaveLength(0);
  });
});

/*
 * The stylesheet the component writes into its own shadow root.
 *
 * Monaco's prebuilt `editor.main.css` inlines the entire codicon TTF as a base64 `@font-face` —
 * 188,044 B raw, 90,666 B gzip, 77% of the file's compressed weight. It does nothing there:
 * measured in headless Chrome, an `@font-face` declared inside a shadow root is ignored outright,
 * while a document-level one applies to shadow content. Our codicons have always come from the
 * document stylesheet Vite extracts from Monaco's ESM modules. `monacoCssPlugin` therefore strips
 * the rule at build time (#148), and these two assertions are a pair: the font must be gone, and
 * the rest of the stylesheet must not be, because the same regex could take everything.
 */
describe('cca-monaco-editor — shadow stylesheet (#148)', () => {
  const shadowStyles = (el: CcaMonacoEditor) =>
    el.shadowRoot?.querySelector('style')?.textContent ?? '';

  it('carries no @font-face, which a shadow root would ignore anyway', async () => {
    const el = await mount({ value: '{}' });

    expect(shadowStyles(el)).not.toContain('@font-face');
    // The font specifically. Monaco also inlines four small PNGs and SVGs as base64 data URIs,
    // which are decoration this rule has no quarrel with — an assertion on `base64` alone would
    // be about those too, and would go red for the wrong reason.
    expect(shadowStyles(el)).not.toContain('data:font');
  });

  it('still carries the editor rules it exists for', async () => {
    const el = await mount({ value: '{}' });

    const styles = shadowStyles(el);
    expect(styles).toContain('.monaco-editor');
    expect(styles.length).toBeGreaterThan(100_000);
  });
});
