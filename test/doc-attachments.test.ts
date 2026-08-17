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
 * The attachment indicator, on the three screens that show it (#84).
 *
 * It answers one question — does this document have attachments, and how many — and
 * answers it with silence when the answer is none. Managing them is #120, so nothing here
 * is clickable and nothing links anywhere.
 *
 * Runs against the real `cca-data-table` and the real indicator, for the reason
 * `doc-derived-columns.test.ts` gives: both the column and its cells are composed into the
 * table's shadow root, and a stubbed table would assert column definitions instead of the
 * DOM they are supposed to produce.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Monaco crashes in happy-dom (canvas pixel ratio). All three screens render it.
// Must precede the imports that transitively pull it in.
vi.mock("../src/components/cca-monaco-editor.js", () => ({}));

import { getContext } from "../src/context";
import {
  anyHaveAttachments,
  attachmentCount,
} from "../src/services/attachments";
import "../src/components/cca-header";
import "../src/components/cca-data-table";
import "../src/plugins/db-mgmt/doc-browser";
import "../src/plugins/db-mgmt/doc-query";
import "../src/plugins/db-mgmt/doc-editor";
import type { CcaColumnPicker } from "../src/components/cca-column-picker";

// doc-query persists every run to its history element; without a stand-in each run rejects
// with "saveHistory is not a function" — an unhandled rejection that fails the suite while
// every test still reads green.
class CcaQueryHistoryStub extends HTMLElement {
  saveHistory() {
    return Promise.resolve();
  }
}
if (!customElements.get("cca-query-history")) {
  customElements.define("cca-query-history", CcaQueryHistoryStub);
}

/** Two attachment stubs, exactly as `_all_docs?include_docs=true` returns them. */
const TWO_STUBS = {
  "notes.txt": { content_type: "text/plain", length: 12, stub: true },
  "logo.png": { content_type: "image/png", length: 903, stub: true },
};

let mounted: HTMLElement[] = [];

async function settle(el: any) {
  for (let i = 0; i < 10; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

async function mountBrowser(docs: Record<string, unknown>[]): Promise<any> {
  vi.spyOn(getContext().dbMgmt, "listDocuments").mockResolvedValue({
    documents: docs,
    bookmark: undefined,
    total_count: docs.length,
  } as any);
  const el = document.createElement("cca-doc-browser") as any;
  el.serverId = "srv1";
  el.dbName = "mydb";
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);
  return el;
}

/** `cca-doc-query` showing `docs`, optionally as the results of a projecting query. */
async function mountQuery(
  docs: Record<string, unknown>[],
  projectedFields: string[] = [],
): Promise<any> {
  vi.spyOn(getContext().dbMgmt, "queryDocuments").mockResolvedValue({
    documents: docs,
    bookmark: "",
    total_count: docs.length,
  } as any);
  const el = document.createElement("cca-doc-query") as any;
  el.dbName = "mydb";
  el.serverId = "srv1";
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);
  if (projectedFields.length > 0) {
    el._fields = projectedFields;
    await settle(el);
  }
  el._runQuery();
  await settle(el);
  return el;
}

async function mountEditor(doc: Record<string, unknown> | null): Promise<any> {
  if (doc) {
    vi.spyOn(getContext().dbMgmt, "getDoc").mockResolvedValue(doc as any);
  }
  const el = document.createElement("cca-doc-editor") as any;
  el.serverId = "srv1";
  el.dbName = "mydb";
  el.docId = doc ? String(doc._id) : "new";
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);
  return el;
}

const tableOf = (el: any): ShadowRoot =>
  (el.shadowRoot!.querySelector("cca-data-table") as HTMLElement).shadowRoot!;

/** The header cells that name a document field — i.e. neither selection nor attachments. */
const fieldHeaders = (el: any): HTMLElement[] =>
  Array.from(tableOf(el).querySelectorAll("th")).filter((th) =>
    th.querySelector("cca-column-picker"),
  );

const columnFields = (el: any): string[] =>
  fieldHeaders(el).map((th) => th.textContent!.trim());

/** Every field any picker on the screen offers. */
const offeredFields = (el: any): string[] =>
  fieldHeaders(el).flatMap(
    (th) =>
      (th.querySelector("cca-column-picker") as CcaColumnPicker | null)
        ?.fields ?? [],
  );

/** The attachment column's header cell, or `null` when the column is not there at all. */
const attachmentHeader = (el: any): HTMLElement | null =>
  Array.from(tableOf(el).querySelectorAll("th")).find(
    (th) => !!th.querySelector("wa-icon") && !th.querySelector("cca-column-picker"),
  ) ?? null;

/** The indicator element in one row, whether or not it has anything to show. */
const indicatorIn = (el: any, row = 0): HTMLElement | null => {
  const tr = tableOf(el).querySelectorAll("tbody tr")[row];
  return tr?.querySelector("cca-attachment-count") ?? null;
};

/** What one indicator actually renders: its count, or `null` when it renders nothing. */
const shownCount = (indicator: Element | null): string | null => {
  const rendered = indicator?.shadowRoot?.querySelector(
    "[data-attachment-count]",
  );
  return rendered ? rendered.textContent!.trim() : null;
};

const rowText = (el: any, row = 0): string =>
  tableOf(el).querySelectorAll("tbody tr")[row].textContent!;

beforeEach(() => {
  localStorage.clear();
  if (!document.querySelector("cca-router-provider")) {
    document.body.appendChild(document.createElement("cca-router-provider"));
  }
  const header = document.createElement("cca-header");
  document.body.appendChild(header);
  mounted.push(header);
  vi.spyOn(getContext().dbMgmt, "listDatabases").mockResolvedValue([] as any);
});

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
  vi.restoreAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
describe("attachmentCount", () => {
  it("counts the stubs CouchDB returns", () => {
    expect(attachmentCount({ _id: "a", _attachments: TWO_STUBS })).toBe(2);
  });

  // The two cases that must look alike to every caller: no attachments, and no answer.
  it("reports none for a document that carries no _attachments", () => {
    expect(attachmentCount({ _id: "a", _rev: "1-a" })).toBe(0);
  });

  it("reports none for an empty _attachments object", () => {
    expect(attachmentCount({ _id: "a", _attachments: {} })).toBe(0);
  });

  // `Object.keys([])` counts indices, so an array would otherwise report its length.
  it("reports none for a malformed _attachments", () => {
    expect(attachmentCount({ _id: "a", _attachments: [] })).toBe(0);
    expect(attachmentCount({ _id: "a", _attachments: "two" })).toBe(0);
    expect(attachmentCount(null)).toBe(0);
  });

  it("sees whether a page has anything to indicate at all", () => {
    expect(anyHaveAttachments([{ _id: "a" }, { _id: "b" }])).toBe(false);
    expect(
      anyHaveAttachments([{ _id: "a" }, { _id: "b", _attachments: TWO_STUBS }]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("doc-browser's attachment indicator (#84)", () => {
  it("shows the count for a document with two attachments", async () => {
    const el = await mountBrowser([
      { _id: "a", _rev: "1-a", _attachments: TWO_STUBS },
    ]);
    expect(shownCount(indicatorIn(el))).toBe("2");
  });

  // An empty column of zeroes is the noise this issue set out not to add.
  it("shows nothing at all for a document without attachments", async () => {
    const el = await mountBrowser([
      { _id: "a", _rev: "1-a", _attachments: TWO_STUBS },
      { _id: "b", _rev: "1-b" },
    ]);
    expect(shownCount(indicatorIn(el, 1))).toBeNull();
    expect(rowText(el, 1)).not.toContain("0");
  });

  it("leaves out the whole column when no document on the page has one", async () => {
    const el = await mountBrowser([{ _id: "a", _rev: "1-a", name: "Ada" }]);
    expect(attachmentHeader(el)).toBeNull();
    expect(indicatorIn(el)).toBeNull();
  });

  it("gives the column a header once a document does", async () => {
    const el = await mountBrowser([
      { _id: "a", _rev: "1-a", _attachments: TWO_STUBS },
    ]);
    expect(attachmentHeader(el)).not.toBeNull();
  });

  // Indicator only — upload/download/delete is #120.
  it("does not link anywhere", async () => {
    const el = await mountBrowser([
      { _id: "a", _rev: "1-a", _attachments: TWO_STUBS },
    ]);
    const root = indicatorIn(el)!.shadowRoot!;
    expect(root.querySelector("a")).toBeNull();
    expect(root.querySelector("wa-button")).toBeNull();
    expect(root.querySelector("button")).toBeNull();
  });
});

describe("_attachments is not an ordinary column (#84)", () => {
  const doc = { _id: "a", _rev: "1-a", name: "Ada", _attachments: TWO_STUBS };

  // Left in the derived union it renders a blob of stub JSON in every row — the thing the
  // paperclip exists to replace. `view-editor` excludes it from its suggestions likewise.
  it("is not one of doc-browser's derived columns", async () => {
    const el = await mountBrowser([doc]);
    expect(columnFields(el)).toEqual(["_id", "_rev", "name"]);
  });

  it("is not offered by doc-browser's column picker", async () => {
    const el = await mountBrowser([doc]);
    expect(offeredFields(el)).not.toContain("_attachments");
  });

  it("is not one of doc-query's derived columns", async () => {
    const el = await mountQuery([doc]);
    expect(columnFields(el)).toEqual(["_id", "_rev", "name"]);
  });

  it("is not offered by doc-query's column picker", async () => {
    const el = await mountQuery([doc]);
    expect(offeredFields(el)).not.toContain("_attachments");
  });

  // The stubs still belong in the raw JSON — that view shows the document as stored.
  it("is still in the document the JSON view renders", async () => {
    const el = await mountBrowser([doc]);
    expect(el._docsValues[0]).toContain("_attachments");
  });
});

// ---------------------------------------------------------------------------
describe("doc-query's attachment indicator (#84)", () => {
  it("shows the count for a result with two attachments", async () => {
    const el = await mountQuery([{ _id: "a", _attachments: TWO_STUBS }]);
    expect(shownCount(indicatorIn(el))).toBe("2");
  });

  /**
   * `_find` returns exactly the fields a `fields` projection asks for, so no row carries
   * `_attachments` however many attachments those documents really have. "0 attachments"
   * would then be a confident lie about a document that has three; silence is the only
   * honest answer, and this is the case that makes it a requirement rather than taste.
   */
  it("shows nothing rather than a zero when the query projects fields", async () => {
    const el = await mountQuery([{ _id: "a", name: "Ada" }], ["_id", "name"]);
    expect(attachmentHeader(el)).toBeNull();
    expect(indicatorIn(el)).toBeNull();
    expect(rowText(el)).not.toContain("0");
  });
});

// ---------------------------------------------------------------------------
describe("doc-editor's attachment badge (#84)", () => {
  const indicatorOf = (el: any) =>
    el.shadowRoot!.querySelector("cca-attachment-count");

  it("says how many the loaded document has", async () => {
    const el = await mountEditor({
      _id: "a",
      _rev: "1-a",
      _attachments: TWO_STUBS,
    });
    expect(shownCount(indicatorOf(el))).toBe("2");
  });

  it("says nothing for a document without attachments", async () => {
    const el = await mountEditor({ _id: "a", _rev: "1-a" });
    expect(shownCount(indicatorOf(el))).toBeNull();
  });

  it("says nothing in create mode, where there is no document yet", async () => {
    const el = await mountEditor(null);
    expect(shownCount(indicatorOf(el))).toBeNull();
  });
});
