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

import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/plugins/replication/repl-editor";
import type { CcaReplEditor } from "../src/plugins/replication/repl-editor";
import type { CcaReplEndpoint } from "../src/plugins/replication/repl-endpoint";
import { stubReplEditorServices } from "./helpers/repl-editor-stubs";

async function mount() {
  stubReplEditorServices();
  const el = document.createElement("cca-repl-editor") as CcaReplEditor;
  document.body.appendChild(el);
  await el.updateComplete;
  const endpoints = () =>
    Array.from(
      el.shadowRoot!.querySelectorAll("cca-repl-endpoint"),
    ) as CcaReplEndpoint[];
  return { el, endpoints };
}

function emit(target: Element, detail: Record<string, unknown>) {
  target.dispatchEvent(
    new CustomEvent("cca-endpoint-change", {
      detail,
      bubbles: true,
      composed: true,
    }),
  );
}

describe("cca-repl-editor endpoint swap", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders two cca-repl-endpoint components, source first", async () => {
    const { endpoints } = await mount();
    const [source, target] = endpoints();
    expect(endpoints().length).toBe(2);
    expect(source.kind).toBe("source");
    expect(source.serverUrl).toBe("https://a");
    expect(target.kind).toBe("target");
    expect(target.serverUrl).toBe("https://a");
  });

  it("routes cca-endpoint-change events into editor state", async () => {
    const { el, endpoints } = await mount();
    emit(endpoints()[0], { kind: "source", serverUrl: "http://remote:5984" });
    emit(endpoints()[0], { kind: "source", database: "crm" });
    emit(endpoints()[1], { kind: "target", database: "crm-copy" });
    emit(endpoints()[1], { kind: "target", auth: { username: "u" } });
    await el.updateComplete;
    const [source, target] = endpoints();
    expect(source.serverUrl).toBe("http://remote:5984");
    expect(source.database).toBe("crm");
    expect(target.database).toBe("crm-copy");
    expect(target.auth).toEqual({ username: "u" });
  });
});
