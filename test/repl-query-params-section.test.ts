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
import "../src/plugins/replication/repl-query-params-section.js";
import type { CcaReplQueryParamsSection } from "../src/plugins/replication/repl-query-params-section.js";

describe("cca-repl-query-params-section", () => {
  let el: CcaReplQueryParamsSection;
  afterEach(() => el?.remove());

  async function mount(json = ""): Promise<CcaReplQueryParamsSection> {
    el = document.createElement("cca-repl-query-params-section") as CcaReplQueryParamsSection;
    el.queryParamsJson = json;
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  }

  it("renders the provided JSON in the textarea", async () => {
    await mount('{"level":"high"}');
    const ta = el.shadowRoot!.querySelector("wa-textarea") as HTMLTextAreaElement | null;
    expect(ta).not.toBeNull();
    expect((ta as unknown as { value: string }).value).toBe('{"level":"high"}');
  });

  it("emits cca-query-params-change with the typed JSON", async () => {
    await mount();
    const ta = el.shadowRoot!.querySelector("wa-textarea")!;
    let detail: { queryParamsJson: string } | null = null;
    el.addEventListener("cca-query-params-change", (e) => {
      detail = (e as CustomEvent<{ queryParamsJson: string }>).detail;
    });
    (ta as unknown as { value: string }).value = '{"a":1}';
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(detail).toEqual({ queryParamsJson: '{"a":1}' });
  });
});
