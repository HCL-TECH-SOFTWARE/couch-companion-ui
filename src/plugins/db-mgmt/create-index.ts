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
import { customElement, property, query, state } from "lit/decorators.js";
import { CcaElement } from "../../components/cca-element.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import { ApiError } from "../../services/api-error.js";
import type { CreateIndexRequest } from "./types.js";
import "../../components/cca-monaco-editor.js";
import { createRef, ref, Ref } from "lit-html/directives/ref.js";
import { CcaMonacoEditor } from "../../components/cca-monaco-editor.js";

interface FieldEntry {
  id: string;
  name: string;
  /** Sort direction this field indexes on; new fields default to "asc" (#57). */
  direction: "asc" | "desc";
}

const isEmptyObject = (obj: any): boolean => {
  return obj && Object.keys(obj).length === 0 && obj.constructor === Object;
};

/**
 * The empty partial-filter-selector value, shared by the initial state, resetForm() and
 * populateFromIndexInfo(). Named rather than repeated: #108 was precisely the case where
 * populate and reset disagreed about what "no filter" means, and three copies of the
 * literal is how they drift apart again.
 */
const EMPTY_SELECTOR = "{\n\n}";

/**
 * A suggested index name for a set of fields: `["status", "created_at"]` →
 * `"status-created_at-index"`.
 *
 * Only {@link CcaCreateIndex.populateFromSort} uses it. CouchDB would happily generate a name
 * itself, but {@link CcaCreateIndex._buildRequestFromForm} requires one, and the point of
 * populating from a failed sort (#78) is that the user confirms rather than types.
 */
const suggestIndexName = (fields: ReadonlyArray<{ name: string }>): string =>
  fields.length > 0
    ? `${fields.map((f) => f.name.replace(/[^\w.-]+/g, "_")).join("-")}-index`
    : "";

@customElement("cca-create-index")
export class CcaCreateIndex extends CcaElement {
  static override get styles() {
    return css`
      :host {
        display: block;
      }
      .container {
        padding: 1rem;
        max-width: 600px;
        color: var(--wa-color-text-normal, #1f2a35);
      }
      .title {
        margin: 0 0 1.5rem 0;
      }
      .section {
        margin-bottom: 1.5rem;
      }
      .label {
        display: block;
        font-size: var(--wa-font-size-s);
        font-weight: var(--wa-font-weight-bold);
        margin-bottom: 0.5rem;
      }
      .required-indicator {
        color: var(--wa-color-danger, #d32f2f);
      }
      .description {
        font-size: var(--wa-font-size-xs);
        opacity: 0.65;
        margin: 0 0 0.5rem 0;
      }
      .input-row {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 0.75rem;
      }
      .input-row wa-input {
        flex: 1;
      }
      .fields-container {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        border: 1px solid var(--wa-color-neutral-border-quiet);
        border-radius: 4px;
        padding: 0.5rem;
      }
      .field-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.35rem;
        background: var(--wa-color-neutral-fill-quiet);
        border-radius: 2px;
      }
      .field-name {
        font-family: var(--wa-font-family-code);
        font-size: var(--wa-font-size-xs);
      }
      .field-item-controls {
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      .field-direction {
        width: 6.5rem;
      }
      .preview-description {
        margin: 0 0 0.75rem 0;
        font-size: var(--wa-font-size-s);
      }
      .preview-editor-container {
        height: 260px;
        border: 1px solid var(--wa-color-neutral-border-normal);
        border-radius: 8px;
        overflow: hidden;
      }
      .empty-message {
        margin: 0;
        padding: 0.5rem;
        font-size: var(--wa-font-size-xs);
        opacity: 0.55;
      }
      .editor-container {
        height: 120px;
        border: 1px solid var(--wa-color-neutral-border-normal);
        border-radius: 8px;
        overflow: hidden;
      }
      .source-editor-container {
        height: 24rem;
        border: 1px solid var(--wa-color-neutral-border-normal);
        border-radius: 8px;
        overflow: hidden;
      }
      .button-row {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
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
    `;
  }

  @property() dbName = "";
  @property() serverId = "";

  @state() private _fields: FieldEntry[] = [];
  @state() private _indexName = "";
  @state() private _indexType: "json" | "text" = "json";
  @state() private _ddoc = "";
  @state() private _fieldInput = "";
  @state() private _creating = false;
  @state() private _partialFilterSelector: string = EMPTY_SELECTOR;
  @state() private _showDeleteCreateIndex = false;
  @state() private _deleteCreateIndex = false;
  /** Preview-and-confirm dialog state (#57): Create/Remove-Create open it instead of
   *  submitting immediately, so the request can be reviewed and edited first. */
  @state() private _previewOpen = false;
  @state() private _previewText = "";
  @state() private _previewAction: "create" | "removeCreate" | null = null;
  /**
   * Which of the two tabs is showing (#92). Always starts — and is put back — on "form": the
   * complaint was that opening an index landed on an editor, so every entry point that fills
   * this component in ({@link populateFromIndexInfo}, {@link populateFromSort}) resets it.
   *
   * Panel names match `index-list.ts`'s per-index Form/Source pair rather than
   * `cca-user-detail.ts`'s "form"/"raw", because `index-manage` renders that list beside this
   * form and the two halves of one screen should not disagree about what a tab is called.
   */
  @state() private _activeTab: "form" | "source" = "form";
  /** The Source tab's own editable text — snapshotted from the form when the tab is switched
   *  to, then free-standing until switched to again, exactly as #85's Source tab behaves. A
   *  mirror that re-derived on every render would overwrite what is being typed. */
  @state() private _rawText = "";
  private _selectorEditorRef: Ref<CcaMonacoEditor> = createRef();

  private _nextFieldId = 1;

  public populateFromIndexInfo(indexInfo: any): void {
    // Reset form state
    this._fields = [];
    this._nextFieldId = 1;
    this._fieldInput = "";

    // Opening an index shows the FORM, never the editor (#92) — that is the whole complaint
    // this tab split answers, so it is asserted here rather than left to whichever tab the
    // user happened to leave open before clicking a different index in the list.
    this._activeTab = "form";
    this._rawText = "";

    // Populate index name
    this._indexName = indexInfo.name || "";

    // Populate index type
    this._indexType = (indexInfo.type as "json" | "text") || "json";

    // Populate fields from index definition, preserving each field's sort direction —
    // CouchDB reports a directioned field as a single-key object ({name: "desc"}), a
    // plain-asc field as a bare string (#57).
    if (indexInfo.def && typeof indexInfo.def === "object") {
      const fields = indexInfo.def.fields;
      if (Array.isArray(fields)) {
        this._fields = fields.map((field: any) => {
          if (typeof field === "string") {
            return {
              id: `field-${this._nextFieldId++}`,
              name: field,
              direction: "asc" as const,
            };
          }
          const name = Object.keys(field)[0] || "";
          const direction = field[name] === "desc" ? "desc" : "asc";
          return { id: `field-${this._nextFieldId++}`, name, direction };
        });
      }
    }

    // Populate the design document (#108). CouchDB reports it fully qualified
    // ("_design/foo") but this form's field holds the bare name — _buildRequestFromForm
    // passes `this._ddoc` straight to createIndex, so keeping the prefix would make a
    // select → Remove/Create round-trip write "_design/_design/foo". The built-in
    // primary index (_all_docs) reports `ddoc: null`, which the typeof guard turns into
    // "" (auto-generate) rather than the string "null".
    this._ddoc =
      typeof indexInfo.ddoc === "string"
        ? indexInfo.ddoc.replace(/^_design\//, "")
        : "";

    // Populate the partial filter selector. Assigned unconditionally: selecting an index
    // without a filter has to CLEAR whatever the previously-selected index left behind,
    // otherwise the form submits index B's name with index A's selector (#108).
    this._partialFilterSelector = indexInfo.def?.partial_filter_selector
      ? JSON.stringify(indexInfo.def.partial_filter_selector, null, 2)
      : EMPTY_SELECTOR;
    this._showDeleteCreateIndex = true;
  }

  /**
   * Fills the form from a sort that `_find` just rejected with `no_usable_index`, so the
   * offer to fix it is a confirmation rather than a retype (#78).
   *
   * Deliberately not {@link populateFromIndexInfo}: that one describes an index that already
   * EXISTS, which is why it reveals "Remove/Create". Nothing exists here — there is only a
   * sort CouchDB could not serve — so Create is the only honest offer, and
   * `_showDeleteCreateIndex` is cleared rather than left to whatever a previous populate set.
   *
   * Field ORDER is preserved because that is what CouchDB matches a sort against: with only
   * an `age` index, sorting by `[age, name]` is still `no_usable_index`. Each field's
   * direction is carried across too; a sort whose directions disagree never reaches here,
   * since CouchDB rejects that one as `unsupported_mixed_sort` instead.
   */
  public populateFromSort(
    sort: ReadonlyArray<{ field: string; direction: "asc" | "desc" }>,
  ): void {
    this._nextFieldId = 1;
    this._fields = sort
      .filter((s) => s.field.trim())
      .map((s) => ({
        id: `field-${this._nextFieldId++}`,
        name: s.field.trim(),
        direction: s.direction === "desc" ? ("desc" as const) : ("asc" as const),
      }));
    this._indexName = suggestIndexName(this._fields);
    this._indexType = "json";
    this._ddoc = "";
    this._fieldInput = "";
    this._partialFilterSelector = EMPTY_SELECTOR;
    this._showDeleteCreateIndex = false;
    // Same reason as populateFromIndexInfo: the offer is something to confirm in the form (#92).
    this._activeTab = "form";
    this._rawText = "";
  }

  public resetForm(): void {
    this._fields = [];
    this._nextFieldId = 1;
    this._indexName = "";
    this._indexType = "json";
    this._ddoc = "";
    this._fieldInput = "";
    this._partialFilterSelector = EMPTY_SELECTOR;
    this._activeTab = "form";
    this._rawText = "";
  }

  private _addField() {
    const fieldName = this._fieldInput.trim();
    if (!fieldName) return;
    if (this._fields.some((f) => f.name === fieldName)) {
      toast(`Field "${fieldName}" already added`, "info");
      this._fieldInput = "";
      return;
    }
    this._fields = [
      ...this._fields,
      { id: `field-${this._nextFieldId++}`, name: fieldName, direction: "asc" },
    ];
    this._fieldInput = "";
  }

  private _removeField(id: string) {
    this._fields = this._fields.filter((f) => f.id !== id);
  }

  private _setFieldDirection(id: string, direction: "asc" | "desc") {
    this._fields = this._fields.map((f) =>
      f.id === id ? { ...f, direction } : f,
    );
  }

  private _onFieldKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this._addField();
    }
  }

  /**
   * Validates the form and turns it into the request that would be sent — the same
   * validations used to run inline before submitting immediately, prior to the
   * preview-and-confirm step (#57). Returns `null` (after toasting the reason) when the
   * form isn't ready to submit.
   */
  private _buildRequestFromForm(): CreateIndexRequest | null {
    if (this._fields.length === 0) {
      toast("At least one field is required", "error");
      return null;
    }

    if (!this.serverId || !this.dbName) {
      toast("Server or database context missing", "error");
      return null;
    }

    if (!this._indexName || this._indexName.trim() === "") {
      toast("Index name is required", "error");
      return null;
    }

    if (isEmptyObject(this._partialFilterSelector)) {
      this._partialFilterSelector = "";
    }

    return this._formRequest();
  }

  /**
   * The form's current contents as a request, with none of {@link _buildRequestFromForm}'s
   * validation or toasts. Split out for the Source tab (#92): switching tabs has to render
   * whatever the form holds right now — including a half-filled one — and must not scold the
   * user for an incomplete form they were on their way to finish in JSON.
   */
  private _formRequest(): CreateIndexRequest {
    return {
      fields: this._fields.map((f) =>
        f.direction === "desc" ? { [f.name]: "desc" as const } : f.name,
      ),
      // dbMgmt.createIndex parses this itself — CreateIndexRequest carries the raw JSON
      // text, not a pre-parsed object — so an invalid selector surfaces as a clear error.
      partial_filter_selector: this._partialFilterSelector || undefined,
      name: this._indexName,
      type: this._indexType,
      ddoc: this._ddoc || undefined,
    };
  }

  /**
   * The Source tab's text: the same JSON the preview dialog shows, so what a user edits in
   * Source is recognisably the request that Confirm will submit rather than a third rendering
   * of the same index.
   */
  private _rawJson(): string {
    return JSON.stringify(
      this._buildPreviewObject(this._formRequest()),
      null,
      2,
    );
  }

  /** Snapshots the form into Source on the way in, and nowhere else — see {@link _rawText}. */
  private _onTabShow(name: string) {
    const next = name === "source" ? "source" : "form";
    if (next === "source" && this._activeTab !== "source") {
      this._rawText = this._rawJson();
    }
    this._activeTab = next;
  }

  /** Renders `request` as the human-editable JSON the preview dialog shows (#57). */
  private _buildPreviewObject(request: CreateIndexRequest): Record<string, unknown> {
    const preview: Record<string, unknown> = {
      name: request.name,
      type: request.type,
      fields: request.fields,
    };
    if (request.ddoc) preview.ddoc = request.ddoc;
    if (request.partial_filter_selector) {
      try {
        const parsed = JSON.parse(request.partial_filter_selector);
        const isEmpty =
          parsed && typeof parsed === "object" && Object.keys(parsed).length === 0;
        if (!isEmpty) preview.partial_filter_selector = parsed;
      } catch {
        // Not valid JSON yet — surface the raw text so the user can fix it in the preview.
        preview.partial_filter_selector = request.partial_filter_selector;
      }
    }
    return preview;
  }

  /**
   * "Create" / "Remove/Create" open this preview instead of submitting immediately (#57).
   *
   * Whichever tab is showing is the one that owns the request (#92) — the same rule #85's Save
   * follows. On Source that is the editor's text, so an edit made there is not silently
   * discarded in favour of the form it was diverging from; the preview then still stands
   * between it and CouchDB, and {@link _confirmPreview} still validates whatever survives.
   */
  private _openPreview(action: "create" | "removeCreate") {
    let previewText: string;
    if (this._activeTab === "source") {
      try {
        JSON.parse(this._rawText);
      } catch {
        toast("The Source tab does not contain valid JSON.", "error");
        return;
      }
      previewText = this._rawText;
    } else {
      const request = this._buildRequestFromForm();
      if (!request) return;
      previewText = JSON.stringify(this._buildPreviewObject(request), null, 2);
    }
    this._previewAction = action;
    this._previewText = previewText;
    this._previewOpen = true;
  }

  private _cancelPreview() {
    this._previewOpen = false;
    this._previewAction = null;
  }

  /** Confirms the preview — parsing whatever the user left in the editor, not the original
   *  form state, so edits made in the preview are what actually gets submitted (#57). */
  private async _confirmPreview() {
    let parsed: any;
    try {
      parsed = JSON.parse(this._previewText);
    } catch {
      toast("Preview is not valid JSON.", "error");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      toast("Preview must be a JSON object.", "error");
      return;
    }
    if (!Array.isArray(parsed.fields) || parsed.fields.length === 0) {
      toast("At least one field is required", "error");
      return;
    }
    if (!parsed.name || typeof parsed.name !== "string" || !parsed.name.trim()) {
      toast("Index name is required", "error");
      return;
    }

    const request: CreateIndexRequest = {
      fields: parsed.fields,
      name: parsed.name,
      type: parsed.type === "text" ? "text" : "json",
      ddoc: parsed.ddoc || undefined,
      partial_filter_selector:
        parsed.partial_filter_selector !== undefined
          ? JSON.stringify(parsed.partial_filter_selector)
          : undefined,
    };

    const deleteCreate = this._previewAction === "removeCreate";
    this._previewOpen = false;
    this._previewAction = null;

    await this._submitIndex(request, deleteCreate);
    if (deleteCreate) {
      this._showDeleteCreateIndex = false;
    }
  }

  private async _submitIndex(
    request: CreateIndexRequest,
    deleteCreate: boolean,
  ): Promise<void> {
    if (!this.serverId || !this.dbName) {
      toast("Server or database context missing", "error");
      return;
    }

    this._deleteCreateIndex = deleteCreate;
    this._creating = true;
    try {
      const result = await getContext().dbMgmt.createIndex(
        this.serverId,
        this.dbName,
        request,
      );

      if (result.result && result.result == "exists") {
        toast(`Index "${result.name}" already exists`, "info");
        this.resetForm();
        return;
      }

      toast(`Index "${result.name}" created successfully`, "success");

      this.resetForm();

      this.dispatchEvent(
        new CustomEvent("index-created", {
          bubbles: true,
          composed: true,
          detail: {
            result: result,
            deleteCreateIndex: this._deleteCreateIndex,
          },
        }),
      );
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? ((err.body as any)?.detail ?? err.message)
          : String(err);
      toast(`Failed to create index: ${msg}`, "error");
    } finally {
      this._creating = false;
      this._deleteCreateIndex = false;
    }
  }

  override render() {
    return html`
      <div class="container">
        <h2 class="title">Create Mango Index</h2>

        <wa-tab-group
          .active=${this._activeTab}
          @wa-tab-show=${(e: CustomEvent<{ name: string }>) =>
            this._onTabShow(e.detail.name)}
        >
          <wa-tab panel="form">Form</wa-tab>
          <wa-tab panel="source">Source</wa-tab>
          <wa-tab-panel name="form">${this.renderFormTab()}</wa-tab-panel>
          <wa-tab-panel name="source">${this.renderSourceTab()}</wa-tab-panel>
        </wa-tab-group>

        <div class="button-row">
          <wa-button
            data-create
            ?disabled=${this._submitDisabled}
            variant="brand"
            @click=${() => this._openPreview("create")}
          >
            Create
          </wa-button>
          ${this.renderRemoveCreateButton()}
        </div>

        ${this.renderPreviewDialog()}
      </div>
    `;
  }

  /**
   * #57's rule — there is nothing to create without at least one field — but only while the
   * Form tab owns the request. On Source the editor's JSON is what gets submitted (#92), so a
   * hand-written index would otherwise be unsubmittable purely because the form behind it is
   * empty.
   */
  private get _submitDisabled(): boolean {
    return (
      this._creating ||
      (this._activeTab === "form" && this._fields.length === 0)
    );
  }

  /** Offered only for an index that already exists — see {@link populateFromSort}. */
  private renderRemoveCreateButton() {
    if (!this._showDeleteCreateIndex) return "";
    return html`<wa-button
      data-remove-create
      ?disabled=${this._submitDisabled}
      variant="brand"
      @click=${() => this._openPreview("removeCreate")}
    >
      Remove/Create
    </wa-button>`;
  }

  /**
   * The Source tab: the whole index request as editable JSON (#92).
   *
   * Only mounted while the tab is showing — `wa-tab-panel` is `display: none` until
   * `wa-tab-group`'s IntersectionObserver activates it, so an eagerly mounted Monaco would
   * measure 0×0. `index-list.ts` and `cca-user-detail.ts` gate theirs the same way.
   */
  private renderSourceTab() {
    if (this._activeTab !== "source") return "";
    return html`
      <div class="section">
        <p class="description">
          The full index request. Editing it here is what Create submits, so the fields on the
          Form tab are only a starting point.
        </p>
        <div class="source-editor-container">
          <cca-monaco-editor
            data-source-editor
            .value=${this._rawText}
            .language=${"json"}
            @change=${(e: CustomEvent) => (this._rawText = e.detail.value)}
          ></cca-monaco-editor>
        </div>
      </div>
    `;
  }

  /** The structured fields — everything this screen offered before #92 introduced the tabs. */
  private renderFormTab() {
    return html`
        <div class="section">
          <label class="label">
            Fields <span class="required-indicator">*</span>
          </label>
          <p class="description">
            Ordered list of fields to index (e.g., "status", "created_at")
          </p>
          <div class="input-row">
            <wa-input
              data-field-input
              placeholder="Enter field name"
              .value=${this._fieldInput}
              @input=${(e: Event) =>
                (this._fieldInput = (e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => this._onFieldKeyDown(e)}
            ></wa-input>
            <wa-button
              data-add-field
              @click=${() => this._addField()}
              variant="brand"
              ?disabled=${!this._fieldInput.trim()}
            >
              Add
            </wa-button>
          </div>
          <div class="fields-container">
            ${
              this._fields.length > 0
                ? this.renderFields()
                : html`<p class="empty-message">No fields added yet</p>`
            }
          </div>
        </div>

        <div class="section">
          <label class="label"> Partial Filter Selector (Optional) </label>
          <div class="editor-container">
            <cca-monaco-editor
              data-selector-editor
              ${ref(this._selectorEditorRef)}
              .value=${this._partialFilterSelector}
              .language=${"json"}
              @change=${(e: CustomEvent) =>
                (this._partialFilterSelector = e.detail.value)}
            ></cca-monaco-editor>
          </div>
        </div>

        <div class="section">
          <label class="label"> Index Name </label>
          <p class="description">CouchDB auto-generates a name if omitted</p>
          <wa-input
            data-index-name
            placeholder="e.g., status-created-idx"
            .value=${this._indexName}
            @input=${(e: Event) =>
              (this._indexName = (e.target as HTMLInputElement).value)}
          ></wa-input>
        </div>

        <div class="section">
          <label class="label"> Index Type </label>
          <wa-select
            data-index-type
            .value=${this._indexType}
            @change=${(e: Event) =>
              (this._indexType = (e.target as HTMLSelectElement).value as
                "json" | "text")}
          >
            <wa-option value="json">JSON (Mango)</wa-option>
            <wa-option value="text">Text Search</wa-option>
          </wa-select>
        </div>

        <div class="section">
          <label class="label"> Design Document (Optional) </label>
          <p class="description">
            Leave blank for auto-generated design document
          </p>
          <wa-input
            data-ddoc
            placeholder="e.g., my-indexes"
            .value=${this._ddoc}
            @input=${(e: Event) =>
              (this._ddoc = (e.target as HTMLInputElement).value)}
          ></wa-input>
        </div>
    `;
  }

  /**
   * Editable preview-and-confirm dialog for the Create / Remove-Create actions (#57). Nothing
   * is submitted until Confirm is pressed, and Confirm submits exactly what the editor holds
   * at that point — so adjusting the JSON here changes what gets sent.
   */
  private renderPreviewDialog() {
    const title =
      this._previewAction === "removeCreate"
        ? "Confirm Remove/Create Index"
        : "Confirm Create Index";
    return html`
      <wa-dialog
        data-preview-dialog
        label=${title}
        ?open=${this._previewOpen}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._cancelPreview();
        }}
      >
        <p class="preview-description">
          Review and adjust the index request below, then confirm to submit it.
        </p>
        <div class="preview-editor-container">
          <cca-monaco-editor
            data-preview-editor
            .value=${this._previewText}
            .language=${"json"}
            @change=${(e: CustomEvent) => (this._previewText = e.detail.value)}
          ></cca-monaco-editor>
        </div>
        <div
          slot="footer"
          style="display:flex;gap:0.5rem;justify-content:flex-end"
        >
          <wa-button
            data-preview-cancel
            ?disabled=${this._creating}
            @click=${() => this._cancelPreview()}
          >
            Cancel
          </wa-button>
          <wa-button
            data-preview-confirm
            variant="brand"
            ?disabled=${this._creating}
            @click=${() => this._confirmPreview()}
          >
            ${this._creating ? html`<wa-spinner></wa-spinner>` : "Confirm"}
          </wa-button>
        </div>
      </wa-dialog>
    `;
  }

  private renderFields() {
    return this._fields.map(
      (field, i) =>
        html`<div class="field-item">
          <span class="field-name"> ${i + 1}. ${field.name} </span>
          <div class="field-item-controls">
            <wa-select
              class="field-direction"
              size="s"
              appearance="filled"
              .value=${field.direction}
              @change=${(e: Event) =>
                this._setFieldDirection(
                  field.id,
                  (e.target as HTMLSelectElement).value as "asc" | "desc",
                )}
            >
              <wa-option value="asc">↑ asc</wa-option>
              <wa-option value="desc">↓ desc</wa-option>
            </wa-select>
            <wa-button
              size="s"
              appearance="plain"
              @click=${() => this._removeField(field.id)}
            >
              <wa-icon name="xmark" variant="solid"></wa-icon>
            </wa-button>
          </div>
        </div>`,
    );
  }
}
