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
): Promise<{ el: CcaReplEditor; stubs: ReturnType<typeof stubReplEditorServices> }> {
  const stubs = stubReplEditorServices({
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
  return { el, stubs };
}

function documentsSection(el: CcaReplEditor) {
  return el.shadowRoot?.querySelector("cca-repl-documents-section") as
    | (HTMLElement & { missingIds: string[] | null; canVerify: boolean })
    | null;
}

function sourceSection(el: CcaReplEditor) {
  return el.shadowRoot?.querySelector('cca-repl-endpoint[kind="source"]') as HTMLElement | null;
}

function filterSection(el: CcaReplEditor) {
  return el.shadowRoot?.querySelector("cca-repl-filter-section") as
    | (HTMLElement & { endpoint: { serverUrl: string; headers: Record<string, string> }; sourceDb: string })
    | null;
}

const LOCAL_EP = { serverUrl: "https://a", headers: {} };
const REMOTE_EP = { serverUrl: "https://unregistered-host", headers: {} };

function verify(el: CcaReplEditor) {
  documentsSection(el)!.dispatchEvent(
    new CustomEvent("cca-verify-docs", { bubbles: true, composed: true }),
  );
}

describe("cca-repl-editor verify-docs wiring", () => {
  let el: CcaReplEditor;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("verifies regular ids via one Mango query and flags the missing ones", async () => {
    const loaded = await loadEditor(); // edit-mode mount: docIds d1,d2 / source https://a + db
    el = loaded.el;
    loaded.stubs.findDocs.mockResolvedValue([{ _id: "d1" }]);
    expect(documentsSection(el)!.canVerify).toBe(true);

    verify(el);
    await vi.waitFor(() => expect(documentsSection(el)!.missingIds).toEqual(["d2"]));

    expect(loaded.stubs.findDocs).toHaveBeenCalledWith(LOCAL_EP, "db", { _id: { $in: ["d1", "d2"] } }, 2);
  });

  it("checks _design ids via docExists (false = missing) and resets results when the list changes", async () => {
    const loaded = await loadEditor({ docIds: ["d1", "_design/x"] });
    el = loaded.el;
    loaded.stubs.findDocs.mockResolvedValue([{ _id: "d1" }]);
    loaded.stubs.docExists.mockResolvedValue(false);

    const section = documentsSection(el)!;
    verify(el);
    await vi.waitFor(() => expect(documentsSection(el)!.missingIds).toEqual(["_design/x"]));
    expect(loaded.stubs.docExists).toHaveBeenCalledWith(LOCAL_EP, "db", "_design/x");

    section.dispatchEvent(
      new CustomEvent("cca-doc-ids-change", { detail: { docIds: ["d1"] }, bubbles: true, composed: true }),
    );
    await el.updateComplete;
    expect(documentsSection(el)!.missingIds).toBeNull();
  });

  it("sets verifying on the section while the check is in flight", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    let resolveQuery!: (value: Record<string, unknown>[]) => void;
    loaded.stubs.findDocs.mockReturnValue(new Promise((resolve) => { resolveQuery = resolve; }));

    verify(el);
    await vi.waitFor(() =>
      expect((documentsSection(el) as unknown as { verifying: boolean }).verifying).toBe(true),
    );

    resolveQuery([{ _id: "d1" }, { _id: "d2" }]);
    await vi.waitFor(() =>
      expect((documentsSection(el) as unknown as { verifying: boolean }).verifying).toBe(false),
    );
  });

  it("drops stale verify results when the source db changes while the check is in flight", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    let resolveQuery!: (value: Record<string, unknown>[]) => void;
    loaded.stubs.findDocs.mockReturnValue(new Promise((resolve) => { resolveQuery = resolve; }));

    verify(el);
    await vi.waitFor(() =>
      expect((documentsSection(el) as unknown as { verifying: boolean }).verifying).toBe(true),
    );

    // Source db changes while the verify request is still in flight.
    sourceSection(el)!.dispatchEvent(
      new CustomEvent("cca-endpoint-change", {
        detail: { kind: "source", database: "other" },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    expect(documentsSection(el)!.missingIds).toBeNull();

    // The stale request finally resolves; its results must not clobber the reset.
    resolveQuery([{ _id: "d1" }]);
    await vi.waitFor(() =>
      expect((documentsSection(el) as unknown as { verifying: boolean }).verifying).toBe(false),
    );
    await el.updateComplete;
    expect(documentsSection(el)!.missingIds).toBeNull();
  });

  it("enables canVerify and points the filter section at a remote source", async () => {
    const loaded = await loadEditor({ sourceUrl: "https://unregistered-host/db" });
    el = loaded.el;

    expect(documentsSection(el)!.canVerify).toBe(true);
    const filter = filterSection(el);
    expect(filter?.endpoint).toEqual(REMOTE_EP);
    expect(filter?.sourceDb).toBe("db");
  });

  it("verifies against the remote endpoint, never the local server", async () => {
    const loaded = await loadEditor({ sourceUrl: "https://unregistered-host/db" });
    el = loaded.el;
    loaded.stubs.findDocs.mockResolvedValue([{ _id: "d1" }]);

    verify(el);
    await vi.waitFor(() => expect(documentsSection(el)!.missingIds).toEqual(["d2"]));
    expect(loaded.stubs.findDocs).toHaveBeenCalledWith(REMOTE_EP, "db", { _id: { $in: ["d1", "d2"] } }, 2);
  });

  it("keeps canVerify true and the filter section populated for a local source", async () => {
    const loaded = await loadEditor(); // default sourceUrl "https://a/db"
    el = loaded.el;

    expect(documentsSection(el)!.canVerify).toBe(true);
    const filter = filterSection(el);
    expect(filter?.endpoint).toEqual(LOCAL_EP);
    expect(filter?.sourceDb).toBe("db");
  });

  it("disables verify and the filter source while a stale URL override is active", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    // A loaded/edited source URL that no longer matches (serverUrl, db): the form fields are
    // not the effective source, so nothing may be queried through them.
    (el as unknown as { sourceUrlValue: string }).sourceUrlValue = "https://elsewhere/other";
    await el.updateComplete;

    expect(documentsSection(el)!.canVerify).toBe(false);
    expect(filterSection(el)?.sourceDb).toBe("");

    verify(el);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(loaded.stubs.findDocs).not.toHaveBeenCalled();
  });
});
