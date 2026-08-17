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
 * Unit tests for CcaDocBrowser component.
 *
 * Tests rendering, connectedCallback branching, and server-segment navigation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LitElement } from "lit";
import { getContext } from "../src/context";

// Prevent the real wa-icon from registering. It fetches each SVG over the network — since #741
// that is same-origin /icons/*, not the fontawesome CDN, but happy-dom has no server to answer
// either, so the in-flight fetches abort on teardown and log DOMException noise.
vi.mock("@awesome.me/webawesome/dist/components/icon/icon.js", () => ({}));

// Prevent monaco-editor from initialising in jsdom (canvas pixel-ratio crash).
// cca-monaco-editor is used in read-only mode inside doc-browser's full-JSON view.
vi.mock("../src/components/cca-monaco-editor.js", () => ({}));

import type { CcaDocBrowser } from "../src/plugins/db-mgmt/doc-browser.js";
import "../src/plugins/db-mgmt/doc-browser.js";
import "../src/components/cca-toast.js";
import type { CcaToast } from "../src/components/cca-toast.js";
import { ApiError } from "../src/services/api-error.js";
import { describeDbAccessError } from "../src/services/db-enumeration.js";

// ---------------------------------------------------------------------------
// Stub wa-* and cca-* custom elements so the component can render in jsdom
// ---------------------------------------------------------------------------
class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}

for (const tag of [
  "wa-button",
  "wa-badge",
  "wa-callout",
  "wa-checkbox",
  "wa-dialog",
  "wa-icon",
  "wa-input",
  "wa-select",
  "wa-option",
  "wa-spinner",
  "wa-drawer",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

for (const tag of ["cca-data-table", "cca-monaco-editor"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockDbMgmt() {
  const ctx = getContext();
  vi.spyOn(ctx.dbMgmt, "listDatabases").mockResolvedValue([]);
  vi.spyOn(ctx.dbMgmt, "listDocuments").mockResolvedValue({
    documents: [],
    bookmark: undefined,
    total_count: 0,
  } as any);
  return ctx;
}

function createBrowser(serverId: string, dbName: string): CcaDocBrowser {
  const el = document.createElement("cca-doc-browser") as CcaDocBrowser;
  // Set properties BEFORE appending so connectedCallback sees them
  el.serverId = serverId;
  el.dbName = dbName;
  document.body.appendChild(el);
  return el;
}

/** Lets the load promise chain settle and Lit re-render before assertions. */
async function settle(el: CcaDocBrowser) {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

/**
 * Re-answers `listDocuments` with `docs`, reloads, and shows `view`.
 *
 * The view used to be the *fetch scope* (`"raw"`/`"full"`), and switching it refetched.
 * Since #79 both bodies render the same loaded page — the request is always for whole
 * documents, because the table derives its columns from them — so the view is a plain
 * state change set alongside the load rather than instead of it.
 */
async function loadDocs(
  el: CcaDocBrowser,
  docs: unknown[],
  view: "table" | "json" = "table",
) {
  vi.spyOn(getContext().dbMgmt, "listDocuments").mockResolvedValue({
    documents: docs,
    bookmark: undefined,
    total_count: docs.length,
  } as any);
  // @ts-ignore — private view mode
  el._view = view;
  // @ts-ignore — private reload
  el._load();
  await settle(el);
}

/** Fails the next load with `err`, the way a refused CouchDB read reaches this screen. */
async function failLoad(el: CcaDocBrowser, err: unknown) {
  vi.spyOn(getContext().dbMgmt, "listDocuments").mockRejectedValue(err);
  // @ts-ignore — private reload
  el._load();
  await settle(el);
}

const q = (el: CcaDocBrowser, sel: string) => el.shadowRoot!.querySelector(sel);
const qa = (el: CcaDocBrowser, sel: string) =>
  Array.from(el.shadowRoot!.querySelectorAll(sel));

/**
 * The shared page-size/skip/previous/next footer's own shadow root (#80). It is a real
 * `cca-page-controls`, not a stub, so both screens are exercised through the same control.
 */
const controlsOf = (el: CcaDocBrowser): ShadowRoot =>
  (q(el, "cca-page-controls") as HTMLElement).shadowRoot!;

const listSpy = () => getContext().dbMgmt.listDocuments as any;

/** The params object of the most recent `listDocuments` call. */
const lastListParams = () => listSpy().mock.calls.at(-1)![2] ?? {};

/** Picks a page size the way the selector does: set the value, announce the change. */
async function choosePageSize(el: CcaDocBrowser, size: number) {
  const select = controlsOf(el).querySelector("[data-page-size]") as any;
  select.value = String(size);
  select.dispatchEvent(new Event("change"));
  await settle(el);
}

/** Types into the skip box and commits it (blur/Enter both surface as `change`). */
async function enterSkip(el: CcaDocBrowser, raw: string) {
  const input = controlsOf(el).querySelector("[data-skip]") as any;
  input.value = raw;
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new Event("change"));
  await settle(el);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("CcaDocBrowser", () => {
  let element: CcaDocBrowser;

  beforeEach(async () => {
    // CcaElement finds the event router via a provider element in the document.
    if (!document.querySelector("cca-router-provider")) {
      document.body.appendChild(document.createElement("cca-router-provider"));
    }
    // The page-size preference is read in the constructor, so it has to be clean
    // before the element exists (#80).
    localStorage.clear();
    mockDbMgmt();
    element = createBrowser("srv1", "mydb");
    await element.updateComplete;
    await Promise.resolve();
    await element.updateComplete;
  });

  afterEach(() => {
    element.remove();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe("Rendering", () => {
    it("mounts and renders without error", async () => {
      expect(element).toBeDefined();
      expect(element.shadowRoot).toBeDefined();
    });

    it("renders a cca-data-table in the shadow DOM", async () => {
      expect(
        element.shadowRoot!.querySelector("cca-data-table"),
      ).not.toBeNull();
    });
  });

  describe("connectedCallback branching", () => {
    it("calls listDocuments when serverId is a concrete server (not $all)", () => {
      const ctx = getContext();
      // listDocuments was spied before element was created; connectedCallback
      // sees serverId='srv1' and calls _load() → listDocuments
      expect(ctx.dbMgmt.listDocuments).toHaveBeenCalled();
    });
  });

  describe("Pagination — hasMore comes from the bookmark, not page length", () => {
    // #80 turned "Next, greyed out" into "no Next at all", so this test now asserts the
    // button's absence. The state check below it is unchanged and is the actual guard:
    // `_hasMore` must come from the bookmark, never from the row count.
    it("hides Next when a full page (exactly the page size) carries no bookmark", async () => {
      const ctx = getContext();
      const fullPage = Array.from({ length: 25 }, (_, i) => ({
        _id: `doc${i}`,
        _rev: "1-a",
      }));
      // _all_docs returns exactly `limit` rows with NO bookmark whenever the
      // remaining count is exactly the page size too — the true last page.
      vi.spyOn(ctx.dbMgmt, "listDocuments").mockResolvedValue({
        documents: fullPage,
        bookmark: undefined,
        total_count: 25,
      } as any);

      // @ts-ignore — reload via the private method with the new mock in place
      element._load();
      await settle(element);

      // @ts-ignore — private state; this is exactly the bug this test guards
      expect(element._hasMore).toBe(false);
      expect(controlsOf(element).querySelector("[data-next-page]")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // #80 — page size is the user's to choose, skip is a real input, and
  // previous/next are hidden rather than greyed out (matching index-list, #57).
  // -------------------------------------------------------------------------
  describe("Page size, skip and page buttons (#80)", () => {
    it("requests the default 25 per page until told otherwise", () => {
      const params = lastListParams();
      expect(params.limit).toBe(25);
      expect(params.skip).toBe(0);
    });

    it("offers 5/10/25/50/100 with the current size selected", async () => {
      const select = controlsOf(element).querySelector("[data-page-size]")!;
      const values = Array.from(select.querySelectorAll("wa-option")).map((o) =>
        o.getAttribute("value"),
      );
      expect(values).toEqual(["5", "10", "25", "50", "100"]);
      expect((select as any).value).toBe("25");
    });

    it("re-requests with the chosen limit when the page size changes", async () => {
      await choosePageSize(element, 50);
      expect(lastListParams().limit).toBe(50);
    });

    it("remembers the choice in localStorage, so a fresh screen starts there", async () => {
      await choosePageSize(element, 100);
      expect(localStorage.getItem("ccaDocBrowserPageSize")).toBe("100");

      // A reload is a new element reading the same localStorage.
      element.remove();
      element = createBrowser("srv1", "mydb");
      await settle(element);
      expect(lastListParams().limit).toBe(100);
    });

    it("sends the skip box's value on as a service param", async () => {
      await enterSkip(element, "40");
      expect(lastListParams().skip).toBe(40);
    });

    it("refuses a skip that is not a whole number, and sends nothing", async () => {
      const before = listSpy().mock.calls.length;
      await enterSkip(element, "-5");
      expect(listSpy().mock.calls.length).toBe(before);
      expect(
        controlsOf(element).querySelector("[data-skip]")!.getAttribute("hint"),
      ).toContain("Whole numbers");

      await enterSkip(element, "2.5");
      expect(listSpy().mock.calls.length).toBe(before);
    });

    it("goes back to the first page when the page size changes", async () => {
      // @ts-ignore — pretend we paged forward
      element._page = 2;
      // @ts-ignore
      element._bookmarks = [undefined, "bm1", "bm2"];
      await choosePageSize(element, 10);
      // @ts-ignore
      expect(element._page).toBe(0);
      expect(lastListParams().bookmark).toBeUndefined();
    });

    it("hides Previous on the first page and shows it on the second", async () => {
      expect(controlsOf(element).querySelector("[data-prev-page]")).toBeNull();

      vi.spyOn(getContext().dbMgmt, "listDocuments").mockResolvedValue({
        documents: [{ _id: "a", _rev: "1-a" }],
        bookmark: undefined,
        total_count: 30,
      } as any);
      // @ts-ignore — private page advance
      element._nextPage();
      await settle(element);

      expect(
        controlsOf(element).querySelector("[data-prev-page]"),
      ).not.toBeNull();
    });

    it("shows Next only while a bookmark says another page exists", async () => {
      await loadDocs(element, [{ _id: "a", _rev: "1-a" }]);
      expect(controlsOf(element).querySelector("[data-next-page]")).toBeNull();

      vi.spyOn(getContext().dbMgmt, "listDocuments").mockResolvedValue({
        documents: [{ _id: "a", _rev: "1-a" }],
        bookmark: "next-token",
        total_count: 99,
      } as any);
      // @ts-ignore — private reload
      element._load();
      await settle(element);

      expect(
        controlsOf(element).querySelector("[data-next-page]"),
      ).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // #80 — infinite scroll is retired: one navigation model, not two.
  // -------------------------------------------------------------------------
  describe("Virtual scroll is gone (#80)", () => {
    it("offers no scroll/pages switch in the options drawer or icon bar", () => {
      const text = element.shadowRoot!.textContent ?? "";
      expect(text).not.toContain("Scroll");
      expect(text).not.toContain("Navigation");
      expect(
        element.shadowRoot!.querySelector('[title="Virtual scroll"]'),
      ).toBeNull();
    });

    it("renders no scroll container or sentinel", async () => {
      await loadDocs(element, [{ _id: "a", _rev: "1-a" }]);
      expect(q(element, ".virtual-scroll-container")).toBeNull();
      expect(q(element, "#vs-sentinel")).toBeNull();
    });
  });

  describe("Navigation — server-segment URL (#518)", () => {
    it("_openDoc navigates to /databases/<serverId>/<dbName>/documents/<docId>", () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, "navigate");

      // @ts-ignore — call private method directly
      element._openDoc("mydoc");

      expect(navigateSpy).toHaveBeenCalledOnce();
      const url: string = navigateSpy.mock.calls[0][0];
      expect(url).toBe("/databases/srv1/mydb/documents/mydoc");
    });

    it("_newDoc navigates to /databases/<serverId>/<dbName>/documents/new", () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, "navigate");

      // @ts-ignore — call private method directly
      element._newDoc();

      expect(navigateSpy).toHaveBeenCalledOnce();
      const url: string = navigateSpy.mock.calls[0][0];
      expect(url).toBe("/databases/srv1/mydb/documents/new");
    });

    it("_openDoc falls back to this.serverId when _selectedServerId is empty", () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, "navigate");

      // @ts-ignore — override private state to simulate un-set server
      element._selectedServerId = "";

      // @ts-ignore — call private method directly
      element._openDoc("somedoc");

      const url: string = navigateSpy.mock.calls[0][0];
      // serverId = 'srv1' is the fallback
      expect(url).toBe("/databases/srv1/mydb/documents/somedoc");
    });

    it("_openDoc falls back to $all when both _selectedServerId and serverId are empty", () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, "navigate");

      // @ts-ignore — clear both server references
      element._selectedServerId = "";
      element.serverId = "";

      // @ts-ignore — call private method directly
      element._openDoc("somedoc");

      const url: string = navigateSpy.mock.calls[0][0];
      expect(url).toBe("/databases/%24all/mydb/documents/somedoc");
    });

    it("_newDoc falls back to $all when both server ids are empty", () => {
      const ctx = getContext();
      const navigateSpy = vi.spyOn(ctx.router, "navigate");

      // @ts-ignore — clear both server references
      element._selectedServerId = "";
      element.serverId = "";

      // @ts-ignore — call private method directly
      element._newDoc();

      const url: string = navigateSpy.mock.calls[0][0];
      expect(url).toBe("/databases/%24all/mydb/documents/new");
    });
  });

  describe("Bulk delete — failure path", () => {
    let toastEl: CcaToast;

    beforeEach(async () => {
      toastEl = document.createElement("cca-toast") as CcaToast;
      document.body.appendChild(toastEl);
      await toastEl.updateComplete;
    });

    afterEach(() => {
      toastEl.remove();
      vi.unstubAllGlobals();
    });

    it("surfaces a toast (not an unhandled rejection) when deleteDocuments rejects", async () => {
      const ctx = getContext();
      vi.spyOn(ctx.dbMgmt, "deleteDocuments").mockRejectedValue(
        new Error("conflict"),
      );

      const docs = [{ _id: "doc1", _rev: "1-a" }];
      // @ts-ignore — populate the selection the way row checkboxes normally would
      element._selectedDocs = new Set(["doc1|1-a"]);

      // @ts-ignore — call the private bulk-delete handler directly
      element.deleteDocuments(docs);
      await element.updateComplete;
      (q(element, "[data-delete-confirm]") as HTMLElement).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const text =
        toastEl.shadowRoot!.querySelector(".toast.error")?.textContent ?? "";
      expect(text).toContain("conflict");
    });
  });

  // -------------------------------------------------------------------------
  // #58.1 — the bulk-delete button was never actually disabled: `.clickable`
  // is not a Web Awesome button property, so it set a stray JS property and
  // nothing else.
  // -------------------------------------------------------------------------
  describe("Bulk delete — the button's disabled state (#58.1)", () => {
    beforeEach(async () => {
      await loadDocs(element, [
        { _id: "a", _rev: "1-a" },
        { _id: "b", _rev: "1-b" },
      ]);
    });

    it("renders the bulk-delete button disabled while nothing is selected", () => {
      const btn = q(element, "[data-bulk-delete]");
      expect(btn).not.toBeNull();
      expect(btn!.hasAttribute("disabled")).toBe(true);
    });

    it("enables the bulk-delete button once a document is selected", async () => {
      // @ts-ignore — the state a row checkbox would set
      element._selectedDocs = new Set(["a|1-a"]);
      element.requestUpdate();
      await element.updateComplete;

      expect(q(element, "[data-bulk-delete]")!.hasAttribute("disabled")).toBe(
        false,
      );
    });
  });

  // -------------------------------------------------------------------------
  // #58.2 — selection existed only in the metadata table, so JSON view could
  // select nothing while its delete button sat in a header it never renders.
  // -------------------------------------------------------------------------
  describe("Selection works in JSON view too (#58.2)", () => {
    beforeEach(async () => {
      await loadDocs(
        element,
        [
          { _id: "a", _rev: "1-a", n: 1 },
          { _id: "b", _rev: "1-b", n: 2 },
        ],
        "json",
      );
    });

    it("renders one selection checkbox per document", () => {
      expect(qa(element, ".editor-item wa-checkbox")).toHaveLength(2);
    });

    it("renders the bulk-delete button", () => {
      expect(q(element, "[data-bulk-delete]")).not.toBeNull();
    });

    it("checking a document's box selects it for deletion", async () => {
      const box = qa(element, ".editor-item wa-checkbox")[0] as HTMLElement;
      (box as any).checked = true;
      box.dispatchEvent(new Event("change"));
      await element.updateComplete;

      // @ts-ignore — private selection set
      expect([...element._selectedDocs]).toEqual(["a|1-a"]);
      expect(q(element, "[data-bulk-delete]")!.hasAttribute("disabled")).toBe(
        false,
      );
    });

    it("select-all reaches every loaded document", async () => {
      const all = q(element, "[data-select-all]") as HTMLElement;
      expect(all).not.toBeNull();
      (all as any).checked = true;
      all.dispatchEvent(new Event("change"));
      await element.updateComplete;

      // @ts-ignore — private selection set
      expect([...element._selectedDocs].sort()).toEqual(["a|1-a", "b|1-b"]);
    });
  });

  // -------------------------------------------------------------------------
  // #58.3 — the JSON view titled each document by re-parsing its JSON and
  // falling back to the literal "Unnamed index" (copied from index-list), then
  // navigated to a document with that id, which does not exist.
  // -------------------------------------------------------------------------
  describe("JSON view titles address the real _id (#58.3)", () => {
    it("shows the document's own _id and opens it", async () => {
      await loadDocs(element, [{ _id: "real-doc", _rev: "1-a" }], "json");
      const navigate = vi.spyOn(getContext().router, "navigate");

      const title = q(element, ".editor-title") as HTMLElement;
      expect(title.textContent!.trim()).toBe("real-doc");

      title.click();
      expect(navigate).toHaveBeenCalledWith(
        "/databases/srv1/mydb/documents/real-doc",
      );
    });

    it("never renders the copy-pasted 'Unnamed index' fallback", async () => {
      await loadDocs(element, [{ _rev: "1-a", note: "no id" }], "json");
      expect(element.shadowRoot!.textContent).not.toContain("Unnamed index");
    });

    it("does not navigate for a document that carries no _id", async () => {
      await loadDocs(element, [{ _rev: "1-a", note: "no id" }], "json");
      const navigate = vi.spyOn(getContext().router, "navigate");

      (q(element, ".editor-title") as HTMLElement).click();
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // #58.4 — every refusal was one vague toast over an empty table. The three
  // statuses CouchDB distinguishes mean opposite things, and db-enumeration is
  // the single place that tells them apart.
  // -------------------------------------------------------------------------
  describe("Load failures are told apart inline (#58.4)", () => {
    const unauthorized = () =>
      new ApiError(401, "You are not authorized to access this db.");
    const forbidden = () =>
      new ApiError(403, "You are not allowed to access this db.");
    const notFound = () => new ApiError(404, "Database does not exist.");

    const errorText = () =>
      (q(element, "[data-load-error]")?.textContent ?? "").trim();

    // #66: what this screen asked for was `GET /{db}/_all_docs`, so its 401 is about this one
    // database. The server-wide "listing the databases is administrator-only" copy — written
    // for `_all_dbs`, and what this screen used to print — describes nothing that happened.
    it("401 says this database will not open for you, not that listing is admin-only", async () => {
      await failLoad(element, unauthorized());
      expect(errorText()).toContain(
        describeDbAccessError(unauthorized(), "mydb", "database"),
      );
      expect(errorText()).not.toMatch(/listing the databases/i);
    });

    it("403 says the account is not a member of this database", async () => {
      await failLoad(element, forbidden());
      expect(errorText()).toContain(
        describeDbAccessError(forbidden(), "mydb"),
      );
    });

    it("404 says there is no such database", async () => {
      await failLoad(element, notFound());
      expect(errorText()).toContain(describeDbAccessError(notFound(), "mydb"));
    });

    it("replaces the results rather than leaving an empty table behind", async () => {
      await failLoad(element, notFound());
      expect(q(element, "cca-data-table")).toBeNull();
    });

    it("offers the way out that still works", async () => {
      await failLoad(element, forbidden());
      const navigate = vi.spyOn(getContext().router, "navigate");
      (q(element, "[data-back-to-databases]") as HTMLElement).click();
      expect(navigate).toHaveBeenCalledWith("/databases/$all");
    });

    it("clears the error once a load succeeds", async () => {
      await failLoad(element, notFound());
      expect(q(element, "[data-load-error]")).not.toBeNull();

      await loadDocs(element, [{ _id: "a", _rev: "1-a" }]);
      expect(q(element, "[data-load-error]")).toBeNull();
      expect(q(element, "cca-data-table")).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // #58.5 — window.confirm was the only blocking browser dialog on a screen
  // that otherwise talks in wa-dialog.
  // -------------------------------------------------------------------------
  describe("Bulk delete confirms in a wa-dialog (#58.5)", () => {
    let deleteSpy: ReturnType<typeof vi.spyOn>;
    let confirmSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      confirmSpy = vi.fn(() => true);
      vi.stubGlobal("confirm", confirmSpy);
      await loadDocs(element, [{ _id: "a", _rev: "1-a" }]);
      deleteSpy = vi
        .spyOn(getContext().dbMgmt, "deleteDocuments")
        .mockResolvedValue({ deleted: 1, errors: [] } as any);
      // @ts-ignore — the state a row checkbox would set
      element._selectedDocs = new Set(["a|1-a"]);
    });

    afterEach(() => vi.unstubAllGlobals());

    async function askToDelete() {
      // @ts-ignore — private bulk-delete entry point
      element.deleteDocuments([{ _id: "a", _rev: "1-a" }]);
      await element.updateComplete;
    }

    it("opens a wa-dialog and never calls window.confirm", async () => {
      await askToDelete();
      expect(confirmSpy).not.toHaveBeenCalled();
      const dialog = q(element, "wa-dialog[data-delete-dialog]");
      expect(dialog).not.toBeNull();
      expect(dialog!.hasAttribute("open")).toBe(true);
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("deletes only after the dialog's Delete is pressed", async () => {
      await askToDelete();
      (q(element, "[data-delete-confirm]") as HTMLElement).click();
      expect(deleteSpy).toHaveBeenCalledOnce();
    });

    it("deletes nothing when the dialog is cancelled", async () => {
      await askToDelete();
      (q(element, "[data-delete-cancel]") as HTMLElement).click();
      await settle(element);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(
        q(element, "wa-dialog[data-delete-dialog]")!.hasAttribute("open"),
      ).toBe(false);
    });
  });
});
