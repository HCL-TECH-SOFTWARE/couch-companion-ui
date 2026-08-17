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
 * The git-sync UI behaviour that more than one design-management screen needs, kept in one place
 * because for the first two, living in only one screen was itself the defect:
 *
 *  - **Reporting a `syncToRepo` result truthfully.** `syncToRepo` does not throw on a conflict or
 *    on a direction refusal — it returns `{status: 'conflict', …}` or counts the document in
 *    `skipped`. The view editor `await`ed it, discarded the result and toasted an unconditional
 *    "saved and synced", claiming a success it had not achieved.
 *  - **Recovering a token when a git call comes back 401.** The retry lived only in
 *    `design-list.ts`, while the view editor's sync checkbox defaults *on* whenever a repository is
 *    linked — so with credential mode `none` (the default and recommended option) every save from a
 *    freshly loaded tab failed with "Bad credentials" and offered no way out.
 *  - **Advising on a request the browser never sent** (#28). `GitHttp` can say the request was not
 *    dispatched and name the host, but not whose Content-Security-Policy is in force — that needs
 *    `getContext().deployment.mode`, which only this layer can read, and all three connect-account
 *    catch blocks need the same sentence.
 */

import { html, type TemplateResult } from 'lit';
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { getContext } from '../../context.js';
import { toast } from '../../components/cca-toast.js';
import { GitHttpError } from '../../services/git/git-http.js';
import type { SyncResult } from '../../services/design-mgmt-service.js';
import type { CredentialMode } from '../../services/git/git-credential-store.js';

/**
 * Reports a `syncToRepo` result truthfully instead of an unconditional "Synced successfully".
 * `status: 'conflict'` and non-zero `skipped`/`reconciled` counts used to be invisible — Task 6
 * made those numbers real specifically so this could report them.
 *
 * Branches on `result.status === 'conflict'`, not `conflicts > 0` — `status` is `SyncResult`'s own
 * authoritative field; a result reporting `status: 'conflict'` with a zero/absent `conflicts`
 * count would otherwise toast a success.
 *
 * Reports only the sync. A caller that also did something else first (the view editor saves to
 * CouchDB before syncing) says so in its own toast, so a refused sync can never retroactively
 * cast doubt on a write that genuinely succeeded — or, as before, a successful write vouch for a
 * sync that did not happen.
 */
export function reportSyncToRepoResult(result: SyncResult): void {
  const prefix = 'Synced to repo';
  const synced = result.synced ?? 0;
  const conflicts = result.conflicts ?? 0;
  const skipped = result.skipped ?? 0;
  const reconciled = result.reconciled ?? 0;
  const parts = [`${synced} synced`];
  if (reconciled > 0) parts.push(`${reconciled} already up to date`);
  if (conflicts > 0) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  const summary = parts.join(', ');

  if (result.status === 'conflict') {
    toast(`${prefix} finished with conflicts (${summary}). Review them before syncing again.`, 'error');
  } else if (skipped > 0) {
    toast(`${prefix} (${summary}).`, 'info');
  } else {
    toast(`${prefix} successfully (${summary}).`, 'success');
  }
}

/**
 * True for either shape a sync-time credential problem can take:
 *  - the explicit, catchable message `getGitAccountRepos` throws when an account has no token at
 *    all to work with, or
 *  - a real `GitHttpError` with `status: 401` — what GitHub actually returns for a request with no
 *    (or an expired/revoked) `Authorization` header. `syncToRepo`/`syncToCouch`/`getRepoDocs`/
 *    `deleteRepoDocs` never pre-check the token (`providerFor` hands a possibly-`null` token
 *    straight to `GitHttp`, which just omits the header), so this is the *only* signal that ever
 *    reaches the UI for them — the "no access token available" string is unreachable from any of
 *    the four, not an alternate spelling of the same case.
 *
 * Re-prompting is equally correct whether the account never had a token or the one it had stopped
 * working — which is why {@link GitTokenPrompt} now writes the answer through the account's real
 * credential mode instead of only remembering it for the tab.
 */
export function isMissingTokenError(err: unknown): boolean {
  if (err instanceof GitHttpError && err.status === 401) return true;
  return err instanceof Error && /no access token available/i.test(err.message);
}

/**
 * The half of a blocked-request diagnosis that `GitHttp` cannot make (#28), as a sentence to append
 * to an error toast — or `''` when there is nothing honest to add.
 *
 * `GitHttp` knows the request was never sent and which host it was headed for, but not whose
 * Content-Security-Policy is in force, and that is the whole difference between useful advice and a
 * wild goose chase:
 *
 *  - **`same-origin`** — the bundle is served by CouchDB, replacing Fauxton at `/_utils`, so the
 *    policy is CouchDB's `[csp] utils_header_value`, its default has no `connect-src` at all, and
 *    the operator can widen it. `docs/install.md` walks through exactly that.
 *  - **`spa`** — the bundle is on some other static host and the policy is that host's. Naming
 *    CouchDB's config key would send the reader to a file that has nothing to do with it, so this
 *    says nothing and lets the message from `GitHttp` stand on its own.
 *
 * Keyed on `kind === 'blocked'`, never on the deployment alone: a 401 from `/_utils` is a token
 * problem, and blaming the CSP for it would be worse than saying nothing.
 */
export function blockedRequestAdvice(err: unknown): string {
  if (!(err instanceof GitHttpError) || err.kind !== 'blocked') return '';
  if (getContext().deployment.mode !== 'same-origin') return '';
  const host = err.host ?? 'that host';
  return (
    ` This page is served by CouchDB, so its Content-Security-Policy is CouchDB's ` +
    `[csp] utils_header_value — check that its connect-src lists ${host} (see docs/install.md).`
  );
}

/**
 * What the prompt says, per credential mode. The `none` copy used to be shown for all three, and
 * for the two persisting modes it was simply false — the account *does* store its token, the
 * stored one has just stopped working, and the one being typed replaces it.
 */
export function tokenPromptMessage(label: string, mode: CredentialMode): string {
  if (mode === 'couchdb') {
    return (
      `The access token stored for "${label}" was rejected — it has most likely expired or been ` +
      'revoked. Enter a new one to continue; it replaces the copy held in the couchcompanion ' +
      'database, where every server admin can read it.'
    );
  }
  if (mode === 'indexeddb') {
    return (
      `The access token stored for "${label}" was rejected — it has most likely expired or been ` +
      'revoked. Enter a new one to continue; it replaces the copy held in this browser profile.'
    );
  }
  return (
    `"${label}" does not store its access token. Enter it to continue — it is kept only in memory ` +
    'for this browser tab and is not saved anywhere.'
  );
}

/**
 * Owns the whole "a git call came back 401, ask for a token and try once more" interaction: the
 * dialog, its state, the account lookup behind the label and the mode-correct write of the answer.
 *
 * A controller rather than a mixin or a pair of copied methods because both hosts are ordinary
 * `CcaElement`s with their own unrelated state, and the previous shape — the entire mechanism
 * private to `design-list.ts` — is exactly why the view editor had no recovery path at all.
 */
export class GitTokenPrompt implements ReactiveController {
  /** Whether the dialog is currently asking for a token. */
  isOpen = false;
  /** Bound to the dialog's input; cleared on both confirm and cancel so it never lingers. */
  value = '';
  private label = '';
  private mode: CredentialMode = 'none';
  private resolver: ((token: string | null) => void) | null = null;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {
    /* nothing to do — the prompt only exists while a call is in flight */
  }

  /**
   * Navigating away with a prompt open used to leave its promise pending forever, and with it the
   * `withTokenRetry` frame and whatever it closed over. Cancelling resolves that promise, which
   * surfaces the original 401 to the caller's own error handling.
   */
  hostDisconnected(): void {
    if (this.isOpen) this.cancel();
  }

  /**
   * Runs `fn`; if it fails with a credential error ({@link isMissingTokenError}) prompts for the
   * token, stores it under the account's real credential mode, and retries `fn` **once**. A second
   * failure — including the user cancelling — propagates normally; this never loops, because a
   * revoked token that keeps being revoked must not spin.
   */
  async run<T>(accountId: string | null, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!accountId || !isMissingTokenError(err)) throw err;
      const { label, mode } = await this.describeAccount(accountId);
      const token = await this.open(label, mode);
      if (token === null) throw err;
      await getContext().designMgmt.saveAccountToken(accountId, token);
      return fn();
    }
  }

  /**
   * Label and credential mode for the prompt, read from the service rather than from a component's
   * already-loaded account list: on the page-load path (`getDesignDocsFromRepo` during
   * `connectedCallback`) that list is still empty, so the dialog named a raw `gitaccount:<uuid>`
   * instead of the account the user recognises. A failed lookup falls back to the id — a prompt
   * with an ugly label is still a prompt; no prompt at all is a dead end.
   */
  private async describeAccount(accountId: string): Promise<{ label: string; mode: CredentialMode }> {
    try {
      const account = await getContext().designMgmt.getGitAccount(accountId);
      return { label: account.label || accountId, mode: account.credential_mode ?? 'none' };
    } catch {
      return { label: accountId, mode: 'none' };
    }
  }

  private open(label: string, mode: CredentialMode): Promise<string | null> {
    return new Promise((resolve) => {
      this.label = label;
      this.mode = mode;
      this.value = '';
      this.isOpen = true;
      this.resolver = resolve;
      this.host.requestUpdate();
    });
  }

  /** Confirms the dialog. Exposed so a host (or a test) can drive it without reaching into state. */
  confirm(): void {
    const token = this.value.trim();
    if (!token) {
      toast('Enter an access token to continue', 'error');
      return;
    }
    this.settle(token);
  }

  cancel(): void {
    this.settle(null);
  }

  private settle(token: string | null): void {
    this.isOpen = false;
    this.value = '';
    const resolve = this.resolver;
    this.resolver = null;
    this.host.requestUpdate();
    resolve?.(token);
  }

  /** The dialog itself. Hosts render this once, unconditionally, anywhere in their template. */
  render(): TemplateResult {
    return html`
      <wa-dialog
        label="Git Access Token Required"
        ?open=${this.isOpen}
        @wa-request-close=${() => this.cancel()}
      >
        <p>${tokenPromptMessage(this.label, this.mode)}</p>
        <wa-input
          label="Access Token"
          type="password"
          .value=${this.value}
          @input=${(e: Event) => {
            this.value = (e.target as HTMLInputElement).value;
          }}
        ></wa-input>
        <wa-button slot="footer" @click=${() => this.cancel()}>Cancel</wa-button>
        <wa-button slot="footer" appearance="filled" variant="brand" @click=${() => this.confirm()}>
          Continue
        </wa-button>
      </wa-dialog>
    `;
  }
}
