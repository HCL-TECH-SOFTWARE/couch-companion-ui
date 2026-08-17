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
import { stubDoc, stubReplEditorServices } from "./helpers/repl-editor-stubs";

// Stub the editor's child components so only the editor logic runs.
class Stub extends LitElement {
  auth: Record<string, string> = {};
  createRenderRoot() {
    return this;
  }
}
for (const tag of [
  "wa-button",
  "wa-textarea",
  "cca-repl-source-section",
  "cca-repl-target-section",
  "cca-repl-selector-section",
  "cca-repl-filter-section",
  "cca-repl-behavior-section",
  "cca-repl-issues-panel",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends Stub {});
  }
}

const BASIC = `Basic ${btoa("alice:secret")}`;

/** Same doc the old fetch mock served: loaded endpoint headers on both sides. */
function authDoc() {
  return stubDoc({
    source: { url: "https://a/db", headers: { Authorization: BASIC } },
    target: { url: "https://a/db2", headers: { Authorization: "Bearer ttok" } },
  });
}

async function mountEditor() {
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

describe("cca-repl-editor auth wiring", () => {
  let el: CcaReplEditor;

  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("passes the loaded source headers object to the source section as auth", async () => {
    ({ el } = await mountEditor());

    const source = el.shadowRoot!.querySelector(
      "cca-repl-source-section",
    ) as unknown as { auth: Record<string, string> };
    expect(source.auth).toEqual({ Authorization: BASIC });
    // Regression: the removed mode prop must not be wired anymore.
    expect(
      (source as unknown as Record<string, unknown>).authMode,
    ).toBeUndefined();
  });

  it("passes the loaded target headers object to the target section as auth", async () => {
    ({ el } = await mountEditor());

    const target = el.shadowRoot!.querySelector(
      "cca-repl-target-section",
    ) as unknown as { auth: Record<string, string> };
    expect(target.auth).toEqual({ Authorization: "Bearer ttok" });
  });

  it("saves source/target endpoint headers matching the loaded auth objects", async () => {
    const { el: mounted, stubs } = await mountEditor();
    el = mounted;

    const form = el.shadowRoot!.querySelector(
      "#replication-editor-form",
    ) as HTMLFormElement;
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );

    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    const put = stubs.updateReplication.mock.calls[0];
    expect(
      put,
      `save was blocked: ${(el as unknown as { error: string }).error}`,
    ).toBeDefined();
    expect(put[0]).toBe("s");
    expect(put[1]).toBe("r");
    const body = put[2] as {
      source: { headers: Record<string, string> };
      target: { headers: Record<string, string> };
    };
    expect(body.source.headers.Authorization).toBe(BASIC);
    expect(body.target.headers.Authorization).toBe("Bearer ttok");
  });

  it("defaults source/target auth to no stored credential on a fresh Create Replication screen", async () => {
    stubReplEditorServices();
    el = document.createElement("cca-repl-editor") as CcaReplEditor;
    // Create mode: no serverId/replId, so no doc is ever loaded — sourceAuth/targetAuth
    // must start at {} rather than the old `{ Authorization: "Bearer " }` placeholder,
    // which the auth panel used to misread as a stored credential (locking both dialogs
    // on Replace/Clear with no way to type a first credential).
    document.body.appendChild(el);
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    const source = el.shadowRoot!.querySelector(
      "cca-repl-source-section",
    ) as unknown as { auth: Record<string, string> };
    const target = el.shadowRoot!.querySelector(
      "cca-repl-target-section",
    ) as unknown as { auth: Record<string, string> };
    expect(source.auth).toEqual({});
    expect(target.auth).toEqual({});
  });

  it("defaults to no stored credential when an edit-mode doc has no headers at all", async () => {
    const stubs = stubReplEditorServices({
      doc: stubDoc({
        source: { url: "https://a/db" },
        target: { url: "https://a/db2" },
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
    void stubs;

    const source = el.shadowRoot!.querySelector(
      "cca-repl-source-section",
    ) as unknown as { auth: Record<string, string> };
    const target = el.shadowRoot!.querySelector(
      "cca-repl-target-section",
    ) as unknown as { auth: Record<string, string> };
    expect(source.auth).toEqual({});
    expect(target.auth).toEqual({});
  });
});
