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

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import {
  THEMES,
  getAppearance,
  setAppearance,
  getThemeName,
  setThemeName,
  type Appearance,
  type ThemeName
} from '../services/theme-service.js';

interface AppearanceOption {
  value: Appearance;
  icon: string;
  label: string;
}

/** Ordered appearance options; also drives the trigger icon. */
const APPEARANCES: readonly AppearanceOption[] = [
  { value: 'light', icon: 'sun', label: 'Light' },
  { value: 'dark', icon: 'moon', label: 'Dark' },
  { value: 'system', icon: 'robot', label: 'System' }
];

/**
 * The two group headings are announced to assistive tech by `aria-describedby` from each item,
 * rather than by wrapping each group in `role="group"`. A wrapper is the obvious fix and it is a
 * trap: `wa-dropdown` finds its items with `defaultSlot.assignedElements({flatten: true})` filtered
 * by `localName === 'wa-dropdown-item'`, which sees only *direct* children (flatten looks through
 * nested `<slot>`s, not through a `<div>`). Wrapping the items empties `getItems()` and silently
 * kills arrow keys, typeahead, Home/End, Enter/Space and the roving tabindex — while mouse clicks
 * keep working, because that path alone uses `closest()`. See #743.
 *
 * Safe because ids resolve within this shadow root, so they cannot collide across instances.
 */
const APPEARANCE_LABEL_ID = 'appearance-label';
const THEME_LABEL_ID = 'theme-label';

/**
 * Header control for the two theme axes. The trigger icon reflects the current *appearance*
 * (sun/moon/robot) — that is the axis people toggle most, and the one they look for. Clicking
 * opens a `wa-dropdown` popover anchored to the trigger, holding two labelled groups: the
 * appearance options, then the Web Awesome themes. The active option in each group carries a
 * checkmark. Selecting one persists it via the theme service and closes the popover. All styling
 * comes from Web Awesome design tokens, so it stays legible in every theme and both appearances.
 */
@customElement('cca-theme-picker')
export class CcaThemePicker extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
    }
  `;

  @state() private _appearance: Appearance = getAppearance();
  @state() private _theme: ThemeName = getThemeName();

  /**
   * Both groups are single-select, so their items must be announced as `menuitemradio` — one of a
   * mutually exclusive set — not `menuitemcheckbox` (independent toggles). Web Awesome has no radio
   * type: `wa-dropdown-item` knows only `type="checkbox"`, and its `updated()` stamps
   * `role="menuitemcheckbox"` whenever `type` changes, overwriting anything the template sets. This
   * observer rewrites that role to `menuitemradio` on every appearance. `aria-checked` stays
   * Web Awesome-managed: the item keys it on `type === 'checkbox'`, not on the role attribute, and
   * `"true"/"false"` is exactly what `menuitemradio` requires. An observer — rather than a one-shot
   * fix after first render — also stays correct across Web Awesome upgrades that re-write the role
   * at times the current build does not. See #767.
   */
  private _roleObserver = new MutationObserver(() => this._fixRoles());

  private _fixRoles(): void {
    for (const item of this.renderRoot.querySelectorAll('wa-dropdown-item[role="menuitemcheckbox"]')) {
      item.setAttribute('role', 'menuitemradio');
    }
  }

  protected firstUpdated(): void {
    // No teardown needed: the observer watches this component's own shadow root, a self-contained
    // cycle the GC collects with the element, and it keeps working across detach/re-attach.
    this._roleObserver.observe(this.renderRoot, {
      subtree: true,
      attributes: true,
      attributeFilter: ['role']
    });
    // Corrective sweep for any item whose first update beat the observer.
    this._fixRoles();
  }

  private _triggerIcon(): string {
    return APPEARANCES.find((o) => o.value === this._appearance)?.icon ?? 'robot';
  }

  /**
   * `wa-dropdown` owns selection, and both of its paths — the click handler on its shadow `#menu`
   * and the Enter/Space branch of its document `keydown` handler — funnel into `makeSelection()`,
   * which flips `item.checked` itself before emitting `wa-select`. Listening for `click` on the
   * items lost both ways round (#50). Keyboard selection dispatches no click, so Enter moved the
   * checkmark without ever changing the theme. And on a real mouse click the browser runs a
   * microtask checkpoint between listeners, so Lit's re-render committed the new checkmark *before*
   * `makeSelection()` toggled it straight back off; because `checked` is a non-reflecting property,
   * that toggle was invisible to the template binding, which still believed it had committed
   * `true`, so the next click on the same item re-rendered nothing and WA's toggle alone put the
   * checkmark right — one click late, exactly as reported.
   *
   * `wa-select` fires after that toggle and covers both input paths, so it is the single place
   * selection is handled here.
   */
  private _onSelect = (event: CustomEvent<{ item: Element }>) => {
    const { option, themeOption } = (event.detail.item as HTMLElement).dataset;
    // The lookups double as validation: an item this picker did not render selects nothing.
    const appearance = APPEARANCES.find((o) => o.value === option);
    if (appearance) {
      setAppearance(appearance.value);
      this._appearance = appearance.value;
    }
    const theme = THEMES.find((t) => t.id === themeOption);
    if (theme) {
      setThemeName(theme.id);
      this._theme = theme.id;
    }
    this._syncChecked();
  };

  /**
   * Re-derives every checkmark from the two axes, so `makeSelection()`'s toggle never survives as
   * state. This cannot be a `?checked` binding in the template: re-selecting the option that is
   * already active leaves both axes unchanged, so nothing re-renders and the toggle would stand,
   * silently unchecking the very option the user just confirmed.
   */
  private _syncChecked(): void {
    for (const item of this.renderRoot.querySelectorAll('wa-dropdown-item')) {
      const { option, themeOption } = item.dataset;
      item.checked =
        option === undefined ? themeOption === this._theme : option === this._appearance;
    }
  }

  protected updated(): void {
    this._syncChecked();
  }

  render() {
    return html`
      <wa-dropdown placement="bottom-end" @wa-select=${this._onSelect}>
        <wa-button slot="trigger" id="theme-trigger" appearance="plain" pill variant="brand">
          <wa-icon name=${this._triggerIcon()} label="Theme" class="wa-font-size-l"></wa-icon>
        </wa-button>

        <h6 id=${APPEARANCE_LABEL_ID} class="group-label" aria-hidden="true">Appearance</h6>
        ${APPEARANCES.map(
          (option) => html`
            <wa-dropdown-item
              data-option=${option.value}
              type="checkbox"
              aria-describedby=${APPEARANCE_LABEL_ID}>
              <wa-icon slot="icon" name=${option.icon}></wa-icon>
              ${option.label}
            </wa-dropdown-item>
          `
        )}

        <wa-divider></wa-divider>

        <h6 id=${THEME_LABEL_ID} class="group-label" aria-hidden="true">Theme</h6>
        ${THEMES.map(
          (theme) => html`
            <wa-dropdown-item
              data-theme-option=${theme.id}
              type="checkbox"
              aria-describedby=${THEME_LABEL_ID}>
              <wa-icon slot="icon" name=${theme.icon}></wa-icon>
              ${theme.label}
            </wa-dropdown-item>
          `
        )}
      </wa-dropdown>
      <wa-tooltip for="theme-trigger">Theme</wa-tooltip>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-theme-picker': CcaThemePicker;
  }
}
