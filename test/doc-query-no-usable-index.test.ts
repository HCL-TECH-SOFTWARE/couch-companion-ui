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
 * Unit tests for doc-query's no-usable-index offer (#78).
 *
 * The error shapes asserted here were taken from a live CouchDB 3.5.2, not from the docs:
 *
 *   POST /{db}/_find  {"selector":{"name":{"$gt":null}},"sort":[{"age":"asc"}],"limit":25}
 *     → 400 {"error":"no_usable_index",
 *            "reason":"No index exists for this sort, try indexing by the sort fields."}
 *
 *   ...the same query with no `sort` at all
 *     → 200 {"docs":[...], "warning":"No matching index found, create an index to optimize
 *            query time."}                        (not an error — nothing to react to)
 *
 *   ...a sort whose fields disagree on direction
 *     → 400 {"error":"unsupported_mixed_sort",
 *            "reason":"Sorts currently only support a single direction for all fields."}
 *
 *   ...a malformed selector / operator / limit
 *     → 400 invalid_selector_json / invalid_operator / invalid_non_neg_integer
 *
 *   POST /{db}/_index as a database member who is not an admin
 *     → 500 {"error":"error_saving_ddoc",
 *            "reason":"Unknown error while saving the design document: forbidden"}
 *
 * So the offer keys off the `no_usable_index` CODE. The negative cases below are the reason:
 * every one of them is also a 4xx/5xx from the same endpoint, and creating an index fixes
 * none of them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Prevent monaco-editor from initialising in happy-dom (canvas pixel-ratio crash).
// Must be called before importing the component that transitively pulls in Monaco —
// doc-query now reaches it through create-index.js as well as directly.
vi.mock("../src/components/cca-monaco-editor.js", () => ({}));

import { getContext } from "../src/context";
import { ApiError } from "../src/services/api-error";
import "../src/components/cca-header";
import "../src/components/cca-toast";
import "../src/plugins/db-mgmt/doc-query";

class CcaMonacoEditorMinStub extends HTMLElement {
  value = "";
}
if (!customElements.get("cca-monaco-editor")) {
  customElements.define("cca-monaco-editor", CcaMonacoEditorMinStub);
}

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

async function mount(): Promise<any> {
  const header = document.createElement("cca-header");
  document.body.appendChild(header);
  mounted.push(header);

  const el = document.createElement("cca-doc-query") as any;
  el.dbName = "testdb";
  el.serverId = "srv-1";
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);
  return el;
}

/** Matches the shape cca-mango's own `_updateQuery()` emits. */
function fireMangoChange(
  el: any,
  detail: { selector?: Record<string, unknown>; sort?: unknown[] },
) {
  const mangoEl = el.shadowRoot!.querySelector("cca-mango")!;
  mangoEl.dispatchEvent(
    new CustomEvent("cca-mango-change", {
      detail: {
        query: {
          selector: detail.selector ?? { _id: { $gt: null } },
          sort: detail.sort,
        },
      },
      bubbles: true,
      composed: true,
    }),
  );
}

/** CouchDB 3.5.2's verbatim rejection for a sort no index can serve. */
function noUsableIndexError(): ApiError {
  const body = {
    error: "no_usable_index",
    reason: "No index exists for this sort, try indexing by the sort fields.",
  };
  return new ApiError(400, body.reason, body);
}

function offerDialog(el: any): HTMLElement {
  return el.shadowRoot!.querySelector(
    "wa-dialog[data-no-index-dialog]",
  ) as HTMLElement;
}

function offerIsOpen(el: any): boolean {
  return offerDialog(el).hasAttribute("open");
}

function indexForm(el: any): any {
  return el.shadowRoot!.querySelector("cca-create-index[data-no-index-form]");
}

/** The `1. age` / `2. name` labels the create-index form lists its fields under. */
function formFieldNames(el: any): string[] {
  return Array.from(
    indexForm(el).shadowRoot!.querySelectorAll(".field-name"),
  ).map((n) => (n as HTMLElement).textContent!.trim());
}

function formFieldDirections(el: any): string[] {
  return Array.from(
    indexForm(el).shadowRoot!.querySelectorAll(".field-direction"),
  ).map((s) => (s as any).value);
}

/** Drives the create-index component's own Create → preview → Confirm path (#57). */
async function confirmIndexCreation(el: any) {
  const form = indexForm(el);
  (form.shadowRoot.querySelector("wa-button[data-create]") as HTMLElement).click();
  await settle(form);
  await settle(el);
  (
    form.shadowRoot.querySelector("wa-button[data-preview-confirm]") as HTMLElement
  ).click();
  await settle(form);
  await settle(el);
}

async function dismissOffer(el: any) {
  (
    el.shadowRoot.querySelector("wa-button[data-no-index-dismiss]") as HTMLElement
  ).click();
  await settle(el);
}

/** Runs a query whose sort CouchDB refuses, and returns the mounted screen. */
async function runRejectedSort(
  sort: unknown[] = [{ age: "asc" }],
  error: unknown = noUsableIndexError(),
): Promise<any> {
  const el = await mount();
  fireMangoChange(el, { selector: { name: { $gt: null } }, sort });
  await settle(el);
  (getContext().dbMgmt.queryDocuments as any).mockRejectedValue(error);
  el._runQuery();
  await settle(el);
  return el;
}

async function toastSpy() {
  return vi.spyOn(await import("../src/components/cca-toast.js"), "toast");
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(getContext().dbMgmt, "listDatabases").mockResolvedValue([
    { db_name: "testdb", servers: [{ server_id: "srv-1" }] },
  ] as any);
  vi.spyOn(getContext().dbMgmt, "queryDocuments").mockResolvedValue({
    documents: [{ _id: "doc:1", name: "x" }],
    bookmark: "",
    total_count: 1,
  } as any);
});

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("doc-query no-usable-index offer (#78)", () => {
  describe("detecting the right failure", () => {
    it("opens the offer when _find rejects the sort with no_usable_index", async () => {
      const el = await runRejectedSort();

      expect(offerIsOpen(el)).toBe(true);
      expect(indexForm(el)).not.toBeNull();
    });

    // The important negative case: the offer must not become "every _find error opens a
    // create-index dialog". Each of these is a real rejection from the same endpoint.
    const unrelated: Array<[string, unknown]> = [
      [
        "unsupported_mixed_sort — no index of any shape would fix it",
        new ApiError(
          400,
          "Sorts currently only support a single direction for all fields.",
          {
            error: "unsupported_mixed_sort",
            reason: "Sorts currently only support a single direction for all fields.",
          },
        ),
      ],
      [
        "invalid_operator",
        new ApiError(400, "Invalid operator: $bogus", {
          error: "invalid_operator",
          reason: "Invalid operator: $bogus",
        }),
      ],
      [
        "invalid_selector_json",
        new ApiError(400, "Selector must be a JSON object", {
          error: "invalid_selector_json",
          reason: "Selector must be a JSON object",
        }),
      ],
      [
        "a 500 with no error code at all",
        new ApiError(500, "Internal server error", { reason: "Internal server error" }),
      ],
      ["a plain Error that is not an ApiError", new Error("network down")],
    ];

    for (const [label, error] of unrelated) {
      it(`leaves ${label} as a toast and never opens the offer`, async () => {
        const toast = await toastSpy();
        const el = await runRejectedSort([{ age: "asc" }], error);

        expect(offerIsOpen(el)).toBe(false);
        expect(indexForm(el)).toBeNull();
        expect(
          toast.mock.calls.filter(([, variant]) => variant === "error"),
        ).toHaveLength(1);
      });
    }

    it("does not open the offer when the rejected query carried no sort", async () => {
      // Defensive: CouchDB answers a sortless query 200-with-a-warning rather than
      // no_usable_index, and an offer with no sort fields would have nothing to index.
      const toast = await toastSpy();
      const el = await runRejectedSort([]);

      expect(offerIsOpen(el)).toBe(false);
      expect(
        toast.mock.calls.filter(([, variant]) => variant === "error"),
      ).toHaveLength(1);
    });

    it("describes the sort that failed, not one the Sort panel drifted to afterwards", async () => {
      const el = await runRejectedSort([{ age: "asc" }]);
      expect(offerIsOpen(el)).toBe(true);

      // The panel moves on while the offer is up; the offer must still describe `age`.
      fireMangoChange(el, { sort: [{ somethingElse: "desc" }] });
      await settle(el);

      // #82 lifted the offer into the shared `IndexOffer` controller, so the sort that
      // failed is now the controller's, not a private field of this screen. The dialog
      // still renders into this screen's own shadow root, which is why every other
      // assertion in this file is untouched.
      expect(el.indexOffer.failedSort).toEqual([
        { field: "age", direction: "asc" },
      ]);
      expect(formFieldNames(el)).toEqual(["1. age"]);
    });
  });

  describe("pre-populating from the failed sort", () => {
    it("fills the create-index form with the sort's fields, in the sort's order", async () => {
      const el = await runRejectedSort([{ age: "asc" }, { name: "asc" }]);

      // Order matters to CouchDB: an index on `age` alone does not serve a sort by
      // [age, name] — that is still no_usable_index.
      expect(formFieldNames(el)).toEqual(["1. age", "2. name"]);
    });

    it("carries each sort field's direction into the form", async () => {
      const el = await runRejectedSort([{ age: "desc" }, { name: "desc" }]);

      expect(formFieldDirections(el)).toEqual(["desc", "desc"]);
    });

    it("suggests an index name, so Create is reachable without typing", async () => {
      const el = await runRejectedSort([{ age: "asc" }, { name: "asc" }]);

      const nameInput = indexForm(el).shadowRoot.querySelector(
        "wa-input[data-index-name]",
      ) as HTMLInputElement;
      expect(nameInput.value).toBe("age-name-index");
    });

    it("offers only Create — there is no existing index to Remove/Create", async () => {
      const el = await runRejectedSort();
      const form = indexForm(el).shadowRoot;

      expect(form.querySelector("wa-button[data-create]")).not.toBeNull();
      expect(form.querySelector("wa-button[data-remove-create]")).toBeNull();
    });
  });

  describe("creating the index is the user's explicit choice", () => {
    it("writes nothing merely by opening the offer", async () => {
      const create = vi.spyOn(getContext().dbMgmt, "createIndex");
      await runRejectedSort();

      expect(create).not.toHaveBeenCalled();
    });

    it("confirming creates the index through the existing create-index flow", async () => {
      const create = vi
        .spyOn(getContext().dbMgmt, "createIndex")
        .mockResolvedValue({
          id: "_design/abc",
          name: "age-name-index",
          type: "json",
          fields: ["age", "name"],
        } as any);
      const el = await runRejectedSort([{ age: "asc" }, { name: "asc" }]);

      await confirmIndexCreation(el);

      expect(create).toHaveBeenCalledTimes(1);
      const [, dbName, request] = create.mock.calls[0] as any[];
      expect(dbName).toBe("testdb");
      expect(request.fields).toEqual(["age", "name"]);
      expect(request.name).toBe("age-name-index");
      expect(request.type).toBe("json");
    });

    it("a descending sort is created as a descending index", async () => {
      const create = vi
        .spyOn(getContext().dbMgmt, "createIndex")
        .mockResolvedValue({ id: "_design/abc", name: "i", type: "json", fields: [] } as any);
      const el = await runRejectedSort([{ age: "desc" }]);

      await confirmIndexCreation(el);

      const [, , request] = create.mock.calls[0] as any[];
      expect(request.fields).toEqual([{ age: "desc" }]);
    });

    it("declining leaves no index created and closes the offer", async () => {
      const create = vi.spyOn(getContext().dbMgmt, "createIndex");
      const el = await runRejectedSort();

      await dismissOffer(el);

      expect(create).not.toHaveBeenCalled();
      expect(offerIsOpen(el)).toBe(false);
    });

    it("re-runs the query that failed once the index exists", async () => {
      vi.spyOn(getContext().dbMgmt, "createIndex").mockResolvedValue({
        id: "_design/abc",
        name: "age-index",
        type: "json",
        fields: ["age"],
      } as any);
      const el = await runRejectedSort([{ age: "asc" }]);
      const queryDocuments = getContext().dbMgmt.queryDocuments as any;
      queryDocuments.mockResolvedValue({
        documents: [{ _id: "doc:1", age: 3 }],
        bookmark: "",
      } as any);
      const before = queryDocuments.mock.calls.length;

      await confirmIndexCreation(el);

      const replayed = queryDocuments.mock.calls.slice(before);
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed.at(-1)![2].sort).toEqual([{ age: "asc" }]);
      expect(offerIsOpen(el)).toBe(false);
      expect(el._results).toEqual([{ _id: "doc:1", age: 3 }]);
    });
  });

  describe("when CouchDB refuses to create the index", () => {
    // A database member who is not a server admin: CouchDB 3.5.2 answers POST /{db}/_index
    // with 500 error_saving_ddoc "...: forbidden" rather than a 403. Nothing here predicts
    // that from the user's role (spec D9) — the response is what decides.
    const forbidden = () =>
      new ApiError(
        500,
        "Unknown error while saving the design document: forbidden",
        {
          error: "error_saving_ddoc",
          reason: "Unknown error while saving the design document: forbidden",
        },
      );

    it("surfaces the refusal as an error toast instead of crashing", async () => {
      const toast = await toastSpy();
      vi.spyOn(getContext().dbMgmt, "createIndex").mockRejectedValue(forbidden());
      const el = await runRejectedSort();

      await confirmIndexCreation(el);

      const errors = toast.mock.calls.filter(([, variant]) => variant === "error");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.at(-1)![0]).toMatch(/Failed to create index/i);
      expect(errors.at(-1)![0]).toMatch(/forbidden/i);
    });

    it("leaves the offer open and re-runs nothing", async () => {
      vi.spyOn(getContext().dbMgmt, "createIndex").mockRejectedValue(forbidden());
      const el = await runRejectedSort();
      const before = (getContext().dbMgmt.queryDocuments as any).mock.calls.length;

      await confirmIndexCreation(el);

      expect(offerIsOpen(el)).toBe(true);
      expect((getContext().dbMgmt.queryDocuments as any).mock.calls.length).toBe(
        before,
      );
    });
  });

  describe("the field-sampling query fails the same way", () => {
    it("offers the index when _fetchFields is the request CouchDB rejected", async () => {
      const el = await mount();
      fireMangoChange(el, {
        selector: { name: { $gt: null } },
        sort: [{ age: "asc" }],
      });
      await settle(el);
      (getContext().dbMgmt.queryDocuments as any).mockRejectedValue(
        noUsableIndexError(),
      );

      await el._fetchFields();
      await settle(el);

      expect(offerIsOpen(el)).toBe(true);
      expect(formFieldNames(el)).toEqual(["1. age"]);
    });
  });
});
