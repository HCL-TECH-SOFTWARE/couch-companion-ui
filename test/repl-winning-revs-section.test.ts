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
import "../src/plugins/replication/repl-winning-revs-section.js";
import type { CcaReplWinningRevsSection } from "../src/plugins/replication/repl-winning-revs-section.js";

describe("cca-repl-winning-revs-section", () => {
  let el: CcaReplWinningRevsSection;
  afterEach(() => el?.remove());

  async function mount(on = false): Promise<CcaReplWinningRevsSection> {
    el = document.createElement("cca-repl-winning-revs-section") as CcaReplWinningRevsSection;
    el.winningRevsOnly = on;
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  }

  it("reflects the property on the checkbox", async () => {
    await mount(true);
    const cb = el.shadowRoot!.querySelector("wa-checkbox");
    expect(cb?.hasAttribute("checked")).toBe(true);
  });

  it("emits cca-winning-revs-change when toggled", async () => {
    await mount(false);
    const cb = el.shadowRoot!.querySelector("wa-checkbox")!;
    let detail: { winningRevsOnly: boolean } | null = null;
    el.addEventListener("cca-winning-revs-change", (e) => {
      detail = (e as CustomEvent<{ winningRevsOnly: boolean }>).detail;
    });
    (cb as unknown as { checked: boolean }).checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    expect(detail).toEqual({ winningRevsOnly: true });
  });
});
