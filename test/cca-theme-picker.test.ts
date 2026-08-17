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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import '../src/components/cca-theme-picker';
import type { CcaThemePicker } from '../src/components/cca-theme-picker';
import {
  APPEARANCE_STORAGE_KEY,
  THEME_NAME_STORAGE_KEY,
  setAppearance,
  THEMES
} from '../src/services/theme-service';

const DARK_CLASS = 'wa-dark';
const LIGHT_CLASS = 'wa-light';
const THEME_CLASSES = THEMES.map((t) => t.themeClass);
const PALETTE_CLASSES = THEMES.map((t) => t.paletteClass);

function mount(): CcaThemePicker {
  const el = document.createElement('cca-theme-picker') as CcaThemePicker;
  document.body.appendChild(el);
  return el;
}

function shadow(el: CcaThemePicker): ShadowRoot {
  if (!el.shadowRoot) throw new Error('expected shadowRoot');
  return el.shadowRoot;
}

function requireEl<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`expected element for selector: ${selector}`);
  return found;
}

function option(el: CcaThemePicker, value: string): HTMLElement & { checked: boolean } {
  return requireEl(shadow(el), `[data-option="${value}"]`);
}

function themeOption(el: CcaThemePicker, value: string): HTMLElement & { checked: boolean } {
  return requireEl(shadow(el), `[data-theme-option="${value}"]`);
}

/**
 * Selects an item the way `wa-dropdown` does.
 *
 * Both of the dropdown's selection paths — the click handler on its shadow `#menu`, and the
 * Enter/Space branch of its document `keydown` handler — funnel into `makeSelection()`, which
 * flips the item's `checked` itself (`item.checked = !item.checked`) before emitting `wa-select`.
 * A bare `item.click()` reaches neither under happy-dom, which does not compose slotted light-DOM
 * children into the host's shadow tree for event dispatch (`assignedSlot` is undefined), so the
 * click stops at the `wa-dropdown` host and the menu listener never runs. Calling `makeSelection()`
 * runs Web Awesome's real toggle and emits its real event, which is what the browser does. See #50.
 */
function select(el: CcaThemePicker, item: Element): void {
  const dropdown = requireEl<HTMLElement & { makeSelection(item: Element): void }>(
    shadow(el),
    'wa-dropdown'
  );
  dropdown.makeSelection(item);
}

/** Ids of the theme options currently showing a checkmark. */
function checkedThemes(el: CcaThemePicker): string[] {
  return Array.from(shadow(el).querySelectorAll<HTMLElement & { checked: boolean }>('[data-theme-option]'))
    .filter((i) => i.checked)
    .map((i) => i.getAttribute('data-theme-option') ?? '');
}

/** Values of the appearance options currently showing a checkmark. */
function checkedAppearances(el: CcaThemePicker): string[] {
  return Array.from(shadow(el).querySelectorAll<HTMLElement & { checked: boolean }>('[data-option]'))
    .filter((i) => i.checked)
    .map((i) => i.getAttribute('data-option') ?? '');
}

function resetRoot(): void {
  document.documentElement.classList.remove(DARK_CLASS, LIGHT_CLASS, ...THEME_CLASSES, ...PALETTE_CLASSES);
}

describe('cca-theme-picker', () => {
  let el: CcaThemePicker;

  beforeEach(() => {
    localStorage.clear();
    resetRoot();
  });

  afterEach(() => {
    el?.remove();
    localStorage.clear();
    resetRoot();
  });

  it('shows the system icon on the trigger by default', async () => {
    el = mount();
    await el.updateComplete;
    const icon = requireEl(shadow(el), '#theme-trigger wa-icon');
    expect(icon.getAttribute('name')).toBe('robot');
  });

  it('reflects the stored appearance on the trigger icon', async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, 'dark');
    el = mount();
    await el.updateComplete;
    const icon = requireEl(shadow(el), '#theme-trigger wa-icon');
    expect(icon.getAttribute('name')).toBe('moon');
  });

  it('renders the three appearance options in the dropdown popover', async () => {
    el = mount();
    await el.updateComplete;
    const values = Array.from(shadow(el).querySelectorAll('[data-option]')).map((o) =>
      o.getAttribute('data-option')
    );
    expect(values).toEqual(['light', 'dark', 'system']);
  });

  it('renders every registered theme in the dropdown popover', async () => {
    el = mount();
    await el.updateComplete;
    const values = Array.from(shadow(el).querySelectorAll('[data-theme-option]')).map((o) =>
      o.getAttribute('data-theme-option')
    );
    expect(values).toEqual(['awesome', 'default', 'shoelace', 'enchanted']);
  });

  it('labels the two groups and separates them with a divider', async () => {
    el = mount();
    await el.updateComplete;
    const labels = Array.from(shadow(el).querySelectorAll('.group-label')).map((l) =>
      l.textContent?.trim()
    );
    expect(labels).toEqual(['Appearance', 'Theme']);
    expect(shadow(el).querySelector('wa-divider')).not.toBeNull();
  });

  describe('group semantics (#743)', () => {
    /** Resolves an element's aria-describedby IDREF within the component's shadow root. */
    function describedByText(item: Element, root: ShadowRoot): string {
      const id = item.getAttribute('aria-describedby');
      if (!id) throw new Error(`no aria-describedby on ${item.getAttribute('data-option') ?? item.getAttribute('data-theme-option')}`);
      const target = root.getElementById(id);
      if (!target) throw new Error(`aria-describedby="${id}" resolves to nothing`);
      return target.textContent?.trim() ?? '';
    }

    it('describes every appearance option with the Appearance heading', async () => {
      el = mount();
      await el.updateComplete;

      const items = Array.from(shadow(el).querySelectorAll('[data-option]'));
      // Non-empty, or "every item is described" passes vacuously.
      expect(items).toHaveLength(3);
      expect(items.map((i) => describedByText(i, shadow(el)))).toEqual(items.map(() => 'Appearance'));
    });

    it('describes every theme option with the Theme heading', async () => {
      el = mount();
      await el.updateComplete;

      const items = Array.from(shadow(el).querySelectorAll('[data-theme-option]'));
      expect(items.length).toBe(THEMES.length);
      expect(items.length).toBeGreaterThan(0);
      expect(items.map((i) => describedByText(i, shadow(el)))).toEqual(items.map(() => 'Theme'));
    });

    it('hides the visual headings from the accessibility tree', async () => {
      el = mount();
      await el.updateComplete;

      // They stay on screen; aria-hidden only removes them as invalid children of role="menu",
      // since aria-describedby still reads their text.
      const headings = Array.from(shadow(el).querySelectorAll('.group-label'));
      expect(headings).toHaveLength(2);
      expect(headings.every((h) => h.getAttribute('aria-hidden') === 'true')).toBe(true);
    });

    it('keeps every item a direct child of wa-dropdown', async () => {
      el = mount();
      await el.updateComplete;

      // Regression guard. Wrapping the items in <div role="group"> is the intuitive way to expose
      // grouping, and it silently breaks keyboard nav: wa-dropdown's getItems() only sees direct
      // children, so arrow keys/typeahead/Home/End/Enter die while mouse clicks keep working.
      const dropdown = requireEl(shadow(el), 'wa-dropdown');
      const items = Array.from(shadow(el).querySelectorAll('wa-dropdown-item'));
      const appearanceCount = shadow(el).querySelectorAll('[data-option]').length;

      expect(items.length).toBe(appearanceCount + THEMES.length);
      expect(items.every((i) => i.parentElement === dropdown)).toBe(true);
    });
  });

  describe('single-select semantics (#767)', () => {
    /**
     * Waits for the host render plus every item's own update — the role is stamped by each item's
     * `updated()`, not by the host's — then for the component's observer correction, which lands a
     * microtask after each stamp.
     */
    async function settledItems(picker: CcaThemePicker): Promise<HTMLElement[]> {
      await picker.updateComplete;
      const items = Array.from(
        shadow(picker).querySelectorAll<HTMLElement & { updateComplete: Promise<boolean> }>(
          'wa-dropdown-item'
        )
      );
      await Promise.all(items.map((i) => i.updateComplete));
      return items;
    }

    function roles(items: HTMLElement[]): (string | null)[] {
      return items.map((i) => i.getAttribute('role'));
    }

    it('exposes every option as menuitemradio, never menuitemcheckbox', async () => {
      el = mount();
      const items = await settledItems(el);
      const appearanceCount = shadow(el).querySelectorAll('[data-option]').length;

      // Non-vacuous: both groups are present and fully counted.
      expect(items.length).toBe(appearanceCount + THEMES.length);
      await vi.waitFor(() => {
        expect(roles(items)).toEqual(items.map(() => 'menuitemradio'));
      });
      expect(shadow(el).querySelector('[role="menuitemcheckbox"]')).toBeNull();
    });

    it('marks exactly the selected option per group with aria-checked="true"', async () => {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, 'light');
      el = mount();
      await settledItems(el);

      expect(option(el, 'light').getAttribute('aria-checked')).toBe('true');
      expect(option(el, 'dark').getAttribute('aria-checked')).toBe('false');
      expect(option(el, 'system').getAttribute('aria-checked')).toBe('false');

      // Theme group: 'awesome' is the unseeded default.
      expect(themeOption(el, 'awesome').getAttribute('aria-checked')).toBe('true');
      const others = THEMES.filter((t) => t.id !== 'awesome');
      expect(others.length).toBeGreaterThan(0);
      for (const t of others) {
        expect(themeOption(el, t.id).getAttribute('aria-checked')).toBe('false');
      }
    });

    it('moves aria-checked on selection and keeps every role menuitemradio', async () => {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, 'light');
      el = mount();
      await settledItems(el);

      select(el, option(el, 'dark'));
      const items = await settledItems(el);

      expect(option(el, 'dark').getAttribute('aria-checked')).toBe('true');
      expect(option(el, 'light').getAttribute('aria-checked')).toBe('false');
      await vi.waitFor(() => {
        expect(roles(items)).toEqual(items.map(() => 'menuitemradio'));
      });
    });

    it('restores menuitemradio if the role is rewritten to menuitemcheckbox', async () => {
      el = mount();
      const items = await settledItems(el);

      // Upgrade guard: simulate a future Web Awesome build re-stamping the role after render.
      items[0].setAttribute('role', 'menuitemcheckbox');
      await vi.waitFor(() => {
        expect(items[0].getAttribute('role')).toBe('menuitemradio');
      });
    });
  });

  describe('selection is driven by wa-dropdown (#50)', () => {
    it('moves the checkmark to the chosen theme on the very first selection', async () => {
      el = mount();
      await el.updateComplete;
      expect(checkedThemes(el)).toEqual(['awesome']);

      select(el, themeOption(el, 'shoelace'));
      await el.updateComplete;

      // The reported symptom: the theme changed but the checkmark had not moved yet.
      expect(document.documentElement.classList.contains('wa-theme-shoelace')).toBe(true);
      expect(checkedThemes(el)).toEqual(['shoelace']);
    });

    it('moves the checkmark to the chosen appearance on the very first selection', async () => {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, 'light');
      el = mount();
      await el.updateComplete;
      expect(checkedAppearances(el)).toEqual(['light']);

      select(el, option(el, 'dark'));
      await el.updateComplete;

      expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
      expect(checkedAppearances(el)).toEqual(['dark']);
    });

    it('keeps the checkmark on the active theme when it is selected again', async () => {
      el = mount();
      await el.updateComplete;

      // Re-selecting is a no-op for the model, so nothing re-renders — the checkmark must not
      // depend on a render happening. wa-dropdown toggles `checked` on every selection.
      select(el, themeOption(el, 'awesome'));
      await el.updateComplete;

      expect(checkedThemes(el)).toEqual(['awesome']);
      expect(document.documentElement.classList.contains('wa-theme-awesome')).toBe(true);
    });

    it('keeps the checkmark on the active appearance when it is selected again', async () => {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, 'dark');
      el = mount();
      await el.updateComplete;

      select(el, option(el, 'dark'));
      await el.updateComplete;

      expect(checkedAppearances(el)).toEqual(['dark']);
      expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
    });

    it('applies the theme when selection arrives without a click (keyboard Enter)', async () => {
      el = mount();
      await el.updateComplete;

      // wa-dropdown's Enter/Space handler calls makeSelection() directly and dispatches no click,
      // so a click listener on the item never sees keyboard selection at all.
      select(el, themeOption(el, 'enchanted'));
      await el.updateComplete;

      expect(localStorage.getItem(THEME_NAME_STORAGE_KEY)).toBe('enchanted');
      expect(document.documentElement.classList.contains('wa-theme-enchanted')).toBe(true);
      expect(checkedThemes(el)).toEqual(['enchanted']);
    });

    it('leaves the trigger icon on the chosen appearance after one selection', async () => {
      el = mount();
      await el.updateComplete;

      select(el, option(el, 'dark'));
      await el.updateComplete;

      const icon = requireEl(shadow(el), '#theme-trigger wa-icon');
      expect(icon.getAttribute('name')).toBe('moon');
    });
  });

  it('anchors the options in a dropdown rather than a centred dialog', async () => {
    el = mount();
    await el.updateComplete;
    expect(shadow(el).querySelector('wa-dropdown')).not.toBeNull();
    expect(shadow(el).querySelector('wa-dialog')).toBeNull();
  });

  it('checks the current appearance option', async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, 'light');
    el = mount();
    await el.updateComplete;
    expect(option(el, 'light').checked).toBe(true);
    expect(option(el, 'dark').checked).toBe(false);
    expect(option(el, 'system').checked).toBe(false);
  });

  it('checks awesome as the default theme', async () => {
    el = mount();
    await el.updateComplete;
    expect(themeOption(el, 'awesome').checked).toBe(true);
    expect(themeOption(el, 'default').checked).toBe(false);
    expect(themeOption(el, 'shoelace').checked).toBe(false);
    expect(themeOption(el, 'enchanted').checked).toBe(false);
  });

  it('selecting an appearance persists it, applies it, and updates the trigger', async () => {
    el = mount();
    await el.updateComplete;

    select(el, option(el, 'dark'));
    await el.updateComplete;

    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
    expect(option(el, 'dark').checked).toBe(true);

    const icon = requireEl(shadow(el), '#theme-trigger wa-icon');
    expect(icon.getAttribute('name')).toBe('moon');
  });

  it('selecting a theme persists it and swaps the theme and palette classes', async () => {
    el = mount();
    await el.updateComplete;

    select(el, themeOption(el, 'shoelace'));
    await el.updateComplete;

    expect(localStorage.getItem(THEME_NAME_STORAGE_KEY)).toBe('shoelace');
    expect(document.documentElement.classList.contains('wa-theme-shoelace')).toBe(true);
    expect(document.documentElement.classList.contains('wa-palette-shoelace')).toBe(true);
    expect(document.documentElement.classList.contains('wa-theme-awesome')).toBe(false);
    expect(themeOption(el, 'shoelace').checked).toBe(true);
  });

  it('selecting an appearance leaves the theme and palette classes untouched', async () => {
    el = mount();
    await el.updateComplete;

    select(el, option(el, 'dark'));
    await el.updateComplete;

    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
    expect(document.documentElement.classList.contains('wa-theme-awesome')).toBe(true);
    expect(document.documentElement.classList.contains('wa-palette-bright')).toBe(true);
    expect(themeOption(el, 'awesome').checked).toBe(true);
  });

  it('selecting a theme leaves the appearance untouched', async () => {
    setAppearance('dark');
    el = mount();
    await el.updateComplete;

    select(el, themeOption(el, 'shoelace'));
    await el.updateComplete;

    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
    expect(document.documentElement.classList.contains('wa-theme-shoelace')).toBe(true);
    expect(document.documentElement.classList.contains('wa-palette-shoelace')).toBe(true);
    expect(option(el, 'dark').checked).toBe(true);
  });
});
