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
  const stubs = stubReplEditorServices();
  const el = document.createElement("cca-repl-editor") as CcaReplEditor;
  document.body.appendChild(el);
  await el.updateComplete;
  const endpoints = () =>
    Array.from(
      el.shadowRoot!.querySelectorAll("cca-repl-endpoint"),
    ) as CcaReplEndpoint[];
  return { el, stubs, endpoints };
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

async function submit(el: CcaReplEditor) {
  el.shadowRoot!.querySelector<HTMLFormElement>(
    "#replication-editor-form",
  )!.requestSubmit();
  await Promise.resolve();
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
}

describe("cca-repl-editor pull setup", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("builds a pull doc: remote source URL plus headers, local target", async () => {
    const { el, stubs, endpoints } = await mount();
    const [source, target] = endpoints();
    emit(source, { kind: "source", serverUrl: "http://remote:5984" });
    emit(source, { kind: "source", database: "crm" });
    emit(source, { kind: "source", auth: { Authorization: "Basic abc" } });
    emit(target, { kind: "target", database: "crm-copy" });
    await el.updateComplete;
    await submit(el);
    const doc = stubs.createReplication.mock.calls[0][0] as unknown as {
      source: unknown;
      target: { url: string };
    };
    expect(doc.source).toEqual({
      url: "http://remote:5984/crm",
      headers: { Authorization: "Basic abc" },
    });
    expect(doc.target.url).toBe("https://a/crm-copy");
  });

  it("percent-encodes a database name with a slash", async () => {
    const { el, stubs, endpoints } = await mount();
    emit(endpoints()[0], { kind: "source", serverUrl: "http://remote:5984" });
    emit(endpoints()[0], { kind: "source", database: "a/b" });
    emit(endpoints()[1], { kind: "target", database: "t" });
    await el.updateComplete;
    await submit(el);
    const doc = stubs.createReplication.mock.calls[0][0] as unknown as {
      source: { url: string };
    };
    expect(doc.source.url).toBe("http://remote:5984/a%2Fb");
  });

  it("tolerates a trailing slash on the server URL", async () => {
    const { el, stubs, endpoints } = await mount();
    emit(endpoints()[0], { kind: "source", serverUrl: "http://remote:5984/" });
    emit(endpoints()[0], { kind: "source", database: "crm" });
    emit(endpoints()[1], { kind: "target", database: "t" });
    await el.updateComplete;
    await submit(el);
    const doc = stubs.createReplication.mock.calls[0][0] as unknown as {
      source: { url: string };
    };
    expect(doc.source.url).toBe("http://remote:5984/crm");
  });

  it("blocks save when the source server URL is invalid", async () => {
    const { el, stubs, endpoints } = await mount();
    emit(endpoints()[0], { kind: "source", serverUrl: "couchdb:5984" });
    emit(endpoints()[0], { kind: "source", database: "crm" });
    emit(endpoints()[1], { kind: "target", database: "t" });
    await el.updateComplete;
    await submit(el);
    expect(stubs.createReplication).not.toHaveBeenCalled();
    expect((el as unknown as { error: string }).error).toContain(
      "Source Server URL is invalid",
    );
  });

  it("keeps an edited source server when the Source JSON is synced and re-applied", async () => {
    const { el, endpoints } = await mount();
    emit(endpoints()[0], { kind: "source", serverUrl: "http://remote:5984" });
    emit(endpoints()[0], { kind: "source", database: "crm" });
    await el.updateComplete;
    const state = el as unknown as {
      sourceDocJson: string;
      sourceServerUrl: string;
      syncSourceFromDesign(): void;
      applySourceToDesign(): boolean;
    };
    state.syncSourceFromDesign();
    expect(JSON.parse(state.sourceDocJson).source.url).toBe(
      "http://remote:5984/crm",
    );
    expect(state.applySourceToDesign()).toBe(true);
    expect(state.sourceServerUrl).toBe("http://remote:5984");
  });
});
