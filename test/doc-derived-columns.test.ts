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
 * Document-derived columns and the per-column field picker, on both document lists (#79).
 *
 * Deliberately runs against the real `cca-data-table` rather than a stub: the headers
 * these screens build render inside *its* shadow root, and the picker they hang there is
 * a real `wa-dropdown`. A stubbed table would assert the column definitions this file
 * never has to name — and would have kept passing through every wiring mistake between
 * a column and the header cell it is supposed to produce.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Monaco crashes in happy-dom (canvas pixel ratio). Both screens render it for their
// JSON view. Must precede the imports that transitively pull it in.
vi.mock("../src/components/cca-monaco-editor.js", () => ({}));

import { getContext } from "../src/context";
import "../src/components/cca-header";
import "../src/components/cca-data-table";
import "../src/plugins/db-mgmt/doc-browser";
import "../src/plugins/db-mgmt/doc-query";
import type { CcaColumnPicker } from "../src/components/cca-column-picker";

// doc-query persists every run to its history element. Without a stand-in, each run
// rejects with "saveHistory is not a function" — an unhandled rejection that fails the
// suite while every test still reads green.
class CcaQueryHistoryStub extends HTMLElement {
  saveHistory() {
    return Promise.resolve();
  }
}
if (!customElements.get("cca-query-history")) {
  customElements.define("cca-query-history", CcaQueryHistoryStub);
}

let mounted: HTMLElement[] = [];

async function settle(el: any) {
  for (let i = 0; i < 10; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

/** `cca-doc-browser` showing `docs`, with the real table rendered. */
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

/** `cca-doc-query` showing `docs` as the results of one run query. */
async function mountQuery(docs: Record<string, unknown>[]): Promise<any> {
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
  el._runQuery();
  await settle(el);
  return el;
}

const tableOf = (el: any): ShadowRoot =>
  (el.shadowRoot!.querySelector("cca-data-table") as HTMLElement).shadowRoot!;

/** The header cells that name a document field — i.e. every one but the selection column. */
const fieldHeaders = (el: any): HTMLElement[] =>
  Array.from(tableOf(el).querySelectorAll("th")).filter((th) =>
    th.querySelector("cca-column-picker"),
  );

/** Which field each column shows, left to right. */
const columnFields = (el: any): string[] =>
  fieldHeaders(el).map((th) => th.textContent!.trim());

/** One row's cells, as rendered, skipping any leading selection cell. */
const rowCells = (el: any, row = 0): string[] => {
  const tr = tableOf(el).querySelectorAll("tbody tr")[row];
  const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
    td.textContent!.trim(),
  );
  return cells.slice(cells.length - fieldHeaders(el).length);
};

/**
 * Points the column currently showing `from` at `to`, the way `wa-dropdown` does.
 *
 * `makeSelection()` is the single funnel both of the dropdown's input paths reach —
 * and the one that flips `checked` before emitting `wa-select`. A bare `.click()` on the
 * item reaches neither under happy-dom; see `cca-theme-picker.test.ts` and #50.
 */
async function pickField(el: any, from: string, to: string) {
  const header = fieldHeaders(el).find((th) => th.textContent!.trim() === from);
  if (!header) throw new Error(`no column showing: ${from}`);
  const picker = header.querySelector("cca-column-picker") as CcaColumnPicker;
  const root = picker.shadowRoot!;
  const item = root.querySelector(`[data-field="${to}"]`);
  if (!item) throw new Error(`picker does not offer: ${to}`);
  (
    root.querySelector("wa-dropdown") as HTMLElement & {
      makeSelection(item: Element): void;
    }
  ).makeSelection(item);
  await settle(el);
}

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
// doc-browser: the table used to be two hardcoded columns, `Document ID` and
// `Revision`, because `scope: "raw"` fetched nothing else to show.
// ---------------------------------------------------------------------------
describe("doc-browser columns come from the documents (#79)", () => {
  it("fetches whole documents, since the columns are derived from them", async () => {
    await mountBrowser([{ _id: "a", _rev: "1-a" }]);
    const params = (getContext().dbMgmt.listDocuments as any).mock.calls.at(
      -1,
    )![2];
    expect(params.scope).toBe("full");
  });

  it("shows the two identity fields for documents that carry only those", async () => {
    const el = await mountBrowser([{ _id: "a", _rev: "1-a" }]);
    expect(columnFields(el)).toEqual(["_id", "_rev"]);
  });

  it("gives a document with extra fields extra columns", async () => {
    const el = await mountBrowser([
      { _id: "a", _rev: "1-a", name: "Ada", age: 36 },
    ]);
    expect(columnFields(el)).toEqual(["_id", "_rev", "name", "age"]);
  });

  it("covers fields the first document happens not to have", async () => {
    const el = await mountBrowser([
      { _id: "a", _rev: "1-a", name: "Ada" },
      { _id: "b", _rev: "1-b", email: "b@example.test" },
    ]);
    expect(columnFields(el)).toContain("email");
  });

  it("renders each document's own values under those columns", async () => {
    const el = await mountBrowser([{ _id: "a", _rev: "1-a", name: "Ada" }]);
    expect(rowCells(el)).toEqual(["a", "1-a", "Ada"]);
  });

  it("shows the dash for a document missing a column's field", async () => {
    const el = await mountBrowser([
      { _id: "a", _rev: "1-a", name: "Ada" },
      { _id: "b", _rev: "1-b" },
    ]);
    expect(rowCells(el, 1)).toEqual(["b", "1-b", "—"]);
  });

  it("shows what is inside an object field rather than [object Object]", async () => {
    const el = await mountBrowser([
      { _id: "a", _rev: "1-a", address: { city: "Oslo" } },
    ]);
    expect(rowCells(el)).toEqual(["a", "1-a", '{"city":"Oslo"}']);
  });

  it("still opens the document a row click addresses", async () => {
    const el = await mountBrowser([{ _id: "a", _rev: "1-a", name: "Ada" }]);
    const navigate = vi.spyOn(getContext().router, "navigate");
    (tableOf(el).querySelector("tbody tr") as HTMLElement).click();
    expect(navigate).toHaveBeenCalledWith("/databases/srv1/mydb/documents/a");
  });
});

describe("doc-browser's per-column field picker (#79)", () => {
  const docs = [{ _id: "a", _rev: "1-a", name: "Ada", email: "a@example.test" }];

  it("puts a picker on every field column and none on the selection column", async () => {
    const el = await mountBrowser(docs);
    const headers = Array.from(tableOf(el).querySelectorAll("th"));
    expect(headers).toHaveLength(5);
    expect(fieldHeaders(el)).toHaveLength(4);
  });

  it("offers every field the page carries, not just this column's", async () => {
    const el = await mountBrowser(docs);
    const picker = fieldHeaders(el)[0].querySelector(
      "cca-column-picker",
    ) as CcaColumnPicker;
    expect(picker.fields).toEqual(["_id", "_rev", "name", "email"]);
  });

  it("changes which field the column renders", async () => {
    const el = await mountBrowser(docs);
    await pickField(el, "name", "email");
    expect(columnFields(el)).toEqual(["_id", "_rev", "email", "email"]);
    expect(rowCells(el)).toEqual([
      "a",
      "1-a",
      "a@example.test",
      "a@example.test",
    ]);
  });

  it("leaves the other columns where they were", async () => {
    const el = await mountBrowser(docs);
    await pickField(el, "_rev", "name");
    expect(columnFields(el)).toEqual(["_id", "name", "name", "email"]);
  });

  // A chosen column must not be re-derived away by the next page's own fields —
  // that would undo the swap once per page and read as the picker forgetting.
  it("keeps the choice across a page of different documents", async () => {
    const el = await mountBrowser(docs);
    await pickField(el, "name", "email");

    vi.spyOn(getContext().dbMgmt, "listDocuments").mockResolvedValue({
      documents: [{ _id: "b", _rev: "1-b", nickname: "Bea" }],
      bookmark: undefined,
      total_count: 1,
    } as any);
    el._load();
    await settle(el);

    expect(columnFields(el)).toEqual(["_id", "_rev", "email", "email"]);
    expect(rowCells(el)).toEqual(["b", "1-b", "—", "—"]);
  });
});

// ---------------------------------------------------------------------------
// doc-query already derived its columns — from the first result row only — and
// had no picker either.
// ---------------------------------------------------------------------------
describe("doc-query columns come from the results (#79)", () => {
  it("shows one column per field the results carry", async () => {
    const el = await mountQuery([{ _id: "a", _rev: "1-a", name: "Ada" }]);
    expect(columnFields(el)).toEqual(["_id", "_rev", "name"]);
  });

  it("covers fields the first result happens not to have", async () => {
    const el = await mountQuery([
      { _id: "a", name: "Ada" },
      { _id: "b", email: "b@example.test" },
    ]);
    expect(columnFields(el)).toEqual(["_id", "name", "email"]);
  });

  it("renders each result's own values under those columns", async () => {
    const el = await mountQuery([{ _id: "a", name: "Ada" }]);
    expect(rowCells(el)).toEqual(["a", "Ada"]);
  });

  // The header label has added its field to the query's projection since long before
  // #79; the picker sits beside it rather than replacing it.
  it("still adds a field to the projection when its header label is clicked", async () => {
    const el = await mountQuery([{ _id: "a", name: "Ada" }]);
    const label = fieldHeaders(el)[1].querySelector(
      "[data-add-field]",
    ) as HTMLElement;
    label.click();
    await settle(el);
    expect(el._fields).toEqual(["name"]);
  });
});

describe("doc-query's per-column field picker (#79)", () => {
  const docs = [{ _id: "a", name: "Ada", email: "a@example.test" }];

  it("puts a picker on every column", async () => {
    const el = await mountQuery(docs);
    expect(fieldHeaders(el)).toHaveLength(3);
  });

  it("changes which field the column renders", async () => {
    const el = await mountQuery(docs);
    await pickField(el, "name", "email");
    expect(columnFields(el)).toEqual(["_id", "email", "email"]);
    expect(rowCells(el)).toEqual(["a", "a@example.test", "a@example.test"]);
  });

  // A new query may project an entirely different set of fields, so the columns go
  // back to being whatever the results carry.
  it("goes back to the derived columns when a new query is run", async () => {
    const el = await mountQuery(docs);
    await pickField(el, "name", "email");
    expect(columnFields(el)).toEqual(["_id", "email", "email"]);

    el._runQuery();
    await settle(el);
    expect(columnFields(el)).toEqual(["_id", "name", "email"]);
  });
});
