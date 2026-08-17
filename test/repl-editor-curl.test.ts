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
import type { Server } from "../src/plugins/server-mgmt/types";
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

/** JSON body between the curl heredoc markers. */
function heredocBody(cmd: string): Record<string, any> {
  const afterMarker = cmd.split("<<'JSON'\n")[1];
  expect(afterMarker).toBeDefined();
  return JSON.parse(afterMarker.slice(0, afterMarker.lastIndexOf("\nJSON")));
}

describe("cca-repl-editor Copy as curl", () => {
  let el: CcaReplEditor;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  async function mountEditor(edit: boolean): Promise<CcaReplEditor> {
    stubReplEditorServices({
      servers: [{ id: "s", name: "S", url: "https://a/" } as Server],
      // Trailing slash kept deliberately: buildReplicatorCurl must normalize
      // it away (see the first test below).
      localBaseUrl: "https://a/",
      doc: stubDoc({
        source: { url: "https://a/db", headers: { Authorization: "Basic c2VjcmV0" } },
      }),
    });
    const editor = document.createElement("cca-repl-editor") as CcaReplEditor;
    if (edit) {
      editor.serverId = "s";
      editor.replId = "r";
    }
    document.body.appendChild(editor);
    await editor.updateComplete;
    await new Promise((r) => setTimeout(r, 0)); // let connectedCallback's awaits settle
    (editor as any).activeTab = "source";
    await editor.updateComplete;
    return editor;
  }

  function copyButton(editor: CcaReplEditor): HTMLElement | null {
    return editor.shadowRoot?.querySelector<HTMLElement>("wa-button.copy-curl") ?? null;
  }

  it("copies a curl POST to the host server's _replicator, stripping _id/_rev", async () => {
    el = await mountEditor(true);
    const btn = copyButton(el);
    expect(btn).not.toBeNull();
    expect(btn?.hasAttribute("disabled")).toBe(false);

    btn?.click();
    await new Promise((r) => setTimeout(r, 0)); // let the async handler settle

    expect(writeText).toHaveBeenCalledTimes(1);
    const cmd = writeText.mock.calls[0][0] as string;
    // Trailing slash on the server url ("https://a/") must be normalized away.
    expect(cmd).toContain('curl -X POST "https://a/_replicator"');
    const body = heredocBody(cmd);
    expect(body._id).toBeUndefined();
    expect(body._rev).toBeUndefined();
    expect(body.source.url).toBe("https://a/db");
    // The app never hands a stored credential back out; curl gets a placeholder instead.
    expect(body.source.headers.Authorization).toBe("REPLACE_WITH_CREDENTIALS");
  });

  it("is enabled immediately in create mode, since the source is always this deployment's one server", async () => {
    el = await mountEditor(false);
    const btn = copyButton(el);
    expect(btn).not.toBeNull();
    expect(btn?.hasAttribute("disabled")).toBe(false);
  });

  it("does not write to the clipboard when the source JSON is invalid", async () => {
    el = await mountEditor(true);
    (el as any).sourceDocJson = "{not json"; // direct edit; updated() only re-syncs on design-key changes
    await el.updateComplete;

    copyButton(el)?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not write to the clipboard when the source JSON is a valid non-object", async () => {
    el = await mountEditor(true);
    (el as any).sourceDocJson = "[1, 2]"; // direct edit; updated() only re-syncs on design-key changes
    await el.updateComplete;

    copyButton(el)?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(writeText).not.toHaveBeenCalled();
  });
});
