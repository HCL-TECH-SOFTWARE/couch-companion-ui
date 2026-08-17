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
 * The per-column field picker (#79), on its own — the two document lists exercise it
 * in place in `doc-derived-columns.test.ts`.
 */

import { describe, it, expect, afterEach } from "vitest";

import "../src/components/cca-column-picker";
import type { CcaColumnPicker } from "../src/components/cca-column-picker";

const FIELDS = ["_id", "_rev", "name", "email"];

let mounted: HTMLElement[] = [];

async function mount(field = "name", fields = FIELDS): Promise<CcaColumnPicker> {
  const el = document.createElement("cca-column-picker") as CcaColumnPicker;
  el.field = field;
  el.fields = fields;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  // The checkmarks are re-derived from `updated()`, one turn after the items render.
  await el.updateComplete;
  return el;
}

function shadow(el: CcaColumnPicker): ShadowRoot {
  if (!el.shadowRoot) throw new Error("expected shadowRoot");
  return el.shadowRoot;
}

function item(el: CcaColumnPicker, field: string): HTMLElement & { checked: boolean } {
  const found = shadow(el).querySelector<HTMLElement & { checked: boolean }>(
    `[data-field="${field}"]`,
  );
  if (!found) throw new Error(`no item for field: ${field}`);
  return found;
}

/**
 * Selects an item the way `wa-dropdown` does.
 *
 * Both of its selection paths — the click handler on its shadow `#menu` and the
 * Enter/Space branch of its document `keydown` handler — funnel into `makeSelection()`,
 * which flips `item.checked` itself before emitting `wa-select`. A bare `item.click()`
 * reaches neither under happy-dom, which does not compose slotted light-DOM children into
 * the host's shadow tree for event dispatch, so the click stops at the `wa-dropdown` host
 * and the menu listener never runs. Calling `makeSelection()` runs Web Awesome's real
 * toggle and emits its real event, which is what a browser does. See #50, and the same
 * helper in `cca-theme-picker.test.ts`.
 */
function select(el: CcaColumnPicker, field: string): void {
  const dropdown = shadow(el).querySelector<
    HTMLElement & { makeSelection(item: Element): void }
  >("wa-dropdown");
  if (!dropdown) throw new Error("expected wa-dropdown");
  dropdown.makeSelection(item(el, field));
}

/** The fields currently showing a checkmark. */
function checked(el: CcaColumnPicker): string[] {
  return Array.from(
    shadow(el).querySelectorAll<HTMLElement & { checked: boolean }>(
      "[data-field]",
    ),
  )
    .filter((i) => i.checked)
    .map((i) => i.dataset.field ?? "");
}

/** Collects `cca-column-field-change` payloads from the picker. */
function changes(el: CcaColumnPicker): string[] {
  const seen: string[] = [];
  el.addEventListener("cca-column-field-change", (e) => {
    seen.push((e as CustomEvent<{ field: string }>).detail.field);
  });
  return seen;
}

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
});

describe("cca-column-picker", () => {
  it("offers every field it was given", async () => {
    const el = await mount();
    expect(
      Array.from(shadow(el).querySelectorAll("[data-field]")).map((i) =>
        i.getAttribute("data-field"),
      ),
    ).toEqual(FIELDS);
  });

  /**
   * `wa-dropdown` finds its items with `assignedElements({flatten: true})` filtered by
   * `localName`, which sees only *direct* children — flatten looks through nested slots,
   * not through a wrapper. Put the items in a div, or in the `role="group"` that grouping
   * them visually seems to call for, and `getItems()` returns nothing: arrow keys,
   * typeahead, Home/End, Enter/Space and the roving tabindex all die silently while mouse
   * clicks keep working, because that path alone uses `closest()`. See #743.
   */
  it("keeps its items reachable by keyboard", async () => {
    const el = await mount();
    const dropdown = shadow(el).querySelector<
      HTMLElement & { getItems(): Element[] }
    >("wa-dropdown")!;
    expect(dropdown.getItems()).toHaveLength(FIELDS.length);
  });

  it("checks the field the column shows, and only that one", async () => {
    expect(checked(await mount("email"))).toEqual(["email"]);
  });

  it("announces the field the column should show now", async () => {
    const el = await mount();
    const seen = changes(el);
    select(el, "email");
    expect(seen).toEqual(["email"]);
  });

  // The picker holds no state: the screen owns which field the column shows, so what
  // carries a checkmark is always what is on screen — never what was last clicked.
  it("leaves the checkmark where it was until the column actually changes", async () => {
    const el = await mount();
    select(el, "email");
    await el.updateComplete;
    expect(checked(el)).toEqual(["name"]);

    el.field = "email";
    await el.updateComplete;
    expect(checked(el)).toEqual(["email"]);
  });

  /**
   * `wa-dropdown`'s `makeSelection()` toggles `checked` itself, *after* any `@click`
   * handler and after Lit has committed — and `checked` does not reflect, so a template
   * binding cannot see the toggle and will not correct it. Re-selecting the field the
   * column already shows changes nothing on the screen, so nothing re-renders either:
   * without the imperative re-derive this leaves the current field *unchecked*, which is
   * exactly the "the checkmark moves one click late" bug from #50.
   */
  it("survives re-selecting the field the column already shows", async () => {
    const el = await mount();
    select(el, "name");
    await el.updateComplete;
    expect(checked(el)).toEqual(["name"]);
  });

  it("announces nothing for an item it did not render", async () => {
    const el = await mount();
    const seen = changes(el);
    const stray = document.createElement("wa-dropdown-item");
    stray.dataset.field = "not-a-field";
    const dropdown = shadow(el).querySelector<
      HTMLElement & { makeSelection(item: Element): void }
    >("wa-dropdown")!;
    dropdown.makeSelection(stray);
    expect(seen).toEqual([]);
  });

  // A column shows exactly one field, so the items are a mutually exclusive set.
  // wa-dropdown-item stamps `menuitemcheckbox` — independent toggles — from its own
  // updated(), overwriting the template. Same fix as cca-theme-picker (#767).
  it("announces its items as a single-choice set", async () => {
    const el = await mount();
    await el.updateComplete;
    const roles = Array.from(shadow(el).querySelectorAll("[data-field]")).map(
      (i) => i.getAttribute("role"),
    );
    expect(roles.every((r) => r === "menuitemradio")).toBe(true);
  });

  it("names the trigger by what the column shows", async () => {
    const el = await mount("email");
    const label =
      shadow(el)
        .querySelector("[data-column-picker] wa-icon")
        ?.getAttribute("label") ?? "";
    expect(label).toContain("email");
  });
});
