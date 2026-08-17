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
 * Unit tests for CcaCreateIndex (create-index.ts) — issue #57:
 *  - a newly added field defaults to ascending order, with a per-field control to switch it
 *    to descending
 *  - Create / Remove-Create open an editable preview-and-confirm dialog instead of submitting
 *    immediately, and adjusting the preview's JSON changes what actually gets submitted
 *
 * create-index.ts side-effect-imports the real Web Awesome button/input/select/dialog
 * components (same as cca-user-detail.test.ts's approach for its own real WA elements), so
 * this suite drives those directly rather than stubbing them — a stub registered after the
 * real one has already loaded would be a no-op and silently leave the real, disabled-aware
 * component in place.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { getContext } from "../src/context";

// Prevent the real wa-icon from registering — it fetches SVGs over the network, which happy-dom
// can't answer (see index-manage.test.ts for the same guard).
vi.mock("@awesome.me/webawesome/dist/components/icon/icon.js", () => ({}));

// Prevent the real Monaco-backed editor from initialising in happy-dom (canvas pixel-ratio
// crash) — same guard cca-user-detail.test.ts uses. Must be mocked before importing
// create-index.js, which pulls it in transitively.
vi.mock("../src/components/cca-monaco-editor.js", () => ({}));

import type { CcaCreateIndex } from "../src/plugins/db-mgmt/create-index.js";
import "../src/plugins/db-mgmt/create-index.js";

if (!customElements.get("cca-monaco-editor")) {
  customElements.define(
    "cca-monaco-editor",
    class extends HTMLElement {
      value = "";
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function settle(el: CcaCreateIndex) {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

async function mount(serverId: string, dbName: string): Promise<CcaCreateIndex> {
  if (!document.querySelector("cca-router-provider")) {
    document.body.appendChild(document.createElement("cca-router-provider"));
  }
  const el = document.createElement("cca-create-index") as CcaCreateIndex;
  el.serverId = serverId;
  el.dbName = dbName;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

async function addField(el: CcaCreateIndex, name: string) {
  const input = el.shadowRoot!.querySelector(
    "wa-input[data-field-input]",
  ) as HTMLInputElement;
  input.value = name;
  input.dispatchEvent(new Event("input"));
  await settle(el);
  (el.shadowRoot!.querySelector("wa-button[data-add-field]") as HTMLElement).click();
  await settle(el);
}

async function setIndexName(el: CcaCreateIndex, name: string) {
  const input = el.shadowRoot!.querySelector(
    "wa-input[data-index-name]",
  ) as HTMLInputElement;
  input.value = name;
  input.dispatchEvent(new Event("input"));
  await settle(el);
}

function fieldDirectionSelect(el: CcaCreateIndex, index = 0): HTMLSelectElement {
  return el.shadowRoot!.querySelectorAll(".field-direction")[
    index
  ] as HTMLSelectElement;
}

async function setFieldDirection(
  el: CcaCreateIndex,
  direction: "asc" | "desc",
  index = 0,
) {
  const select = fieldDirectionSelect(el, index) as any;
  select.value = direction;
  select.dispatchEvent(new Event("change"));
  await settle(el);
}

function ddocInput(el: CcaCreateIndex): HTMLInputElement {
  return el.shadowRoot!.querySelector("wa-input[data-ddoc]") as HTMLInputElement;
}

async function setDdoc(el: CcaCreateIndex, ddoc: string) {
  const input = ddocInput(el);
  input.value = ddoc;
  input.dispatchEvent(new Event("input"));
  await settle(el);
}

function selectorEditor(el: CcaCreateIndex): HTMLElement & { value: string } {
  return el.shadowRoot!.querySelector(
    "cca-monaco-editor[data-selector-editor]",
  ) as HTMLElement & { value: string };
}

function previewEditor(el: CcaCreateIndex): HTMLElement & { value: string } {
  return el.shadowRoot!.querySelector(
    "cca-monaco-editor[data-preview-editor]",
  ) as HTMLElement & { value: string };
}

function editPreview(el: CcaCreateIndex, json: string) {
  previewEditor(el).dispatchEvent(new CustomEvent("change", { detail: { value: json } }));
}

function previewDialog(el: CcaCreateIndex): HTMLElement {
  return el.shadowRoot!.querySelector("wa-dialog[data-preview-dialog]") as HTMLElement;
}

/**
 * Switches tabs the way the real `wa-tab-group` does — it emits `wa-tab-show` carrying the
 * panel name (verified in the vendored source: `WaTabShowEvent`, bubbles + composed). Clicking
 * the `wa-tab` itself would depend on the tab group's IntersectionObserver having activated
 * the group, which never fires under happy-dom's zero-sized layout.
 */
async function showTab(el: CcaCreateIndex, name: "form" | "source") {
  el.shadowRoot!.querySelector("wa-tab-group")!.dispatchEvent(
    new CustomEvent("wa-tab-show", { detail: { name } }),
  );
  await settle(el);
}

function sourceEditor(el: CcaCreateIndex): HTMLElement & { value: string } {
  return el.shadowRoot!.querySelector(
    "cca-monaco-editor[data-source-editor]",
  ) as HTMLElement & { value: string };
}

function editSource(el: CcaCreateIndex, json: string) {
  sourceEditor(el).dispatchEvent(new CustomEvent("change", { detail: { value: json } }));
}

async function openCreatePreview(el: CcaCreateIndex) {
  (el.shadowRoot!.querySelector("wa-button[data-create]") as HTMLElement).click();
  await settle(el);
}

async function confirmPreview(el: CcaCreateIndex) {
  (el.shadowRoot!.querySelector("wa-button[data-preview-confirm]") as HTMLElement).click();
  await settle(el);
}

describe("CcaCreateIndex", () => {
  afterEach(() => {
    document.body.querySelectorAll("cca-create-index").forEach((e) => e.remove());
    vi.restoreAllMocks();
  });

  describe("field sort direction (#57)", () => {
    it("a newly added field defaults to ascending order", async () => {
      const el = await mount("srv1", "mydb");
      await addField(el, "status");

      const select = fieldDirectionSelect(el);
      expect(select).not.toBeNull();
      expect((select as any).value).toBe("asc");
    });

    it("switching a field's control to desc changes what gets submitted", async () => {
      const create = vi
        .spyOn(getContext().dbMgmt, "createIndex")
        .mockResolvedValue({ id: "_design/x", name: "idx", type: "json", fields: [] } as any);
      const el = await mount("srv1", "mydb");
      await addField(el, "status");
      await setIndexName(el, "status-idx");
      await setFieldDirection(el, "desc");

      await openCreatePreview(el);
      await confirmPreview(el);

      expect(create).toHaveBeenCalledTimes(1);
      const [, , request] = create.mock.calls[0];
      expect(request.fields).toEqual([{ status: "desc" }]);
    });

    it("editing an existing index preserves each field's direction", async () => {
      const el = await mount("srv1", "mydb");
      el.populateFromIndexInfo({
        name: "by-status-created",
        type: "json",
        ddoc: "_design/abc",
        def: { fields: ["status", { created_at: "desc" }] },
      });
      await settle(el);

      const selects = el.shadowRoot!.querySelectorAll(".field-direction");
      expect((selects[0] as any).value).toBe("asc");
      expect((selects[1] as any).value).toBe("desc");
    });
  });

  describe("editable create/remove preview (#57)", () => {
    it("clicking Create opens a preview dialog instead of submitting immediately", async () => {
      const create = vi.spyOn(getContext().dbMgmt, "createIndex");
      const el = await mount("srv1", "mydb");
      await addField(el, "status");
      await setIndexName(el, "status-idx");

      expect(previewDialog(el).hasAttribute("open")).toBe(false);

      await openCreatePreview(el);

      expect(previewDialog(el).hasAttribute("open")).toBe(true);
      expect(create).not.toHaveBeenCalled();
    });

    it("the preview shows the fields and index name that would be submitted", async () => {
      const el = await mount("srv1", "mydb");
      await addField(el, "status");
      await setIndexName(el, "status-idx");

      await openCreatePreview(el);

      const parsed = JSON.parse(previewEditor(el).value);
      expect(parsed).toMatchObject({ name: "status-idx", type: "json", fields: ["status"] });
    });

    it("Cancel closes the dialog without submitting", async () => {
      const create = vi.spyOn(getContext().dbMgmt, "createIndex");
      const el = await mount("srv1", "mydb");
      await addField(el, "status");
      await setIndexName(el, "status-idx");

      await openCreatePreview(el);
      (el.shadowRoot!.querySelector("wa-button[data-preview-cancel]") as HTMLElement).click();
      await settle(el);

      expect(previewDialog(el).hasAttribute("open")).toBe(false);
      expect(create).not.toHaveBeenCalled();
    });

    it("adjusting the preview's JSON changes what actually gets submitted", async () => {
      const create = vi
        .spyOn(getContext().dbMgmt, "createIndex")
        .mockResolvedValue({
          id: "_design/x",
          name: "renamed-idx",
          type: "json",
          fields: [],
        } as any);
      const el = await mount("srv1", "mydb");
      await addField(el, "status");
      await setIndexName(el, "status-idx");

      await openCreatePreview(el);

      const edited = {
        ...JSON.parse(previewEditor(el).value),
        name: "renamed-idx",
        fields: ["status", "created_at"],
      };
      editPreview(el, JSON.stringify(edited));

      await confirmPreview(el);

      expect(create).toHaveBeenCalledTimes(1);
      const [, , request] = create.mock.calls[0];
      expect(request.name).toBe("renamed-idx");
      expect(request.fields).toEqual(["status", "created_at"]);
    });

    it("rejects invalid JSON typed into the preview without submitting", async () => {
      const create = vi.spyOn(getContext().dbMgmt, "createIndex");
      const el = await mount("srv1", "mydb");
      await addField(el, "status");
      await setIndexName(el, "status-idx");

      await openCreatePreview(el);
      editPreview(el, "{ not valid json");
      await confirmPreview(el);

      expect(create).not.toHaveBeenCalled();
    });

    it("Remove/Create opens the same preview flow and submits with the delete-create flag", async () => {
      const create = vi.spyOn(getContext().dbMgmt, "createIndex").mockResolvedValue({
        id: "_design/x",
        name: "by-status",
        type: "json",
        fields: [],
      } as any);
      const el = await mount("srv1", "mydb");
      el.populateFromIndexInfo({
        name: "by-status",
        type: "json",
        def: { fields: ["status"] },
      });
      await settle(el);

      let dispatchedDetail: any;
      el.addEventListener("index-created", (e: Event) => {
        dispatchedDetail = (e as CustomEvent).detail;
      });

      (el.shadowRoot!.querySelector("wa-button[data-remove-create]") as HTMLElement).click();
      await settle(el);
      expect(previewDialog(el).hasAttribute("open")).toBe(true);

      await confirmPreview(el);

      expect(create).toHaveBeenCalledTimes(1);
      expect(dispatchedDetail?.deleteCreateIndex).toBe(true);
    });
  });

  describe("selecting an index fully repopulates the form (#108)", () => {
    it("populates the Design Document field with the bare ddoc name", async () => {
      const el = await mount("srv1", "mydb");
      el.populateFromIndexInfo({
        name: "by-status",
        type: "json",
        ddoc: "_design/my-indexes",
        def: { fields: ["status"] },
      });
      await settle(el);

      // The form field holds the bare name; the "_design/" prefix CouchDB reports would
      // otherwise be re-sent and produce "_design/_design/my-indexes".
      expect((ddocInput(el) as any).value).toBe("my-indexes");

      await setIndexName(el, "by-status");
      await openCreatePreview(el);
      expect(JSON.parse(previewEditor(el).value).ddoc).toBe("my-indexes");
    });

    it("clears the partial filter when the newly selected index has none", async () => {
      const el = await mount("srv1", "mydb");
      el.populateFromIndexInfo({
        name: "filtered",
        type: "json",
        ddoc: "_design/a",
        def: {
          fields: ["status"],
          partial_filter_selector: { status: { $eq: "active" } },
        },
      });
      await settle(el);
      expect(selectorEditor(el).value).toContain("$eq");

      el.populateFromIndexInfo({
        name: "unfiltered",
        type: "json",
        ddoc: "_design/b",
        def: { fields: ["created_at"] },
      });
      await settle(el);

      expect(selectorEditor(el).value).toBe("{\n\n}");
      expect(selectorEditor(el).value).not.toContain("$eq");

      // The stale selector must not reach the request either.
      await openCreatePreview(el);
      expect(JSON.parse(previewEditor(el).value).partial_filter_selector).toBeUndefined();
    });

    it("leaves the Design Document empty for the primary index (ddoc: null)", async () => {
      const el = await mount("srv1", "mydb");
      await setDdoc(el, "my-indexes");
      expect((ddocInput(el) as any).value).toBe("my-indexes");

      // CouchDB's built-in _all_docs index is listed and clickable, and reports ddoc: null.
      el.populateFromIndexInfo({
        name: "_all_docs",
        type: "special",
        ddoc: null,
        def: { fields: [{ _id: "asc" }] },
      });
      await settle(el);

      expect((ddocInput(el) as any).value).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // #92 item 4 — "when opening a mango index doc, open the form, not the
  // editor; editor in Source tab". Same Form/Source split #85 built for the
  // user-document editor and index-list.ts's per-index view already use.
  // -------------------------------------------------------------------------
  describe("Form / Source tabs (#92)", () => {
    it("offers exactly a Form and a Source tab", async () => {
      const el = await mount("srv1", "mydb");
      const labels = Array.from(
        el.shadowRoot!.querySelectorAll("wa-tab"),
      ).map((t) => t.textContent!.trim());
      expect(labels).toEqual(["Form", "Source"]);
    });

    it("opens on the Form tab — the structured fields, not a JSON editor", async () => {
      const el = await mount("srv1", "mydb");
      await addField(el, "status");

      // The form's own controls are what a fresh screen shows...
      expect(el.shadowRoot!.querySelector("wa-input[data-field-input]")).not.toBeNull();
      expect(el.shadowRoot!.querySelector(".field-direction")).not.toBeNull();
      // ...and the raw-JSON editor is not mounted at all until Source is asked for.
      expect(sourceEditor(el)).toBeNull();
    });

    it("opening an existing index lands on Form with the fields populated", async () => {
      const el = await mount("srv1", "mydb");
      el.populateFromIndexInfo({
        name: "by-status-created",
        type: "json",
        ddoc: "_design/abc",
        def: { fields: ["status", { created_at: "desc" }] },
      });
      await settle(el);

      expect(sourceEditor(el)).toBeNull();
      const names = Array.from(el.shadowRoot!.querySelectorAll(".field-name")).map((n) =>
        n.textContent!.trim(),
      );
      expect(names).toEqual(["1. status", "2. created_at"]);
      expect((el.shadowRoot!.querySelector("wa-input[data-index-name]") as any).value).toBe(
        "by-status-created",
      );
    });

    it("opening an index while Source is showing switches back to Form", async () => {
      // The literal complaint in #92: clicking an index in the list dropped the user on an
      // editor. Landing on Form has to hold even when Source was the tab last left open.
      const el = await mount("srv1", "mydb");
      await showTab(el, "source");
      expect(sourceEditor(el)).not.toBeNull();

      el.populateFromIndexInfo({
        name: "by-status",
        type: "json",
        ddoc: "_design/abc",
        def: { fields: ["status"] },
      });
      await settle(el);

      expect(sourceEditor(el)).toBeNull();
      expect(el.shadowRoot!.querySelector(".field-name")!.textContent).toContain("status");
    });

    it("populateFromSort (#78) also lands on Form, not Source", async () => {
      const el = await mount("srv1", "mydb");
      await showTab(el, "source");

      el.populateFromSort([
        { field: "age", direction: "asc" },
        { field: "name", direction: "asc" },
      ]);
      await settle(el);

      expect(sourceEditor(el)).toBeNull();
      const names = Array.from(el.shadowRoot!.querySelectorAll(".field-name")).map((n) =>
        n.textContent!.trim(),
      );
      expect(names).toEqual(["1. age", "2. name"]);
    });

    it("the Source tab shows the request the form describes, as raw JSON", async () => {
      const el = await mount("srv1", "mydb");
      await addField(el, "status");
      await setFieldDirection(el, "desc");
      await setIndexName(el, "status-idx");
      await setDdoc(el, "my-indexes");
      await showTab(el, "source");

      const parsed = JSON.parse(sourceEditor(el).value);
      expect(parsed).toEqual({
        name: "status-idx",
        type: "json",
        fields: [{ status: "desc" }],
        ddoc: "my-indexes",
      });
    });

    it("the Source editor is editable — nothing marks it read-only", async () => {
      const el = await mount("srv1", "mydb");
      await showTab(el, "source");
      const editor = sourceEditor(el);
      expect(editor).not.toBeNull();
      expect(editor.hasAttribute("readonly")).toBe(false);
      expect((editor as any).readOnly).toBeFalsy();
    });

    it("what is typed into Source is what gets submitted", async () => {
      const create = vi
        .spyOn(getContext().dbMgmt, "createIndex")
        .mockResolvedValue({ id: "_design/x", name: "hand-written", type: "json", fields: [] } as any);
      const el = await mount("srv1", "mydb");
      await addField(el, "status");
      await setIndexName(el, "status-idx");
      await showTab(el, "source");

      editSource(
        el,
        JSON.stringify({
          name: "hand-written",
          type: "json",
          fields: ["a", { b: "desc" }],
          partial_filter_selector: { active: true },
        }),
      );
      await settle(el);

      await openCreatePreview(el);
      await confirmPreview(el);

      expect(create).toHaveBeenCalledTimes(1);
      const [, , request] = create.mock.calls[0];
      expect(request.name).toBe("hand-written");
      expect(request.fields).toEqual(["a", { b: "desc" }]);
      expect(JSON.parse(request.partial_filter_selector!)).toEqual({ active: true });
    });

    it("Source edits survive a trip back to Form and are not clobbered on re-entry", async () => {
      const el = await mount("srv1", "mydb");
      await addField(el, "status");
      await setIndexName(el, "status-idx");
      await showTab(el, "source");
      editSource(el, JSON.stringify({ name: "typed", type: "json", fields: ["typed"] }));
      await settle(el);

      // Leaving and coming back re-snapshots from the form, which is #85's rule: Source is a
      // free-standing edit *while it is open*, seeded on the way in rather than mirrored.
      await showTab(el, "form");
      await showTab(el, "source");
      expect(JSON.parse(sourceEditor(el).value).name).toBe("status-idx");
    });

    it("refuses to open the preview when Source holds invalid JSON", async () => {
      const create = vi.spyOn(getContext().dbMgmt, "createIndex");
      const toastSpy = vi.spyOn(await import("../src/components/cca-toast.js"), "toast");
      const el = await mount("srv1", "mydb");
      await addField(el, "status");
      await setIndexName(el, "status-idx");
      await showTab(el, "source");

      editSource(el, "{ not valid json");
      await settle(el);
      await openCreatePreview(el);

      expect(toastSpy).toHaveBeenCalledWith(
        "The Source tab does not contain valid JSON.",
        "error",
      );
      expect(previewDialog(el).hasAttribute("open")).toBe(false);
      expect(create).not.toHaveBeenCalled();
    });

    it("keeps #57's Create-disabled-without-fields rule on the Form tab", async () => {
      const el = await mount("srv1", "mydb");
      const createBtn = el.shadowRoot!.querySelector("wa-button[data-create]") as HTMLElement;
      expect(createBtn.hasAttribute("disabled")).toBe(true);

      await addField(el, "status");
      expect(createBtn.hasAttribute("disabled")).toBe(false);
    });

    it("lets Source stand on its own — Create is enabled there with no form fields", async () => {
      // On Source the form's field list is no longer what will be submitted, so gating Create
      // on it would make a hand-written index unsubmittable.
      const el = await mount("srv1", "mydb");
      await showTab(el, "source");

      const createBtn = el.shadowRoot!.querySelector("wa-button[data-create]") as HTMLElement;
      expect(createBtn.hasAttribute("disabled")).toBe(false);
    });

    it("Remove/Create still appears for an opened index and previews from Source too", async () => {
      const create = vi
        .spyOn(getContext().dbMgmt, "createIndex")
        .mockResolvedValue({ id: "_design/x", name: "edited", type: "json", fields: [] } as any);
      const el = await mount("srv1", "mydb");
      el.populateFromIndexInfo({
        name: "by-status",
        type: "json",
        ddoc: "_design/abc",
        def: { fields: ["status"] },
      });
      await settle(el);
      await showTab(el, "source");

      editSource(el, JSON.stringify({ name: "edited", type: "json", fields: ["status"] }));
      await settle(el);

      const removeCreate = el.shadowRoot!.querySelector(
        "wa-button[data-remove-create]",
      ) as HTMLElement;
      expect(removeCreate).not.toBeNull();
      removeCreate.click();
      await settle(el);
      expect(previewDialog(el).hasAttribute("open")).toBe(true);

      await confirmPreview(el);
      expect(create.mock.calls[0][2].name).toBe("edited");
    });
  });
});
