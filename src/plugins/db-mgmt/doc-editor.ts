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
import { createRef, ref } from "lit/directives/ref.js";
import type { Ref } from "lit/directives/ref.js";
import { CcaElement } from "../../components/cca-element.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import "../../components/cca-monaco-editor.js";
import "../../components/cca-attachment-count.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/format-bytes/format-bytes.js";
import {
  attachmentCount,
  attachmentErrorMessage,
  listAttachments,
} from "../../services/attachments.js";
import type { AttachmentInfo } from "../../services/attachments.js";

import type { CcaMonacoEditor } from "../../components/cca-monaco-editor.js";
import { setHeaderTitle } from "../../components/cca-header.js";

const DEFAULT_BODY = JSON.stringify({}, null, 2);

/**
 * Hands a downloaded attachment to the browser as a file (#120).
 *
 * The bytes were fetched through the app's API client — that is the whole point, since only it
 * carries the session — so by the time they get here they are a `Blob` in memory, and an
 * object URL is the only way to turn one back into something the download attribute accepts.
 *
 * Two details are load-bearing rather than superstition: the anchor must be *in* the document
 * for the synthetic click to be honoured in Firefox, and the URL is revoked on the next task
 * rather than immediately, because revoking it in the same task can cancel the download the
 * click just started.
 */
function saveBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

@customElement("cca-doc-editor")
export class CcaDocEditor extends CcaElement {
  static override get styles() {
    return css`
      .attachments {
        margin-bottom: var(--wa-space-m);
        border: var(--wa-border-width-s) var(--wa-border-style)
          var(--wa-color-neutral-border-quiet);
        border-radius: var(--wa-border-radius-m);
      }
      .attachments-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--wa-space-s);
        padding: var(--wa-space-xs) var(--wa-space-s);
      }
      .attachments-title {
        display: flex;
        align-items: center;
        gap: var(--wa-space-2xs);
        font-size: var(--wa-font-size-s);
        font-weight: var(--wa-font-weight-semibold);
      }
      .attachment-row {
        display: flex;
        align-items: center;
        gap: var(--wa-space-s);
        padding: var(--wa-space-2xs) var(--wa-space-s);
        border-top: var(--wa-border-width-s) var(--wa-border-style)
          var(--wa-color-neutral-border-quiet);
        font-size: var(--wa-font-size-s);
      }
      .attachment-name {
        flex: 1 1 auto;
        min-width: 0;
        font-family: var(--wa-font-family-code);
        /* Attachment names come from whoever wrote the document, so they can be long and
           have no spaces to break at; anywhere is the only value that will not push the
           action buttons off the panel. */
        overflow-wrap: anywhere;
      }
      .attachment-meta {
        flex: 0 0 auto;
        color: var(--wa-color-text-quiet);
      }
      .attachment-actions {
        display: flex;
        flex: 0 0 auto;
        gap: var(--wa-space-3xs);
      }
      .attachments-note {
        padding: var(--wa-space-2xs) var(--wa-space-s) var(--wa-space-xs);
        border-top: var(--wa-border-width-s) var(--wa-border-style)
          var(--wa-color-neutral-border-quiet);
        color: var(--wa-color-text-quiet);
        font-size: var(--wa-font-size-s);
      }
    `;
  }

  /** Set by the router from the :dbName path param. */
  @property() dbName = "";

  /** Set by the router from the :docId path param.
   *  Empty or "new" means create mode; any other value means edit mode (future). */
  @property() docId = "";

  /** Set by the router from the :serverId path param. */
  @property({ type: String }) serverId = "";

  @state() private _selectedServerId = "";
  @state() private _customId = "";
  @state() private _saving = false;
  @state() private _loadingDoc = false;
  @state() private _editorValue = DEFAULT_BODY;
  /**
   * How many attachments the *loaded* document carries (#84).
   *
   * Read from the load rather than from the editor's text on every keystroke: the badge
   * describes the document that is stored, and half-typed JSON in the buffer has no
   * attachments to report either way. Zero in create mode, where there is no document yet.
   */
  @state() private _attachmentCount = 0;

  /** The attachments of the *loaded* document, in filename order — the panel's whole content. */
  @state() private _attachments: AttachmentInfo[] = [];

  /**
   * The revision every attachment write is sent against.
   *
   * Read from the loaded document and updated from CouchDB's response after each write, never
   * from the editor buffer: the buffer is text the user is free to break, and a `?rev=` taken
   * from it would be a revision nobody has agreed to.
   */
  private _loadedRev = "";

  /**
   * Whether the buffer has edits the document does not have — see {@link _differsFromLoaded}.
   * Reactive because it decides whether the attachment buttons are usable.
   */
  @state() private _dirty = false;

  /** A picked file whose name is already taken, held while the overwrite dialog is open. */
  @state() private _pendingOverwrite: File | null = null;

  /** The attachment awaiting delete confirmation, or `null` when that dialog is closed. */
  @state() private _pendingAttachmentDelete: AttachmentInfo | null = null;

  /** The attachment an operation is in flight for, so its row can say so and not be re-clicked. */
  @state() private _busyAttachment: string | null = null;

  private _editorRef: Ref<CcaMonacoEditor> = createRef();
  private _fileInputRef: Ref<HTMLInputElement> = createRef();

  override connectedCallback() {
    super.connectedCallback();
    setHeaderTitle(
      this._isCreateMode ? "New Document" : `Edit Document: ${this.docId}`,
    );
    // serverId is injected as a route property by the app shell.
    this._selectedServerId = this.serverId;
    if (!this._isCreateMode) {
      void this._loadForEdit();
    }
  }

  private get _isCreateMode(): boolean {
    return !this.docId || this.docId === "new";
  }

  private _prettify() {
    this._editorRef.value?.format();
  }

  private async _loadForEdit() {
    if (!this.docId || this.docId === "new") return;
    if (!this._selectedServerId) {
      toast("No server selected — cannot load document for editing.", "error");
      return;
    }

    this._loadingDoc = true;
    try {
      const doc = await getContext().dbMgmt.getDoc(
        this._selectedServerId,
        this.dbName,
        this.docId,
      );
      this._editorValue = JSON.stringify(doc, null, 2);
      this._attachmentCount = attachmentCount(doc);
      this._attachments = listAttachments(doc);
      this._loadedRev = typeof doc._rev === "string" ? doc._rev : "";
      // The buffer is now, by definition, the document again — whether this was the first
      // load or the re-read after an attachment write.
      this._dirty = false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Failed to load document: ${msg}`, "error");
    } finally {
      this._loadingDoc = false;
    }
  }

  /**
   * Tracks whether the buffer still says what the stored document says.
   *
   * `cca-monaco-editor` suppresses this event around its own `setValue`, so re-loading the
   * document after an attachment write does not register as the user typing.
   */
  private _onEditorChange(e: Event) {
    const value = (e as CustomEvent<{ value?: string }>).detail?.value;
    if (typeof value !== "string") return;
    const dirty = this._differsFromLoaded(value);
    // Assigned only on a transition: this fires on every keystroke, and `_dirty` is reactive.
    if (dirty !== this._dirty) this._dirty = dirty;
  }

  /**
   * Whether `text` is a different *document* from the one that was loaded — not merely
   * different text.
   *
   * The comparison runs through `JSON.parse`/`JSON.stringify` at the same indentation the
   * loaded value was built with, so reformatting alone (the Prettify button, or Monaco's own
   * format-on-paste) does not count as an edit. Key order survives that round trip, so a
   * genuine reordering still does.
   *
   * Unparseable text counts as an edit: whatever it is, it is not the document that was
   * loaded, and half-typed JSON is precisely the state an attachment write must not be
   * reconciled against.
   */
  private _differsFromLoaded(text: string): boolean {
    if (text === this._editorValue) return false;
    try {
      return JSON.stringify(JSON.parse(text), null, 2) !== this._editorValue;
    } catch {
      return true;
    }
  }

  /**
   * Why attachments cannot be changed right now, or `null` when they can.
   *
   * **The chosen answer to revision churn (#120):** every upload and delete bumps `_rev`, and
   * the editor may be holding unsaved JSON. Rather than let the two diverge — which surfaces
   * later as a 409 on save that names nothing the user did — the write is refused while the
   * buffer differs from the stored document, and after every successful write the document is
   * re-read so the buffer, the revision, the stub list and #84's badge all come from one
   * response.
   *
   * The alternative — patching the new `_rev` into the user's text — was rejected because it
   * silently edits the buffer under the cursor and still leaves `_attachments` in it stale, so
   * it trades a clear 409 for a document that merely looks right.
   *
   * Downloads are deliberately not gated: reading bytes needs no revision and changes nothing.
   */
  private _attachmentBlockReason(): string | null {
    if (this._isCreateMode) {
      return "Save the document before adding attachments.";
    }
    if (this._dirty) {
      return "Save or undo your edits before changing attachments — every attachment change creates a new document revision.";
    }
    if (!this._loadedRev) {
      return "The document revision is unknown — reload the document and try again.";
    }
    return null;
  }

  /** Opens the file picker, unless something is in the way — in which case it says what. */
  private _pickFile() {
    const blocked = this._attachmentBlockReason();
    if (blocked) {
      toast(blocked, "info");
      return;
    }
    this._fileInputRef.value?.click();
  }

  /**
   * A file came back from the picker: upload it, or ask first when the name is taken.
   *
   * CouchDB has no "add without replacing" — a `PUT` to an existing attachment name overwrites
   * it and answers `201` either way (verified against 3.5.2) — so the only place this can be
   * asked is before the request.
   */
  private _onFileChosen(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    // Cleared so that picking the *same* file again still fires `change`: the event follows a
    // change of value, and re-choosing an identical path is no change at all.
    input.value = "";
    if (!file) return;

    const blocked = this._attachmentBlockReason();
    if (blocked) {
      toast(blocked, "info");
      return;
    }

    if (this._attachments.some((a) => a.name === file.name)) {
      this._pendingOverwrite = file;
      return;
    }
    void this._upload(file);
  }

  /** Uploads one file under its own name, then re-reads the document. */
  private async _upload(file: File) {
    const name = file.name;
    this._busyAttachment = name;
    try {
      const rev = await getContext().attachments.upload(
        this.dbName,
        this.docId,
        name,
        file,
        this._loadedRev,
      );
      // Adopted before the re-read so that even a failed reload leaves the next write with a
      // revision CouchDB will accept.
      this._loadedRev = rev;
      toast(`Attached “${name}”.`, "success");
      await this._loadForEdit();
    } catch (err: unknown) {
      toast(attachmentErrorMessage(err, "upload", name), "error");
    } finally {
      this._busyAttachment = null;
    }
  }

  /** Deletes the attachment the dialog just confirmed, then re-reads the document. */
  private async _deleteAttachment(info: AttachmentInfo) {
    const blocked = this._attachmentBlockReason();
    if (blocked) {
      toast(blocked, "info");
      return;
    }
    this._busyAttachment = info.name;
    try {
      const rev = await getContext().attachments.remove(
        this.dbName,
        this.docId,
        info.name,
        this._loadedRev,
      );
      this._loadedRev = rev;
      toast(`Deleted “${info.name}”.`, "success");
      await this._loadForEdit();
    } catch (err: unknown) {
      toast(attachmentErrorMessage(err, "delete", info.name), "error");
    } finally {
      this._busyAttachment = null;
    }
  }

  /**
   * Fetches one attachment through the app's client and hands it to the browser as a file.
   *
   * Not gated on unsaved edits: a download reads bytes at the current revision and changes
   * nothing, so there is no divergence for it to cause.
   */
  private async _download(info: AttachmentInfo) {
    this._busyAttachment = info.name;
    try {
      const blob = await getContext().attachments.download(
        this.dbName,
        this.docId,
        info.name,
      );
      saveBlobAsFile(blob, info.name);
    } catch (err: unknown) {
      toast(attachmentErrorMessage(err, "download", info.name), "error");
    } finally {
      this._busyAttachment = null;
    }
  }

  private async _save() {
    const raw = this._editorRef.value?.getValue() ?? "";
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      toast("Invalid JSON — please fix the document before saving.", "error");
      return;
    }
    if (typeof body !== "object" || Array.isArray(body) || body === null) {
      toast("Document body must be a JSON object.", "error");
      return;
    }

    const id = this._isCreateMode ? this._customId.trim() || null : this.docId;
    this._saving = true;
    try {
      await getContext().dbMgmt.saveDocument(
        this._selectedServerId,
        this.dbName,
        {
          id,
          body,
        },
      );
      toast(
        this._isCreateMode
          ? "Document created successfully."
          : "Document updated successfully.",
        "success",
      );
      getContext().router.navigate(
        `/databases/${encodeURIComponent(this._selectedServerId || this.serverId || "$all")}/${encodeURIComponent(this.dbName)}/documents`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Failed to save document: ${msg}`, "error");
    } finally {
      this._saving = false;
    }
  }

  override render() {
    return html`
      <!-- Header bar -->
      <div
        style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem"
      >
        <div style="display:flex;align-items:center;gap:0.75rem">
          <wa-button
            appearance="plain"
            @click=${() =>
              getContext().router.back(
                `/databases/${encodeURIComponent(this._selectedServerId || this.serverId || "$all")}/${encodeURIComponent(this.dbName)}/documents`,
              )}
          >
            ← Back
          </wa-button>
        </div>
        <div style="display:flex;align-items:center;gap:0.5rem">
          <!-- Says whether this document has attachments, and how many; nothing when it
               has none (#84). Still not a link: the panel below manages them (#120), and
               it re-reads the document after every change, so this count follows. -->
          <cca-attachment-count
            .count=${this._attachmentCount}
          ></cca-attachment-count>
          <wa-button
            appearance="plain"
            @click=${() => this._prettify()}
            ?disabled=${this._saving}
          >
            Prettify
          </wa-button>
          <wa-button
            @click=${() => this._save()}
            ?disabled=${
              this._saving || this._loadingDoc || !this._selectedServerId
            }
          >
            ${
              this._saving
                ? html`<wa-spinner
                    style="font-size:var(--wa-font-size-m)"
                  ></wa-spinner>`
                : "Save"
            }
          </wa-button>
        </div>
      </div>

      <!-- Optional custom document ID (create mode only) -->
      ${this._isCreateMode ? this.renderCreateModeIdInput() : ""}

      <!-- Upload, download and delete of this document's attachments (#120) -->
      ${this.renderAttachments()}

      <!-- Monaco JSON editor -->
      <div
        style="height:60vh;border:1px solid var(--wa-color-neutral-border-quiet);border-radius:4px;overflow:hidden"
      >
        <cca-monaco-editor
          ${ref(this._editorRef)}
          .value=${this._editorValue}
          .language=${"json"}
          @change=${(e: Event) => this._onEditorChange(e)}
        ></cca-monaco-editor>
      </div>

      ${
        this._loadingDoc
          ? html`<div style="margin-top:0.75rem">
              <wa-spinner></wa-spinner>
            </div>`
          : ""
      }
      ${
        !this._selectedServerId
          ? html`<div
              style="margin-top:0.75rem;font-size:var(--wa-font-size-s);color:var(--wa-color-danger-on-quiet)"
            >
              No server selected — cannot save. Navigate here from the doc
              browser with a server selected.
            </div>`
          : ""
      }
      ${this.renderOverwriteConfirm()} ${this.renderAttachmentDeleteConfirm()}
    `;
  }

  /**
   * The attachment panel (#120): what this document carries, and the four things that can be
   * done about it.
   *
   * Shown even when the document has none — an empty panel is where the Add button lives, and
   * the whole feature would otherwise be invisible on exactly the documents that need it. The
   * paperclip badge in the header bar stays the *page-level* answer to "does this have
   * attachments"; this is the list.
   */
  private renderAttachments() {
    const blocked = this._attachmentBlockReason();
    return html`
      <section class="attachments" data-attachments>
        <div class="attachments-head">
          <span class="attachments-title">
            <wa-icon name="paperclip" variant="solid"></wa-icon>
            Attachments (${this._attachments.length})
          </span>
          <wa-button
            size="s"
            appearance="outlined"
            data-attachment-add
            ?disabled=${blocked !== null || this._busyAttachment !== null}
            @click=${() => this._pickFile()}
          >
            <wa-icon slot="start" name="plus"></wa-icon>
            Add attachment
          </wa-button>
        </div>

        ${this._attachments.map((a) => this.renderAttachmentRow(a))}
        ${
          this._attachments.length === 0 && !this._isCreateMode
            ? html`<div class="attachments-note" data-attachments-empty>
                This document has no attachments.
              </div>`
            : nothing
        }
        ${
          blocked
            ? html`<div class="attachments-note" data-attachments-blocked>
                ${blocked}
              </div>`
            : nothing
        }
      </section>

      <!-- The picker itself is never shown: the Add button clicks it, so the panel keeps one
           button style rather than the browser's unstylable file control. -->
      <input
        ${ref(this._fileInputRef)}
        type="file"
        data-attachment-file-input
        hidden
        @change=${(e: Event) => this._onFileChosen(e)}
      />
    `;
  }

  private renderAttachmentRow(a: AttachmentInfo) {
    const busy = this._busyAttachment === a.name;
    const writesBlocked = this._attachmentBlockReason() !== null;
    return html`
      <div class="attachment-row" data-attachment-row=${a.name}>
        <span class="attachment-name">${a.name}</span>
        <span class="attachment-meta">${a.contentType}</span>
        <span class="attachment-meta">
          <wa-format-bytes value=${a.length}></wa-format-bytes>
        </span>
        <span class="attachment-actions">
          <wa-button
            size="s"
            appearance="outlined"
            class="row-action-button"
            title="Download"
            data-attachment-download
            ?disabled=${this._busyAttachment !== null}
            @click=${() => this._download(a)}
          >
            <wa-icon name="download" label="Download"></wa-icon>
          </wa-button>
          <wa-button
            size="s"
            variant="danger"
            appearance="outlined"
            class="row-action-button"
            title="Delete"
            data-attachment-delete
            ?disabled=${writesBlocked || this._busyAttachment !== null}
            @click=${() => (this._pendingAttachmentDelete = a)}
          >
            <wa-icon name="trash-can" label="Delete"></wa-icon>
          </wa-button>
          ${
            busy
              ? html`<wa-spinner
                  data-attachment-busy
                  style="font-size:var(--wa-font-size-m)"
                ></wa-spinner>`
              : nothing
          }
        </span>
      </div>
    `;
  }

  /**
   * "That name is taken — replace it?"
   *
   * Not a nicety: `PUT` to an existing attachment name replaces its contents, and CouchDB
   * answers the same `201` it would for a new one, so nothing after the fact can tell the user
   * that something was overwritten — or get it back.
   */
  private renderOverwriteConfirm() {
    const name = this._pendingOverwrite?.name ?? "";
    return html`
      <wa-dialog
        data-overwrite-dialog
        label="Replace attachment"
        ?open=${this._pendingOverwrite !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._pendingOverwrite = null;
        }}
      >
        <p style="margin-top:0">
          This document already has an attachment named
          <strong>${name}</strong>. Uploading replaces its contents — the
          current version cannot be recovered.
        </p>
        <div
          slot="footer"
          style="display:flex;gap:0.5rem;justify-content:flex-end"
        >
          <wa-button
            data-overwrite-cancel
            @click=${() => (this._pendingOverwrite = null)}
            >Cancel</wa-button
          >
          <wa-button
            data-overwrite-confirm
            variant="danger"
            @click=${() => {
              const file = this._pendingOverwrite;
              this._pendingOverwrite = null;
              if (file) void this._upload(file);
            }}
            >Replace</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }

  /** Asks before deleting an attachment, in the same dialog the document list uses (#58). */
  private renderAttachmentDeleteConfirm() {
    const name = this._pendingAttachmentDelete?.name ?? "";
    return html`
      <wa-dialog
        data-attachment-delete-dialog
        label="Delete attachment"
        ?open=${this._pendingAttachmentDelete !== null}
        @wa-after-hide=${(e: Event) => {
          if (e.target === e.currentTarget) this._pendingAttachmentDelete = null;
        }}
      >
        <p style="margin-top:0">
          Delete <strong>${name}</strong> from this document? This cannot be
          undone.
        </p>
        <div
          slot="footer"
          style="display:flex;gap:0.5rem;justify-content:flex-end"
        >
          <wa-button
            data-attachment-delete-cancel
            @click=${() => (this._pendingAttachmentDelete = null)}
            >Cancel</wa-button
          >
          <wa-button
            data-attachment-delete-confirm
            variant="danger"
            @click=${() => {
              const target = this._pendingAttachmentDelete;
              this._pendingAttachmentDelete = null;
              if (target) void this._deleteAttachment(target);
            }}
            >Delete</wa-button
          >
        </div>
      </wa-dialog>
    `;
  }

  private renderCreateModeIdInput() {
    return html`
      <div style="margin-bottom:1rem;max-width:28rem">
        <label
          for="cca-doc-editor-id"
          style="display:block;font-size:var(--wa-font-size-s);font-weight:var(--wa-font-weight-semibold);margin-bottom:0.35rem"
          >Document ID
          <span style="font-weight:var(--wa-font-weight-normal);opacity:0.55"
            >(optional — leave blank to auto-generate)</span
          ></label
        >
        <input
          id="cca-doc-editor-id"
          type="text"
          .value=${this._customId}
          @input=${(e: Event) =>
            (this._customId = (e.target as HTMLInputElement).value)}
          placeholder="e.g. my-doc-001"
          style="width:100%;box-sizing:border-box;padding:0.4rem 0.6rem;border:1px solid var(--wa-color-neutral-border-normal);border-radius:4px;font-size:var(--wa-font-size-s);font-family:inherit"
        />
      </div>
    `;
  }
}
