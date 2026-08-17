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
import { customElement, property } from "lit/decorators.js";
import { CcaElement } from "./cca-element.js";
import type { TableColumn } from "./cca-data-table.js";
import { anyHaveAttachments, attachmentCount } from "../services/attachments.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";

/**
 * "This document has attachments, and there are this many" — a paperclip and a number (#84).
 *
 * Three screens show it: both document lists, as a column, and the document editor, beside
 * its actions. It is an indicator only — attachment management is #120 — so it deliberately
 * links nowhere and takes no click.
 *
 * A component rather than a shared template function because two of its three homes are
 * table cells, and a cell's content is composed into `cca-data-table`'s shadow root, out of
 * reach of the calling screen's stylesheet. `cca-column-picker` is a component for exactly
 * the same reason.
 *
 * Renders nothing at all at zero. An attachment column reading "0" down every row is noise
 * in the one place — a document list — where the whole value is spotting the few rows that
 * differ; and after a Mango projection, zero would not even be true (see
 * {@link attachmentCount}).
 */
@customElement("cca-attachment-count")
export class CcaAttachmentCount extends CcaElement {
  static override get styles() {
    return css`
      :host {
        display: inline-flex;
      }
      .indicator {
        display: inline-flex;
        align-items: center;
        gap: var(--wa-space-3xs);
        color: var(--wa-color-text-quiet);
        font-size: var(--wa-font-size-s);
        /* Field-name headers opt out of the table's uppercasing for case-sensitivity's
           sake; a count is a number, but it sits on the same baseline, so it opts out
           of the inherited weight and casing too. */
        font-weight: var(--wa-font-weight-normal);
        text-transform: none;
      }
    `;
  }

  /** How many attachments to announce. Zero — or anything below it — renders nothing. */
  @property({ type: Number }) count = 0;

  override render() {
    if (!(this.count > 0)) return nothing;
    const plural = this.count === 1 ? "attachment" : "attachments";
    return html`
      <span
        class="indicator"
        data-attachment-count=${this.count}
        title=${`${this.count} ${plural}`}
      >
        <!-- The icon carries the word and the number carries itself, so a screen reader
             reads "Attachments 3" rather than the count twice. The name resolves through
             the local Font Awesome set src/icons.ts points wa-icon at (#741); no icon
             name here reaches a CDN. -->
        <wa-icon name="paperclip" variant="solid" label="Attachments"></wa-icon>
        <span>${this.count}</span>
      </span>
    `;
  }
}

/**
 * The attachment column both document lists put in front of their derived ones, or no
 * column at all when nothing on this page has an attachment.
 *
 * Page-dependent on purpose, and for the same reason the cells are: a header over a column
 * of blanks is the noise this issue set out not to add. The screens' other columns are
 * already derived per page (#79), so a column that comes and goes with the documents is
 * the behaviour this table already has.
 *
 * Shared so `doc-browser` and `doc-query` cannot drift apart the way their page footers
 * once did (#80).
 */
export function attachmentColumn<T>(docs: readonly T[]): TableColumn<T>[] {
  if (!anyHaveAttachments(docs)) return [];
  return [
    {
      label: "Attachments",
      width: "6rem",
      // The header is the same paperclip the cells are, so the column needs no wider than
      // its contents; `label` above stays the readable name for anything reading columns.
      headerRender: () =>
        html`<wa-icon
          name="paperclip"
          variant="solid"
          label="Attachments"
        ></wa-icon>`,
      render: (doc: T) =>
        html`<cca-attachment-count
          .count=${attachmentCount(doc)}
        ></cca-attachment-count>`,
    },
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "cca-attachment-count": CcaAttachmentCount;
  }
}
