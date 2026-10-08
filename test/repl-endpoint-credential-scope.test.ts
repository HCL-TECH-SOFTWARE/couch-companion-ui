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
  if (!customElements.get(tag)) customElements.define(tag, class extends Stub {});
}

const STORED = { Authorization: "Basic stored" };

async function loadEditor(headers: Record<string, string> = STORED) {
  const stubs = stubReplEditorServices({
    doc: stubDoc({ source: { url: "http://remote:5984/crm", headers } }),
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

const sourceEndpointEl = (el: CcaReplEditor) =>
  el.shadowRoot!.querySelector('cca-repl-endpoint[kind="source"]') as HTMLElement;
const browserEndpoint = (el: CcaReplEditor) =>
  (sourceEndpointEl(el).shadowRoot!.querySelector("cca-repl-db-browser") as unknown as {
    endpoint: { serverUrl: string; headers: Record<string, string> };
  }).endpoint;
const change = (el: CcaReplEditor, detail: Record<string, unknown>) =>
  sourceEndpointEl(el).dispatchEvent(
    new CustomEvent("cca-endpoint-change", {
      detail: { kind: "source", ...detail },
      bubbles: true,
      composed: true,
    }),
  );
const preview = (el: CcaReplEditor) =>
  (el as unknown as { handlePreview(): Promise<void> }).handlePreview();

describe("stored endpoint credentials are scoped to their origin", () => {
  let el: CcaReplEditor;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("drops loaded headers from Browse and preview once the server origin changes", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    change(el, { serverUrl: "http://evil:5984" });
    await el.updateComplete;
    await sourceEndpointEl(el).updateComplete;

    expect(browserEndpoint(el)).toEqual({ serverUrl: "http://evil:5984", headers: {} });
    await preview(el);
    expect(loaded.stubs.previewReplication).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: { serverUrl: "http://evil:5984", headers: {} } }),
    );
  });

  it("keeps sending stored headers while the origin is unchanged", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    change(el, { database: "other" });
    await el.updateComplete;
    await sourceEndpointEl(el).updateComplete;

    expect(browserEndpoint(el).headers).toEqual(STORED);
    await preview(el);
    expect(loaded.stubs.previewReplication).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: { serverUrl: "http://remote:5984", headers: STORED } }),
    );
  });

  it("sends headers applied this session even at a changed origin", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    change(el, { serverUrl: "http://new:5984" });
    change(el, { auth: { Authorization: "Bearer fresh" } });
    await el.updateComplete;
    await sourceEndpointEl(el).updateComplete;

    expect(browserEndpoint(el).headers).toEqual({ Authorization: "Bearer fresh" });
    await preview(el);
    expect(loaded.stubs.previewReplication).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: { serverUrl: "http://new:5984", headers: { Authorization: "Bearer fresh" } },
      }),
    );
  });

  it("hands Browse cleaned headers, so a blank junk entry never counts as credentials", async () => {
    const loaded = await loadEditor({ Authorization: "" });
    el = loaded.el;
    await el.updateComplete;
    await sourceEndpointEl(el).updateComplete;

    expect(browserEndpoint(el).headers).toEqual({});
  });
});
