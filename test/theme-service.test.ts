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

import { THEMES } from '../src/services/theme-service';

const DARK_CLASS = 'wa-dark';
const LIGHT_CLASS = 'wa-light';
// A static import, not `loadService()`'s per-test fresh copy: THEMES is a constant, and these
// derived lists are only used for DOM cleanup between tests, not for behaviour under test.
const THEME_CLASSES = THEMES.map((t) => t.themeClass);
const PALETTE_CLASSES = THEMES.map((t) => t.paletteClass);

type ThemeService = typeof import('../src/services/theme-service');

/**
 * Loads a fresh copy of the service so the module-level "live listener already
 * attached" guard in `initTheme` is reset between tests.
 */
async function loadService(): Promise<ThemeService> {
  vi.resetModules();
  return import('../src/services/theme-service');
}

/**
 * Installs a controllable `window.matchMedia` stub for the
 * `(prefers-color-scheme: dark)` query. Returns a `setDark` helper that flips
 * the OS preference and fires a `change` event to registered listeners.
 */
function installMatchMedia(initialDark: boolean) {
  let matches = initialDark;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    media: '(prefers-color-scheme: dark)',
    get matches() {
      return matches;
    },
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    dispatchEvent: () => true,
    onchange: null
  };
  window.matchMedia = ((_query: string) => mql) as unknown as typeof window.matchMedia;
  return {
    setDark(value: boolean) {
      matches = value;
      listeners.forEach((cb) => cb({ matches } as MediaQueryListEvent));
    }
  };
}

function isDark(): boolean {
  return document.documentElement.classList.contains(DARK_CLASS);
}

function classesOn(): string[] {
  return Array.from(document.documentElement.classList);
}

function resetRoot(): void {
  document.documentElement.classList.remove(DARK_CLASS, LIGHT_CLASS, ...THEME_CLASSES, ...PALETTE_CLASSES);
}

describe('theme-service', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRoot();
    installMatchMedia(false);
  });

  afterEach(() => {
    localStorage.clear();
    resetRoot();
    vi.restoreAllMocks();
  });

  describe('getAppearance', () => {
    it('defaults to system when nothing is stored', async () => {
      const svc = await loadService();
      expect(svc.getAppearance()).toBe('system');
    });

    it('returns the stored appearance', async () => {
      const svc = await loadService();
      localStorage.setItem(svc.APPEARANCE_STORAGE_KEY, 'dark');
      expect(svc.getAppearance()).toBe('dark');
    });

    it('falls back to system for an unrecognised stored value', async () => {
      const svc = await loadService();
      localStorage.setItem(svc.APPEARANCE_STORAGE_KEY, 'rainbow');
      expect(svc.getAppearance()).toBe('system');
    });

    it('reads the pre-existing ccaTheme key so stored preferences survive the rename', async () => {
      const svc = await loadService();
      expect(svc.APPEARANCE_STORAGE_KEY).toBe('ccaTheme');
      localStorage.setItem('ccaTheme', 'light');
      expect(svc.getAppearance()).toBe('light');
    });
  });

  describe('getEffectiveAppearance', () => {
    it('resolves system to dark when the OS prefers dark', async () => {
      const svc = await loadService();
      installMatchMedia(true);
      expect(svc.getEffectiveAppearance()).toBe('dark');
    });

    it('resolves system to light when the OS prefers light', async () => {
      const svc = await loadService();
      installMatchMedia(false);
      expect(svc.getEffectiveAppearance()).toBe('light');
    });

    it('honours an explicit dark preference regardless of the OS', async () => {
      const svc = await loadService();
      installMatchMedia(false);
      svc.setAppearance('dark');
      expect(svc.getEffectiveAppearance()).toBe('dark');
    });

    it('honours an explicit light preference regardless of the OS', async () => {
      const svc = await loadService();
      installMatchMedia(true);
      svc.setAppearance('light');
      expect(svc.getEffectiveAppearance()).toBe('light');
    });
  });

  describe('getThemeName', () => {
    it('defaults to awesome when nothing is stored', async () => {
      const svc = await loadService();
      expect(svc.getThemeName()).toBe('awesome');
      expect(svc.DEFAULT_THEME).toBe('awesome');
    });

    it('returns the stored theme', async () => {
      const svc = await loadService();
      localStorage.setItem(svc.THEME_NAME_STORAGE_KEY, 'shoelace');
      expect(svc.getThemeName()).toBe('shoelace');
    });

    // The sentinel has to be a theme that does not exist, or this asserts nothing. It used to be
    // 'enchanted', which stopped being unreal in #745.
    it('falls back to awesome for an unrecognised stored value', async () => {
      const svc = await loadService();
      localStorage.setItem(svc.THEME_NAME_STORAGE_KEY, 'rainbow');
      expect(svc.getThemeName()).toBe('awesome');
    });
  });

  describe('THEMES registry', () => {
    it('pairs every theme with its companion palette and picker icon', async () => {
      const svc = await loadService();
      expect(svc.THEMES.map((t) => [t.id, t.themeClass, t.paletteClass, t.icon])).toEqual([
        ['awesome', 'wa-theme-awesome', 'wa-palette-bright', 'wand-magic-sparkles'],
        ['default', 'wa-theme-default', 'wa-palette-default', 'circle-half-stroke'],
        ['shoelace', 'wa-theme-shoelace', 'wa-palette-shoelace', 'shoe-prints'],
        ['enchanted', 'wa-theme-enchanted', 'wa-palette-enchanted', 'hat-wizard']
      ]);
    });
  });

  describe('applyTheme', () => {
    it('adds the wa-dark class when the effective appearance is dark', async () => {
      const svc = await loadService();
      installMatchMedia(true);
      svc.applyTheme();
      expect(isDark()).toBe(true);
    });

    it('removes the wa-dark class when the effective appearance is light', async () => {
      const svc = await loadService();
      document.documentElement.classList.add(DARK_CLASS);
      installMatchMedia(false);
      svc.applyTheme();
      expect(isDark()).toBe(false);
    });

    it('keeps wa-light and wa-dark mutually exclusive on <html>', async () => {
      const svc = await loadService();

      installMatchMedia(true);
      svc.applyTheme();
      expect(classesOn()).toContain(DARK_CLASS);
      expect(classesOn()).not.toContain(LIGHT_CLASS);

      installMatchMedia(false);
      svc.applyTheme();
      expect(classesOn()).not.toContain(DARK_CLASS);
      expect(classesOn()).toContain(LIGHT_CLASS);
    });

    it('applies the default theme and palette classes when nothing is stored', async () => {
      const svc = await loadService();
      svc.applyTheme();
      expect(classesOn()).toContain('wa-theme-awesome');
      expect(classesOn()).toContain('wa-palette-bright');
    });

    it('leaves exactly one theme class and one palette class on <html>', async () => {
      const svc = await loadService();
      // Simulate a stale class from a previous theme.
      document.documentElement.classList.add('wa-theme-shoelace', 'wa-palette-shoelace');
      svc.setThemeName('default');

      expect(classesOn().filter((c) => THEME_CLASSES.includes(c))).toEqual(['wa-theme-default']);
      expect(classesOn().filter((c) => PALETTE_CLASSES.includes(c))).toEqual(['wa-palette-default']);
    });
  });

  describe('setAppearance', () => {
    it('persists the appearance and applies it', async () => {
      const svc = await loadService();
      installMatchMedia(false);
      svc.setAppearance('dark');
      expect(localStorage.getItem(svc.APPEARANCE_STORAGE_KEY)).toBe('dark');
      expect(isDark()).toBe(true);
    });

    it('does not disturb the theme classes', async () => {
      const svc = await loadService();
      svc.setThemeName('shoelace');
      svc.setAppearance('dark');
      expect(classesOn()).toContain('wa-theme-shoelace');
      expect(classesOn()).toContain('wa-palette-shoelace');
      expect(isDark()).toBe(true);
    });
  });

  describe('setThemeName', () => {
    it('persists the theme and applies it', async () => {
      const svc = await loadService();
      svc.setThemeName('shoelace');
      expect(localStorage.getItem(svc.THEME_NAME_STORAGE_KEY)).toBe('shoelace');
      expect(classesOn()).toContain('wa-theme-shoelace');
      expect(classesOn()).toContain('wa-palette-shoelace');
    });

    it('does not disturb the appearance class', async () => {
      const svc = await loadService();
      svc.setAppearance('dark');
      svc.setThemeName('default');
      expect(isDark()).toBe(true);
    });
  });

  describe('initTheme live listener', () => {
    it('follows OS changes while the appearance is system', async () => {
      const svc = await loadService();
      const media = installMatchMedia(false);
      svc.initTheme();
      expect(isDark()).toBe(false);

      media.setDark(true);
      expect(isDark()).toBe(true);

      media.setDark(false);
      expect(isDark()).toBe(false);
    });

    it('ignores OS changes while an explicit appearance is pinned', async () => {
      const svc = await loadService();
      const media = installMatchMedia(false);
      svc.initTheme();
      svc.setAppearance('light');

      media.setDark(true);
      expect(isDark()).toBe(false);
    });

    it('applies the stored theme at startup', async () => {
      const svc = await loadService();
      localStorage.setItem('ccaThemeName', 'shoelace');
      installMatchMedia(false);
      svc.initTheme();
      expect(classesOn()).toContain('wa-theme-shoelace');
    });
  });
});
