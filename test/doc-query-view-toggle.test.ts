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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Prevent monaco-editor from initialising in happy-dom (canvas pixel-ratio crash).
// Must be called before importing the component that transitively pulls in Monaco.
vi.mock("../src/components/cca-monaco-editor.js", () => ({}));

import { getContext } from "../src/context";
import { ApiError } from "../src/services/api-error";
import "../src/components/cca-header";
import "../src/components/cca-toast";
import "../src/plugins/db-mgmt/doc-query";

// Register a minimal cca-monaco-editor stub so the component template renders.
class CcaMonacoEditorMinStub extends HTMLElement {}
if (!customElements.get("cca-monaco-editor")) {
  customElements.define("cca-monaco-editor", CcaMonacoEditorMinStub);
}

// Register a minimal cca-query-history stub so saveHistory calls don't throw.
class CcaQueryHistoryStub extends HTMLElement {
  saveHistory() {
    return Promise.resolve();
  }
}
if (!customElements.get("cca-query-history")) {
  customElements.define("cca-query-history", CcaQueryHistoryStub);
}

let mounted: HTMLElement[] = [];

async function settle(el: any) {
  for (let i = 0; i < 10; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

async function mountWithResults(): Promise<any> {
  const header = document.createElement("cca-header");
  document.body.appendChild(header);
  mounted.push(header);

  const el = document.createElement("cca-doc-query") as any;
  el.dbName = "testdb";
  el.serverId = "srv-1";
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);

  // Setup, not the behavior under test: put results on screen so the
  // results header (and with it the view toggle) renders.
  el._runQuery();
  await settle(el);
  expect(el._ran).toBe(true);
  return el;
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(getContext().dbMgmt, "listDatabases").mockResolvedValue([
    { db_name: "testdb", servers: [{ server_id: "srv-1" }] },
  ] as any);
  vi.spyOn(getContext().dbMgmt, "queryDocuments").mockResolvedValue({
    documents: [{ _id: "doc:1", name: "x" }],
    bookmark: "",
    total_count: 1,
  } as any);
  vi.spyOn(getContext().dbMgmt, "getDoc").mockResolvedValue({
    entries: [],
  } as any);
  vi.spyOn(getContext().dbMgmt, "saveDocument").mockResolvedValue({} as any);
});

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("doc-query result-view toggle (#830)", () => {
  it("renders the toggle as a labelled radio group with radio semantics", async () => {
    const el = await mountWithResults();
    const group = el.shadowRoot!.querySelector(
      'wa-radio-group[label="Result view"]',
    );
    expect(group).not.toBeNull();
    const table = el.shadowRoot!.querySelector("#view-table")!;
    const json = el.shadowRoot!.querySelector("#view-json")!;
    expect(table.getAttribute("role")).toBe("radio");
    expect(json.getAttribute("role")).toBe("radio");
  });

  it("defaults to the table view with AT-visible checked state", async () => {
    const el = await mountWithResults();
    expect(
      el.shadowRoot!.querySelector("#view-table")!.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      el.shadowRoot!.querySelector("#view-json")!.getAttribute("aria-checked"),
    ).toBe("false");
    expect(el.shadowRoot!.querySelector("cca-data-table")).not.toBeNull();
  });

  it("a real click on JSON flips the view and the checked state", async () => {
    const el = await mountWithResults();
    (el.shadowRoot!.querySelector("#view-json") as HTMLElement).click();
    await settle(el);
    expect(
      el.shadowRoot!.querySelector("#view-json")!.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      el.shadowRoot!.querySelector("#view-table")!.getAttribute("aria-checked"),
    ).toBe("false");
    expect(el.shadowRoot!.querySelector("cca-data-table")).toBeNull();

    (el.shadowRoot!.querySelector("#view-table") as HTMLElement).click();
    await settle(el);
    expect(el.shadowRoot!.querySelector("cca-data-table")).not.toBeNull();
  });

  it("carries no inline style hacks on the toggle", async () => {
    const el = await mountWithResults();
    const group = el.shadowRoot!.querySelector(".view-toggle-group")!;
    expect(group.querySelector("wa-button")).toBeNull();
    for (const radio of Array.from(group.querySelectorAll("wa-radio"))) {
      expect((radio as HTMLElement).getAttribute("style")).toBeNull();
    }
  });
});

describe("doc-query surfaces the CouchDB reason on query failure, not 'undefined'", () => {
  it("renders err.message (the reason) when the ApiError body carries no `detail` field", async () => {
    const toastEl = document.createElement("cca-toast") as any;
    document.body.appendChild(toastEl);
    mounted.push(toastEl);
    await toastEl.updateComplete;

    (getContext().dbMgmt.queryDocuments as any).mockRejectedValueOnce(
      new ApiError(400, "Invalid selector syntax", {
        error: "bad_request",
        reason: "Invalid selector syntax",
      }),
    );

    const el = document.createElement("cca-doc-query") as any;
    el.dbName = "testdb";
    el.serverId = "srv-1";
    document.body.appendChild(el);
    mounted.push(el);
    await settle(el);

    el._runQuery();
    await settle(el);

    const text =
      toastEl.shadowRoot!.querySelector(".toast.error")?.textContent ?? "";
    expect(text).toContain("Invalid selector syntax");
    expect(text).not.toContain("undefined");
  });
});
