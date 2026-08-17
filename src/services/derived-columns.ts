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
 * Turning a page of documents into table columns.
 *
 * Both document lists — `doc-browser`'s `_all_docs` table and `doc-query`'s `_find`
 * results — show one column per field the returned documents actually carry, rather
 * than a fixed set the screen decided in advance (#79). `doc-query` already worked
 * this way from its first result row; `doc-browser` showed two hardcoded columns,
 * `_id` and `_rev`. Deriving is what makes a header worth clicking, which is what
 * #82's header-click sort will attach to.
 *
 * Fauxton ranks candidate fields by how often they occur and offers a "show all"
 * escape hatch (`table-view.js:23-69`). This deliberately does not: PR #76's gap
 * analysis (§4.3) recommends the simpler pattern already in this repo, and a
 * per-column picker — the thing frequency ranking exists to compensate for — is part
 * of the same issue.
 */

import { ATTACHMENTS_FIELD } from "./attachments.js";

/** Longest cell text rendered before it is cut. Keeps one fat field from owning the row. */
const MAX_CELL_CHARS = 80;

/**
 * Fields that never become a column, however many documents carry them.
 *
 * `_attachments` is the whole list. Since #79 switched both lists to whole documents, every
 * document that has attachments arrives carrying its stubs — so left in the union it becomes
 * an ordinary column rendering `{"a.png":{"content_type":"image/png","length":9,"stub":…` as
 * cell text, one wide unreadable blob per row. The paperclip indicator says the same thing
 * in one glyph and a number (#84), so the raw field is kept out of the derived set, and
 * therefore out of `available` and every picker offering from it. `view-editor` keeps
 * `_attachments` out of its own field suggestions for the same reason.
 */
const EXCLUDED_FIELDS = new Set<string>([ATTACHMENTS_FIELD]);

/**
 * A document's identity, and the only two fields every CouchDB document has. They lead
 * the column order no matter where they appear in the JSON, so the leftmost columns of
 * a heterogeneous page do not shuffle from one page to the next — and so `doc-browser`
 * still opens on `Document ID`, `Revision`, the two columns it used to hardcode.
 */
const LEADING_FIELDS = ["_id", "_rev"];

/** What each column shows, and everything a column may be switched to. */
export interface DerivedColumns {
  /** The field each column renders, left to right. */
  fields: string[];
  /** Every field a per-column picker may offer. A superset of {@link fields}. */
  available: string[];
}

/** De-duplicates while keeping first-appearance order. */
function unique(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * The fields a page of documents carries, in the order a reader meets them: `_id` and
 * `_rev` first, then every other key by where it first appeared.
 *
 * The union across the whole page, not just the first document, is the point — CouchDB
 * databases are heterogeneous by design, so keying the columns off `documents[0]` alone
 * would hide every field the first document happens not to have.
 *
 * {@link EXCLUDED_FIELDS} is subtracted from that union: a field can be in the documents
 * and still not be a column.
 */
export function deriveFieldNames(docs: readonly Record<string, unknown>[]): string[] {
  const keys = docs
    .flatMap((doc) => Object.keys(doc))
    .filter((key) => !EXCLUDED_FIELDS.has(key));
  const leading = LEADING_FIELDS.filter((f) => keys.includes(f));
  return unique([...leading, ...keys]);
}

/**
 * Reconciles what the documents offer with what the user picked.
 *
 * `chosen` is `null` until a picker is used; from then on it is the whole truth about
 * which field each column shows, and fields appearing on later pages are *not* appended
 * — a swap means "show me this instead", and re-adding the field it replaced would undo
 * it on the next page. A chosen field that this page's documents lack still gets its
 * column (rendering the missing-value dash) and still appears in `available`, so the
 * picker can show which field the column is set to even while nothing here has it.
 */
export function resolveColumns(
  docs: readonly Record<string, unknown>[],
  chosen: readonly string[] | null,
): DerivedColumns {
  const derived = deriveFieldNames(docs);
  const fields = chosen && chosen.length > 0 ? [...chosen] : derived;
  return { fields, available: unique([...derived, ...fields]) };
}

/**
 * One field's value as a single line of cell text.
 *
 * A document field holds anything JSON does, and `${value}` on an object renders the
 * literal `[object Object]` — the same nothing for every object. Objects and arrays are
 * shown as compact JSON instead, so a cell says what is in there, and everything is cut
 * at {@link MAX_CELL_CHARS} so one long field cannot push the rest of the row off screen.
 * A missing field gets the same em dash `cca-data-table` renders for one.
 */
export function formatCellValue(value: unknown): string {
  if (value === undefined) return "—";
  // `String({})` is `[object Object]` — the same nothing for every object — so only
  // primitives go through String(); null included, which reads as `null` rather than
  // as the dash a *missing* field gets.
  const text =
    value !== null && typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return text.length > MAX_CELL_CHARS
    ? `${text.slice(0, MAX_CELL_CHARS)}…`
    : text;
}
