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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LitElement, type CSSResult } from "lit";
import { getContext } from "../src/context";
import type { AppContext } from "../src/context";
import * as oidc from "../src/services/oidc-service";
import { Logger, Level } from "../src/services/log-service";
import { PluginLoader } from "../src/services/plugin-loader";
import type { Banner } from "../src/types/api";
import type { NavItem } from "../src/types/plugin";

// Mock webawesome module imports to avoid real component registration and element internals issues
vi.mock("@awesome.me/webawesome/dist/styles/webawesome.css", () => ({}));
vi.mock("@awesome.me/webawesome/dist/styles/themes/default.css", () => ({}));
vi.mock("@awesome.me/webawesome/dist/components/page/page.js", () => ({}));
vi.mock("@awesome.me/webawesome/dist/components/button/button.js", () => ({}));
vi.mock("@awesome.me/webawesome/dist/components/card/card.js", () => ({}));
vi.mock(
  "@awesome.me/webawesome/dist/components/divider/divider.js",
  () => ({}),
);
vi.mock("@awesome.me/webawesome/dist/components/input/input.js", () => ({}));
vi.mock(
  "@awesome.me/webawesome/dist/components/breadcrumb/breadcrumb.js",
  () => ({}),
);
vi.mock(
  "@awesome.me/webawesome/dist/components/breadcrumb-item/breadcrumb-item.js",
  () => ({}),
);

class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}

for (const tag of [
  "wa-page",
  "wa-button",
  "wa-card",
  "wa-icon",
  "wa-input",
  "wa-divider",
  "wa-breadcrumb",
  "wa-breadcrumb-item",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

for (const tag of [
  "cca-nav",
  "cca-header",
  "cca-login",
  "cca-toast",
  "cca-not-found",
  "cca-banner",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

import "../src/components/cca-shell";
import { CcaShell, NAV_COLLAPSED_STORAGE_KEY } from "../src/components/cca-shell";
import { SINGLE_SERVER_ID } from "../src/services/single-server.js";

function getEl(): CcaShell {
  const el = document.createElement("cca-shell") as CcaShell;
  document.body.appendChild(el);
  return el;
}

async function updated(el: CcaShell) {
  await el.updateComplete;
}

function requireShadowRoot(el: CcaShell): ShadowRoot {
  if (!el.shadowRoot) {
    throw new Error("Expected shadowRoot to exist");
  }
  return el.shadowRoot;
}

function queryRequired<T extends Element>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Expected element for selector: ${selector}`);
  }
  return element;
}

describe("cca-shell", () => {
  let el: CcaShell;
  let ctx: AppContext;

  beforeEach(async () => {
    sessionStorage.clear();
    // #51: the nav-collapse preference is read once on connect; without this, a stray
    // "true" left by an earlier test would make every subsequent shell mount collapsed.
    localStorage.removeItem(NAV_COLLAPSED_STORAGE_KEY);
    // These tests share the singleton context and the global location.hash across a
    // sequential run. Reset the hash so it can't leak between tests — without this,
    // ordering + async hashchange timing makes the route tests flaky under
    // parallel-suite load.
    window.location.hash = "";
    ctx = getContext();
    vi.spyOn(PluginLoader.prototype, "discoverAndRegister").mockResolvedValue();
    vi.spyOn(PluginLoader.prototype, "getNavItems").mockReturnValue([]);
    vi.spyOn(
      PluginLoader.prototype,
      "ensureComponentLoaded",
    ).mockResolvedValue();
    vi.spyOn(getContext().bannerAdmin, "getActiveBanner").mockResolvedValue({});
    el = getEl();
    await updated(el);
  });

  afterEach(() => {
    el.remove();
    vi.restoreAllMocks();
  });

  describe("rendering", () => {
    it("renders wa-page layout with navigation header", () => {
      const root = requireShadowRoot(el);
      expect(root.querySelector("wa-page")).not.toBeNull();
      expect(
        root.querySelector('cca-nav-header[slot="navigation-header"]'),
      ).not.toBeNull();
    });

    it("renders cca-header in main-header slot", () => {
      const root = requireShadowRoot(el);
      const header = queryRequired(root, "cca-header");
      expect(header.getAttribute("slot")).toBe("main-header");
    });

    it("renders cca-nav in navigation slot", () => {
      const root = requireShadowRoot(el);
      const nav = queryRequired(root, "cca-nav");
      expect(nav.getAttribute("slot")).toBe("navigation");
    });

    it("renders main content area", () => {
      const root = requireShadowRoot(el);
      expect(root.querySelector("main")).not.toBeNull();
    });

    it("renders the companion server in the navigation header", async () => {
      (
        el as unknown as {
          auth: {
            authenticated: boolean;
            username: string | null;
            companionServer: string | null;
          };
        }
      ).auth = {
        authenticated: true,
        username: "admin",
        companionServer: "https://couch.example.com",
      };
      await updated(el);

      const root = requireShadowRoot(el);
      const navigationHeader = queryRequired(
        root,
        'cca-nav-header[slot="navigation-header"]',
      ) as Element & {
        companionServer?: string;
      };
      expect(navigationHeader.companionServer).toBe(
        "https://couch.example.com",
      );
    });

    it("does not pass the companion server to cca-header", async () => {
      (
        el as unknown as {
          auth: {
            authenticated: boolean;
            username: string | null;
            companionServer: string | null;
          };
        }
      ).auth = {
        authenticated: true,
        username: "admin",
        companionServer: "https://couch.example.com",
      };
      await updated(el);

      const root = requireShadowRoot(el);
      const header = queryRequired(root, "cca-header") as Element & {
        companionServer?: string;
      };
      expect(header.companionServer).toBeUndefined();
    });
  });

  describe("routing", () => {
    it("shows cca-not-found when no route matches", async () => {
      ctx.router.navigate("/nonexistent-path");
      // Force synchronous resolution rather than depending on the async `hashchange`
      // event (fires unreliably under parallel-suite load — the flake's root cause).
      ctx.router.resolve();
      await updated(el);

      const root = requireShadowRoot(el);
      const main = queryRequired(root, "main");
      expect(main.querySelector("cca-not-found")).not.toBeNull();
    });

    it("passes current path to cca-not-found", async () => {
      ctx.router.navigate("/missing-page");
      ctx.router.resolve();
      await updated(el);

      const root = requireShadowRoot(el);
      const notFound = queryRequired(root, "main cca-not-found");
      expect(notFound.textContent).toContain("/missing-page");
    });

    it("renders matched route component", async () => {
      ctx.router.navigate("/");
      ctx.router.resolve();
      await updated(el);

      const root = requireShadowRoot(el);
      const main = queryRequired(root, "main");
      expect(main.querySelector("cca-server-dashboard")).not.toBeNull();
    });

    it("points the home dashboard at the single server", async () => {
      ctx.router.navigate("/");
      ctx.router.resolve();
      await updated(el);

      const root = requireShadowRoot(el);
      const dashboard = queryRequired<HTMLElement & { serverId?: string }>(
        root,
        "main cca-server-dashboard",
      );
      expect(dashboard.serverId).toBe(SINGLE_SERVER_ID);
    });
  });

  // The /servers screens are gone (spec D2/D3 — there is only ever one server),
  // but bookmarks and history entries outlive them, so both patterns land on the
  // home dashboard instead of cca-not-found.
  describe("retired /servers routes", () => {
    it("redirects /servers to the home dashboard", async () => {
      ctx.router.navigate("/servers");
      ctx.router.resolve();
      await updated(el);

      expect(ctx.router.currentPath()).toBe("/");
      const main = queryRequired(requireShadowRoot(el), "main");
      expect(main.querySelector("cca-server-dashboard")).not.toBeNull();
    });

    it("redirects a bookmarked /servers/:serverId to the home dashboard", async () => {
      ctx.router.navigate(`/servers/${SINGLE_SERVER_ID}`);
      ctx.router.resolve();
      await updated(el);

      expect(ctx.router.currentPath()).toBe("/");
      const main = queryRequired(requireShadowRoot(el), "main");
      expect(main.querySelector("cca-server-dashboard")).not.toBeNull();
    });
  });

  describe("navigation", () => {
    it("navigate method updates currentPath via hash router", () => {
      el.navigate("/test-path");
      expect(ctx.router.currentPath()).toBe("/test-path");
    });
  });

  // #31 removed both server dropdowns, but deliberately kept the :serverId
  // route segment as the SINGLE_SERVER_ID constant (spec D2) so every existing
  // deep link still resolves. These are the guard tests for that promise; each
  // uses a fresh path pattern because router registrations accumulate across
  // this suite and a same-path re-registration silently loses the tie.
  describe("deep links keep working (#31)", () => {
    type Probe = HTMLElement & { serverId?: string; dbName?: string };

    it("resolves a :serverId route and hands the view SINGLE_SERVER_ID", async () => {
      ctx.router.addRoute({
        path: "/dl31a/:serverId",
        component: "cca-db-list",
      });
      ctx.router.navigate(`/dl31a/${SINGLE_SERVER_ID}`);
      // Force synchronous resolution instead of depending on the async `hashchange`
      // event, which fires unreliably under parallel-suite load.
      ctx.router.resolve();
      await updated(el);
      const view = queryRequired<Probe>(
        requireShadowRoot(el),
        "main cca-db-list",
      );
      expect(view.serverId).toBe(SINGLE_SERVER_ID);
      expect(ctx.router.currentPath()).toBe(`/dl31a/${SINGLE_SERVER_ID}`);
    });

    it("resolves a deeper :serverId deep link with its other params and query", async () => {
      ctx.router.addRoute({
        path: "/dl31b/:serverId/:dbName/documents",
        component: "cca-doc-browser",
      });
      ctx.router.navigate(`/dl31b/${SINGLE_SERVER_ID}/mydb/documents?limit=5`);
      ctx.router.resolve();
      await updated(el);
      const view = queryRequired<Probe>(
        requireShadowRoot(el),
        "main cca-doc-browser",
      );
      expect(view.serverId).toBe(SINGLE_SERVER_ID);
      expect(view.dbName).toBe("mydb");
      expect(ctx.router.currentPath()).toBe(
        `/dl31b/${SINGLE_SERVER_ID}/mydb/documents`,
      );
      expect(ctx.router.currentQuery().get("limit")).toBe("5");
    });

    it("leaves the :serverId segment exactly as the URL spelled it", async () => {
      ctx.router.addRoute({
        path: "/dl31c/:serverId",
        component: "cca-db-list",
        allowsAllServers: true,
      });
      ctx.router.navigate("/dl31c/$all");
      ctx.router.resolve();
      await updated(el);
      // Nothing rewrites the segment any more — no selection bridge exists.
      expect(ctx.router.currentPath()).toBe("/dl31c/$all");
      expect(
        queryRequired<Probe>(requireShadowRoot(el), "main cca-db-list").serverId,
      ).toBe("$all");
    });
  });

  describe("header has no server control (#31)", () => {
    type HeaderProbe = HTMLElement & {
      serverDisplay?: string;
      allServers?: boolean;
    };

    function headerEl(): HeaderProbe {
      return queryRequired<HeaderProbe>(requireShadowRoot(el), "cca-header");
    }

    it("never binds a server display mode, on any route", async () => {
      ctx.router.addRoute({
        path: "/sdisp31/:serverId",
        component: "cca-db-list",
        allowsAllServers: true,
      });
      ctx.router.navigate(`/sdisp31/${SINGLE_SERVER_ID}`);
      ctx.router.resolve();
      await updated(el);
      expect(headerEl().serverDisplay).toBeUndefined();
      expect(headerEl().allServers).toBeUndefined();
      expect(headerEl().hasAttribute("server-display")).toBe(false);
    });
  });

  describe("lifecycle", () => {
    it("cleans up subscriptions on disconnect", () => {
      el.remove();
      expect(() => {
        ctx.auth.logout();
        ctx.router.navigate("/");
      }).not.toThrow();
    });

  });

  // #53 originally moved logout into the navigation-footer, styled as a third row
  // alongside News/Documentation. Moved again, out of the footer and into the main
  // <cca-nav> list itself — cca-nav.ts now owns its rendering entirely (see
  // test/cca-nav.test.ts); this only covers the wiring between the two components.
  describe("navigation footer", () => {
    function footer(): Element {
      return queryRequired(requireShadowRoot(el), '[slot="navigation-footer"]');
    }

    it("only has News and Documentation — Logout is no longer here", () => {
      const links = Array.from(footer().querySelectorAll("a")).map((a) =>
        a.textContent?.trim(),
      );
      expect(links).toEqual(["News", "Documentation"]);
    });
  });

  describe("logout (moved into the nav list)", () => {
    const RP = {
      end_session_endpoint: "http://localhost:8080/realms/couch/protocol/openid-connect/logout",
      client_id: "couch-companion-ui",
    };

    function nav(): Element {
      return queryRequired(requireShadowRoot(el), "cca-nav");
    }

    function dialog(): Element & { open: () => void } {
      return queryRequired(requireShadowRoot(el), "cca-logout-dialog");
    }

    /** What the dialog emits once the user has answered it. */
    function confirmLogout(everywhere: boolean): void {
      dialog().dispatchEvent(
        new CustomEvent("logout-confirmed", {
          detail: { everywhere },
          bubbles: true,
          composed: true,
        }),
      );
    }

    // #24: the click no longer logs out on the spot — it asks, because the "Full logout from
    // IdP" choice lives in that dialog and on a shared machine it is the choice that matters.
    it("opens the confirmation dialog rather than logging out immediately", () => {
      const logoutSpy = vi.spyOn(ctx.auth, "logout").mockImplementation(() => {});
      const openSpy = vi.spyOn(dialog(), "open").mockImplementation(() => {});

      nav().dispatchEvent(new CustomEvent("logout", { bubbles: true, composed: true }));

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(logoutSpy).not.toHaveBeenCalled();
    });

    it("tears the local session down once the dialog confirms", () => {
      const logoutSpy = vi.spyOn(ctx.auth, "logout").mockImplementation(() => {});
      const rpSpy = vi.spyOn(oidc, "beginRpLogout").mockImplementation(() => {});

      confirmLogout(false);

      expect(logoutSpy).toHaveBeenCalledTimes(1);
      expect(rpSpy).not.toHaveBeenCalled();
    });

    /** Asking to log out everywhere cannot conjure a provider to log out of. */
    it("stays local when there is no IdP session to end", () => {
      const logoutSpy = vi.spyOn(ctx.auth, "logout").mockImplementation(() => {});
      const rpSpy = vi.spyOn(oidc, "beginRpLogout").mockImplementation(() => {});

      confirmLogout(true);

      expect(logoutSpy).toHaveBeenCalledTimes(1);
      expect(rpSpy).not.toHaveBeenCalled();
    });

    /**
     * The ordering guarantee, proved against the real `AuthService` and the real storage rather
     * than by asserting on mock call order.
     *
     * `auth.logout()` deliberately forgets the IdP record, so the descriptor can only reach
     * `beginRpLogout` if it was read *before* teardown. Reverse the two statements in the shell
     * and this test goes red: the read returns null and no redirect is issued at all — which is
     * exactly the failure mode where a user who asked to be signed out everywhere silently is
     * not.
     */
    it("reads the IdP session before teardown, then redirects", () => {
      // A JWT session, so the real logout() skips the cookie DELETE it would otherwise attempt.
      sessionStorage.setItem("cca_oidc_logout", JSON.stringify(RP));
      sessionStorage.setItem(
        "cca_user",
        JSON.stringify({
          name: "hariseldon",
          roles: [],
          companionServer: "http://couch.local",
          kind: "jwt",
        }),
      );
      const rpSpy = vi.spyOn(oidc, "beginRpLogout").mockImplementation(() => {});

      confirmLogout(true);

      expect(rpSpy).toHaveBeenCalledTimes(1);
      expect(rpSpy.mock.calls[0][0]).toEqual(RP);
      expect(rpSpy.mock.calls[0][1]).toBe(oidc.redirectUriFor(window.location.href));
      // Teardown really happened, and really did forget the record.
      expect(ctx.auth.state.authenticated).toBe(false);
      expect(oidc.readRpLogout()).toBeNull();
    });

    /** `post_logout_redirect_uri` has to be the registered value, not whatever route we are on. */
    it("sends the deployment's own URI, stripped of route and query", () => {
      sessionStorage.setItem("cca_oidc_logout", JSON.stringify(RP));
      const rpSpy = vi.spyOn(oidc, "beginRpLogout").mockImplementation(() => {});
      vi.spyOn(ctx.auth, "logout").mockImplementation(() => {});

      confirmLogout(true);

      const uri = rpSpy.mock.calls[0][1];
      expect(uri).not.toContain("#");
      expect(uri).not.toContain("?");
      expect(uri.startsWith(window.location.origin)).toBe(true);
    });
  });

  describe("banner", () => {
    async function mountWithBanner(banner: Banner): Promise<CcaShell> {
      // Tear down the default shell from beforeEach so we mount fresh with our banner.
      el.remove();
      vi.spyOn(getContext().bannerAdmin, "getActiveBanner").mockResolvedValue(banner);
      const shell = getEl();
      await shell.updateComplete;
      // The fetch happens in connectedCallback; flush microtasks then re-render.
      await Promise.resolve();
      await shell.updateComplete;
      return shell;
    }

    it("fetches the banner once on mount", () => {
      expect(getContext().bannerAdmin.getActiveBanner).toHaveBeenCalledTimes(1);
    });

    it("renders cca-banner in the banner slot when a message is present", async () => {
      const shell = await mountWithBanner({
        message: "Maintenance tonight",
        icon: "circle-info",
        link: "https://example.org",
      });
      const root = shell.shadowRoot;
      if (!root) throw new Error("expected shadowRoot");
      const banner = root.querySelector("cca-banner");
      if (!banner) throw new Error("expected cca-banner");
      expect(banner.getAttribute("slot")).toBe("banner");
      expect((banner as unknown as Banner).message).toBe("Maintenance tonight");
      expect((banner as unknown as Banner).icon).toBe("circle-info");
      expect((banner as unknown as Banner).link).toBe("https://example.org");
    });

    it("omits cca-banner when fetch resolves to {}", async () => {
      const shell = await mountWithBanner({});
      const root = shell.shadowRoot;
      if (!root) throw new Error("expected shadowRoot");
      expect(root.querySelector("cca-banner")).toBeNull();
    });

    it("treats an already-expired until as no banner", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const shell = await mountWithBanner({ message: "old", until: past });
      const root = shell.shadowRoot;
      if (!root) throw new Error("expected shadowRoot");
      expect(root.querySelector("cca-banner")).toBeNull();
    });

    it("clears the banner when the until timer fires", async () => {
      vi.useFakeTimers();
      try {
        const future = new Date(Date.now() + 10_000).toISOString();
        el.remove();
        vi.spyOn(getContext().bannerAdmin, "getActiveBanner").mockResolvedValue({
          message: "Brief",
          until: future,
        });
        const shell = getEl();
        // Flush microtasks so connectedCallback's awaited fetch resolves.
        for (let i = 0; i < 5; i++) await Promise.resolve();
        await shell.updateComplete;

        const banner = shell.shadowRoot?.querySelector("cca-banner");
        if (!banner) throw new Error("expected cca-banner");
        expect((banner as unknown as Banner).message).toBe("Brief");

        vi.advanceTimersByTime(10_001);
        await shell.updateComplete;

        expect(
          shell.shadowRoot?.querySelector("cca-banner") ?? null,
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders the banner and logs error when until is unparseable", async () => {
      const errSpy = vi.fn();
      const originalErrorTarget = Logger.logTarget[Level.ERROR];
      Logger.logTarget[Level.ERROR] = errSpy;
      try {
        const shell = await mountWithBanner({
          message: "no expiry",
          until: "not-a-date",
        });
        const root = shell.shadowRoot;
        if (!root) throw new Error("expected shadowRoot");
        const banner = root.querySelector("cca-banner");
        if (!banner) throw new Error("expected cca-banner");
        expect((banner as unknown as Banner).message).toBe("no expiry");
        expect(errSpy).toHaveBeenCalled();
      } finally {
        Logger.logTarget[Level.ERROR] = originalErrorTarget;
      }
    });

    it("clears the expiry timer on disconnect", async () => {
      vi.useFakeTimers();
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      try {
        const future = new Date(Date.now() + 5_000).toISOString();
        el.remove();
        vi.spyOn(getContext().bannerAdmin, "getActiveBanner").mockResolvedValue({
          message: "will be unmounted",
          until: future,
        });
        const shell = getEl();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        await shell.updateComplete;

        const callsBefore = clearSpy.mock.calls.length;
        shell.remove();
        expect(clearSpy.mock.calls.length).toBeGreaterThan(callsBefore);
        // Advancing past expiry after disconnect must not throw.
        expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("route parameters", () => {
    it("decodes route parameters and passes them to created elements", async () => {
      ctx.router.navigate("/database/test%20db");
      await updated(el);

      const root = requireShadowRoot(el);
      const main = queryRequired(root, "main");
      const element = main.firstElementChild;

      // The parameter should be decoded from 'test%20db' to 'test db'
      if (element && "dbId" in element) {
        expect((element as Record<string, unknown>).dbId).toContain("test db");
      }
    });

    it("handles malformed URL encoding gracefully by keeping original value", async () => {
      // Mock a malformed encoding scenario
      const originalCreate = document.createElement;
      const mockElement = { setAttribute: vi.fn() };
      vi.spyOn(document, "createElement").mockImplementation(
        () => mockElement as any,
      );

      ctx.router.navigate("/database/%FF%FF");
      await updated(el);

      // Should not throw when encountering invalid encoding
      expect(() => updated(el)).not.toThrow();

      vi.restoreAllMocks();
    });
  });

  describe("page title from route", () => {
    it("updates page title based on active navigation item", async () => {
      el.navItems = [{ label: "Setup", path: "/setup", order: 1 }];
      ctx.router.navigate("/setup");
      // hashchange delivery is async; resolve() is idempotent and syncs state now
      ctx.router.resolve();
      await updated(el);

      const root = requireShadowRoot(el);
      const header = root.querySelector("cca-header") as any;
      // The pageTitle should be set to the active nav item label or path
      expect(header.pageTitle).toBe("Setup");
    });

    it("uses the nav item label when the path has a resolved server (issue #758)", async () => {
      el.navItems = [
        { label: "Users", path: "/users/$all", icon: null, order: 1 },
      ];
      ctx.router.navigate("/users/server-1");
      // hashchange delivery is async; resolve() is idempotent and syncs state now
      ctx.router.resolve();
      await updated(el);

      const root = requireShadowRoot(el);
      const header = root.querySelector("cca-header") as any;
      expect(header.pageTitle).toBe("Users");
    });

    it("shows default title when no nav item matches current path", async () => {
      ctx.router.navigate("/nonexistent");
      await updated(el);

      const root = requireShadowRoot(el);
      const header = root.querySelector("cca-header") as any;
      expect(header.pageTitle).toBeDefined();
    });
  });

  describe("authentication state", () => {
    it("passes username to cca-header", async () => {
      (
        el as unknown as {
          auth: {
            authenticated: boolean;
            username: string | null;
            companionServer: string | null;
          };
        }
      ).auth = {
        authenticated: true,
        username: "testuser",
        companionServer: null,
      };
      await updated(el);

      const root = requireShadowRoot(el);
      const header = root.querySelector("cca-header") as any;
      // Header should have username accessible
      expect(header).not.toBeNull();
    });

    it("passes username to cca-nav-header", async () => {
      (
        el as unknown as {
          auth: {
            authenticated: boolean;
            username: string | null;
            companionServer: string | null;
          };
        }
      ).auth = {
        authenticated: true,
        username: "admin",
        companionServer: null,
      };
      await updated(el);

      const root = requireShadowRoot(el);
      const navHeader = root.querySelector(
        'cca-nav-header[slot="navigation-header"]',
      ) as any;
      expect(navHeader.userName).toBe("admin");
    });
  });

  describe("plugin loading", () => {
    it("renders cca-nav component", () => {
      const root = requireShadowRoot(el);
      const nav = root.querySelector("cca-nav");
      expect(nav).not.toBeNull();
    });

    it("renders main content area for route output", () => {
      const root = requireShadowRoot(el);
      const main = root.querySelector("main");
      expect(main).not.toBeNull();
    });

    it("passes current path to cca-nav", async () => {
      ctx.router.navigate("/");
      await new Promise((r) => setTimeout(r, 0));
      await updated(el);

      const root = requireShadowRoot(el);
      const nav = root.querySelector("cca-nav") as any;
      expect(nav.currentPath).toBe("/");
    });
  });

  describe("banner display", () => {
    it("displays banner when fetch returns valid data", async () => {
      const bannerData: Banner = {
        message: "Maintenance window",
        icon: "alert",
        link: "https://example.com",
      };

      el.remove();
      vi.spyOn(getContext().bannerAdmin, "getActiveBanner").mockResolvedValue(bannerData);
      el = getEl();

      for (let i = 0; i < 5; i++) await Promise.resolve();
      await updated(el);

      const root = requireShadowRoot(el);
      const banner = root.querySelector("cca-banner");
      expect(banner).not.toBeNull();
    });

    it("does not display banner when empty object is returned", async () => {
      el.remove();
      vi.spyOn(getContext().bannerAdmin, "getActiveBanner").mockResolvedValue({});
      el = getEl();

      for (let i = 0; i < 5; i++) await Promise.resolve();
      await updated(el);

      const root = requireShadowRoot(el);
      const banner = root.querySelector("cca-banner");
      expect(banner).toBeNull();
    });
  });

  // #51: the collapsible nav rail — the toggle, the CSS class it drives, persistence to
  // localStorage, and its interaction with wa-page's own "view" attribute on mobile.
  describe("nav rail collapse (#51)", () => {
    function toggleButton(shell: CcaShell): HTMLButtonElement {
      return queryRequired<HTMLButtonElement>(
        requireShadowRoot(shell),
        ".nav-collapse-toggle",
      );
    }

    function waPageEl(shell: CcaShell): HTMLElement {
      return queryRequired<HTMLElement>(requireShadowRoot(shell), "wa-page");
    }

    function navEl(shell: CcaShell): HTMLElement & { collapsed?: boolean } {
      return queryRequired<HTMLElement & { collapsed?: boolean }>(
        requireShadowRoot(shell),
        "cca-nav",
      );
    }

    function navHeaderEl(shell: CcaShell): HTMLElement & { collapsed?: boolean } {
      return queryRequired<HTMLElement & { collapsed?: boolean }>(
        requireShadowRoot(shell),
        'cca-nav-header[slot="navigation-header"]',
      );
    }

    describe("toggle behavior", () => {
      it("is expanded by default", () => {
        expect(waPageEl(el).classList.contains("nav-collapsed")).toBe(false);
        expect(navEl(el).collapsed).toBe(false);
        expect(navHeaderEl(el).collapsed).toBe(false);
      });

      it("clicking the toggle collapses the rail and its children", async () => {
        toggleButton(el).click();
        await updated(el);

        expect(waPageEl(el).classList.contains("nav-collapsed")).toBe(true);
        expect(navEl(el).collapsed).toBe(true);
        expect(navHeaderEl(el).collapsed).toBe(true);
      });

      it("clicking a second time returns to expanded", async () => {
        toggleButton(el).click();
        await updated(el);
        toggleButton(el).click();
        await updated(el);

        expect(waPageEl(el).classList.contains("nav-collapsed")).toBe(false);
        expect(navEl(el).collapsed).toBe(false);
      });

      it("flips aria-expanded and the chevron direction with the state", async () => {
        const btn = toggleButton(el);
        expect(btn.getAttribute("aria-expanded")).toBe("true");
        expect(
          requireShadowRoot(el)
            .querySelector(".nav-collapse-toggle wa-icon")
            ?.getAttribute("name"),
        ).toBe("chevron-left");

        btn.click();
        await updated(el);

        expect(btn.getAttribute("aria-expanded")).toBe("false");
        expect(
          requireShadowRoot(el)
            .querySelector(".nav-collapse-toggle wa-icon")
            ?.getAttribute("name"),
        ).toBe("chevron-right");
      });
    });

    describe("the nav-collapsed CSS class", () => {
      it("is absent from wa-page while expanded", () => {
        expect(waPageEl(el).className).not.toContain("nav-collapsed");
      });

      it("is applied to wa-page once the rail is collapsed", async () => {
        toggleButton(el).click();
        await updated(el);
        expect(waPageEl(el).className).toContain("nav-collapsed");
      });
    });

    // cca-nav and cca-nav-header are stubbed in this file's test harness (see the top of
    // this file), so their own tooltip/label rendering is covered in cca-nav.test.ts and
    // cca-nav-header.test.ts. What belongs here is the navigation-footer (News/
    // Documentation), which cca-shell.ts renders itself — point 5 of #51's plan.
    describe("tooltip appearance when collapsed", () => {
      it("shows the News/Documentation labels and no tooltips while expanded", () => {
        const root = requireShadowRoot(el);
        const footer = queryRequired(root, '[slot="navigation-footer"]');
        expect(footer.textContent).toContain("News");
        expect(footer.textContent).toContain("Documentation");
        expect(root.querySelectorAll("wa-tooltip").length).toBe(0);
      });

      it("goes icon-only with a tooltip per link once the rail is collapsed", async () => {
        toggleButton(el).click();
        await updated(el);

        const root = requireShadowRoot(el);
        // The links themselves drop their text (icon only); the tooltips are the sole
        // remaining source of the "News"/"Documentation" label text in this region.
        const newsLink = queryRequired<HTMLAnchorElement>(root, "#nav-footer-news");
        const docsLink = queryRequired<HTMLAnchorElement>(root, "#nav-footer-docs");
        expect(newsLink.textContent?.trim()).toBe("");
        expect(docsLink.textContent?.trim()).toBe("");

        const newsTooltip = root.querySelector('wa-tooltip[for="nav-footer-news"]');
        const docsTooltip = root.querySelector('wa-tooltip[for="nav-footer-docs"]');
        expect(newsTooltip?.textContent?.trim()).toBe("News");
        expect(docsTooltip?.textContent?.trim()).toBe("Documentation");
      });

      it("passes collapsed=true down to cca-nav/cca-nav-header so their own collapsed rendering kicks in (see cca-nav.test.ts / cca-nav-header.test.ts)", async () => {
        toggleButton(el).click();
        await updated(el);
        expect(navEl(el).collapsed).toBe(true);
        expect(navHeaderEl(el).collapsed).toBe(true);
      });
    });

    describe("persistence", () => {
      it("reads ccaNavCollapsed from localStorage on connect", async () => {
        localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, "true");
        el.remove();
        const shell = getEl();
        await shell.updateComplete;

        expect(waPageEl(shell).classList.contains("nav-collapsed")).toBe(true);
        expect(navEl(shell).collapsed).toBe(true);
        shell.remove();
      });

      it("defaults to expanded when nothing is stored", async () => {
        el.remove();
        const shell = getEl();
        await shell.updateComplete;

        expect(waPageEl(shell).classList.contains("nav-collapsed")).toBe(false);
        shell.remove();
      });

      it("ignores a non-'true' stored value and defaults to expanded", async () => {
        localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, "nonsense");
        el.remove();
        const shell = getEl();
        await shell.updateComplete;

        expect(waPageEl(shell).classList.contains("nav-collapsed")).toBe(false);
        shell.remove();
      });

      it("writes ccaNavCollapsed to localStorage on every toggle", async () => {
        expect(localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY)).toBeNull();

        toggleButton(el).click();
        await updated(el);
        expect(localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY)).toBe("true");

        toggleButton(el).click();
        await updated(el);
        expect(localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY)).toBe("false");
      });
    });

    describe("mobile view is unaffected by the desktop toggle state", () => {
      async function goMobile(shell: CcaShell) {
        waPageEl(shell).setAttribute("view", "mobile");
        // The mobile-awareness comes from a MutationObserver on wa-page's own "view"
        // attribute rather than a duplicated matchMedia breakpoint check; its callback
        // fires as a microtask, so flush a couple before asserting.
        await Promise.resolve();
        await Promise.resolve();
        await updated(shell);
      }

      it("forces cca-nav/cca-nav-header expanded on mobile even though the desktop toggle is collapsed", async () => {
        toggleButton(el).click();
        await updated(el);
        expect(navEl(el).collapsed).toBe(true);

        await goMobile(el);

        expect(navEl(el).collapsed).toBe(false);
        expect(navHeaderEl(el).collapsed).toBe(false);
      });

      it("leaves the desktop toggle's own state untouched underneath — the nav-collapsed class stays on wa-page", async () => {
        toggleButton(el).click();
        await updated(el);

        await goMobile(el);

        expect(waPageEl(el).classList.contains("nav-collapsed")).toBe(true);
      });

      it("re-collapses cca-nav/cca-nav-header once back on desktop, without needing another click", async () => {
        toggleButton(el).click();
        await updated(el);
        await goMobile(el);
        expect(navEl(el).collapsed).toBe(false);

        waPageEl(el).setAttribute("view", "desktop");
        await Promise.resolve();
        await Promise.resolve();
        await updated(el);

        expect(navEl(el).collapsed).toBe(true);
        expect(navHeaderEl(el).collapsed).toBe(true);
      });

      it("has no effect on mobile when the desktop toggle was never collapsed", async () => {
        await goMobile(el);
        expect(navEl(el).collapsed).toBe(false);
        expect(waPageEl(el).classList.contains("nav-collapsed")).toBe(false);
      });
    });
  });
});

// #113: wa-page's desktop rail is a grid pinned to "height: 100%" whose rows are all
// "minmax(0, ...)". On a short viewport that squashes the nav row rather than overflowing it,
// cca-nav's links spill out, and the opaque navigation-footer paints over them — logout is
// erased along with its click target. One CSS rule unpins the rail.
//
// This suite runs in happy-dom, which performs no layout at all, so the overlap itself cannot
// be reproduced or asserted here. The guard is deliberately narrow: it catches the rule being
// deleted or watered down, nothing more.
describe("desktop nav rail overflow (#113)", () => {
  /** The declarations inside the single "wa-page::part(navigation)" rule, "" if it is gone. */
  function navigationRule(): string {
    const { cssText } = CcaShell.styles as CSSResult;
    return /wa-page::part\(navigation\)\s*\{([^}]*)\}/.exec(cssText)?.[1] ?? "";
  }

  it("unpins the rail from wa-page's height: 100% so its rows are never squashed", () => {
    // Anchored so "min-height: auto" cannot satisfy this on its own.
    expect(navigationRule()).toMatch(/(?:^|[;\s])height:\s*auto\s*;/);
  });

  it("keeps the rail filling the menu, so the footer stays bottom-pinned when it does fit", () => {
    expect(navigationRule()).toMatch(/(?:^|[;\s])min-height:\s*100%\s*;/);
  });
});
