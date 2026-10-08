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
import { CORS_HELP_URL } from "../src/plugins/replication/endpoint-errors";
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

const REMOTE_ENDPOINT = { serverUrl: "http://remote:5984", headers: { Authorization: "Basic x" } };

async function loadRemoteEditor(docIds: string[] = []) {
  const stubs = stubReplEditorServices({
    doc: stubDoc({
      source: { url: "http://remote:5984/crm", headers: { Authorization: "Basic x" } },
      doc_ids: docIds,
    }),
  });
  const el = document.createElement("cca-repl-editor") as CcaReplEditor;
  (el as unknown as { serverId: string }).serverId = "s";
  (el as unknown as { replId: string }).replId = "r";
  document.body.appendChild(el);
  await vi.waitFor(async () => {
    await el.updateComplete;
    expect((el as unknown as { sourceDb: string }).sourceDb).toBe("crm");
  });
  return { el, stubs };
}

describe("cca-repl-editor against a remote source", () => {
  let el: CcaReplEditor;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("previews against the entered remote source with the entered auth", async () => {
    const loaded = await loadRemoteEditor();
    el = loaded.el;

    await (el as unknown as { handlePreview(): Promise<void> }).handlePreview();

    expect(loaded.stubs.previewReplication).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: REMOTE_ENDPOINT, source_db: "crm" }),
    );
    expect(loaded.stubs.previewReplication.mock.calls[0][0]).not.toHaveProperty("source_server_id");
  });

  it("verify-docs checks the remote source and reports missing ids", async () => {
    const loaded = await loadRemoteEditor(["a", "b"]);
    el = loaded.el;
    loaded.stubs.findDocs.mockResolvedValue([{ _id: "a" }]);
    await el.updateComplete;
    const docs = el.shadowRoot!.querySelector("cca-repl-documents-section") as HTMLElement & {
      canVerify: boolean;
      missingIds: string[] | null;
    };
    expect(docs.canVerify).toBe(true);

    docs.dispatchEvent(new CustomEvent("cca-verify-docs", { bubbles: true, composed: true }));
    await vi.waitFor(() => expect(docs.missingIds).toEqual(["b"]));
    expect(loaded.stubs.findDocs).toHaveBeenCalledWith(REMOTE_ENDPOINT, "crm", { _id: { $in: ["a", "b"] } }, 2);
  });

  it("a failed preview shows the endpoint failure story with the help link", async () => {
    const loaded = await loadRemoteEditor();
    el = loaded.el;
    loaded.stubs.previewReplication.mockRejectedValue(new TypeError("Failed to fetch"));

    await (el as unknown as { handlePreview(): Promise<void> }).handlePreview();
    await el.updateComplete;

    const error = el.shadowRoot!.querySelector("p.error");
    expect(error?.textContent).toContain("Could not reach the server");
    expect(el.shadowRoot!.querySelector(`a[href="${CORS_HELP_URL}"]`)).not.toBeNull();
  });

  it("clears the help link once the next preview succeeds", async () => {
    const loaded = await loadRemoteEditor();
    el = loaded.el;
    loaded.stubs.previewReplication.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const preview = () => (el as unknown as { handlePreview(): Promise<void> }).handlePreview();

    await preview();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector("p.error a")).not.toBeNull();

    await preview();
    await el.updateComplete;
    expect(el.shadowRoot!.querySelector("p.error")).toBeNull();
  });
});
