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

import { LitElement, html, css, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { NavItem } from '../types/plugin.js';
import { ifDefined } from 'lit/directives/if-defined.js';

/**
 * Rail width when `cca-shell.ts`'s toggle has collapsed the nav — icon-only, no labels.
 * Defined here (rather than in `cca-shell.ts`, which owns the toggle) because `cca-shell.ts`
 * already imports from this module for {@link matchesNavPath}; the reverse import would be
 * circular and, since both modules read the value at class-definition time via `static
 * styles`, would throw a temporal-dead-zone `ReferenceError` on load. `cca-nav`'s icon column
 * below is the same width, so the label sits entirely past the visible edge and the
 * `overflow-x: hidden` on `wa-page::part(menu)` (`cca-shell.ts`) clips it cleanly rather than
 * leaving a stray sliver of text.
 */
export const NAV_RAIL_COLLAPSED_WIDTH = '3.5rem';

/** True when a nav item's path covers the given resolved path — `$all` segments match any value. */
export function matchesNavPath(itemPath: string, currentPath: string): boolean {
  const nav = itemPath.split('/').filter(Boolean);
  const cur = currentPath.split('/').filter(Boolean);
  if (cur.length < nav.length) return false;
  return nav.every((seg, i) => seg === '$all' || seg === cur[i]);
}

@customElement('cca-nav')
export class CcaNav extends LitElement {
  static styles = css`
    :host {
      /* wa-page imposes a default 16px padding (plus flex/gap) on whatever is slotted into
       * "navigation", via an internal selector with higher specificity than a bare :host rule
       * (confirmed empirically — a plain "padding: 0" here is silently outranked; only
       * !important wins). Fine at the 15rem expanded width, but it eats a third of the entire
       * 3.5rem collapsed rail (NAV_RAIL_COLLAPSED_WIDTH), leaving only 24px for a 56px-wide
       * icon column and clipping every icon in half. This component owns its own spacing via
       * each link's own padding below, so it resets wa-page's default rather than fighting it
       * from inside .nav-icon's width.
       */
      padding: 0 !important;
      border-inline-end: var(--wa-border-width-s) var(--wa-border-style) var(--wa-color-surface-border);
    }
    a {
      display: flex;
      align-items: center;
      gap: var(--wa-space-xs);
      padding: var(--wa-space-xs) var(--wa-space-s);
      color: var(--wa-color-text-normal);
      text-decoration: none;
      white-space: nowrap;
      box-sizing: border-box;
    }

    /* Collapsed: .nav-icon below is fixed-width and flex-shrink:0, sized to fill the whole
       rail on its own (NAV_RAIL_COLLAPSED_WIDTH === cca-shell's collapsed --menu-width) — it
       assumes it starts flush at the host's left edge. The anchor's own horizontal padding
       broke that assumption: 12px of it landed before .nav-icon, pushing .nav-icon's box
       12px past the rail's visible width, so its own centered glyph rendered off-center
       within the clipped remainder — dead space on the left, icon crowded to the right.
       Zeroing inline padding only when collapsed restores "starts flush at 0" without
       touching the expanded layout, where that padding is what gives the icon+label row
       its normal inset. */
    :host([collapsed]) a {
      padding-inline: 0;
    }

    a.active {
      color: var(--wa-color-brand-fill-loud);
      font-weight: var(--wa-font-weight-bold);
    }

    a:hover {
      text-decoration: underline;
    }

    /*
     * A fixed column, not a shrink-to-fit icon: this is what makes the "collapsed" rail
     * icon-only rather than icon-plus-a-sliver-of-clipped-text. It is the same width as
     * cca-shell.ts's collapsed --menu-width, so the label starts exactly where the visible
     * rail ends and wa-page::part(menu)'s overflow-x: hidden clips it in full.
     */
    .nav-icon {
      display: inline-flex;
      flex-shrink: 0;
      justify-content: center;
      width: ${unsafeCSS(NAV_RAIL_COLLAPSED_WIDTH)};
    }
  `;
  @property({ type: Array }) navItems: NavItem[] = [];
  @property({ type: String }) currentPath = '/';
  /** True while cca-shell.ts's rail toggle has collapsed the nav to icon-only.
   *  Reflected to an attribute so :host([collapsed]) below can key off it. */
  @property({ type: Boolean, reflect: true }) collapsed = false;

  private isActive(path: string) {
    return matchesNavPath(path, this.currentPath);
  }

  private placeholders: NavItem[] = [
    { label: 'Setup', path: '/setup', icon: 'gears', order: 4 },
    { label: 'Active Tasks', path: '/active-tasks/$all', icon: 'tasks', order: 5 },
    {
      label: 'Configuration',
      path: '/configuration/$all',
      icon: 'sliders',
      order: 6
    }
  ];

  /** `wa-tooltip`'s `for` target needs a stable, DOM-unique id per link. */
  private navId(path: string): string {
    return `nav-item-${path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  private renderLink(id: string, href: string, icon: string | undefined, label: string, active: boolean) {
    return html`
      <a id=${id} class=${`nav-button ${active ? 'active' : ''}`} href=${href}>
        <span class="nav-icon"><wa-icon name=${ifDefined(icon)}></wa-icon></span>
        <span class="nav-label">${label}</span>
      </a>
      ${this.collapsed ? html`<wa-tooltip for=${id} placement="right">${label}</wa-tooltip>` : nothing}
    `;
  }

  /**
   * Logout is an action, not a route — same visual treatment as a real nav link
   * (icon column, label, collapsed tooltip) via the same markup `renderLink` produces,
   * but `href="#"` with its default prevented and a `logout` event dispatched instead of
   * a hash navigation. Kept out of `renderLink` itself (which every real item still uses
   * unchanged) since context/auth access belongs to `cca-shell.ts`, not this otherwise
   * presentational component.
   */
  private renderLogout() {
    const id = 'nav-logout';
    return html`
      <a
        id=${id}
        class="nav-button"
        href="#"
        @click=${(e: Event) => {
          e.preventDefault();
          this.dispatchEvent(new CustomEvent('logout', { bubbles: true, composed: true }));
        }}
      >
        <span class="nav-icon"><wa-icon name="person-through-window"></wa-icon></span>
        <span class="nav-label">Logout</span>
      </a>
      ${this.collapsed ? html`<wa-tooltip for=${id} placement="right">Logout</wa-tooltip>` : nothing}
    `;
  }

  render() {
    const allItems = [...this.navItems, ...this.placeholders].sort((a, b) => a.order - b.order);

    return html`
      ${this.renderLink('nav-home', '#/', 'home', 'Home', this.currentPath === '/')}
      ${allItems.map((item) =>
        this.renderLink(
          this.navId(item.path),
          `#${item.path}`,
          item.icon ?? undefined,
          item.label,
          this.isActive(item.path)
        )
      )}
      ${this.renderLogout()}
    `;
  }
}
