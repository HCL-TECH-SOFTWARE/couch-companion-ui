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

import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { CcaElement } from "./cca-element.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";

/**
 * The "show a different field here" control that sits in one table column's header (#79).
 *
 * Columns on the two document lists are derived from the documents that came back, so a
 * page of wide documents produces more columns than fit and a page of narrow ones may not
 * produce the field someone came to read. Fauxton answers that with a dropdown per header
 * cell that swaps which field the column shows (`WrappedAutocomplete.js:16-41`, wired in
 * `TableView.js:44-88`); this is the same control, owned once so `doc-browser` and
 * `doc-query` cannot drift apart the way their page footers did (#80).
 *
 * It holds no state: the screen owns which field each column shows and reacts to
 * `cca-column-field-change`, so what carries a checkmark is always what is on screen.
 *
 * Lives *inside* `cca-data-table`'s shadow root, since that is where `headerRender()`
 * output lands — which is exactly why it is a component and not a template helper. Its
 * own shadow root is the only place `_syncChecked()` has to search, whichever table
 * renders it.
 *
 * @fires cca-column-field-change - CustomEvent<{ field: string }> — the field to show now
 */
@customElement("cca-column-picker")
export class CcaColumnPicker extends CcaElement {
  static override get styles() {
    return css`
      :host {
        display: inline-flex;
        vertical-align: middle;
      }
      /* This lives in a table header, which cca-data-table renders uppercase, bold and
         one size down — and those three inherit straight through into the menu. Field
         names are case-sensitive, so a menu offering "NAME" would be offering a field
         that is not there. The trigger keeps the header's size, since it sits in the
         header; the menu is read on its own and takes the app's normal text size. */
      wa-dropdown-item {
        text-transform: none;
        font-weight: var(--wa-font-weight-normal);
        font-size: var(--wa-font-size-s);
      }
    `;
  }

  /** The field this column currently shows. Carries the checkmark. */
  @property({ type: String }) field = "";

  /** Every field this column may be switched to, in the order they are offered. */
  @property({ type: Array }) fields: string[] = [];

  /**
   * `wa-dropdown-item` knows only `type="checkbox"` and stamps `role="menuitemcheckbox"`
   * from its own `updated()`, overwriting whatever the template set. These items are one
   * mutually exclusive set — a column shows exactly one field — so the role has to be
   * `menuitemradio`. Same observer, and same reason, as `cca-theme-picker` (#767).
   */
  private _roleObserver = new MutationObserver(() => this._fixRoles());

  private _fixRoles(): void {
    for (const item of this.renderRoot.querySelectorAll(
      'wa-dropdown-item[role="menuitemcheckbox"]',
    )) {
      item.setAttribute("role", "menuitemradio");
    }
  }

  protected override _onFirstUpdate(): void {
    // Watches this component's own shadow root — a self-contained cycle the GC collects
    // with the element, so there is nothing to tear down on disconnect.
    this._roleObserver.observe(this.renderRoot, {
      subtree: true,
      attributes: true,
      attributeFilter: ["role"],
    });
    this._fixRoles();
  }

  /**
   * `wa-dropdown` owns selection. Both of its input paths — the click handler on its
   * shadow `#menu` and the Enter/Space branch of its document `keydown` handler — end in
   * `makeSelection()`, which flips `item.checked` itself *before* emitting `wa-select`.
   * Listening for `click` on the items loses both ways round (#50): keyboard selection
   * dispatches no click at all, and on a mouse click Lit's re-render commits the new
   * checkmark before `makeSelection()` toggles it straight back off — invisibly, since
   * `checked` does not reflect — so the checkmark appears to move one click late.
   *
   * `wa-select` fires after that toggle and covers both paths, so it is the single place
   * selection is handled.
   */
  private _onSelect = (event: CustomEvent<{ item: Element }>) => {
    const field = (event.detail.item as HTMLElement).dataset.field;
    // The membership test doubles as validation: an item this picker did not render
    // selects nothing.
    if (field !== undefined && this.fields.includes(field)) {
      this.dispatchEvent(
        new CustomEvent("cca-column-field-change", {
          detail: { field },
          bubbles: true,
          composed: true,
        }),
      );
    }
    this._syncChecked();
  };

  /**
   * Re-derives every checkmark from {@link field}, so `makeSelection()`'s toggle never
   * survives as state. This cannot be a `?checked` binding: re-selecting the field the
   * column already shows changes nothing, so nothing re-renders, and the toggle would
   * stand — silently unchecking the very field the user just confirmed.
   */
  private _syncChecked(): void {
    for (const item of this.renderRoot.querySelectorAll("wa-dropdown-item")) {
      item.checked = item.dataset.field === this.field;
    }
  }

  protected override _onUpdated(): void {
    this._syncChecked();
  }

  override render() {
    return html`
      <wa-dropdown @wa-select=${this._onSelect}>
        <wa-button slot="trigger" size="s" appearance="plain" data-column-picker>
          <!-- The name goes on the icon, not on the button: that is Web Awesome's own
               recipe for an icon-only button (wa-icon renders role="img" with this as
               its label), and the shape every other icon button in this app uses. -->
          <wa-icon
            name="chevron-down"
            variant="solid"
            label=${`Show a different field. This column shows ${this.field || "no field"}`}
          ></wa-icon>
        </wa-button>
        ${this.fields.map(
          (name) => html`
            <wa-dropdown-item data-field=${name} type="checkbox"
              >${name}</wa-dropdown-item
            >
          `,
        )}
      </wa-dropdown>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cca-column-picker": CcaColumnPicker;
  }
}
