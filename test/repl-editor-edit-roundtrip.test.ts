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
  "cca-repl-source-section",
  "cca-repl-target-section",
  "cca-repl-selector-section",
  "cca-repl-filter-section",
  "cca-repl-behavior-section",
  "cca-repl-documents-section",
  "cca-repl-query-params-section",
  "cca-repl-winning-revs-section",
  "cca-repl-since-seq-section",
  "cca-repl-issues-panel",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends Stub {});
  }
}

// The stored doc the editor edit-loads — same payload the pre-#687 global-fetch
// mock served for GET /api/replications/s/r (#812/#813/#799 contract data).
function editDoc() {
  return stubDoc({
    create_target: true,
    selector: { year: { $gt: 2010 }, status: "open" },
    doc_ids: ["doc:1", "doc:2"],
    use_checkpoints: true,
    checkpoint_interval: 30000,
    retries_per_request: 5,
    worker_processes: 4,
    worker_batch_size: 500,
    http_connections: 20,
  });
}

type Stubs = ReturnType<typeof stubReplEditorServices>;

async function loadEditor(): Promise<{ el: CcaReplEditor; stubs: Stubs }> {
  const stubs = stubReplEditorServices({ doc: editDoc() });
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

async function submitAndGetPutBody(
  el: CcaReplEditor,
  stubs: Stubs,
): Promise<Record<string, unknown>> {
  const form = el.shadowRoot!.querySelector(
    "#replication-editor-form",
  ) as HTMLFormElement;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  expect(
    stubs.updateReplication,
    `save blocked: ${(el as unknown as { error: string }).error}`,
  ).toHaveBeenCalled();
  const [serverId, replId, body] = stubs.updateReplication.mock.calls[0];
  expect(serverId).toBe("s");
  expect(replId).toBe("r");
  return body as unknown as Record<string, unknown>;
}

describe("cca-repl-editor edit round-trip", () => {
  let el: CcaReplEditor;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("edit-loads doc_ids from the API response and echoes them in the PUT body (#812)", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    const state = el as unknown as { docIds: string[] };
    expect(state.docIds).toEqual(["doc:1", "doc:2"]);
    const body = await submitAndGetPutBody(el, loaded.stubs);
    expect(body.doc_ids).toEqual(["doc:1", "doc:2"]);
  });

  it("edit-loads nested Mango selectors without flattening (#813)", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    const state = el as unknown as { selectorJson: string };
    expect(JSON.parse(state.selectorJson)).toEqual({
      year: { $gt: 2010 },
      status: "open",
    });
    const body = await submitAndGetPutBody(el, loaded.stubs);
    // The native _replicator document's selector is an object (unlike the
    // old CCA wire body, which JSON-stringified it) — see ReplicatorDoc.
    expect(body.selector).toEqual({
      year: { $gt: 2010 },
      status: "open",
    });
  });

  it("edit-loads create_target and carries tuning fields into both the Source doc and the PUT body (#799)", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    const state = el as unknown as { createTarget: boolean; sourceDocJson: string };
    expect(state.createTarget).toBe(true);
    const sourceDoc = JSON.parse(state.sourceDocJson) as Record<string, unknown>;
    expect(sourceDoc.create_target).toBe(true);
    expect(sourceDoc.use_checkpoints).toBe(true);
    expect(sourceDoc.checkpoint_interval).toBe(30000);
    expect(sourceDoc.retries_per_request).toBe(5);
    expect(sourceDoc.worker_processes).toBe(4);
    expect(sourceDoc.worker_batch_size).toBe(500);
    expect(sourceDoc.http_connections).toBe(20);
    const body = await submitAndGetPutBody(el, loaded.stubs);
    // The editor now saves a native _replicator document directly (Task 3):
    // tuning fields the form has no controls for ride straight through, the
    // opposite of the old CCA wire body, which dropped them and relied on
    // the backend re-adding stored values from its own read-modify-write.
    expect(body.use_checkpoints).toBe(true);
    expect(body.checkpoint_interval).toBe(30000);
    expect(body.retries_per_request).toBe(5);
    expect(body.worker_processes).toBe(4);
    expect(body.worker_batch_size).toBe(500);
    expect(body.http_connections).toBe(20);
  });
});
