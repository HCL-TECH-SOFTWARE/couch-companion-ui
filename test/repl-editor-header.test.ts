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

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { LitElement } from "lit";
import "../src/plugins/replication/repl-editor.js";
import type { CcaReplEditor } from "../src/plugins/replication/repl-editor.js";
import "../src/components/cca-header.js";
import type { CcaHeader } from "../src/components/cca-header.js";
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

describe("cca-repl-editor header actions", () => {
  let header: CcaHeader;
  let el: CcaReplEditor;

  beforeEach(async () => {
    header = document.createElement("cca-header") as CcaHeader;
    document.body.appendChild(header);
    await header.updateComplete;
  });

  afterEach(() => {
    el?.remove();
    header.remove();
    vi.restoreAllMocks();
  });

  it("registers Preview/Save/Cancel as header actions and drops the inline toolbar", async () => {
    stubReplEditorServices({ doc: stubDoc({ doc_ids: ["d1", "d2"] }) });
    el = document.createElement("cca-repl-editor") as CcaReplEditor;
    document.body.appendChild(el);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0)); // let connectedCallback's awaits settle
    await header.updateComplete;

    // Scoped to .subactions: cca-header also renders a fixed, id-less Logout
    // cca-action outside .subactions (see cca-header.test.ts's own `subactions()`
    // helper), which an unscoped `cca-action` query would also match.
    const ids = [...(header.shadowRoot?.querySelectorAll(".subactions cca-action") ?? [])].map((a) => a.id);
    expect(ids).toEqual(["repl-preview", "repl-save", "repl-cancel"]);
    expect(el.shadowRoot?.querySelector(".toolbar")).toBeNull();
  });

  it("disables Save while source is unselected, and clears actions on disconnect", async () => {
    stubReplEditorServices({ doc: stubDoc({ doc_ids: ["d1", "d2"] }) });
    el = document.createElement("cca-repl-editor") as CcaReplEditor;
    document.body.appendChild(el);
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    await header.updateComplete;

    const save = header.shadowRoot?.querySelector<HTMLElement>("cca-action#repl-save");
    expect(save?.hasAttribute("disabled")).toBe(true); // no source server/db yet → rails block save

    el.remove();
    await header.updateComplete;
    expect(header.shadowRoot?.querySelectorAll(".subactions cca-action").length).toBe(0);
  });
});
