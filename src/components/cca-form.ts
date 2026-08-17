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

import { CcaElement } from "./cca-element.js";
import { html, css } from "lit";
import { property, state } from "lit/decorators.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/button/button.js";

export type FieldType = "text" | "url" | "email" | "password" | "number";

export interface FormFieldDef {
  /** Key used in the output data object */
  key: string;
  /** Display label */
  label: string;
  type?: FieldType;
  placeholder?: string;
  required?: boolean;
  /** For number inputs — pass "any" or a numeric step value */
  step?: number | "any";
  /** Initial value */
  defaultValue?: string;
  /**
   * If set, the field is placed in a collapsible section with this value as
   * its heading. Multiple fields with the same `group` string are combined.
   * Fields without `group` are always visible.
   */
  group?: string;
}

export interface FormSubmitEvent {
  data: Record<string, string>;
}

/**
 * Dynamic form that renders wa-input fields from a `fields` property array
 * and emits a `cca-form-submit` CustomEvent with `{ data: Record<string, string> }`
 * when the user submits.
 *
 * @fires cca-form-submit  - detail: { data: Record<string, string> }
 *
 * @example
 * ```html
 * <cca-form
 *   .fields=${[{ key: "name", label: "Name", required: true }]}
 *   submit-label="Save"
 * ></cca-form>
 * ```
 */
const stylesheet = new CSSStyleSheet();
stylesheet.replaceSync(`
    :host {
      display: block;
    }
    .fields {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .actions {
      display: flex;
      gap: 0.75rem;
      margin-top: 1rem;
    }
    .actions .submit {
      margin-left: auto;
    }
    .error {
      color: var(--wa-color-danger-fill-loud);
      font-size: var(--wa-font-size-s);
    }
    .collapsible-header {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      cursor: pointer;
      font-weight: var(--wa-font-weight-semibold);
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-link);
      user-select: none;
    }
    .collapsible-header .chevron {
      font-size: var(--wa-font-size-3xs);
    }
    .collapsible-body {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding-left: 0.75rem;
      border-left: 2px solid var(--wa-color-border-quiet);
      margin-top: 0.5rem;
    }
    wa-input.has-error::part(hint) {
      color: var(--wa-color-danger-fill-loud);
    }
  `);

export class CcaForm extends CcaElement {
  static override get styles() {
    return [stylesheet];
  }

  /** Field definitions to render */
  @property({ type: Array }) fields: FormFieldDef[] = [];

  /** Label for the submit button */
  @property({ attribute: "submit-label" }) submitLabel = "Submit";

  /** Label for the optional cancel button — omit to hide it */
  @property({ attribute: "cancel-label" }) cancelLabel = "";

  /** Top-level error message to display above actions */
  @property({ type: String }) error = "";

  /** Per-field validation errors keyed by field.key */
  @property({ type: Object }) fieldErrors: Record<string, string[]> = {};

  /** When true the submit button shows a loading state */
  @property({ type: Boolean }) submitting = false;

  @state() private _values: Record<string, string> = {};
  @state() private _expandedGroups: Set<string> = new Set();

  /** Returns the current form values without submitting */
  get values(): Record<string, string> {
    return { ...this._values };
  }

  /** Resets all field values to their defaults */
  reset() {
    this._values = Object.fromEntries(
      this.fields.map((f) => [f.key, f.defaultValue ?? ""]),
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    this.reset();
  }

  override updated(changed: Map<string, unknown>) {
    if (
      changed.has("fieldErrors") &&
      Object.keys(this.fieldErrors).length > 0
    ) {
      // Auto-expand any group that contains a field with an error
      for (const f of this.fields) {
        if (f.group && this.fieldErrors[f.key]?.length) {
          this._expandedGroups = new Set([...this._expandedGroups, f.group]);
        }
      }
    }
  }

  private _inputValue(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  private _set(key: string, value: string) {
    this._values = { ...this._values, [key]: value };
    this.dispatchEvent(
      new CustomEvent("cca-field-input", {
        detail: { key, value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Programmatically set a single field's value without firing cca-field-input. */
  setFieldValue(key: string, value: string) {
    this._values = { ...this._values, [key]: value };
  }

  private _handleSubmit() {
    this.publish("submit:form", { data: this.values });
  }

  private _handleCancel() {
    this.dispatchEvent(
      new CustomEvent("cca-form-cancel", { bubbles: true, composed: true }),
    );
  }

  private _renderField(field: FormFieldDef) {
    const value = this._values[field.key] ?? "";
    const fieldError = this.fieldErrors[field.key]?.[0] ?? "";

    return html`
      <wa-input
        class=${fieldError ? "has-error" : ""}
        label=${field.label}
        type=${field.type ?? "text"}
        ?required=${field.required ?? false}
        placeholder=${field.placeholder ?? ""}
        .step=${field.step !== undefined ? field.step : "any"}
        .value=${value}
        hint=${fieldError}
        .customError=${fieldError || null}
        @input=${(e: Event) => this._set(field.key, this._inputValue(e))}
      ></wa-input>
    `;
  }

  private _renderGroup(label: string, fields: FormFieldDef[]) {
    const expanded = this._expandedGroups.has(label);
    return html`
      <div>
        <div
          class="collapsible-header"
          @click=${() => {
            const next = new Set(this._expandedGroups);
            expanded ? next.delete(label) : next.add(label);
            this._expandedGroups = next;
          }}
        >
          <span class="chevron">${expanded ? "▼" : "▶"}</span>
          ${label}
        </div>
        ${expanded
          ? html`<div class="collapsible-body">
              ${fields.map((f) => this._renderField(f))}
            </div>`
          : ""}
      </div>
    `;
  }

  override render() {
    // Walk fields in order; emit ungrouped fields directly, emit each group
    // once at the position of its first field.
    type Section =
      | { type: "field"; field: FormFieldDef }
      | { type: "group"; label: string; fields: FormFieldDef[] };
    const seenGroups = new Set<string>();
    const sections: Section[] = [];
    for (const f of this.fields) {
      if (!f.group) {
        sections.push({ type: "field", field: f });
      } else if (!seenGroups.has(f.group)) {
        seenGroups.add(f.group);
        sections.push({
          type: "group",
          label: f.group,
          fields: this.fields.filter((x) => x.group === f.group),
        });
      }
    }

    return html`
      <div class="fields">
        ${sections.map((s) =>
          s.type === "field"
            ? this._renderField(s.field)
            : this._renderGroup(s.label, s.fields),
        )}
        ${this.error ? html`<p class="error">${this.error}</p>` : ""}
        <div class="actions">
          ${this.cancelLabel
            ? html`<wa-button @click=${this._handleCancel}
                >${this.cancelLabel}</wa-button
              >`
            : ""}
          <wa-button
            class="submit"
            appearance="filled"
            ?disabled=${this.submitting}
            @click=${this._handleSubmit}
          >
            ${this.submitting ? "..." : this.submitLabel}
          </wa-button>
        </div>
      </div>
    `;
  }
}

customElements.define("cca-form", CcaForm);
