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

import { describe, it, expect, afterEach } from "vitest";
import { LitElement } from "lit";
import "../src/plugins/replication/repl-target-section.js";
import type { CcaReplTargetSection } from "../src/plugins/replication/repl-target-section.js";

class WaStub extends LitElement {
  value = "";
  createRenderRoot() {
    return this;
  }
}
for (const tag of ["wa-details", "wa-input"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

function root(el: CcaReplTargetSection): ShadowRoot {
  if (!el.shadowRoot) throw new Error("expected shadowRoot");
  return el.shadowRoot;
}

describe("cca-repl-target-section", () => {
  let el: CcaReplTargetSection;

  afterEach(() => el?.remove());

  it("lays out a URL input, a database field and auth on one row", async () => {
    el = document.createElement(
      "cca-repl-target-section",
    ) as CcaReplTargetSection;
    document.body.appendChild(el);
    await el.updateComplete;

    const row = root(el).querySelector(".row");
    // The server picker is gone (Task 3): a free-text URL field for the
    // server, plus the existing database field — two wa-inputs total.
    expect(row?.querySelector('wa-input[type="url"]')).toBeTruthy();
    expect(row?.querySelectorAll("wa-input").length).toBe(2);
    expect(row?.querySelector("cca-repl-auth-panel")).toBeTruthy();
  });

  it("shows the CouchDB-3-has-no-local-endpoints hint", async () => {
    el = document.createElement(
      "cca-repl-target-section",
    ) as CcaReplTargetSection;
    document.body.appendChild(el);
    await el.updateComplete;

    expect(root(el).textContent).toMatch(/full URL and credentials/i);
  });

  it("dispatches cca-target-server-url-change when the URL input changes", async () => {
    el = document.createElement(
      "cca-repl-target-section",
    ) as CcaReplTargetSection;
    document.body.appendChild(el);
    await el.updateComplete;

    let detail: { targetServerUrl: string } | undefined;
    el.addEventListener("cca-target-server-url-change", (e) => {
      detail = (e as CustomEvent<{ targetServerUrl: string }>).detail;
    });

    const urlInput = root(el).querySelector('wa-input[type="url"]')!;
    (urlInput as unknown as { value: string }).value =
      "https://remote.example:6984";
    urlInput.dispatchEvent(new Event("input"));

    expect(detail?.targetServerUrl).toBe("https://remote.example:6984");
  });

  it("re-dispatches cca-auth-change as cca-target-auth-change", async () => {
    el = document.createElement(
      "cca-repl-target-section",
    ) as CcaReplTargetSection;
    document.body.appendChild(el);
    await el.updateComplete;

    const panel = root(el).querySelector("cca-repl-auth-panel")!;
    let detail: { auth: Record<string, string> } | undefined;
    el.addEventListener("cca-target-auth-change", (e) => {
      detail = (e as CustomEvent<{ auth: Record<string, string> }>).detail;
    });

    panel.dispatchEvent(
      new CustomEvent("cca-auth-change", {
        detail: { auth: { "X-Api-Key": "k" } },
        bubbles: true,
        composed: true,
      }),
    );

    expect(detail?.auth).toEqual({ "X-Api-Key": "k" });
  });
});
