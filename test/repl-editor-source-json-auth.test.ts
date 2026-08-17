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
import { CREDENTIAL_PLACEHOLDER } from "../src/plugins/replication/replicator-curl.js";
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

const SOURCE_AUTH = "Basic c2VjcmV0";
const TARGET_AUTH = "Bearer ttok";

function authDoc() {
  return stubDoc({
    source: { url: "https://a/db", headers: { Authorization: SOURCE_AUTH } },
    target: { url: "https://a/db2", headers: { Authorization: TARGET_AUTH } },
  });
}

type Stubs = ReturnType<typeof stubReplEditorServices>;

async function loadEditor(): Promise<{ el: CcaReplEditor; stubs: Stubs }> {
  const stubs = stubReplEditorServices({ doc: authDoc() });
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
  const [, , body] = stubs.updateReplication.mock.calls[0];
  return body as unknown as Record<string, unknown>;
}

describe("cca-repl-editor Source JSON auth masking", () => {
  let el: CcaReplEditor;

  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("masks stored Authorization headers in the Source JSON view, not the real secret", async () => {
    ({ el } = await loadEditor());

    const json = (el as unknown as { sourceDocJson: string }).sourceDocJson;
    expect(json).not.toContain("c2VjcmV0");
    expect(json).not.toContain("ttok");
    const parsed = JSON.parse(json) as {
      source: { headers: Record<string, string> };
      target: { headers: Record<string, string> };
    };
    expect(parsed.source.headers.Authorization).toBe(CREDENTIAL_PLACEHOLDER);
    expect(parsed.target.headers.Authorization).toBe(CREDENTIAL_PLACEHOLDER);
  });

  it("resolves the masked sentinel back to the real Authorization value on submit", async () => {
    const loaded = await loadEditor();
    el = loaded.el;

    // Edit an unrelated field in the Source JSON; leave the masked Authorization
    // sentinel exactly as displayed.
    const parsed = JSON.parse(
      (el as unknown as { sourceDocJson: string }).sourceDocJson,
    ) as Record<string, unknown>;
    parsed.owner = "changed-owner";
    (el as unknown as { sourceDocJson: string }).sourceDocJson = JSON.stringify(
      parsed,
      null,
      2,
    );
    (el as unknown as { activeTab: string }).activeTab = "source";
    await el.updateComplete;

    const body = await submitAndGetPutBody(el, loaded.stubs);
    expect(body.owner).toBe("changed-owner");
    const written = body as {
      source: { headers: Record<string, string> };
      target: { headers: Record<string, string> };
    };
    // The written document carries the ORIGINAL credential, not the sentinel.
    expect(written.source.headers.Authorization).toBe(SOURCE_AUTH);
    expect(written.target.headers.Authorization).toBe(TARGET_AUTH);
  });

  it("masks a credential stored under a custom header name too, not just Authorization, and splices it back on apply", async () => {
    // The auth panel's "Custom headers" mode can store a credential under any header name
    // (e.g. X-Auth-CouchDB-Token, Cookie) — masking must be key-generic, not an Authorization
    // lookup, or that credential would reach the Source JSON tab verbatim (finding #2).
    const stubs = stubReplEditorServices({
      doc: stubDoc({
        source: {
          url: "https://a/db",
          headers: { "X-Auth-CouchDB-Token": "tok-c2VjcmV0" },
        },
        target: { url: "https://a/db2", headers: {} },
      }),
    });
    el = document.createElement("cca-repl-editor") as CcaReplEditor;
    (el as unknown as { serverId: string }).serverId = "s";
    (el as unknown as { replId: string }).replId = "r";
    document.body.appendChild(el);
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    const json = (el as unknown as { sourceDocJson: string }).sourceDocJson;
    expect(json).not.toContain("tok-c2VjcmV0");
    const parsed = JSON.parse(json) as Record<string, unknown> & {
      source: { headers: Record<string, string> };
    };
    expect(parsed.source.headers["X-Auth-CouchDB-Token"]).toBe(CREDENTIAL_PLACEHOLDER);

    // Edit an unrelated field, leaving the masked custom header exactly as displayed.
    parsed.owner = "changed-owner";
    (el as unknown as { sourceDocJson: string }).sourceDocJson = JSON.stringify(parsed);
    (el as unknown as { activeTab: string }).activeTab = "source";
    await el.updateComplete;

    const body = await submitAndGetPutBody(el, stubs);
    const written = body as { source: { headers: Record<string, string> } };
    expect(written.source.headers["X-Auth-CouchDB-Token"]).toBe("tok-c2VjcmV0");
  });

  it("still writes a genuinely typed new credential instead of resolving it", async () => {
    const loaded = await loadEditor();
    el = loaded.el;

    const parsed = JSON.parse(
      (el as unknown as { sourceDocJson: string }).sourceDocJson,
    ) as {
      source: { headers: Record<string, string> };
      target: { headers: Record<string, string> };
    };
    parsed.source.headers.Authorization = "Bearer freshly-typed";
    (el as unknown as { sourceDocJson: string }).sourceDocJson = JSON.stringify(
      parsed,
      null,
      2,
    );
    (el as unknown as { activeTab: string }).activeTab = "source";
    await el.updateComplete;

    const body = await submitAndGetPutBody(el, loaded.stubs);
    const written = body as {
      source: { headers: Record<string, string> };
      target: { headers: Record<string, string> };
    };
    expect(written.source.headers.Authorization).toBe("Bearer freshly-typed");
    // Target's sentinel was left untouched, so it still resolves to the stored value.
    expect(written.target.headers.Authorization).toBe(TARGET_AUTH);
  });
});
