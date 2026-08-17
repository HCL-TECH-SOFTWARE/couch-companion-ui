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
import "../src/plugins/replication/repl-documents-section.js";
import type { CcaReplDocumentsSection } from "../src/plugins/replication/repl-documents-section.js";

class WaStub extends LitElement {
  value = "";
  createRenderRoot() {
    return this;
  }
}
for (const tag of ["wa-tag", "wa-input", "wa-button", "wa-icon"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

function root(el: CcaReplDocumentsSection): ShadowRoot {
  if (!el.shadowRoot) throw new Error("expected shadowRoot");
  return el.shadowRoot;
}

async function mount(docIds: string[] = []): Promise<CcaReplDocumentsSection> {
  const el = document.createElement(
    "cca-repl-documents-section",
  ) as CcaReplDocumentsSection;
  el.docIds = docIds;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("cca-repl-documents-section", () => {
  let el: CcaReplDocumentsSection;
  afterEach(() => el?.remove());

  it("renders one pill per document id", async () => {
    el = await mount(["alpha", "beta"]);
    expect(root(el).querySelectorAll("wa-tag").length).toBe(2);
  });

  it("emits cca-doc-ids-change with the added id", async () => {
    el = await mount(["alpha"]);
    let detail: { docIds: string[] } | undefined;
    el.addEventListener("cca-doc-ids-change", (e) => {
      detail = (e as CustomEvent<{ docIds: string[] }>).detail;
    });
    (el as unknown as { _input: string })._input = "beta";
    (root(el).querySelector("wa-button") as HTMLElement).click();
    expect(detail?.docIds).toEqual(["alpha", "beta"]);
  });

  it("ignores blank input", async () => {
    el = await mount(["alpha"]);
    let fired = false;
    el.addEventListener("cca-doc-ids-change", () => (fired = true));
    (el as unknown as { _input: string })._input = "   ";
    (root(el).querySelector("wa-button") as HTMLElement).click();
    expect(fired).toBe(false);
  });

  it("ignores a duplicate id", async () => {
    el = await mount(["alpha"]);
    let fired = false;
    el.addEventListener("cca-doc-ids-change", () => (fired = true));
    (el as unknown as { _input: string })._input = "alpha";
    (root(el).querySelector("wa-button") as HTMLElement).click();
    expect(fired).toBe(false);
  });

  it("emits without a removed id", async () => {
    el = await mount(["alpha", "beta"]);
    let detail: { docIds: string[] } | undefined;
    el.addEventListener("cca-doc-ids-change", (e) => {
      detail = (e as CustomEvent<{ docIds: string[] }>).detail;
    });
    (root(el).querySelector(".tag-remove") as HTMLElement).click();
    expect(detail?.docIds).toEqual(["beta"]);
  });

  it("disables Verify when canVerify is false or the list is empty", async () => {
    el = await mount(["a"]);
    el.canVerify = false;
    await el.updateComplete;
    expect(root(el).querySelector('[data-verify]')?.hasAttribute("disabled")).toBe(true);

    el.canVerify = true;
    el.docIds = [];
    await el.updateComplete;
    expect(root(el).querySelector('[data-verify]')?.hasAttribute("disabled")).toBe(true);
  });

  it("emits cca-verify-docs on Verify click", async () => {
    el = await mount(["a"]);
    el.canVerify = true;
    await el.updateComplete;
    let fired = 0;
    el.addEventListener("cca-verify-docs", () => { fired += 1; });
    (root(el).querySelector('[data-verify]') as HTMLElement).dispatchEvent(new Event("click"));
    expect(fired).toBe(1);
  });

  it("marks pills found/missing and shows a summary once missingIds is set", async () => {
    el = await mount(["a", "b", "c"]);
    el.missingIds = ["b"];
    await el.updateComplete;
    expect(root(el).querySelectorAll('[data-status="found"]').length).toBe(2);
    expect(root(el).querySelectorAll('[data-status="missing"]').length).toBe(1);
    expect(root(el).querySelector("[data-verify-summary]")?.textContent).toContain("2 of 3");
  });

  it("shows no markers or summary before verification (missingIds null)", async () => {
    el = await mount(["a"]);
    await el.updateComplete;
    expect(root(el).querySelectorAll("[data-status]").length).toBe(0);
    expect(root(el).querySelector("[data-verify-summary]")).toBeNull();
  });
});
