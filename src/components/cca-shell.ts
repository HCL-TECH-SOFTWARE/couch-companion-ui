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

import { LitElement, html, css, unsafeCSS, nothing } from "lit";
import { customElement, state, query } from "lit/decorators.js";
import { getContext } from "../context.js";
import { getLogger } from "../services/log-service.js";
import type { AuthState } from "../services/auth-service.js";
import {
  beginRpLogout,
  readRpLogout,
  redirectUriFor,
} from "../services/oidc-service.js";

const log = getLogger("components/cca-shell");
import type { Route } from "../router.js";
import type { Banner } from "../types/api.js";
import type { NavItem } from "../types/plugin.js";
import "../webawesome.js";
import "./cca-banner.js";
import "./cca-login.js";
import { matchesNavPath, NAV_RAIL_COLLAPSED_WIDTH } from "./cca-nav.js";
import "./cca-header.js";
import "./cca-not-found.js";
import "./cca-breadcrumb.js";
import "./cca-nav-header.js";
import "./cca-logout-dialog.js";
import type { CcaLogoutDialog } from "./cca-logout-dialog.js";
import "./server-dashboard/cca-server-dashboard.js";
import { SINGLE_SERVER_ID } from "../services/single-server.js";

/**
 * `localStorage` key persisting the nav rail's collapsed state (#51). Same shape as
 * `theme-service.ts`'s `APPEARANCE_STORAGE_KEY`/`THEME_NAME_STORAGE_KEY`: read once on
 * connect, written on every toggle. keep-admin-ui's equivalent does not persist this at
 * all — it resets to collapsed on every load — so this key has no counterpart there.
 */
export const NAV_COLLAPSED_STORAGE_KEY = "ccaNavCollapsed";

/** Top-level app shell — owns navigation layout, route rendering, and plugin lifecycle. Only mounted when authenticated. */
@customElement("cca-shell")
export class CcaShell extends LitElement {
  static styles = css`
    wa-page {
      --menu-width: 15rem;
      --aside-width: 0;
    }

    /* #51: the collapsed rail — icon-only, driven by wa-page's own --menu-width custom
       property, the same mechanism the existing rule above already relies on. */
    wa-page.nav-collapsed {
      --menu-width: ${unsafeCSS(NAV_RAIL_COLLAPSED_WIDTH)};
    }

    wa-page[view="desktop"] {
      [slot*="navigation"] {
        border-inline-end: var(--wa-border-width-s) var(--wa-border-style)
          var(--wa-color-surface-border);
      }
    }
    wa-page[view="mobile"] {
      --menu-width: auto;
      --aside-width: auto;
    }
    /* A bare "wa-page.nav-collapsed" rule and the mobile rule above tie on specificity
       (one class, one attribute selector), so source order would decide the winner. This
       combined selector outranks both, so mobile always wins regardless of order: the rail
       stays full width in the drawer no matter what the desktop toggle was last set to. */
    wa-page[view="mobile"].nav-collapsed {
      --menu-width: auto;
      --aside-width: auto;
    }

    wa-page::part(menu) {
      /* Clips nav-header/nav/footer labels while the rail is collapsed so nothing peeks
         past the icon column; see the fixed icon-column width in cca-nav.ts. */
      overflow-x: hidden;
    }
    /* #113: wa-page's own rail is a grid pinned to "height: 100%" whose three rows are each
       "minmax(0, ...)" — a 0 minimum. Once navigation-header + navigation + navigation-footer
       need more room than the menu has (below roughly 937px of viewport height, so nearly
       everyone), the middle row is squashed instead of overflowing: cca-nav's links spill out
       of their row, and the opaque navigation-footer — wa-page paints every slotted element
       with --wa-color-surface-default — repaints straight over them. Logout disappears and
       its click target goes with it.

       Letting the rail take its content height hands that overflow up to part(menu), which
       already carries its own "overflow: auto", so the whole rail scrolls as one. min-height
       keeps it filling the menu whenever there IS room, so the footer stays bottom-pinned in
       the common case. Desktop-only by construction: the mobile drawer forwards the same
       slots without any part=navigation wrapper, so it never matches this rule. */
    wa-page::part(navigation) {
      height: auto;
      min-height: 100%;
    }
    wa-page::part(body) {
      transition: grid-template-columns 200ms ease-in-out;
    }

    .nav-collapse-toggle {
      position: fixed;
      /* --banner-height/--header-height/--subheader-height are wa-page's own computed custom
       * properties (measured from the slotted banner/header/subheader via ResizeObserver) and
       * inherit down to this button, a plain light-DOM child of <wa-page>. Without them, "top"
       * was measured from the viewport's top edge, not from where the nav rail actually starts
       * below that chrome — the button floated over the banner, nowhere near the menu it
       * toggles.
       *
       * wa-page's own grid stacks banner/header/subheader as full-width rows ABOVE the
       * menu/main/aside row — navigation-header (the CouchCompanion/Server/User block) is a
       * separate block stacked at the *top of the rail itself*, not part of what those three
       * height vars measure. So sitting "below the header" means past navigation-header's own
       * height too, not centered inside it: add its full height (same formula the
       * [slot="navigation-header"] rule above uses), not half of it.
       *
       * The + 6px is a live-measured correction on top of that formula, not a derived value:
       * ResizeObserver's contentBoxSize (which sets --header-height/--subheader-height) always
       * excludes border regardless of box-sizing, so each bordered slot above this rail
       * (header, subheader — see their border-block-end rules) undercounts by its own border
       * width. That accounts for some but not all of it; the rest wasn't traceable without a
       * live render, so this is pinned to what was actually measured on screen rather than
       * left slightly off. */
      top: calc(
        var(--banner-height, 0px) + var(--header-height, 0px) + var(--subheader-height, 0px) +
          var(--wa-form-control-height) + 2 * var(--wa-space-xs) + 6px
      );
      /* left: var(--menu-width) puts the button flush with the rail's trailing edge. The
       * earlier "- var(--wa-space-m)" pulled it 16px back into the rail — off by exactly
       * wa-space-m, not a smaller nudge — clipping it behind the icon column instead of
       * sitting on the border the way the border-radius/border-inline-start:0 styling below
       * assumes. */
      left: var(--menu-width);
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      width: var(--wa-space-l);
      height: var(--wa-space-2xl);
      padding: 0;
      border: var(--wa-border-width-s) var(--wa-border-style)
        var(--wa-color-surface-border);
      border-inline-start: 0;
      border-radius: 0 var(--wa-border-radius-l) var(--wa-border-radius-l) 0;
      background-color: var(--wa-color-surface-raised);
      color: var(--wa-color-text-normal);
      cursor: pointer;
      transition: left 200ms ease-in-out;
    }
    /* Desktop-only affordance: mobile uses wa-page's own drawer, where a rail toggle makes
       no sense. CSS-only guard reusing the "view" attribute wa-page already reflects and
       this stylesheet already selects on above — no matchMedia/isMobile state needed just
       to hide a button. */
    wa-page[view="mobile"] .nav-collapse-toggle {
      display: none;
    }

    [slot="banner"] {
      --wa-color-text-link: var(--wa-color-neutral-on-loud);
      background-color: var(--wa-color-neutral-fill-loud);
    }
    /* Announcement banner is a danger surface spanning the full banner cell;
       the host (not just the inner <p>) is painted so no neutral backdrop
       shows through. */
    cca-banner[slot="banner"] {
      --wa-color-text-link: var(--wa-color-danger-on-loud);
      background-color: var(--wa-color-danger-fill-loud);
    }
    [slot="header"] {
      --wa-link-decoration-default: none;
      border-block-end: var(--wa-border-width-s) var(--wa-border-style)
        var(--wa-color-surface-border);
    }
    [slot*="header"] a {
      font-weight: var(--wa-font-weight-action);
    }
    [slot="subheader"] {
      background-color: var(--wa-color-surface-lowered);
      border-block-end: var(--wa-border-width-s) var(--wa-border-style)
        var(--wa-color-surface-border);
    }
    [slot="navigation-header"] {
      border-block-end: var(--wa-border-width-s) var(--wa-border-style)
        var(--wa-color-surface-border);
    }

    [slot*="navigation"] a {
      --wa-color-text-link: var(--wa-color-text-normal);
    }
    [slot="navigation-footer"] {
      width: 100%;
      box-sizing: border-box;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      gap: var(--wa-space-xs);
      padding: var(--wa-space-s);
      border-block-start: var(--wa-border-width-s) var(--wa-border-style)
        var(--wa-color-surface-border);

      .wa-flank {
        --flank-size: 1.25em;
      }
    }

    [slot="navigation-footer"] a {
      display: inline-flex;
      align-items: center;
      gap: var(--wa-space-xs);
    }

    [slot="navigation"],
    [slot="navigation-header"],
    [slot="navigation-footer"] {
      border-inline-end: var(--wa-border-width-s) var(--wa-border-style)
        var(--wa-color-surface-border);
      border-block-end: var(--wa-border-width-s) var(--wa-border-style)
        var(--wa-color-surface-border);
    }
    [slot="navigation-header"] {
      height: calc(var(--wa-form-control-height) + (2 * var(--wa-space-xs)));
      display: flex;
      align-items: center;
      box-sizing: border-box;
      padding: 0 var(--wa-space-l);
    }

    [slot="main-header"] {
      height: calc(var(--wa-form-control-height) + (2 * var(--wa-space-xs)));
      display: flex;
      align-items: center;
      box-sizing: border-box;
      border-block-end: var(--wa-border-width-s) var(--wa-border-style)
        var(--wa-color-surface-border);
    }
    [slot="navigation-footer"] {
      font-size: var(--wa-font-size-s);
    }
    [slot="main-footer"] {
      border-block-start: var(--wa-border-width-s) var(--wa-border-style)
        var(--wa-color-surface-border);
    }
    [slot="footer"] {
      --wa-color-text-link: var(--wa-color-text-quiet);
      background-color: var(--wa-color-surface-lowered);
      font-size: var(--wa-font-size-s);
    }
  `;
  @state() private auth: AuthState = {
    authenticated: false,
    username: null,
    companionServer: null,
    roles: [],
    kind: "cookie",
  };
  @state() private currentPath = "/";
  @state() private currentRoute: Route | null = null;
  @state() private routeParams: Record<string, string> = {};
  @state() private navItems: NavItem[] = [];
  @state() private banner: Banner = {};

  /** The desktop toggle's own state, persisted under {@link NAV_COLLAPSED_STORAGE_KEY}. */
  @state() private collapsed = false;
  /**
   * True once `<wa-page>` has reflected `view="mobile"`. Read off that attribute rather than
   * a duplicate `matchMedia`/breakpoint check — `wa-page` already computes this from its own
   * `ResizeObserver`, and this repo's CSS already selects on the same attribute (see
   * `wa-page[view="mobile"]` above), so there is nothing left to duplicate or drift from.
   */
  @state() private isMobile = false;

  @query("wa-page") private waPageEl?: HTMLElement;
  @query("cca-logout-dialog") private logoutDialog?: CcaLogoutDialog;
  private navViewObserver?: MutationObserver;

  private unsubAuth?: () => void;
  private unsubRouter?: () => void;
  private bannerExpiryTimer?: ReturnType<typeof setTimeout>;
  private pluginsLoaded = false;
  private pluginsLoading: Promise<void> | null = null;

  async connectedCallback() {
    super.connectedCallback();
    const ctx = getContext();

    this.collapsed = localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY) === "true";

    this.auth = ctx.auth.state;
    this.unsubAuth = ctx.auth.subscribe((state) => {
      this.auth = state;
      if (state.authenticated) {
        this.loadPlugins();
      }
    });

    this.unsubRouter = ctx.router.subscribe((route, params) => {
      this.currentRoute = route;
      this.routeParams = params;
      this.currentPath = ctx.router.currentPath();
      // Lazy-load plugin module for the matched route's component. Not awaited —
      // the router subscription callback itself is fire-and-forget — but the
      // rejection still needs a home: ensureComponentLoaded already logs the
      // failure itself before rethrowing, so this just prevents a duplicate,
      // uncaught-in-promise report for the same error.
      if (route) {
        getContext().plugins.ensureComponentLoaded(route.component).catch(() => undefined);
      }
      // The :serverId segment is no longer a selection to mirror — it is the
      // SINGLE_SERVER_ID constant, handed to the view as a route param like
      // any other (#31). Nothing rewrites it, so deep links stay verbatim.
    });

    // Register overview route. This deployment manages exactly one CouchDB
    // (spec D2/D3), so the landing page is that server's own dashboard — there
    // is no fleet left for a fleet-wide dashboard to summarise.
    ctx.router.addRoute({
      path: "/",
      component: "cca-server-dashboard",
      label: "Overview",
      params: { serverId: SINGLE_SERVER_ID },
    });

    // The /servers list and per-server dashboard retired with it; keep their
    // URLs resolvable so bookmarks and back-button history land on the same
    // information rather than on the not-found page.
    ctx.router.addRedirect("/servers", "/");
    ctx.router.addRedirect("/servers/:serverId", "/");

    if (this.auth.authenticated) {
      await this.loadPlugins();
    }

    ctx.router.resolve();

    const fetched = await ctx.bannerAdmin.getActiveBanner();
    this.applyBanner(fetched);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubAuth?.();
    this.unsubRouter?.();
    clearTimeout(this.bannerExpiryTimer);
    this.navViewObserver?.disconnect();
  }

  protected firstUpdated() {
    this.syncIsMobile();
    if (this.waPageEl) {
      this.navViewObserver = new MutationObserver(() => this.syncIsMobile());
      this.navViewObserver.observe(this.waPageEl, {
        attributes: true,
        attributeFilter: ["view"],
      });
    }
  }

  private syncIsMobile() {
    this.isMobile = this.waPageEl?.getAttribute("view") === "mobile";
  }

  /**
   * The rail collapse is a desktop affordance — on mobile the navigation lives in
   * `wa-page`'s own drawer, where an icon-only rail makes no sense (mirrors
   * keep-admin-ui's `get expanded()`, inverted). The desktop toggle's own state is left
   * untouched so it survives a trip through a narrow viewport and back.
   */
  private get railCollapsed(): boolean {
    return !this.isMobile && this.collapsed;
  }

  private readonly toggleNavCollapsed = (): void => {
    this.collapsed = !this.collapsed;
    localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, String(this.collapsed));
  };

  private applyBanner(b: Banner) {
    clearTimeout(this.bannerExpiryTimer);
    this.bannerExpiryTimer = undefined;

    if (b.until == null) {
      this.banner = b;
      return;
    }

    const expiry = Date.parse(b.until);
    if (Number.isNaN(expiry)) {
      log.error("banner: unparseable until", { until: b.until });
      this.banner = b;
      return;
    }

    const remaining = expiry - Date.now();
    if (remaining <= 0) {
      this.banner = {};
      return;
    }

    this.banner = b;
    this.bannerExpiryTimer = setTimeout(() => {
      this.banner = {};
    }, remaining);
  }

  private async loadPlugins() {
    if (this.pluginsLoaded) {
      return;
    }

    if (this.pluginsLoading) {
      await this.pluginsLoading;
      return;
    }

    const ctx = getContext();
    this.pluginsLoading = (async () => {
      await ctx.plugins.discoverAndRegister();
      this.navItems = ctx.plugins.getNavItems();
      this.pluginsLoaded = true;
    })();

    try {
      await this.pluginsLoading;
    } finally {
      this.pluginsLoading = null;
    }
  }

  /**
   * Programmatic navigation — updates browser history and internal state.
   * @param path - URL path to navigate to
   */
  navigate(path: string) {
    getContext().router.navigate(path);
    this.currentPath = getContext().router.currentPath();
  }

  /**
   * Logout entry point, now inside the main nav list itself rather than the
   * navigation-footer (moved there for #53, moved again here per the repo owner).
   * `cca-nav.ts` owns the click handling and `preventDefault()` — this only reacts to
   * the `logout` event it dispatches once that's done.
   *
   * Since #24 this asks first rather than logging out on the spot: the dialog is where the
   * "Full logout from IdP" choice lives, and on a shared machine that choice is the difference
   * between signing out and appearing to.
   */
  private handleLogout = () => {
    this.logoutDialog?.open();
  };

  /**
   * Performs the confirmed logout, **local teardown first, redirect second**.
   *
   * That order is the whole point. The redirect leaves this page and is not guaranteed to come
   * back — the provider may reject the request, the user may abandon its confirmation screen —
   * and a local session that outlived a logout the user asked for is exactly the bug #24 is
   * about. Reading {@link readRpLogout} before `auth.logout()` is what makes the order possible:
   * teardown deliberately forgets that record.
   */
  private handleLogoutConfirmed = (e: Event) => {
    const { everywhere } = (e as CustomEvent<{ everywhere: boolean }>).detail;
    const rp = everywhere ? readRpLogout() : null;
    getContext().auth.logout();
    if (rp) {
      log.debug?.("ending the identity provider session as well");
      beginRpLogout(rp, redirectUriFor(window.location.href));
    }
  };

  private renderContent() {
    if (!this.currentRoute) {
      return html`<cca-not-found>${this.currentPath}</cca-not-found>`;
    }
    const tag = this.currentRoute.component;
    return html`${this.createElement(tag, this.routeParams)}`;
  }

  private createElement(tag: string, params: Record<string, string>) {
    const el = document.createElement(tag);
    // Pass route params as properties so plugin components can read them
    for (const [key, value] of Object.entries(params)) {
      let decoded = value;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        // Keep original value if URL decoding fails.
      }
      (el as unknown as Record<string, unknown>)[key] = decoded;
    }
    return el;
  }

  private getHeaderTitle(): string {
    // Try to find the active nav item by currentPath
    const active = this.navItems.find((item) =>
      matchesNavPath(item.path, this.currentPath),
    );
    if (active) return active.label;
    // Fallback to route label (e.g. for Home or unknown routes)
    return this.currentRoute?.label ?? "";
  }

  render() {
    const collapsed = this.railCollapsed;
    return html`
      <wa-page class=${this.collapsed ? "nav-collapsed" : ""}>
        ${
          this.banner.message
            ? html`<cca-banner
                slot="banner"
                .message=${this.banner.message}
                .icon=${this.banner.icon}
                .link=${this.banner.link}
              ></cca-banner>`
            : nothing
        }
        <cca-nav-header
          slot="navigation-header"
          companionServer=${this.auth.companionServer ?? "n/a"}
          userName=${this.auth.username ?? "Anonymous"}
          ?collapsed=${collapsed}
        ></cca-nav-header>
        <cca-nav
          slot="navigation"
          .navItems=${this.navItems}
          .currentPath=${this.currentPath}
          ?collapsed=${collapsed}
          @logout=${this.handleLogout}
        ></cca-nav>
        <div slot="navigation-footer">
          <a
            id="nav-footer-news"
            href="https://blog.couchdb.org/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <wa-icon name="newspaper"></wa-icon>
            ${collapsed ? nothing : "News"}
          </a>
          ${
            collapsed
              ? html`<wa-tooltip for="nav-footer-news" placement="right"
                  >News</wa-tooltip
                >`
              : nothing
          }
          <a
            id="nav-footer-docs"
            href="https://docs.couchdb.org/en/latest/"
            target="_blank"
            rel="noopener noreferrer"
          >
            <wa-icon name="book"></wa-icon>
            ${collapsed ? nothing : "Documentation"}
          </a>
          ${
            collapsed
              ? html`<wa-tooltip for="nav-footer-docs" placement="right"
                  >Documentation</wa-tooltip
                >`
              : nothing
          }
        </div>
        <cca-breadcrumb slot="subheader"></cca-breadcrumb>
        <cca-header
          slot="main-header"
          .pageTitle=${this.getHeaderTitle() ?? ""}
        ></cca-header>
        <main>${this.renderContent()}</main>
        <button
          type="button"
          class="nav-collapse-toggle"
          aria-label=${this.collapsed ? "Expand navigation" : "Collapse navigation"}
          aria-expanded=${this.collapsed ? "false" : "true"}
          @click=${this.toggleNavCollapsed}
        >
          <wa-icon
            name=${this.collapsed ? "chevron-right" : "chevron-left"}
          ></wa-icon>
        </button>
        <cca-logout-dialog
          @logout-confirmed=${this.handleLogoutConfirmed}
        ></cca-logout-dialog>
      </wa-page>
    `;
  }
}
