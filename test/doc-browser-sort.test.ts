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
 * Index-based sort on `doc-browser`'s column headers (#82).
 *
 * Runs against the real `cca-data-table`, not a stub: the sort button and the `aria-sort`
 * this issue is about are rendered by *its* shadow root, from the column definitions this
 * screen hands it. A stubbed table would let every wiring mistake between the two through.
 *
 * The behaviours asserted here were measured against a live CouchDB 3.5.2, not assumed:
 *
 *   POST /{db}/_find {"selector":{"_id":{"$gt":null}},"sort":[{"age":"asc"}],"limit":5}
 *     → 400 {"error":"no_usable_index", ...}          (before any index on `age` exists)
 *     → 200 {"docs":[5 docs], "bookmark":"g2wAAAAC..."}   (after it does)
 *
 *   ...the same query paged with that bookmark, twice more
 *     → 200 5 docs + bookmark, then 200 2 docs + bookmark, then 200 0 docs + bookmark
 *
 * That last line is the whole reason `_hasMore` cannot be `!!resp.bookmark` in sort mode:
 * `_find` returns a bookmark on EVERY response, including the last page and a page past
 * the end. `_all_docs` is the opposite — its token is minted only when a lookahead row
 * proved another page exists — so the two rules stay separate, as doc-query.ts insists.
 *
 *   ...a sort with two directions
 *     → 400 {"error":"unsupported_mixed_sort", ...}   (no index would fix it — no offer)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Monaco crashes in happy-dom (canvas pixel ratio). This screen renders it for its JSON
// view, and reaches it again through the create-index form the offer hosts. Must precede
// the imports that transitively pull it in.
vi.mock("../src/components/cca-monaco-editor.js", () => ({}));

import { getContext } from "../src/context";
import { ApiError } from "../src/services/api-error";
import "../src/components/cca-header";
import "../src/components/cca-toast";
import "../src/components/cca-data-table";
import "../src/plugins/db-mgmt/doc-browser";

let mounted: HTMLElement[] = [];

async function settle(el: any) {
  for (let i = 0; i < 10; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

/** Three documents carrying two sortable fields beyond the two every document has. */
const DOCS = [
  { _id: "doc1", _rev: "1-a", name: "Zoe", age: 31 },
  { _id: "doc2", _rev: "1-b", name: "Amy", age: 24 },
  { _id: "doc3", _rev: "1-c", name: "Mel", age: 47 },
];

/** `_all_docs` answers this by default; `_find` answers it once a sort is active. */
function stubBothSources(docs: Record<string, unknown>[] = DOCS) {
  vi.spyOn(getContext().dbMgmt, "listDocuments").mockResolvedValue({
    documents: docs,
    bookmark: undefined,
    total_count: docs.length,
  } as any);
  vi.spyOn(getContext().dbMgmt, "queryDocuments").mockResolvedValue({
    documents: docs,
    // `_find` always returns one, which is exactly the trap `_hasMore` must not fall into.
    bookmark: "find-bm-1",
  } as any);
}

async function mountBrowser(): Promise<any> {
  const el = document.createElement("cca-doc-browser") as any;
  el.serverId = "srv1";
  el.dbName = "mydb";
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);
  return el;
}

const listSpy = () => getContext().dbMgmt.listDocuments as any;
const findSpy = () => getContext().dbMgmt.queryDocuments as any;

/** The Mango request body of the most recent `_find`. */
const lastFind = () => findSpy().mock.calls.at(-1)![2];
/** The params of the most recent `_all_docs` read. */
const lastList = () => listSpy().mock.calls.at(-1)![2] ?? {};

const tableOf = (el: any): ShadowRoot =>
  (el.shadowRoot!.querySelector("cca-data-table") as HTMLElement).shadowRoot!;

/** One column's header cell, found by the field it names. */
const headerFor = (el: any, field: string): HTMLElement =>
  tableOf(el)
    .querySelector(`[data-sort-header="${field}"]`)!
    .closest("th") as HTMLElement;

const ariaSortOf = (el: any, field: string): string | null =>
  headerFor(el, field).getAttribute("aria-sort");

/** Every `aria-sort` currently stamped on the table, in column order. */
const allAriaSorts = (el: any): (string | null)[] =>
  Array.from(tableOf(el).querySelectorAll("th")).map((th) =>
    th.getAttribute("aria-sort"),
  );

/** Clicks a column's sort button — the control this issue adds. */
async function clickSort(el: any, field: string) {
  const button = tableOf(el).querySelector(
    `[data-sort-header="${field}"]`,
  ) as HTMLElement;
  if (!button) throw new Error(`no sort header for: ${field}`);
  button.click();
  await settle(el);
}

const controlsOf = (el: any): ShadowRoot =>
  (el.shadowRoot!.querySelector("cca-page-controls") as HTMLElement).shadowRoot!;

async function choosePageSize(el: any, size: number) {
  const select = controlsOf(el).querySelector("[data-page-size]") as any;
  select.value = String(size);
  select.dispatchEvent(new Event("change"));
  await settle(el);
}

async function enterSkip(el: any, raw: string) {
  const input = controlsOf(el).querySelector("[data-skip]") as any;
  input.value = raw;
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new Event("change"));
  await settle(el);
}

const sortBanner = (el: any) => el.shadowRoot!.querySelector("[data-sort-mode]");
const offerDialog = (el: any) =>
  el.shadowRoot!.querySelector("wa-dialog[data-no-index-dialog]") as HTMLElement;
const offerIsOpen = (el: any): boolean => offerDialog(el).hasAttribute("open");
const indexForm = (el: any): any =>
  el.shadowRoot!.querySelector("cca-create-index[data-no-index-form]");

/** CouchDB 3.5.2's verbatim rejection of a sort no index can serve. */
const noUsableIndexError = () =>
  new ApiError(400, "No index exists for this sort, try indexing by the sort fields.", {
    error: "no_usable_index",
    reason: "No index exists for this sort, try indexing by the sort fields.",
  });

/** Its near neighbour, which creating an index would not fix. */
const mixedSortError = () =>
  new ApiError(400, "Sorts currently only support a single direction for all fields.", {
    error: "unsupported_mixed_sort",
    reason: "Sorts currently only support a single direction for all fields.",
  });

beforeEach(() => {
  localStorage.clear();
  if (!document.querySelector("cca-router-provider")) {
    document.body.appendChild(document.createElement("cca-router-provider"));
  }
  const header = document.createElement("cca-header");
  document.body.appendChild(header);
  mounted.push(header);
  stubBothSources();
});

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("doc-browser header sort (#82)", () => {
  describe("which endpoint answers the list", () => {
    it("reads _all_docs, and nothing else, while no sort is active", async () => {
      const el = await mountBrowser();

      expect(listSpy()).toHaveBeenCalled();
      expect(findSpy()).not.toHaveBeenCalled();
      expect(sortBanner(el)).toBeNull();
    });

    it("routes a sorted list through _find, because _all_docs cannot order by a field", async () => {
      const el = await mountBrowser();
      const listCallsBefore = listSpy().mock.calls.length;

      await clickSort(el, "age");

      expect(findSpy()).toHaveBeenCalled();
      expect(lastFind().sort).toEqual([{ age: "asc" }]);
      // The unsorted endpoint is not also consulted — one list, one source.
      expect(listSpy().mock.calls.length).toBe(listCallsBefore);
    });

    it("sends an explicit limit on the sorted request, since _find truncates at 25 without one", async () => {
      const el = await mountBrowser();

      await clickSort(el, "age");

      expect(lastFind().limit).toBe(25);
    });

    it("asks for whole documents, so the derived columns survive the switch", async () => {
      const el = await mountBrowser();

      await clickSort(el, "age");

      expect(lastFind().scope).toBe("full");
      expect(lastFind().selector).toEqual({ _id: { $gt: null } });
    });

    it("goes back to _all_docs when the sort is turned off again", async () => {
      const el = await mountBrowser();
      await clickSort(el, "age");
      await clickSort(el, "age");
      const findCallsBefore = findSpy().mock.calls.length;

      // Third click on the same header: ascending → descending → off.
      await clickSort(el, "age");

      expect(listSpy()).toHaveBeenCalled();
      expect(listSpy().mock.calls.length).toBeGreaterThan(0);
      expect(findSpy().mock.calls.length).toBe(findCallsBefore);
      expect(sortBanner(el)).toBeNull();
    });
  });

  describe("the aria-sort contract", () => {
    it("stamps ascending on the clicked column and reverses it on the next click", async () => {
      const el = await mountBrowser();

      await clickSort(el, "age");
      expect(ariaSortOf(el, "age")).toBe("ascending");
      expect(lastFind().sort).toEqual([{ age: "asc" }]);

      await clickSort(el, "age");
      expect(ariaSortOf(el, "age")).toBe("descending");
      expect(lastFind().sort).toEqual([{ age: "desc" }]);
    });

    it("carries aria-sort on exactly one column, and none at all when unsorted", async () => {
      const el = await mountBrowser();
      expect(allAriaSorts(el).filter(Boolean)).toEqual([]);

      await clickSort(el, "age");

      expect(allAriaSorts(el).filter(Boolean)).toEqual(["ascending"]);
      expect(ariaSortOf(el, "name")).toBeNull();
      expect(ariaSortOf(el, "_id")).toBeNull();
    });

    it("moves aria-sort to another column, restarting that column at ascending", async () => {
      const el = await mountBrowser();
      await clickSort(el, "age");
      await clickSort(el, "age");
      expect(ariaSortOf(el, "age")).toBe("descending");

      await clickSort(el, "name");

      expect(ariaSortOf(el, "name")).toBe("ascending");
      expect(ariaSortOf(el, "age")).toBeNull();
      expect(lastFind().sort).toEqual([{ name: "asc" }]);
    });

    it("drops aria-sort entirely once sorting is turned off", async () => {
      const el = await mountBrowser();
      await clickSort(el, "age");
      await clickSort(el, "age");

      await clickSort(el, "age");

      expect(allAriaSorts(el).filter(Boolean)).toEqual([]);
    });

    it("leaves the non-field columns unsortable — they carry no button and no aria-sort", async () => {
      const el = await mountBrowser();
      const ths = Array.from(tableOf(el).querySelectorAll("th"));

      // The leading selection column is not a document field, so nothing could order by it.
      expect(ths[0].querySelector("[data-sort-header]")).toBeNull();
      expect(ths[0].hasAttribute("aria-sort")).toBe(false);
    });

    it("keeps the field picker working in the same header cell as the sort button", async () => {
      const el = await mountBrowser();
      await clickSort(el, "age");

      const header = headerFor(el, "age");
      expect(header.querySelector("cca-column-picker")).not.toBeNull();
      expect(header.querySelector("[data-sort-header]")).not.toBeNull();
    });
  });

  describe("paging across the two page models", () => {
    it("goes back to page one when a sort is switched on, discarding the _all_docs token", async () => {
      const el = await mountBrowser();
      el._page = 2;
      el._bookmarks = [undefined, "all-docs-token-1", "all-docs-token-2"];

      await clickSort(el, "age");

      expect(el._page).toBe(0);
      expect(lastFind().bookmark).toBeUndefined();
    });

    it("goes back to page one when the sort is switched off, discarding the _find bookmark", async () => {
      const el = await mountBrowser();
      await clickSort(el, "age");
      el._page = 1;
      el._bookmarks = [undefined, "find-bm-1"];

      await clickSort(el, "age");
      await clickSort(el, "age");

      expect(el._page).toBe(0);
      expect(lastList().bookmark).toBeUndefined();
    });

    it("goes back to page one when the sorted column changes", async () => {
      const el = await mountBrowser();
      await clickSort(el, "age");
      el._page = 1;
      el._bookmarks = [undefined, "find-bm-1"];

      await clickSort(el, "name");

      expect(el._page).toBe(0);
      expect(lastFind().bookmark).toBeUndefined();
    });

    it("pages a sorted list with the bookmark _find handed back", async () => {
      const el = await mountBrowser();
      // The bookmark is kept only when a page came back full, because that is the only
      // time `_hasMore` says another page exists — a short page's bookmark leads nowhere.
      findSpy().mockResolvedValue({
        documents: Array.from({ length: 25 }, (_, i) => ({
          _id: `d${i}`,
          _rev: "1-a",
          age: i,
        })),
        bookmark: "find-bm-1",
      } as any);
      await clickSort(el, "age");

      el._nextPage();
      await settle(el);

      expect(el._page).toBe(1);
      expect(lastFind().bookmark).toBe("find-bm-1");
      expect(lastFind().sort).toEqual([{ age: "asc" }]);
    });

    it("decides 'another page exists' by row count in sort mode, never by the bookmark", async () => {
      const el = await mountBrowser();
      // A short page that still carries a bookmark — every _find last page looks like this.
      findSpy().mockResolvedValue({
        documents: DOCS,
        bookmark: "find-bm-1",
      } as any);

      await clickSort(el, "age");

      expect(el._hasMore).toBe(false);
      expect(controlsOf(el).querySelector("[data-next-page]")).toBeNull();
    });

    it("offers Next in sort mode when the page came back exactly full", async () => {
      const el = await mountBrowser();
      findSpy().mockResolvedValue({
        documents: Array.from({ length: 25 }, (_, i) => ({
          _id: `d${i}`,
          _rev: "1-a",
          age: i,
        })),
        bookmark: "find-bm-1",
      } as any);

      await clickSort(el, "age");

      expect(el._hasMore).toBe(true);
      expect(controlsOf(el).querySelector("[data-next-page]")).not.toBeNull();
    });

    it("still decides it from the token, not the row count, with no sort", async () => {
      const el = await mountBrowser();
      // A full page with no token is the true last page of _all_docs.
      listSpy().mockResolvedValue({
        documents: Array.from({ length: 25 }, (_, i) => ({
          _id: `d${i}`,
          _rev: "1-a",
        })),
        bookmark: undefined,
        total_count: 25,
      } as any);
      el._load();
      await settle(el);

      expect(el._hasMore).toBe(false);
    });
  });

  describe("page size and skip work in both modes", () => {
    it("re-requests _all_docs with the chosen page size while unsorted", async () => {
      const el = await mountBrowser();

      await choosePageSize(el, 50);

      expect(lastList().limit).toBe(50);
    });

    it("re-requests _find with the chosen page size while sorted", async () => {
      const el = await mountBrowser();
      await clickSort(el, "age");

      await choosePageSize(el, 50);

      expect(lastFind().limit).toBe(50);
      expect(lastFind().sort).toEqual([{ age: "asc" }]);
    });

    it("sends the skip box's value to _all_docs while unsorted", async () => {
      const el = await mountBrowser();

      await enterSkip(el, "40");

      expect(lastList().skip).toBe(40);
    });

    it("sends the skip box's value to _find while sorted", async () => {
      const el = await mountBrowser();
      await clickSort(el, "age");

      await enterSkip(el, "40");

      expect(lastFind().skip).toBe(40);
      expect(lastFind().sort).toEqual([{ age: "asc" }]);
    });

    it("keeps the skip offset across a switch into sort mode", async () => {
      const el = await mountBrowser();
      await enterSkip(el, "10");

      await clickSort(el, "age");

      expect(lastFind().skip).toBe(10);
    });
  });

  describe("the mode is visible, not silent", () => {
    it("says which field orders the list and that _find, not _all_docs, is answering", async () => {
      const el = await mountBrowser();

      await clickSort(el, "age");

      const text = sortBanner(el)!.textContent!.replace(/\s+/g, " ");
      expect(text).toContain("age");
      expect(text).toContain("ascending");
      expect(text).toContain("_find");
      expect(text).toContain("_all_docs");
    });

    it("warns that documents without the field drop out of the list", async () => {
      // Measured: a sort by `age` over 13 documents returns 12 — the one with no `age`
      // at all is absent (one with `age: null` is present). Silently losing a row is
      // exactly what this banner exists to stop.
      const el = await mountBrowser();

      await clickSort(el, "age");

      expect(sortBanner(el)!.textContent).toMatch(/not listed/i);
    });

    it("names the descending order once the direction reverses", async () => {
      const el = await mountBrowser();
      await clickSort(el, "age");

      await clickSort(el, "age");

      expect(sortBanner(el)!.textContent).toContain("descending");
    });

    it("offers a way straight back to _all_docs", async () => {
      const el = await mountBrowser();
      await clickSort(el, "age");
      const findCallsBefore = findSpy().mock.calls.length;

      (
        el.shadowRoot!.querySelector("[data-clear-sort]") as HTMLElement
      ).click();
      await settle(el);

      expect(sortBanner(el)).toBeNull();
      expect(el._page).toBe(0);
      expect(findSpy().mock.calls.length).toBe(findCallsBefore);
      expect(listSpy()).toHaveBeenCalled();
    });

    it("shows no banner at all while the list is unsorted", async () => {
      const el = await mountBrowser();
      expect(sortBanner(el)).toBeNull();
    });
  });

  describe("a sort no index can serve", () => {
    it("opens the shared create-index offer instead of a dead end", async () => {
      const el = await mountBrowser();
      findSpy().mockRejectedValue(noUsableIndexError());

      await clickSort(el, "age");

      expect(offerIsOpen(el)).toBe(true);
      expect(indexForm(el)).not.toBeNull();
    });

    it("pre-populates the form with the clicked field", async () => {
      const el = await mountBrowser();
      findSpy().mockRejectedValue(noUsableIndexError());

      await clickSort(el, "age");

      const names = Array.from(
        indexForm(el).shadowRoot!.querySelectorAll(".field-name"),
      ).map((n) => (n as HTMLElement).textContent!.trim());

      expect(names).toEqual(["1. age"]);
    });

    it("carries the clicked direction into the form, so a descending sort indexes descending", async () => {
      // The first click is served (an index covers ascending); the second is refused. The
      // sorted list is empty behind the modal offer either way, which is why this drives
      // the second click from a *successful* first one rather than a failed one — after a
      // failure the table has no headers left to click.
      const el = await mountBrowser();
      await clickSort(el, "age");
      findSpy().mockRejectedValue(noUsableIndexError());

      await clickSort(el, "age");

      const names = Array.from(
        indexForm(el).shadowRoot!.querySelectorAll(".field-name"),
      ).map((n) => (n as HTMLElement).textContent!.trim());
      const directions = Array.from(
        indexForm(el).shadowRoot!.querySelectorAll(".field-direction"),
      ).map((s) => (s as any).value);

      expect(names).toEqual(["1. age"]);
      expect(directions).toEqual(["desc"]);
    });

    it("writes nothing merely by offering", async () => {
      const create = vi.spyOn(getContext().dbMgmt, "createIndex");
      const el = await mountBrowser();
      findSpy().mockRejectedValue(noUsableIndexError());

      await clickSort(el, "age");

      expect(create).not.toHaveBeenCalled();
    });

    it("does NOT offer for unsupported_mixed_sort — no index of any shape would fix it", async () => {
      const el = await mountBrowser();
      findSpy().mockRejectedValue(mixedSortError());

      await clickSort(el, "age");

      expect(offerIsOpen(el)).toBe(false);
      expect(indexForm(el)).toBeNull();
      // It still has to say something: the inline callout every other refusal gets.
      expect(el.shadowRoot!.querySelector("[data-load-error]")).not.toBeNull();
    });

    it("does NOT offer for a refusal about the database itself", async () => {
      const el = await mountBrowser();
      findSpy().mockRejectedValue(
        new ApiError(403, "You are not allowed to access this db."),
      );

      await clickSort(el, "age");

      expect(offerIsOpen(el)).toBe(false);
      const text = el.shadowRoot!.querySelector("[data-load-error]")!.textContent;
      expect(text).toMatch(/not a member/i);
    });

    it("declining puts the list back to the order that worked", async () => {
      const el = await mountBrowser();
      findSpy().mockRejectedValue(noUsableIndexError());
      await clickSort(el, "age");
      expect(offerIsOpen(el)).toBe(true);

      (
        el.shadowRoot!.querySelector("[data-no-index-dismiss]") as HTMLElement
      ).click();
      await settle(el);

      expect(offerIsOpen(el)).toBe(false);
      expect(el._sort).toBeNull();
      expect(sortBanner(el)).toBeNull();
      expect(listSpy()).toHaveBeenCalled();
    });

    it("re-runs the sorted list once the index exists", async () => {
      vi.spyOn(getContext().dbMgmt, "createIndex").mockResolvedValue({
        id: "_design/abc",
        name: "age-index",
        type: "json",
        fields: ["age"],
      } as any);
      const el = await mountBrowser();
      findSpy().mockRejectedValue(noUsableIndexError());
      await clickSort(el, "age");

      // The index now exists, so the replay succeeds.
      findSpy().mockResolvedValue({
        documents: DOCS,
        bookmark: "find-bm-1",
      } as any);
      const form = indexForm(el);
      (
        form.shadowRoot.querySelector("wa-button[data-create]") as HTMLElement
      ).click();
      await settle(form);
      await settle(el);
      (
        form.shadowRoot.querySelector(
          "wa-button[data-preview-confirm]",
        ) as HTMLElement
      ).click();
      await settle(form);
      await settle(el);

      expect(offerIsOpen(el)).toBe(false);
      expect(lastFind().sort).toEqual([{ age: "asc" }]);
      expect(el._sort).toEqual({ field: "age", direction: "asc" });
      expect(ariaSortOf(el, "age")).toBe("ascending");
    });
  });
});
