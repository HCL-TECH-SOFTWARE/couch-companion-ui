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

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import { getContext } from '../context.js';
import { toast } from './cca-toast.js';
import { getLogger } from '../services/log-service.js';
import {
  addConnectSrcOrigins,
  buildCspCurl,
  connectSrcValues,
  missingOrigins,
  removeConnectSrcOrigins,
  scriptSrcAllowsEval,
  setUnsafeEval
} from '../services/csp-policy.js';

const log = getLogger('components/cca-csp-check');

/**
 * What a violation report tells us, kept only long enough to name the host in the copy.
 * `originalPolicy` is the exact header the browser enforced — a second, independent reading of
 * the same truth {@link CspService.readUtilsPolicy} fetches.
 */
interface ViolationEventLike {
  originalPolicy?: string;
  blockedURI?: string;
  effectiveDirective?: string;
}

/**
 * Checks the Content-Security-Policy in force against the origins a feature actually needs, and
 * offers to extend it — a toggle, not a one-way write (#34).
 *
 * Used twice, and the copy comes from the caller because the diagnosis reads differently each
 * time: git sync on the version-control screen (#34), and single sign-on on the identity-provider
 * screen (#149), whose origins are three endpoints that need not share a host.
 *
 * THE PROBLEM IT PREVENTS. CouchDB serves `/_utils/` with `default-src 'self'` and no
 * `connect-src`, so the browser refuses every cross-origin request *before dispatching it*. Git
 * sync talks to GitHub directly from the browser (there is no backend to proxy it), so from the
 * drop-in — the primary deployment target — it cannot reach GitHub at all. It presents as
 * "Failed to fetch" with **nothing in the network tab**, because no request was ever made. This
 * component detects that before it bites.
 *
 * WHY IT LIVES ON THE SCREEN THAT CONFIGURES THE THING. The required origins are computed from
 * what the operator configured, and each screen already holds that; the person setting the feature
 * up is the person the question is for. Hence `origins` as a property rather than a fetch here.
 *
 * TWO SEPARATE OFFERS, NEVER ONE. Widening `connect-src` and allowing `script-src 'unsafe-eval'`
 * are different decisions with different consequences, so they are different switches. Folding
 * the second into the first would widen an operator's script policy without ever saying so. The
 * second is opt-in per screen (`view-tester`): only the view editor needs `unsafe-eval`, and an
 * identity-provider screen offering it would be inviting a change nothing there requires.
 *
 * DEGRADES.
 *  - **SPA mode** — hidden entirely. The policy comes from whoever serves the page, not from
 *    CouchDB, so neither the diagnosis nor the fix would be true.
 *  - **Cannot write config** — no switches at all: the computed header and the `curl` from
 *    `docs/install.md`, to hand to someone who can. Writing `[csp]` needs the server-admin role,
 *    which is a fact about the session, not a guess about a database; and if a write is refused
 *    anyway, the refusal itself flips this component into that same copy-only state rather than
 *    leaving a switch that does nothing.
 */
@customElement('cca-csp-check')
export class CcaCspCheck extends LitElement {
  static styles = css`
    :host {
      display: block;
      margin-bottom: var(--wa-space-m);
    }
    .row {
      display: flex;
      align-items: start;
      gap: var(--wa-space-m);
      margin-block: var(--wa-space-m);
    }
    .row wa-switch {
      flex: none;
    }
    .consequence {
      color: var(--wa-color-text-quiet);
      font-size: var(--wa-font-size-s);
      margin: 0;
    }
    .policy {
      margin: var(--wa-space-xs) 0 0;
      padding: var(--wa-space-s);
      background: var(--wa-color-surface-lowered);
      border: 1px solid var(--wa-color-border-quiet);
      border-radius: var(--wa-border-radius-m);
      color: var(--wa-color-text-normal);
      font-family: var(--wa-font-family-code);
      font-size: var(--wa-font-size-s);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 12rem;
      overflow: auto;
    }
    .label {
      color: var(--wa-color-text-normal);
      font-weight: var(--wa-font-weight-bold);
    }
    .actions {
      display: flex;
      gap: var(--wa-space-s);
      margin-top: var(--wa-space-s);
      flex-wrap: wrap;
    }
    .error {
      color: var(--wa-color-danger-60);
    }
    code {
      font-family: var(--wa-font-family-code);
      overflow-wrap: anywhere;
    }
  `;

  /**
   * The origins the feature needs to reach, computed by the parent from what it has configured
   * (`requiredGitOrigins`, `requiredIdpOrigins`). A property rather than a fetch of its own: the
   * screen that hosts this has already loaded them, and a second read would only invent a way for the two to
   * disagree.
   */
  @property({ attribute: false }) origins: string[] = [];

  /**
   * What the origins are for, as a noun phrase that reads inside a sentence — "git sync",
   * "single sign-on". Every line of copy here names it, because "this page cannot reach
   * accounts.google.com" is a fact the reader can only act on once they know which feature it
   * breaks.
   */
  @property({ attribute: false }) subject = 'this page';

  /**
   * How the block presents to a user who does not know the policy is the cause — the sentence that
   * turns "connect-src is missing an origin" into the symptom they have already seen. Caller-
   * supplied because it differs: git sync fails at "Failed to fetch", sign-in fails at the token
   * exchange, and both do it with nothing in the network tab.
   */
  @property({ attribute: false }) blockedSymptom =
    'those requests fail before the browser sends them, with nothing in the network tab';

  /** Shown instead of the switch when nothing is configured yet, so there is nothing to allow. */
  @property({ attribute: false }) emptyMessage =
    'Nothing is configured yet that would need a cross-origin connection.';

  /**
   * Whether to also offer `script-src 'unsafe-eval'`. Off unless a screen asks: only the view
   * editor's Run Test needs it, and offering it elsewhere would invite a change nothing there
   * requires.
   */
  @property({ type: Boolean, attribute: 'view-tester' }) viewTester = false;

  /** The live header, or `null` for "the server sends none". `undefined` until the read lands. */
  @state() private _policy: string | null | undefined = undefined;
  @state() private _busy = false;
  @state() private _error = '';
  /** Set once a write comes back refused — the copy-only state, reached by response not by guess. */
  @state() private _writeDenied = false;
  /** The host a `securitypolicyviolation` report named, if the browser has refused one for real. */
  @state() private _blockedHost = '';

  private readonly _onViolation = (event: Event) => this._recordViolation(event as ViolationEventLike);

  override connectedCallback() {
    super.connectedCallback();
    // A second reading of the same truth, and the only one that can name a host the browser has
    // actually refused: `originalPolicy` is the exact header enforced, `blockedURI` is the proof.
    document.addEventListener('securitypolicyviolation', this._onViolation);
    if (this._sameOrigin) void this.reload();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('securitypolicyviolation', this._onViolation);
  }

  private get _sameOrigin(): boolean {
    return getContext().deployment.mode === 'same-origin';
  }

  /**
   * Whether this session can write `[csp]`. Server config is a server-admin operation on CouchDB's
   * own terms — not a per-database permission — so the session's role is the honest answer here,
   * and {@link _writeDenied} still defers to what the server actually says if a write is refused.
   */
  private get _canWrite(): boolean {
    return getContext().auth.isAdmin && !this._writeDenied;
  }

  private _recordViolation(event: ViolationEventLike) {
    if (event.originalPolicy) this._policy = event.originalPolicy;
    const uri = event.blockedURI;
    if (!uri) return;
    try {
      this._blockedHost = new URL(uri).host;
    } catch {
      this._blockedHost = uri;
    }
  }

  /** Re-reads the live header. Public so the host screen can refresh after connecting an account. */
  async reload(): Promise<void> {
    try {
      this._policy = await getContext().csp.readUtilsPolicy();
    } catch (err: unknown) {
      // Not surfaced to the user: failing to read the policy is not itself a problem with the
      // feature, and a toast here would fire on every visit behind a proxy that answers HEAD oddly.
      log.debug('Could not read the /_utils Content-Security-Policy', err as Error);
      this._policy = null;
    }
  }

  private async _write(header: string, done: string) {
    // Nothing to say to the server. Guards the double click, and keeps a switch that is already
    // in the requested position from writing the config for the sake of it.
    if (header === this._policy) return;
    this._busy = true;
    this._error = '';
    try {
      await getContext().csp.writeUtilsPolicy(getContext().selectedServer, header);
      // Read back rather than assume: the server owns the header, and a proxy in front of it may
      // have its own opinion about what actually reaches the browser.
      await this.reload();
      toast(done, 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this._error = message;
      // CouchDB answers a non-admin config write with 401 "You are not a server admin." — not
      // 403 — so this reacts to the refusal itself rather than to a status code.
      this._writeDenied = true;
      toast(`Could not update the Content-Security-Policy: ${message}`, 'error');
    } finally {
      this._busy = false;
    }
  }

  /** Adds (or removes again) this screen's origins on `connect-src`. Public for the switch and tests. */
  async setOriginAccess(allow: boolean): Promise<void> {
    const policy = this._policy;
    if (typeof policy !== 'string' || this.origins.length === 0) return;
    await this._write(
      allow ? addConnectSrcOrigins(policy, this.origins) : removeConnectSrcOrigins(policy, this.origins),
      allow
        ? `Content-Security-Policy now allows ${this.subject}.`
        : `Removed those origins from the Content-Security-Policy.`
    );
  }

  /** The separate `script-src 'unsafe-eval'` decision. Public for the switch and tests. */
  async setViewTesterAllowed(allow: boolean): Promise<void> {
    const policy = this._policy;
    if (typeof policy !== 'string') return;
    await this._write(
      setUnsafeEval(policy, allow),
      allow ? "script-src now allows 'unsafe-eval'." : "script-src no longer allows 'unsafe-eval'."
    );
  }

  private get _missing(): string[] {
    const policy = this._policy;
    if (typeof policy !== 'string') return [];
    return missingOrigins(policy, this.origins, window.location.origin);
  }

  /**
   * True only when every required origin is listed on `connect-src` *literally* — the state this
   * component put the policy into, and therefore the only one it can take back out again. A policy
   * that permits GitHub some other way (`*`, a wildcard host) is allowed but not ours to edit, so
   * the switch stays out of it.
   */
  private get _managed(): boolean {
    const policy = this._policy;
    if (typeof policy !== 'string' || this.origins.length === 0) return false;
    const listed = connectSrcValues(policy) ?? [];
    return this.origins.every((origin) => listed.includes(origin));
  }

  /** The header an operator without config rights should hand to someone who has them. */
  private get _desiredHeader(): string {
    const policy = this._policy;
    if (typeof policy !== 'string') return '';
    return addConnectSrcOrigins(policy, this._missing);
  }

  private async _copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`, 'success');
    } catch {
      toast(`Failed to copy ${what.toLowerCase()}`, 'error');
    }
  }

  private _renderCopyOnly() {
    const curl = buildCspCurl(getContext().deployment.baseUrl, this._desiredHeader);
    return html`
      <p class="consequence" data-copy-only>
        Changing this needs the CouchDB server-admin role. Give the header below to an
        administrator, or the command that writes it.
      </p>
      <pre class="policy" data-desired-header>${this._desiredHeader}</pre>
      <pre class="policy" data-curl>${curl}</pre>
      <div class="actions">
        <wa-button
          size="small"
          data-copy-header
          @click=${() => void this._copy(this._desiredHeader, 'Header')}
          ><wa-icon slot="start" name="copy"></wa-icon>Copy header</wa-button
        >
        <wa-button size="small" data-copy-curl @click=${() => void this._copy(curl, 'curl command')}
          ><wa-icon slot="start" name="copy"></wa-icon>Copy curl</wa-button
        >
      </div>
    `;
  }

  private _renderOriginAccess() {
    if (this.origins.length === 0) {
      return html`<p class="consequence" data-nothing-configured>${this.emptyMessage}</p>`;
    }
    // Permitted, but not by anything this component put there — a wildcard, a scheme source, a
    // host pattern the operator chose. There is nothing to offer and nothing we could take back
    // out again, so the switch stays out of it entirely.
    if (this._missing.length === 0 && !this._managed) {
      return html`<p class="consequence" data-already-allowed>
        This policy already permits connections to ${this.origins.join(', ')}, by a rule this
        screen did not write and will not change.
      </p>`;
    }
    const hosts = this.origins.join(', ');
    if (!this._canWrite) return this._renderCopyOnly();
    return html`
      <div class="row">
        <wa-switch
          data-origin-access
          ?checked=${this._managed}
          ?disabled=${this._busy}
          @change=${(e: Event) => void this.setOriginAccess((e.target as HTMLInputElement).checked)}
        ></wa-switch>
        <div>
          <div class="label">Let this page reach ${hosts}</div>
          <p class="consequence">
            Adds those origins to <code>connect-src</code>, keeping every other directive the
            server sends. Turning it off removes exactly what it added.
          </p>
        </div>
      </div>
    `;
  }

  private _renderViewTester() {
    const policy = this._policy as string;
    const allowed = scriptSrcAllowsEval(policy);
    if (!this._canWrite) {
      return html`<p class="consequence" data-view-tester-note>
        ${allowed
          ? "script-src allows 'unsafe-eval', so the view editor's Run Test button works."
          : "script-src does not allow 'unsafe-eval', so the view editor's Run Test button cannot compile a map function."}
      </p>`;
    }
    return html`
      <div class="row">
        <wa-switch
          data-unsafe-eval
          ?checked=${allowed}
          ?disabled=${this._busy}
          @change=${(e: Event) =>
            void this.setViewTesterAllowed((e.target as HTMLInputElement).checked)}
        ></wa-switch>
        <div>
          <div class="label">Let the view editor test views (script-src 'unsafe-eval')</div>
          <p class="consequence">
            Testing a view runs your map and reduce functions, which the runner compiles with
            <code>new Function</code>. Without this the Run Test button fails with "Evaluating a
            string as JavaScript violates the following Content Security Policy directive" —
            measured, not assumed. Nothing else in the app needs it.
          </p>
        </div>
      </div>
    `;
  }

  render() {
    // SPA mode: the policy belongs to whoever serves this page, so CouchDB's config key is not the
    // answer and naming it would send the reader to the wrong file entirely.
    if (!this._sameOrigin) return nothing;
    // No header at all means nothing is being blocked — there is no problem to report.
    if (typeof this._policy !== 'string') return nothing;

    const missing = this._missing;
    const blocked = missing.length > 0;
    return html`
      <wa-callout
        data-csp-check
        variant=${blocked ? 'warning' : 'neutral'}
        appearance="outlined">
        <wa-icon slot="icon" name=${blocked ? 'triangle-exclamation' : 'shield-halved'}></wa-icon>
        <div class="label">Content-Security-Policy</div>
        <p class="consequence">
          ${blocked
            ? html`This page is served by CouchDB, and its policy refuses connections to
                ${missing.join(', ')} before the browser sends them — ${this.blockedSymptom}.`
            : html`This page is served by CouchDB, and its policy already allows the connections
                ${this.subject} makes.`}
          ${this._blockedHost
            ? html`The browser has already refused a request to
                <code data-blocked-host>${this._blockedHost}</code> under this policy.`
            : nothing}
        </p>
        <pre class="policy" data-live-policy>${this._policy}</pre>
        ${this._renderOriginAccess()} ${this.viewTester ? this._renderViewTester() : nothing}
        ${this._error ? html`<p class="consequence error" data-error>${this._error}</p>` : nothing}
      </wa-callout>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cca-csp-check': CcaCspCheck;
  }
}
