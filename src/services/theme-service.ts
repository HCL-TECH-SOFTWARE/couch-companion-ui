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
 * Two independent, persisted axes, both reflected onto `<html>` as classes:
 *
 * - **Appearance** — light / dark / system. Toggles `wa-dark`.
 * - **Theme** — which Web Awesome theme's tokens are in force. Toggles `wa-theme-*`
 *   plus the theme's companion `wa-palette-*`.
 *
 * They are orthogonal: every theme renders in both light and dark.
 */

/**
 * Colour-scheme preference persisted across sessions.
 *
 * - `light` / `dark` pin the appearance, ignoring the OS setting.
 * - `system` follows the OS `prefers-color-scheme` setting live.
 */
export type Appearance = 'light' | 'dark' | 'system';

/**
 * A theme whose tokens are in force. The first three ship in
 * `@awesome.me/webawesome/dist/styles/themes/`; `enchanted` is ours, in `src/themes/`.
 */
export type ThemeName = 'awesome' | 'default' | 'shoelace' | 'enchanted';

export interface ThemeDefinition {
  id: ThemeName;
  /** Shown in the picker. */
  label: string;
  /** Web Awesome scopes a theme's tokens to this class. */
  themeClass: string;
  /** The colour ramp the theme's stylesheet imports; must travel with it. */
  paletteClass: string;
  /** Font Awesome icon name shown next to the theme's label in the picker. */
  icon: string;
}

/**
 * The extension point for adding a theme. A new theme needs a stylesheet declaring
 * `.wa-theme-<id>` blocks, an import in `webawesome.ts`, and one entry here — carrying its picker
 * icon too. Order is the order the picker lists them.
 *
 * A theme's stylesheet does **not** belong in `ENTRY_STYLESHEETS` in
 * `eslint-rules/no-undefined-wa-token.js`, even though it is a stylesheet the app loads. That list
 * defines which tokens component code may reference, and component code renders under whichever
 * theme is active — so it may only name tokens *every* theme declares. `enchanted` is the reason
 * this is worth stating: it adds 93 palette tokens the Web Awesome themes have no equivalent for.
 * See the rule's own docstring.
 */
export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'awesome',
    label: 'Awesome',
    themeClass: 'wa-theme-awesome',
    paletteClass: 'wa-palette-bright',
    icon: 'wand-magic-sparkles'
  },
  {
    id: 'default',
    label: 'Default',
    themeClass: 'wa-theme-default',
    paletteClass: 'wa-palette-default',
    icon: 'circle-half-stroke'
  },
  {
    id: 'shoelace',
    label: 'Shoelace',
    themeClass: 'wa-theme-shoelace',
    paletteClass: 'wa-palette-shoelace',
    icon: 'shoe-prints'
  },
  {
    id: 'enchanted',
    label: 'Enchanted',
    themeClass: 'wa-theme-enchanted',
    paletteClass: 'wa-palette-enchanted',
    icon: 'hat-wizard'
  }
];

export const DEFAULT_THEME: ThemeName = 'awesome';

/** `localStorage` key holding the {@link Appearance}. Predates the theme axis, hence the name. */
export const APPEARANCE_STORAGE_KEY = 'ccaTheme';

/** `localStorage` key holding the {@link ThemeName}. */
export const THEME_NAME_STORAGE_KEY = 'ccaThemeName';

/** Web Awesome activates dark tokens when this class is on `<html>`. */
const DARK_CLASS = 'wa-dark';

/**
 * `index.html` ships this class as the pre-JS default so first paint is never unstyled. Once
 * `applyTheme` runs, it must be toggled off in lockstep with {@link DARK_CLASS}: left on, a
 * theme's light and dark blocks — `.wa-theme-*.wa-light` and `.wa-theme-*.wa-dark` — tie on
 * specificity, and dark only wins because it happens to be later in the stylesheet.
 */
const LIGHT_CLASS = 'wa-light';

const DARK_QUERY = '(prefers-color-scheme: dark)';

const isAppearance = (value: string | null): value is Appearance =>
  value === 'light' || value === 'dark' || value === 'system';

const isThemeName = (value: string | null): value is ThemeName =>
  THEMES.some((theme) => theme.id === value);

/** Reads the stored appearance, defaulting to `system` when unset or invalid. */
export function getAppearance(): Appearance {
  const stored = localStorage.getItem(APPEARANCE_STORAGE_KEY);
  return isAppearance(stored) ? stored : 'system';
}

/** Reads the stored theme, defaulting to {@link DEFAULT_THEME} when unset or invalid. */
export function getThemeName(): ThemeName {
  const stored = localStorage.getItem(THEME_NAME_STORAGE_KEY);
  return isThemeName(stored) ? stored : DEFAULT_THEME;
}

/** True when the OS currently prefers a dark colour scheme. */
function osPrefersDark(): boolean {
  return window.matchMedia?.(DARK_QUERY).matches ?? false;
}

/** Resolves the appearance preference to the concrete scheme to render. */
export function getEffectiveAppearance(): 'light' | 'dark' {
  const appearance = getAppearance();
  if (appearance === 'system') {
    return osPrefersDark() ? 'dark' : 'light';
  }
  return appearance;
}

/**
 * Reflects both axes onto `<html>`. Every theme class is toggled on each call, so a
 * previously-active theme cannot linger: two `wa-theme-*` classes on the root would
 * leave the winner to source order in the bundled CSS.
 */
export function applyTheme(): void {
  const root = document.documentElement;
  const dark = getEffectiveAppearance() === 'dark';
  root.classList.toggle(DARK_CLASS, dark);
  root.classList.toggle(LIGHT_CLASS, !dark);

  const active = getThemeName();
  for (const theme of THEMES) {
    const isActive = theme.id === active;
    root.classList.toggle(theme.themeClass, isActive);
    root.classList.toggle(theme.paletteClass, isActive);
  }
}

/** Persists a new appearance and applies it immediately. */
export function setAppearance(appearance: Appearance): void {
  localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  applyTheme();
}

/** Persists a new theme and applies it immediately. */
export function setThemeName(name: ThemeName): void {
  localStorage.setItem(THEME_NAME_STORAGE_KEY, name);
  applyTheme();
}

let listenerAttached = false;

/**
 * Applies the stored appearance and theme at startup and, once, attaches a listener
 * that re-applies when the OS setting changes — but only while the appearance is
 * `system` (a pinned light/dark choice ignores the OS).
 */
export function initTheme(): void {
  applyTheme();
  if (listenerAttached) {
    return;
  }
  const media = window.matchMedia?.(DARK_QUERY);
  if (!media) {
    return;
  }
  media.addEventListener('change', () => {
    if (getAppearance() === 'system') {
      applyTheme();
    }
  });
  listenerAttached = true;
}
