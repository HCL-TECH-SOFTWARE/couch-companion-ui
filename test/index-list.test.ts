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
 * Unit tests for CcaIndexList (index-list.ts) — issue #57/#92:
 *  - Previous/Next are hidden entirely (not just disabled) when there is no such page
 *  - Each index row defaults to a structured "Form" tab; the raw JSON editor lives behind
 *    a "Source" tab instead of always being shown (mirrors the #85 split on
 *    cca-user-detail.ts)
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { getContext } from "../src/context";
import type { ListIndexesResponse } from "../src/plugins/db-mgmt/types.js";

// Prevent the real wa-icon from registering — it fetches SVGs over the network, which happy-dom
// can't answer (see index-manage.test.ts for the same guard).
vi.mock("@awesome.me/webawesome/dist/components/icon/icon.js", () => ({}));

// Prevent the real Monaco-backed editor from initialising in happy-dom (canvas pixel-ratio
// crash) — same guard cca-user-detail.test.ts / doc-browser.test.ts use.
vi.mock("../src/components/cca-monaco-editor.js", () => ({}));

import type { CcaIndexList } from "../src/plugins/db-mgmt/index-list.js";
import "../src/plugins/db-mgmt/index-list.js";

if (!customElements.get("cca-monaco-editor")) {
  customElements.define(
    "cca-monaco-editor",
    class extends HTMLElement {
      value = "";
    },
  );
}

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function settle(el: CcaIndexList) {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

async function mount(serverId: string, dbName: string): Promise<CcaIndexList> {
  if (!document.querySelector("cca-router-provider")) {
    document.body.appendChild(document.createElement("cca-router-provider"));
  }
  const el = document.createElement("cca-index-list") as CcaIndexList;
  el.serverId = serverId;
  el.dbName = dbName;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

function mockListIndexes(resp: ListIndexesResponse) {
  return vi.spyOn(getContext().dbMgmt, "listIndexes").mockResolvedValue(resp);
}

function prevButton(el: CcaIndexList): HTMLElement | null {
  return Array.from(el.shadowRoot!.querySelectorAll("wa-button")).find((b) =>
    (b.textContent ?? "").includes("Previous"),
  ) as HTMLElement | undefined ?? null;
}

function nextButton(el: CcaIndexList): HTMLElement | null {
  return Array.from(el.shadowRoot!.querySelectorAll("wa-button")).find((b) =>
    (b.textContent ?? "").includes("Next"),
  ) as HTMLElement | undefined ?? null;
}

describe("CcaIndexList", () => {
  afterEach(() => {
    document.body.querySelectorAll("cca-index-list").forEach((e) => e.remove());
    vi.restoreAllMocks();
  });

  describe("Previous / Next pagination (#57)", () => {
    it("hides both buttons entirely — not just disables them — on a single, total page", async () => {
      mockListIndexes({
        indexes: [{ name: "idx1", ddoc: "_design/a", def: {} }],
        total_count: 1,
      });
      const el = await mount("$all", "mydb");

      expect(prevButton(el)).toBeNull();
      expect(nextButton(el)).toBeNull();
    });

    it("shows Next but hides Previous on the first of several pages", async () => {
      mockListIndexes({
        indexes: Array.from({ length: PAGE_SIZE }, (_, i) => ({
          name: `idx${i}`,
          ddoc: `_design/d${i}`,
          def: {},
        })),
        total_count: PAGE_SIZE + 5,
      });
      const el = await mount("$all", "mydb");

      expect(prevButton(el)).toBeNull();
      expect(nextButton(el)).not.toBeNull();
    });

    it("shows Previous but hides Next on the last page", async () => {
      const list = mockListIndexes({
        indexes: Array.from({ length: PAGE_SIZE }, (_, i) => ({
          name: `idx${i}`,
          ddoc: `_design/d${i}`,
          def: {},
        })),
        total_count: PAGE_SIZE + 5,
      });
      const el = await mount("$all", "mydb");

      (nextButton(el) as HTMLElement).click();
      await settle(el);

      // Second page: 5 remaining indexes, no third page.
      list.mockResolvedValue({
        indexes: Array.from({ length: 5 }, (_, i) => ({
          name: `idx${PAGE_SIZE + i}`,
          ddoc: `_design/d${PAGE_SIZE + i}`,
          def: {},
        })),
        total_count: PAGE_SIZE + 5,
      });
      await settle(el);

      expect(prevButton(el)).not.toBeNull();
      expect(nextButton(el)).toBeNull();
    });

    it("shows Next when the total count is unknown, even on page 0", async () => {
      mockListIndexes({
        indexes: [{ name: "idx1", ddoc: "_design/a", def: {} }],
        total_count: undefined as unknown as number,
      });
      const el = await mount("$all", "mydb");

      expect(nextButton(el)).not.toBeNull();
    });
  });

  describe("Form/Source tab split per index (#57/#92)", () => {
    const index = {
      name: "by-status-created",
      ddoc: "_design/my-idx",
      type: "json" as const,
      def: {
        fields: ["status", { created_at: "desc" }],
      },
    };

    it("defaults to the Form tab: structured fields shown, raw editor absent", async () => {
      mockListIndexes({ indexes: [index], total_count: 1 });
      const el = await mount("$all", "mydb");

      const text = el.shadowRoot!.textContent ?? "";
      expect(text).toContain("by-status-created");
      expect(text).toContain("status");
      expect(text).toContain("(asc)");
      expect(text).toContain("created_at");
      expect(text).toContain("(desc)");
      expect(el.shadowRoot!.querySelector("cca-monaco-editor")).toBeNull();
    });

    it("renders the tab labels as Form and Source", async () => {
      mockListIndexes({ indexes: [index], total_count: 1 });
      const el = await mount("$all", "mydb");

      const text = el.shadowRoot!.textContent ?? "";
      expect(text).toContain("Form");
      expect(text).toContain("Source");
    });

    it("switching to Source reveals the raw, read-only JSON editor", async () => {
      mockListIndexes({ indexes: [index], total_count: 1 });
      const el = await mount("$all", "mydb");

      el.shadowRoot!.querySelector("wa-tab-group")!.dispatchEvent(
        new CustomEvent("wa-tab-show", { detail: { name: "source" } }),
      );
      await settle(el);

      const editor = el.shadowRoot!.querySelector("cca-monaco-editor") as HTMLElement & {
        value?: string;
      };
      expect(editor).not.toBeNull();
      expect(editor.hasAttribute("readonly")).toBe(true);
      expect(JSON.parse(editor.value ?? "{}")).toMatchObject({ name: "by-status-created" });
    });
  });
});
