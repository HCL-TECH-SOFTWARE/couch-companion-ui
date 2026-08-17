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
 * Unit tests for CcaManageIndex (index-manage.ts).
 *
 * The screen carries no server picker of its own — the single server arrives
 * on the :serverId route param (#31).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LitElement } from "lit";
import { getContext } from "../src/context";

// Prevent the real wa-icon from registering. It fetches each SVG over the network — since #741
// that is same-origin /icons/*, not the fontawesome CDN, but happy-dom has no server to answer
// either, so the in-flight fetches abort on teardown and log DOMException noise.
vi.mock("@awesome.me/webawesome/dist/components/icon/icon.js", () => ({}));

import type { CcaManageIndex } from "../src/plugins/db-mgmt/index-manage.js";
import "../src/plugins/db-mgmt/index-manage.js";

// ---------------------------------------------------------------------------
// Stub wa-* and cca-* custom elements so the component can render in jsdom
// ---------------------------------------------------------------------------
class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}

for (const tag of [
  "wa-button",
  "wa-badge",
  "wa-select",
  "wa-option",
  "wa-spinner",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

for (const tag of ["cca-create-index", "cca-index-list", "cca-header-bar"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockDbMgmt() {
  const ctx = getContext();
  vi.spyOn(ctx.dbMgmt, "listDatabases").mockResolvedValue([
    {
      db_name: "mydb",
      servers: [
        { server_id: "s1", server_name: "One", doc_count: 1 },
        { server_id: "s2", server_name: "Two", doc_count: 2 },
      ],
    },
  ] as any);
  return ctx;
}

function createIndexManage(serverId: string, dbName: string): CcaManageIndex {
  const el = document.createElement("cca-index-manage") as CcaManageIndex;
  // Set properties BEFORE appending so connectedCallback sees them
  el.serverId = serverId;
  el.dbName = dbName;
  document.body.appendChild(el);
  return el;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("CcaManageIndex", () => {
  let element: CcaManageIndex;

  beforeEach(async () => {
    // CcaElement finds the event router via a provider element in the document.
    if (!document.querySelector("cca-router-provider")) {
      document.body.appendChild(document.createElement("cca-router-provider"));
    }
    mockDbMgmt();
    element = createIndexManage("$all", "mydb");
    await element.updateComplete;
    await Promise.resolve();
    await element.updateComplete;
  });

  afterEach(() => {
    element.remove();
    vi.restoreAllMocks();
  });

  describe("Rendering", () => {
    it("mounts and renders without error", () => {
      expect(element).toBeDefined();
      expect(element.shadowRoot).toBeDefined();
    });
  });
});
