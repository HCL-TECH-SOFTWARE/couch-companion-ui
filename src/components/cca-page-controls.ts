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

import { html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CcaElement } from "./cca-element.js";
import { PAGE_SIZE_OPTIONS, parseSkip } from "../services/page-size-preference.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";

/** Shown under the skip box while what is typed there is not a document offset. */
const SKIP_HINT = "Whole numbers, 0 or more";

/**
 * The one footer every paged list screen wears: page size, skip, the range being
 * shown, and previous/next.
 *
 * It exists because `doc-browser` and `doc-query` had written their own footer each,
 * and the copies had already drifted (#80). Owning it once is what lets the two
 * screens agree on the things this issue settles — five fixed page sizes remembered
 * in `localStorage`, a digits-only skip, and previous/next **hidden rather than
 * disabled** when there is no such page, the shape `index-list` landed in #57.
 *
 * It holds no paging state of its own: the screen owns `pageSize`/`skip` and reacts
 * to the events below, so the value shown is always the value the last request used.
 *
 * Events:
 * - `cca-page-size-change` — `{ pageSize }`, a value from `PAGE_SIZE_OPTIONS`
 * - `cca-skip-change` — `{ skip }`, a non-negative integer, only once it validates
 * - `cca-page-prev` / `cca-page-next` — move one page
 */
@customElement("cca-page-controls")
export class CcaPageControls extends CcaElement {
  static override get styles() {
    return css`
      :host {
        display: block;
      }
      .page-controls {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-top: 1rem;
      }
      .control-group {
        display: flex;
        align-items: flex-end;
        gap: 0.75rem;
      }
      .size-field {
        width: 6rem;
      }
      .skip-field {
        width: 9rem;
      }
      .skip-field::part(hint) {
        color: var(--wa-color-danger-on-quiet);
      }
      .range {
        font-size: var(--wa-font-size-s);
        color: var(--wa-color-text-quiet);
      }
      .button-group {
        display: flex;
        gap: 0.5rem;
      }
    `;
  }

  /** Documents fetched per page. Always one of `PAGE_SIZE_OPTIONS`. */
  @property({ type: Number }) pageSize = 25;

  /** Documents skipped before the first page. */
  @property({ type: Number }) skip = 0;

  /** True when a page exists before the current one. */
  @property({ type: Boolean }) hasPrev = false;

  /** True unless this is positively known to be the last page. */
  @property({ type: Boolean }) hasNext = false;

  /** True while a request is in flight: the range becomes a spinner, the buttons inert. */
  @property({ type: Boolean }) loading = false;

  /** What is on screen, e.g. `1–25 of 812`. Rendered as-is. */
  @property({ type: String }) rangeLabel = "";

  /**
   * What is in the skip box right now, which is not yet what was requested: the
   * value is only announced once it validates, so a half-typed number neither
   * refetches nor gets overwritten mid-keystroke.
   */
  @state() private _skipDraft: string | null = null;

  @state() private _skipError = false;

  override willUpdate(changed: Map<string, unknown>) {
    // A skip the screen changed (page reset, a fresh query) replaces whatever the box
    // held; a skip this control just announced is already the draft's own value.
    if (changed.has("skip") && String(this.skip) !== this._skipDraft) {
      this._skipDraft = null;
      this._skipError = false;
    }
  }

  private get _skipValue(): string {
    return this._skipDraft ?? String(this.skip);
  }

  private _onPageSizeChange(e: Event) {
    const raw = (e.target as HTMLSelectElement).value;
    const next = Number(raw);
    if (!PAGE_SIZE_OPTIONS.includes(next) || next === this.pageSize) return;
    this.dispatchEvent(
      new CustomEvent("cca-page-size-change", {
        detail: { pageSize: next },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onSkipInput(e: Event) {
    this._skipDraft = (e.target as HTMLInputElement).value;
    this._skipError = parseSkip(this._skipDraft) === null;
  }

  /** Commits the box on blur or Enter — never per keystroke, which would refetch per digit. */
  private _commitSkip() {
    const next = parseSkip(this._skipValue);
    if (next === null) {
      this._skipError = true;
      return;
    }
    this._skipError = false;
    this._skipDraft = String(next);
    if (next === this.skip) return;
    this.dispatchEvent(
      new CustomEvent("cca-skip-change", {
        detail: { skip: next },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _emit(name: string) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  override render() {
    return html`
      <div class="page-controls">
        <div class="control-group">
          <wa-select
            data-page-size
            class="size-field"
            size="s"
            label="Per page"
            .value=${String(this.pageSize)}
            @change=${(e: Event) => this._onPageSizeChange(e)}
          >
            ${PAGE_SIZE_OPTIONS.map(
              (n) => html`<wa-option value=${String(n)}>${n}</wa-option>`,
            )}
          </wa-select>
          <wa-input
            data-skip
            class="skip-field"
            size="s"
            label="Skip"
            inputmode="numeric"
            hint=${this._skipError ? SKIP_HINT : ""}
            .value=${this._skipValue}
            @input=${(e: Event) => this._onSkipInput(e)}
            @change=${() => this._commitSkip()}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") this._commitSkip();
            }}
          ></wa-input>
        </div>
        <span class="range" data-range aria-live="polite">
          ${this.loading
            ? html`<wa-spinner></wa-spinner>`
            : this.rangeLabel}
        </span>
        <div class="button-group">
          ${this.hasPrev
            ? html`<wa-button
                data-prev-page
                size="s"
                ?disabled=${this.loading}
                @click=${() => this._emit("cca-page-prev")}
                >← Previous</wa-button
              >`
            : nothing}
          ${this.hasNext
            ? html`<wa-button
                data-next-page
                size="s"
                ?disabled=${this.loading}
                @click=${() => this._emit("cca-page-next")}
                >Next →</wa-button
              >`
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cca-page-controls": CcaPageControls;
  }
}
