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

/** Binds a URL path pattern to the custom element that should render it. */
export interface Route {
  path: string;
  component: string;
  label?: string;
  allowsAllServers?: boolean;
  /**
   * Constant params handed to the component on top of the ones the path yields
   * — how a static path addresses a resource whose id never varies. Anything
   * the path itself matches wins over these.
   */
  params?: Record<string, string>;
}

type RouteChangeCallback = (
  route: Route | null,
  params: Record<string, string>
) => void;

/** A retired path pattern and the path that replaced it. */
interface Redirect {
  from: string;
  to: string;
}

/** Minimal client-side router — matches paths by specificity and notifies subscribers on navigation. */
export class Router {
  private routes: Route[] = [];
  private redirects: Redirect[] = [];
  private listeners: Set<RouteChangeCallback> = new Set();

  /**
   * In-app navigations since load. history.back() means "where the user came from" only
   * while this is above zero — on a deep link or a fresh tab the previous entry belongs to
   * whatever site was there before, and going back would leave the app entirely.
   */
  private depth = 0;

  /**
   * Hash writes this router made whose (asynchronous) hashchange has not arrived yet.
   * A hashchange with none outstanding is the browser's own back/forward button, which
   * is the only kind that unwinds `depth`.
   */
  private pendingSelfNavigations = 0;

  constructor() {
    window.addEventListener('hashchange', () => {
      if (this.pendingSelfNavigations > 0) this.pendingSelfNavigations--;
      else this.depth = Math.max(0, this.depth - 1);
      this.resolve();
    });
  }

  /**
   * Registers a route and re-sorts by specificity (static segments dominate; longer paths break ties).
   * @param route - route definition to add
   */
  addRoute(route: Route) {
    this.routes.push(route);
    this.routes.sort((a, b) => specificity(b.path) - specificity(a.path));
  }

  /**
   * Convenience wrapper — registers multiple routes at once.
   * @param routes - array of route definitions
   */
  addRoutes(routes: Route[]) {
    for (const route of routes) {
      this.addRoute(route);
    }
  }

  /**
   * Points a retired path pattern at its replacement, so bookmarks and history
   * entries for a screen that no longer exists land somewhere useful instead of
   * on the not-found page. Checked before routes; a path that already equals
   * the target is left alone, so a redirect can never loop.
   * @param from - path pattern that no longer has a route (params allowed)
   * @param to - concrete path to send it to
   */
  addRedirect(from: string, to: string) {
    this.redirects.push({ from, to });
  }

  /**
   * Navigates to the given path by setting the location hash.
   * @param path - URL path to navigate to (e.g. "/databases/abc")
   */
  navigate(path: string) {
    // A path equal to the current one leaves history untouched, so it must not
    // count as a step the user could come back from.
    if (this.setHash(path)) this.depth++;
  }

  /**
   * Returns the user to where they actually came from, falling back to a declared parent
   * when there is no in-app history to return to (deep link, bookmark, fresh tab).
   * @param fallback - concrete path to use when back would leave the app
   */
  back(fallback: string) {
    if (this.depth > 0) {
      window.history.back();
    } else {
      this.navigate(fallback);
    }
  }

  /**
   * Writes the location hash, recording that the hashchange it triggers is this
   * router's own doing rather than a browser back/forward.
   * @param path - URL path to write (leading '#' optional)
   * @returns true when the hash actually changed; false when the path was already
   *   current, in which case the route is resolved in place instead
   */
  private setHash(path: string): boolean {
    const target = path.startsWith('#') ? path.slice(1) : path;
    if (window.location.hash.slice(1) === target) {
      this.resolve(); // same hash → no hashchange event, resolve directly
      return false;
    }
    this.pendingSelfNavigations++;
    window.location.hash = target;
    return true;
  }

  /**
   * Registers a callback invoked whenever the active route changes.
   * @param listener - receives the matched Route (or null) and extracted path params
   * @returns unsubscribe function
   */
  subscribe(listener: RouteChangeCallback): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Pure match of a path against the registered routes. */
  match(path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      const params = matchPath(route.path, path);
      if (params !== null) return { route, params: { ...route.params, ...params } };
    }
    return null;
  }

  /** Matches the current hash path against registered routes and notifies subscribers. */
  resolve() {
    const path = this.currentPath();
    const target = this.redirectTarget(path);
    if (target === null) {
      this.notifyFor(path);
      return;
    }
    // Rewrite the URL, then resolve the target in this same pass: subscribers
    // never see the retired path, and nothing waits on the async hashchange.
    // Not navigate(): a redirect is the app correcting itself, not a step the
    // user took, so back() must not offer to return to the retired path.
    this.setHash(target);
    this.notifyFor(target);
  }

  /** @returns the path this one was retired in favour of, or null if it still stands. */
  private redirectTarget(path: string): string | null {
    for (const redirect of this.redirects) {
      if (redirect.to !== path && matchPath(redirect.from, path) !== null) {
        return redirect.to;
      }
    }
    return null;
  }

  private notifyFor(path: string) {
    const hit = this.match(path);
    if (hit) this.notify(hit.route, hit.params);
    else this.notify(null, {});
  }

  private notify(route: Route | null, params: Record<string, string>) {
    for (const listener of this.listeners) {
      listener(route, params);
    }
  }

  /** @returns the active hash path (no leading '#', no query). */
  currentPath(): string {
    return parseHash(window.location.hash).path;
  }

  /** @returns the query params parsed from inside the hash. */
  currentQuery(): URLSearchParams {
    return new URLSearchParams(parseHash(window.location.hash).query);
  }
}

/** Higher = more specific. Static segments dominate; longer paths break ties. */
function specificity(path: string): number {
  const parts = path.split('/').filter(Boolean);
  const staticCount = parts.filter((p) => !p.startsWith(':')).length;
  return staticCount * 1000 + parts.length;
}

/** Splits a raw location.hash into its path and query portions. */
function parseHash(hash: string): { path: string; query: string } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const qIndex = raw.indexOf('?');
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const query = qIndex === -1 ? '' : raw.slice(qIndex + 1);
  return { path: path === '' ? '/' : path, query };
}

function matchPath(
  pattern: string,
  path: string
): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);

  if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
