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
 * `cca-page-controls` — the footer `doc-browser` and `doc-query` share since #80.
 *
 * The screens' own suites cover what reaches the service; this one covers the control's
 * side of the contract: which sizes it offers, when it announces a change, what it
 * refuses, and that previous/next are *absent* rather than greyed out when there is no
 * such page (the shape #57 landed on `index-list`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import "../src/components/cca-page-controls.js";
import type { CcaPageControls } from "../src/components/cca-page-controls.js";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  getPageSize,
  parseSkip,
  setPageSize,
} from "../src/services/page-size-preference.js";

let el: CcaPageControls;

async function mount(
  props: Partial<CcaPageControls> = {},
): Promise<CcaPageControls> {
  const node = document.createElement("cca-page-controls") as CcaPageControls;
  Object.assign(node, props);
  document.body.appendChild(node);
  await node.updateComplete;
  return node;
}

const q = (sel: string) => el.shadowRoot!.querySelector(sel);

/** Picks a size the way the selector does: set the value, announce the change. */
async function choose(size: string) {
  const select = q("[data-page-size]") as any;
  select.value = size;
  select.dispatchEvent(new Event("change"));
  await el.updateComplete;
}

/** Types into the skip box; `commit` false stops before the blur/Enter that applies it. */
async function type(raw: string, commit = true) {
  const input = q("[data-skip]") as any;
  input.value = raw;
  input.dispatchEvent(new Event("input"));
  if (commit) input.dispatchEvent(new Event("change"));
  await el.updateComplete;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  el?.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("cca-page-controls — page size", () => {
  it("offers exactly 5/10/25/50/100", async () => {
    el = await mount();
    const values = Array.from(
      q("[data-page-size]")!.querySelectorAll("wa-option"),
    ).map((o) => o.getAttribute("value"));
    expect(values).toEqual(["5", "10", "25", "50", "100"]);
  });

  it("announces the chosen size", async () => {
    el = await mount({ pageSize: 25 });
    const seen: number[] = [];
    el.addEventListener("cca-page-size-change", (e) =>
      seen.push((e as CustomEvent).detail.pageSize),
    );
    await choose("50");
    expect(seen).toEqual([50]);
  });

  it("says nothing when the size did not actually change", async () => {
    el = await mount({ pageSize: 25 });
    const spy = vi.fn();
    el.addEventListener("cca-page-size-change", spy);
    await choose("25");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("cca-page-controls — skip", () => {
  it("announces a whole number once it is committed", async () => {
    el = await mount({ skip: 0 });
    const seen: number[] = [];
    el.addEventListener("cca-skip-change", (e) =>
      seen.push((e as CustomEvent).detail.skip),
    );
    await type("40");
    expect(seen).toEqual([40]);
  });

  it("stays quiet while the number is still being typed", async () => {
    el = await mount({ skip: 0 });
    const spy = vi.fn();
    el.addEventListener("cca-skip-change", spy);
    await type("4", false);
    await type("40", false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a negative, a fraction and a letter, and explains why", async () => {
    el = await mount({ skip: 0 });
    const spy = vi.fn();
    el.addEventListener("cca-skip-change", spy);

    for (const bad of ["-1", "2.5", "1e3", "ten"]) {
      await type(bad);
      expect(spy).not.toHaveBeenCalled();
      expect(q("[data-skip]")!.getAttribute("hint")).toContain(
        "Whole numbers",
      );
    }
  });

  it("reads an emptied box as zero", async () => {
    el = await mount({ skip: 40 });
    const seen: number[] = [];
    el.addEventListener("cca-skip-change", (e) =>
      seen.push((e as CustomEvent).detail.skip),
    );
    await type("");
    expect(seen).toEqual([0]);
  });

  it("shows the skip the screen last requested, not a stale draft", async () => {
    el = await mount({ skip: 0 });
    await type("abc", false);
    el.skip = 25;
    await el.updateComplete;
    expect((q("[data-skip]") as any).value).toBe("25");
    expect(q("[data-skip]")!.getAttribute("hint")).toBe("");
  });
});

describe("cca-page-controls — previous/next are hidden, not disabled (#57 shape)", () => {
  it("renders neither button when there is no page either way", async () => {
    el = await mount({ hasPrev: false, hasNext: false });
    expect(q("[data-prev-page]")).toBeNull();
    expect(q("[data-next-page]")).toBeNull();
  });

  it("renders each button only when its page exists", async () => {
    el = await mount({ hasPrev: true, hasNext: false });
    expect(q("[data-prev-page]")).not.toBeNull();
    expect(q("[data-next-page]")).toBeNull();

    el.hasNext = true;
    await el.updateComplete;
    expect(q("[data-next-page]")).not.toBeNull();
  });

  it("announces the move when a button is pressed", async () => {
    el = await mount({ hasPrev: true, hasNext: true });
    const seen: string[] = [];
    el.addEventListener("cca-page-prev", () => seen.push("prev"));
    el.addEventListener("cca-page-next", () => seen.push("next"));

    (q("[data-prev-page]") as HTMLElement).click();
    (q("[data-next-page]") as HTMLElement).click();
    expect(seen).toEqual(["prev", "next"]);
  });

  it("greys the buttons out only while a request is in flight", async () => {
    el = await mount({ hasPrev: true, hasNext: true, loading: true });
    expect(q("[data-prev-page]")!.hasAttribute("disabled")).toBe(true);
    expect(q("[data-next-page]")!.hasAttribute("disabled")).toBe(true);

    el.loading = false;
    await el.updateComplete;
    expect(q("[data-next-page]")!.hasAttribute("disabled")).toBe(false);
  });

  it("shows the range it was given, and a spinner instead while loading", async () => {
    el = await mount({ rangeLabel: "1–25 of 812" });
    expect(q("[data-range]")!.textContent).toContain("1–25 of 812");

    el.loading = true;
    await el.updateComplete;
    expect(q("[data-range]")!.querySelector("wa-spinner")).not.toBeNull();
  });
});

describe("page-size preference storage", () => {
  it("defaults to 25 when nothing is stored", () => {
    expect(getPageSize("ccaTestPageSize")).toBe(DEFAULT_PAGE_SIZE);
    expect(DEFAULT_PAGE_SIZE).toBe(25);
  });

  it("round-trips a stored size", () => {
    setPageSize("ccaTestPageSize", 50);
    expect(getPageSize("ccaTestPageSize")).toBe(50);
  });

  it("ignores a stored size the selector cannot show", () => {
    localStorage.setItem("ccaTestPageSize", "37");
    expect(getPageSize("ccaTestPageSize")).toBe(DEFAULT_PAGE_SIZE);

    setPageSize("ccaTestPageSize", 37);
    expect(localStorage.getItem("ccaTestPageSize")).toBe("37");
    expect(getPageSize("ccaTestPageSize")).toBe(DEFAULT_PAGE_SIZE);
  });

  it("ignores junk", () => {
    localStorage.setItem("ccaTestPageSize", "not a number");
    expect(getPageSize("ccaTestPageSize")).toBe(DEFAULT_PAGE_SIZE);
  });

  it("keeps every offered size storable", () => {
    for (const size of PAGE_SIZE_OPTIONS) {
      setPageSize("ccaTestPageSize", size);
      expect(getPageSize("ccaTestPageSize")).toBe(size);
    }
  });
});

describe("parseSkip", () => {
  it("accepts digits and an empty box", () => {
    expect(parseSkip("0")).toBe(0);
    expect(parseSkip("40")).toBe(40);
    expect(parseSkip("  7 ")).toBe(7);
    expect(parseSkip("")).toBe(0);
  });

  it("rejects anything that is not a whole non-negative number", () => {
    for (const bad of ["-1", "2.5", "1e3", "ten", "0x10", "+1", "Infinity"]) {
      expect(parseSkip(bad)).toBeNull();
    }
  });
});
