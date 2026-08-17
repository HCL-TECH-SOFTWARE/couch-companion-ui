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
 * Reaching a database's design documents from the screens that browse its documents (#81).
 *
 * There is no filtered `_all_docs` range over `_design/` here and there is no new screen:
 * `cca-design-list` already lists design documents and already narrows itself to the
 * `?database=` it arrives with. This is the same route pair `db-list`'s row action and
 * `repo-overview`'s target pills navigate with, so all four entry points land identically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Monaco crashes in happy-dom (canvas pixel ratio); both screens render it.
vi.mock("../src/components/cca-monaco-editor.js", () => ({}));

import { getContext } from "../src/context";
import * as headerModule from "../src/components/cca-header";
import "../src/components/cca-header";
import "../src/plugins/db-mgmt/doc-browser";
import "../src/plugins/db-mgmt/doc-query";

// doc-query persists every run to its history element; see doc-derived-columns.test.ts.
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

async function mount(tag: string, serverId: string, dbName: string) {
  const el = document.createElement(tag) as any;
  el.serverId = serverId;
  el.dbName = dbName;
  document.body.appendChild(el);
  mounted.push(el);
  await settle(el);
  return el;
}

/** The header action carrying `tooltip`, out of everything doc-browser registered. */
function headerAction(spy: any, tooltip: string) {
  const actions = spy.mock.calls.flatMap(([list]: [any[]]) => list);
  return actions.find((a: any) => a.tooltip === tooltip);
}

beforeEach(() => {
  localStorage.clear();
  if (!document.querySelector("cca-router-provider")) {
    document.body.appendChild(document.createElement("cca-router-provider"));
  }
  const header = document.createElement("cca-header");
  document.body.appendChild(header);
  mounted.push(header);
  vi.spyOn(getContext().dbMgmt, "listDatabases").mockResolvedValue([] as any);
  vi.spyOn(getContext().dbMgmt, "listDocuments").mockResolvedValue({
    documents: [],
    bookmark: undefined,
    total_count: 0,
  } as any);
});

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("doc-browser links to the design documents (#81)", () => {
  it("offers the action beside the screen's other header actions", async () => {
    const spy = vi.spyOn(headerModule, "addHeaderActions");
    await mount("cca-doc-browser", "srv1", "mydb");
    expect(headerAction(spy, "Design Documents")).toBeDefined();
  });

  // Same icon db-list's own row action uses for this destination.
  it("wears the design-document icon", async () => {
    const spy = vi.spyOn(headerModule, "addHeaderActions");
    await mount("cca-doc-browser", "srv1", "mydb");
    expect(headerAction(spy, "Design Documents").icon).toBe("pen-nib");
  });

  it("navigates to the design list narrowed to this database", async () => {
    const spy = vi.spyOn(headerModule, "addHeaderActions");
    await mount("cca-doc-browser", "srv1", "mydb");
    const navigate = vi.spyOn(getContext().router, "navigate");
    headerAction(spy, "Design Documents").action(new Event("click"));
    expect(navigate).toHaveBeenCalledWith("/design-docs/srv1?database=mydb");
  });

  // A database name is free-form and a server id may be too; both are path/query data.
  it("encodes the server id and the database name", async () => {
    const spy = vi.spyOn(headerModule, "addHeaderActions");
    await mount("cca-doc-browser", "srv 1", "my db/1");
    const navigate = vi.spyOn(getContext().router, "navigate");
    headerAction(spy, "Design Documents").action(new Event("click"));
    expect(navigate).toHaveBeenCalledWith(
      "/design-docs/srv%201?database=my%20db%2F1",
    );
  });
});

describe("doc-query links to the design documents (#81)", () => {
  it("offers the link in the screen's header bar", async () => {
    const el = await mount("cca-doc-query", "srv1", "mydb");
    expect(el.shadowRoot.querySelector("[data-design-docs]")).not.toBeNull();
  });

  it("navigates to the design list narrowed to this database", async () => {
    const el = await mount("cca-doc-query", "srv1", "mydb");
    const navigate = vi.spyOn(getContext().router, "navigate");
    (el.shadowRoot.querySelector("[data-design-docs]") as HTMLElement).click();
    expect(navigate).toHaveBeenCalledWith("/design-docs/srv1?database=mydb");
  });

  it("encodes the server id and the database name", async () => {
    const el = await mount("cca-doc-query", "srv 1", "my db/1");
    const navigate = vi.spyOn(getContext().router, "navigate");
    (el.shadowRoot.querySelector("[data-design-docs]") as HTMLElement).click();
    expect(navigate).toHaveBeenCalledWith(
      "/design-docs/srv%201?database=my%20db%2F1",
    );
  });
});
