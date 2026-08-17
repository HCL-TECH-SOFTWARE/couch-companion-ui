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

/**
 * `doc-query`'s half of #80: the page-size selector, the skip box, and the previous/next
 * pair — all of it the same `cca-page-controls` `doc-browser` wears, so the two screens
 * cannot drift apart again.
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

function create(): any {
  const el = document.createElement("cca-doc-query") as any;
  el.dbName = "testdb";
  el.serverId = "srv-1";
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

/** Mounts and runs one query, so the results area — and with it the footer — exists. */
async function mountWithResults(): Promise<any> {
  const header = document.createElement("cca-header");
  document.body.appendChild(header);
  mounted.push(header);

  const el = create();
  await settle(el);
  el._runQuery();
  await settle(el);
  expect(el._ran).toBe(true);
  return el;
}

const queryMock = () => getContext().dbMgmt.queryDocuments as any;

/** The request object of the most recent `_find` call. */
const lastRequest = () => queryMock().mock.calls.at(-1)![2];

/** The shared footer's own shadow root. */
const controlsOf = (el: any): ShadowRoot =>
  el.shadowRoot!.querySelector("cca-page-controls")!.shadowRoot!;

async function choosePageSize(el: any, size: number) {
  const select = controlsOf(el).querySelector("[data-page-size]") as any;
  select.value = String(size);
  select.dispatchEvent(new Event("change"));
  await settle(el);
}

async function enterSkip(el: any, raw: string) {
  const input = controlsOf(el).querySelector("[data-skip]") as any;
  input.value = raw;
  input.dispatchEvent(new Event("input"));
  input.dispatchEvent(new Event("change"));
  await settle(el);
}

/** Answers `_find` with `count` documents, the way a full page comes back. */
function answerWith(count: number) {
  queryMock().mockResolvedValue({
    documents: Array.from({ length: count }, (_, i) => ({
      _id: `doc:${i}`,
      name: "x",
    })),
    bookmark: "bm",
  } as any);
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(getContext().dbMgmt, "listDatabases").mockResolvedValue([
    { db_name: "testdb", servers: [{ server_id: "srv-1" }] },
  ] as any);
  vi.spyOn(getContext().dbMgmt, "queryDocuments").mockResolvedValue({
    documents: [{ _id: "doc:1", name: "x" }],
    bookmark: "",
  } as any);
});

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("doc-query page size (#80)", () => {
  // The trap this issue calls out: `_find` with no `limit` silently truncates at 25,
  // so a 50- or 100-per-page choice would come back short and read as the last page.
  it("always sends an explicit limit — on the first page and on every later one", async () => {
    const el = await mountWithResults();
    expect(lastRequest().limit).toBe(25);

    // A full first page hands back the bookmark the second page is fetched with.
    answerWith(25);
    el._runQuery();
    await settle(el);
    el._nextPage();
    await settle(el);
    expect(lastRequest().limit).toBe(25);
    expect(lastRequest().bookmark).toBe("bm");
  });

  it("re-requests with the chosen limit", async () => {
    const el = await mountWithResults();
    await choosePageSize(el, 100);
    expect(lastRequest().limit).toBe(100);
  });

  it("remembers the choice in localStorage, so a fresh screen starts there", async () => {
    const el = await mountWithResults();
    await choosePageSize(el, 5);
    expect(localStorage.getItem("ccaDocQueryPageSize")).toBe("5");

    // A reload is a new element reading the same localStorage.
    const reloaded = create();
    await settle(reloaded);
    reloaded._runQuery();
    await settle(reloaded);
    expect(lastRequest().limit).toBe(5);
  });

  it("returns to the first page, dropping bookmarks minted at the old size", async () => {
    const el = await mountWithResults();
    answerWith(25);
    el._nextPage();
    await settle(el);
    expect(el._page).toBe(1);

    await choosePageSize(el, 10);
    expect(el._page).toBe(0);
    expect(lastRequest().bookmark).toBeUndefined();
    expect(lastRequest().limit).toBe(10);
  });

  // "Run Preview (Max 10 Docs)" used to be told apart from a real page by its limit
  // being 10 — which 10-per-page would have made ambiguous, routing every page into
  // the preview panel.
  it("keeps preview at 10 documents and out of the results, even at 10 per page", async () => {
    const el = await mountWithResults();
    await choosePageSize(el, 10);

    queryMock().mockResolvedValue({
      documents: [{ _id: "preview:1" }],
      bookmark: "",
    } as any);
    el._runPreview();
    await settle(el);

    expect(lastRequest().limit).toBe(10);
    expect(el._previewResults).toEqual([{ _id: "preview:1" }]);
    expect(el._results).not.toEqual([{ _id: "preview:1" }]);
  });
});

describe("doc-query skip (#80)", () => {
  it("sends the skip box's value on as a `_find` param", async () => {
    const el = await mountWithResults();
    await enterSkip(el, "40");
    expect(lastRequest().skip).toBe(40);
  });

  it("refuses a skip that is not a whole number, and queries nothing", async () => {
    const el = await mountWithResults();
    const before = queryMock().mock.calls.length;
    await enterSkip(el, "-5");
    expect(queryMock().mock.calls.length).toBe(before);
  });

  it("never sends a skip with a preview", async () => {
    const el = await mountWithResults();
    await enterSkip(el, "40");
    el._runPreview();
    await settle(el);
    expect(lastRequest().skip).toBeUndefined();
  });
});

describe("doc-query previous/next are hidden, not disabled (#80)", () => {
  it("shows neither button on a single short page", async () => {
    const el = await mountWithResults();
    expect(controlsOf(el).querySelector("[data-prev-page]")).toBeNull();
    expect(controlsOf(el).querySelector("[data-next-page]")).toBeNull();
  });

  it("shows Next once a full page says there may be more", async () => {
    const el = await mountWithResults();
    answerWith(25);
    el._runQuery();
    await settle(el);
    expect(controlsOf(el).querySelector("[data-next-page]")).not.toBeNull();
    expect(controlsOf(el).querySelector("[data-prev-page]")).toBeNull();
  });

  it("shows Previous only from the second page onwards", async () => {
    const el = await mountWithResults();
    answerWith(25);
    el._runQuery();
    await settle(el);

    (controlsOf(el).querySelector("[data-next-page]") as HTMLElement).click();
    await settle(el);
    expect(el._page).toBe(1);
    expect(controlsOf(el).querySelector("[data-prev-page]")).not.toBeNull();

    (controlsOf(el).querySelector("[data-prev-page]") as HTMLElement).click();
    await settle(el);
    expect(el._page).toBe(0);
    expect(controlsOf(el).querySelector("[data-prev-page]")).toBeNull();
  });
});
