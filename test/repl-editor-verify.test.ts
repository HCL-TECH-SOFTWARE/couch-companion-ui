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

import { describe, it, expect, afterEach, vi } from "vitest";
import { LitElement } from "lit";
import "../src/plugins/replication/repl-editor.js";
import type { CcaReplEditor } from "../src/plugins/replication/repl-editor.js";
import { getContext } from "../src/context";
import { ApiError } from "../src/services/api-error";
import { stubReplEditorServices, stubDoc } from "./helpers/repl-editor-stubs";

class Stub extends LitElement {
  docIds: string[] = [];
  selectorJson = "";
  filterFn = "";
  createRenderRoot() {
    return this;
  }
}
for (const tag of [
  "wa-button",
  "wa-textarea",
  "wa-tab",
  "wa-tab-group",
  "wa-tab-panel",
  "wa-icon",
  "cca-repl-source-section",
  "cca-repl-target-section",
  "cca-repl-selector-section",
  "cca-repl-filter-section",
  "cca-repl-behavior-section",
  "cca-repl-documents-section",
  "cca-repl-issues-panel",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends Stub {});
  }
}

async function loadEditor(
  opts: { docIds?: string[]; sourceUrl?: string } = {},
): Promise<{ el: CcaReplEditor }> {
  stubReplEditorServices({
    doc: stubDoc({
      source: { url: opts.sourceUrl ?? "https://a/db", headers: {} },
      doc_ids: opts.docIds ?? ["d1", "d2"],
    }),
  });
  const el = document.createElement("cca-repl-editor") as CcaReplEditor;
  (el as unknown as { serverId: string }).serverId = "s";
  (el as unknown as { replId: string }).replId = "r";
  document.body.appendChild(el);
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  return { el };
}

function documentsSection(el: CcaReplEditor) {
  return el.shadowRoot?.querySelector("cca-repl-documents-section") as
    | (HTMLElement & { missingIds: string[] | null; canVerify: boolean })
    | null;
}

function sourceSection(el: CcaReplEditor) {
  return el.shadowRoot?.querySelector("cca-repl-source-section") as HTMLElement | null;
}

function filterSection(el: CcaReplEditor) {
  return el.shadowRoot?.querySelector("cca-repl-filter-section") as
    | (HTMLElement & { sourceServer: string; sourceDb: string })
    | null;
}

describe("cca-repl-editor verify-docs wiring", () => {
  let el: CcaReplEditor;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("verifies regular ids via one Mango query and flags the missing ones", async () => {
    const query = vi
      .spyOn(getContext().dbMgmt, "queryDocuments")
      .mockResolvedValue({ documents: [{ _id: "d1" }] });
    const loaded = await loadEditor(); // edit-mode mount: docIds d1,d2 / source s/db
    el = loaded.el;
    const section = documentsSection(el)!;
    expect(section.canVerify).toBe(true);

    section.dispatchEvent(new CustomEvent("cca-verify-docs", { bubbles: true, composed: true }));
    await vi.waitFor(() => expect(documentsSection(el)!.missingIds).toEqual(["d2"]));

    expect(query).toHaveBeenCalledWith("s", "db", {
      selector: { _id: { $in: ["d1", "d2"] } },
      scope: "raw",
      limit: 2,
    });
  });

  it("checks _design ids via getDoc (404 = missing) and resets results when the list changes", async () => {
    vi.spyOn(getContext().dbMgmt, "queryDocuments").mockResolvedValue({ documents: [{ _id: "d1" }] });
    const getDoc = vi
      .spyOn(getContext().dbMgmt, "getDoc")
      .mockRejectedValue(new ApiError(404, "not found"));
    const loaded = await loadEditor({ docIds: ["d1", "_design/x"] });
    el = loaded.el;

    const section = documentsSection(el)!;
    section.dispatchEvent(new CustomEvent("cca-verify-docs", { bubbles: true, composed: true }));
    await vi.waitFor(() => expect(documentsSection(el)!.missingIds).toEqual(["_design/x"]));
    expect(getDoc).toHaveBeenCalledWith("s", "db", "_design/x");

    section.dispatchEvent(
      new CustomEvent("cca-doc-ids-change", { detail: { docIds: ["d1"] }, bubbles: true, composed: true }),
    );
    await el.updateComplete;
    expect(documentsSection(el)!.missingIds).toBeNull();
  });

  it("sets verifying on the section while the check is in flight", async () => {
    let resolveQuery!: (value: { documents: Record<string, unknown>[] }) => void;
    vi.spyOn(getContext().dbMgmt, "queryDocuments").mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );
    const loaded = await loadEditor();
    el = loaded.el;
    const section = documentsSection(el)!;

    section.dispatchEvent(new CustomEvent("cca-verify-docs", { bubbles: true, composed: true }));
    await vi.waitFor(() =>
      expect((documentsSection(el) as unknown as { verifying: boolean }).verifying).toBe(true),
    );

    resolveQuery({ documents: [{ _id: "d1" }, { _id: "d2" }] });
    await vi.waitFor(() =>
      expect((documentsSection(el) as unknown as { verifying: boolean }).verifying).toBe(false),
    );
  });

  it("drops stale verify results when the source db changes while the check is in flight", async () => {
    let resolveQuery!: (value: { documents: Record<string, unknown>[] }) => void;
    vi.spyOn(getContext().dbMgmt, "queryDocuments").mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );
    const loaded = await loadEditor();
    el = loaded.el;
    const section = documentsSection(el)!;

    section.dispatchEvent(new CustomEvent("cca-verify-docs", { bubbles: true, composed: true }));
    await vi.waitFor(() =>
      expect((documentsSection(el) as unknown as { verifying: boolean }).verifying).toBe(true),
    );

    // Source db changes while the verify request is still in flight. (The
    // source server itself can no longer change — it's always this
    // deployment's one server, per Task 3 — so the db field is the only
    // remaining trigger for this staleness guard.)
    sourceSection(el)!.dispatchEvent(
      new CustomEvent("cca-source-db-change", {
        detail: { sourceDb: "other" },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    expect(documentsSection(el)!.missingIds).toBeNull();

    // The stale request finally resolves; its results must not clobber the reset.
    resolveQuery({ documents: [{ _id: "d1" }] });
    await vi.waitFor(() =>
      expect((documentsSection(el) as unknown as { verifying: boolean }).verifying).toBe(false),
    );
    await el.updateComplete;
    expect(documentsSection(el)!.missingIds).toBeNull();
  });

  it("disables canVerify and clears the filter-section source when the loaded source isn't the local server", async () => {
    // The saved doc's source url ("https://unregistered-host/db") doesn't
    // match this deployment's one server (stubbed to "https://a"), so
    // (sourceServer, sourceDb) — which still resolve to the edit-mode
    // server "s" / db "db" for other API calls — are NOT the effective
    // source endpoint. Verify and Browse must be disabled rather than
    // silently targeting the wrong db on the real local server.
    const loaded = await loadEditor({ sourceUrl: "https://unregistered-host/db" });
    el = loaded.el;

    const section = documentsSection(el)!;
    expect(section.canVerify).toBe(false);

    const filter = filterSection(el);
    expect(filter?.sourceServer).toBe("");
    expect(filter?.sourceDb).toBe("");
  });

  it("guards handleVerifyDocs itself: no query fires for an unregistered raw-URL source", async () => {
    const query = vi.spyOn(getContext().dbMgmt, "queryDocuments");
    const loaded = await loadEditor({ sourceUrl: "https://unregistered-host/db" });
    el = loaded.el;

    const section = documentsSection(el)!;
    section.dispatchEvent(new CustomEvent("cca-verify-docs", { bubbles: true, composed: true }));
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    expect(query).not.toHaveBeenCalled();
  });

  it("keeps canVerify true and the filter-section source populated when the source url matches the local server/db (existing edit-mode fixture)", async () => {
    const loaded = await loadEditor(); // default sourceUrl "https://a/db" === local base ("https://a") + "/db"
    el = loaded.el;

    const section = documentsSection(el)!;
    expect(section.canVerify).toBe(true);

    const filter = filterSection(el);
    expect(filter?.sourceServer).toBe("s");
    expect(filter?.sourceDb).toBe("db");
  });

  // Finding #7 of the Phase 4 final-review wave: ReplicationService.previewReplication runs
  // `_find`/`_all_docs` against the LOCAL server using the bare `sourceDb` name. For a legacy
  // remote-source doc (source url not this deployment's own server), that would silently query
  // the wrong database on the local server instead of the real remote one. handlePreview must be
  // gated the same way handleVerifyDocs already is.
  it("does not query the local server for a preview when the loaded source isn't the local server (guards handlePreview itself)", async () => {
    const loaded = await loadEditor({ sourceUrl: "https://unregistered-host/db" });
    el = loaded.el;
    // Spied AFTER mount: stubReplEditorServices (inside loadEditor) already replaced
    // ctx.replication.previewReplication with its own mock — spying now wraps that live method
    // instead of a copy that handlePreview would no longer be calling through.
    const preview = vi.spyOn(getContext().replication, "previewReplication");

    await (el as unknown as { handlePreview(): Promise<void> }).handlePreview();

    expect(preview).not.toHaveBeenCalled();
    expect((el as unknown as { preview: unknown }).preview).toBeNull();
  });
});
