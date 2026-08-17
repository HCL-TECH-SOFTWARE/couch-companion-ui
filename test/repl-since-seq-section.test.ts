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
import "../src/plugins/replication/repl-since-seq-section.js";
import type { CcaReplSinceSeqSection } from "../src/plugins/replication/repl-since-seq-section.js";

describe("cca-repl-since-seq-section", () => {
  let el: CcaReplSinceSeqSection;
  afterEach(() => el?.remove());

  async function mount(seq = ""): Promise<CcaReplSinceSeqSection> {
    el = document.createElement("cca-repl-since-seq-section") as CcaReplSinceSeqSection;
    el.sinceSeq = seq;
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  }

  it("renders the provided sequence in the input", async () => {
    await mount("42-abc");
    const input = el.shadowRoot!.querySelector("wa-input");
    expect((input as unknown as { value: string } | null)?.value).toBe("42-abc");
  });

  it("emits cca-since-seq-change with the typed value", async () => {
    await mount();
    const input = el.shadowRoot!.querySelector("wa-input")!;
    let detail: { sinceSeq: string } | null = null;
    el.addEventListener("cca-since-seq-change", (e) => {
      detail = (e as CustomEvent<{ sinceSeq: string }>).detail;
    });
    (input as unknown as { value: string }).value = "42-abc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(detail).toEqual({ sinceSeq: "42-abc" });
  });
});
