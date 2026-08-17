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
vi.mock("../src/plugins/replication/repl-filter-picker.js", () => ({}));
import "../src/plugins/replication/repl-filter-section.js";
import type { CcaReplFilterSection } from "../src/plugins/replication/repl-filter-section.js";

class WaStub extends LitElement {
  value = "";
  createRenderRoot() {
    return this;
  }
}
for (const tag of ["wa-input", "cca-repl-filter-picker", "wa-button"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

async function mount(
  filterFn = "",
  sourceServer = "",
  sourceDb = "",
): Promise<CcaReplFilterSection> {
  const el = document.createElement(
    "cca-repl-filter-section",
  ) as CcaReplFilterSection;
  el.filterFn = filterFn;
  el.sourceServer = sourceServer;
  el.sourceDb = sourceDb;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/** Capture the filterFn carried by the next cca-filter-fn-change event. */
function emittedBy(el: CcaReplFilterSection, act: () => void): string | undefined {
  let detail: { filterFn: string } | undefined;
  const handler = (e: Event) => {
    detail = (e as CustomEvent<{ filterFn: string }>).detail;
  };
  el.addEventListener("cca-filter-fn-change", handler);
  act();
  el.removeEventListener("cca-filter-fn-change", handler);
  return detail?.filterFn;
}

describe("cca-repl-filter-section", () => {
  let el: CcaReplFilterSection;
  afterEach(() => el?.remove());

  it("emits an empty filter (not '/') when the only function name is cleared", async () => {
    el = await mount("/myfilter"); // function only, no design doc
    const emitted = emittedBy(el, () => el.updateFilterFunctionName(""));
    expect(emitted).toBe("");
    expect(el.filterFn).toBe("");
  });

  it("emits an empty filter (not '/') when the only design doc is cleared", async () => {
    el = await mount("mydesign/"); // design doc only, no function
    const emitted = emittedBy(el, () => el.updateFilterDesignDoc(""));
    expect(emitted).toBe("");
    expect(el.filterFn).toBe("");
  });

  it("composes a full ddoc/function filter as the user types", async () => {
    el = await mount("");
    expect(emittedBy(el, () => el.updateFilterDesignDoc("mydesign"))).toBe(
      "mydesign/",
    );
    expect(emittedBy(el, () => el.updateFilterFunctionName("myfilter"))).toBe(
      "mydesign/myfilter",
    );
  });

  it("keeps the remaining part when only one field of a full filter is cleared", async () => {
    el = await mount("mydesign/myfilter");
    expect(emittedBy(el, () => el.updateFilterDesignDoc(""))).toBe("/myfilter");
  });

  it("disables Browse until source server and db are known", async () => {
    el = await mount("");
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("[data-browse]")?.hasAttribute("disabled")).toBe(true);

    el.sourceServer = "s1";
    el.sourceDb = "db1";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("[data-browse]")?.hasAttribute("disabled")).toBe(false);
  });

  it("opens the picker on Browse and applies a pick as the filter value", async () => {
    el = await mount("");
    el.sourceServer = "s1";
    el.sourceDb = "db1";
    await el.updateComplete;

    (el.shadowRoot?.querySelector("[data-browse]") as HTMLElement).dispatchEvent(new Event("click"));
    await el.updateComplete;
    const picker = el.shadowRoot?.querySelector("cca-repl-filter-picker") as HTMLElement & { open: boolean };
    expect(picker.open).toBe(true);

    const emitted = emittedBy(el, () =>
      picker.dispatchEvent(
        new CustomEvent("cca-filter-picked", {
          detail: { designDoc: "flows", filterName: "byUser" },
          bubbles: true,
          composed: true
        })
      )
    );
    expect(emitted).toBe("flows/byUser");
    expect(el.filterFn).toBe("flows/byUser");

    // Verify picker closes after a successful pick
    await el.updateComplete;
    expect(picker.open).toBe(false);
  });

  it("closes picker and emits no event on cancel", async () => {
    el = await mount("mydesign/existing");
    el.sourceServer = "s1";
    el.sourceDb = "db1";
    await el.updateComplete;

    // Open the picker
    (el.shadowRoot?.querySelector("[data-browse]") as HTMLElement).dispatchEvent(new Event("click"));
    await el.updateComplete;
    const picker = el.shadowRoot?.querySelector("cca-repl-filter-picker") as HTMLElement & { open: boolean };
    expect(picker.open).toBe(true);

    // Track if any cca-filter-fn-change events are emitted
    let eventEmitted = false;
    const handler = () => {
      eventEmitted = true;
    };
    el.addEventListener("cca-filter-fn-change", handler);

    // Dispatch cancel event
    picker.dispatchEvent(
      new CustomEvent("cca-filter-pick-cancel", {
        bubbles: true,
        composed: true
      })
    );
    await el.updateComplete;

    el.removeEventListener("cca-filter-fn-change", handler);

    // Verify picker closed
    expect(picker.open).toBe(false);

    // Verify no change event was emitted
    expect(eventEmitted).toBe(false);

    // Verify filter value is unchanged
    expect(el.filterFn).toBe("mydesign/existing");
  });
});
