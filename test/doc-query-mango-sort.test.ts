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

async function mount(): Promise<any> {
  const header = document.createElement("cca-header");
  document.body.appendChild(header);
  mounted.push(header);

  const el = document.createElement("cca-doc-query") as any;
  el.dbName = "testdb";
  el.serverId = "srv-1";
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);
  return el;
}

/** Dispatches `cca-mango-change` directly on the child `cca-mango`, matching
 * the shape cca-mango's own `_updateQuery()` emits: a `sort` array of
 * single-key `{field: direction}` objects living alongside `selector`. */
function fireMangoChange(
  el: any,
  detail: { selector?: Record<string, unknown>; sort?: unknown[] },
) {
  const mangoEl = el.shadowRoot!.querySelector("cca-mango")!;
  mangoEl.dispatchEvent(
    new CustomEvent("cca-mango-change", {
      detail: { query: { selector: detail.selector ?? { _id: { $gt: null } }, sort: detail.sort } },
      bubbles: true,
      composed: true,
    }),
  );
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
});

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("doc-query Sort panel wiring (#75)", () => {
  it("populates _sortItems from cca-mango-change's sort field instead of discarding it", async () => {
    const el = await mount();
    expect(el._sortItems).toEqual([]);

    fireMangoChange(el, { sort: [{ name: "asc" }, { age: "desc" }] });
    await settle(el);

    expect(el._sortItems).toEqual([
      { field: "name", direction: "asc" },
      { field: "age", direction: "desc" },
    ]);
  });

  it("clears _sortItems when a cca-mango-change event carries no sort", async () => {
    const el = await mount();
    fireMangoChange(el, { sort: [{ name: "asc" }] });
    await settle(el);
    expect(el._sortItems).toEqual([{ field: "name", direction: "asc" }]);

    fireMangoChange(el, { sort: undefined });
    await settle(el);
    expect(el._sortItems).toEqual([]);
  });

  it("a subsequent _runQuery forwards the live sort array to _find", async () => {
    const el = await mount();
    fireMangoChange(el, {
      selector: { status: "open" },
      sort: [{ createdAt: "desc" }],
    });
    await settle(el);

    el._runQuery();
    await settle(el);

    const queryDocuments = getContext().dbMgmt.queryDocuments as ReturnType<
      typeof vi.fn
    >;
    const lastCall = queryDocuments.mock.calls.at(-1)!;
    const request = lastCall[2];
    expect(request.sort).toEqual([{ createdAt: "desc" }]);
    // The selector itself must stay the bare selector, not the whole
    // {selector, sort} envelope.
    expect(request.selector).toEqual({ selector: { status: "open" } });
  });
});

describe("doc-query field-name sampling unwraps the selector (#92)", () => {
  it("_fetchFields sends a bare selector with no leaked selector/sort keys", async () => {
    const el = await mount();
    fireMangoChange(el, {
      selector: { status: "open" },
      sort: [{ createdAt: "desc" }],
    });
    await settle(el);

    await el._fetchFields();

    const queryDocuments = getContext().dbMgmt.queryDocuments as ReturnType<
      typeof vi.fn
    >;
    const lastCall = queryDocuments.mock.calls.at(-1)!;
    const request = lastCall[2];
    expect(request.selector).toEqual({ status: "open" });
    expect(request.selector.selector).toBeUndefined();
    expect(request.selector.sort).toBeUndefined();
    // Sort still reaches the request via the dedicated `sort` field.
    expect(request.sort).toEqual([{ createdAt: "desc" }]);
  });
});
