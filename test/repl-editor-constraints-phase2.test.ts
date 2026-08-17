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
import "../src/plugins/replication/repl-editor.js";
import type { CcaReplEditor } from "../src/plugins/replication/repl-editor.js";
import { stubReplEditorServices, stubDoc } from "./helpers/repl-editor-stubs";

class Stub extends LitElement {
  docIds: string[] = [];
  selectorJson = "";
  filterFn = "";
  createRenderRoot() {
    return this;
  }
}
for (const tag of [
  "wa-button",
  "wa-textarea",
  "wa-tab",
  "wa-tab-group",
  "wa-tab-panel",
  "wa-icon",
  "cca-repl-source-section",
  "cca-repl-target-section",
  "cca-repl-selector-section",
  "cca-repl-filter-section",
  "cca-repl-behavior-section",
  "cca-repl-documents-section",
  "cca-repl-query-params-section",
  "cca-repl-winning-revs-section",
  "cca-repl-since-seq-section",
  "cca-repl-issues-panel",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends Stub {});
  }
}

async function loadEditor(): Promise<{
  el: CcaReplEditor;
  stubs: ReturnType<typeof stubReplEditorServices>;
}> {
  const stubs = stubReplEditorServices({
    doc: stubDoc({
      filter: "ddoc/by_level",
      query_params: { level: "high" },
      winning_revs_only: true,
      since_seq: "42-seq",
    }),
  });
  const el = document.createElement("cca-repl-editor") as CcaReplEditor;
  (el as unknown as { serverId: string }).serverId = "s";
  (el as unknown as { replId: string }).replId = "r";
  document.body.appendChild(el);
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  return { el, stubs };
}

async function submitAndGetPutBody(
  el: CcaReplEditor,
  stubs: ReturnType<typeof stubReplEditorServices>,
): Promise<Record<string, unknown>> {
  const form = el.shadowRoot!.querySelector(
    "#replication-editor-form",
  ) as HTMLFormElement;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  const call = stubs.updateReplication.mock.calls[0];
  expect(
    call,
    `save blocked: ${(el as unknown as { error: string }).error}`,
  ).toBeDefined();
  return call![2] as Record<string, unknown>;
}

describe("cca-repl-editor phase-2 constraints", () => {
  let el: CcaReplEditor;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("loads the three fields from the API doc and echoes them in the PUT body", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    const state = el as unknown as {
      queryParamsJson: string;
      winningRevsOnly: boolean;
      sinceSeq: string;
    };
    expect(JSON.parse(state.queryParamsJson)).toEqual({ level: "high" });
    expect(state.winningRevsOnly).toBe(true);
    expect(state.sinceSeq).toBe("42-seq");

    const body = await submitAndGetPutBody(el, loaded.stubs);
    expect(body.query_params).toEqual({ level: "high" });
    expect(body.winning_revs_only).toBe(true);
    expect(body.since_seq).toBe("42-seq");
  });

  it("edit-loads the native _replicator doc's filter field and echoes it in the PUT body (#808)", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    const state = el as unknown as {
      filterFn: string;
      computeSafetyRails(): { blocking: string[]; warnings: string[] };
    };
    expect(state.filterFn).toBe("ddoc/by_level");

    // the fixture pairs query_params with the filter, so the
    // "no effect without a filter" warning must not fire
    expect(
      state.computeSafetyRails().warnings.some((w) => /without a filter/i.test(w)),
    ).toBe(false);

    const body = await submitAndGetPutBody(el, loaded.stubs);
    expect(body.filter).toBe("ddoc/by_level");
  });

  it("shows checkmarks on the new tabs when set, an Options heading, and winning revs under Options", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    const r = el.shadowRoot!;
    for (const panel of ["query-params", "since-seq"]) {
      expect(
        r.querySelector(`wa-tab[panel="${panel}"] wa-icon.constraint-check`),
        panel,
      ).toBeTruthy();
    }
    const headings = [...r.querySelectorAll("h3")].map((h) => h.textContent?.trim());
    expect(headings).toContain("Options");
    expect(r.querySelector('wa-tab[panel="winning-revs"]')).toBeFalsy();
    expect(r.querySelector("wa-tab-panel cca-repl-winning-revs-section")).toBeFalsy();
    expect(r.querySelector("cca-repl-winning-revs-section")).toBeTruthy();
  });

  it("clears loaded fields to an explicit null in the request body (not silently omitted) and the tabs show no checkmarks", async () => {
    // Finding #1 of the Phase 4 final-review wave: these three fields WERE loaded from the API
    // doc (see the fixture in `loadEditor`), so clearing them must send an explicit `null` —
    // ReplicationService.updateReplication is what turns that into a truly absent key server-side
    // (see replication-service.test.ts's "drops a caller-supplied null key..."). Omitting the key
    // here instead would let the read-modify-write merge silently restore the stored value.
    const loaded = await loadEditor();
    el = loaded.el;
    const state = el as unknown as {
      queryParamsJson: string;
      winningRevsOnly: boolean;
      sinceSeq: string;
    };
    state.queryParamsJson = "";
    state.winningRevsOnly = false;
    state.sinceSeq = "";
    await el.updateComplete;

    const r = el.shadowRoot!;
    for (const panel of ["query-params", "since-seq"]) {
      expect(
        r.querySelector(`wa-tab[panel="${panel}"] wa-icon.constraint-check`),
        panel,
      ).toBeFalsy();
    }
    const body = await submitAndGetPutBody(el, loaded.stubs);
    expect(body.query_params).toBeNull();
    expect(body.winning_revs_only).toBeNull();
    expect(body.since_seq).toBeNull();

    const sourceDoc = JSON.parse(
      (el as unknown as { sourceDocJson: string }).sourceDocJson,
    );
    expect(sourceDoc.query_params).toBeNull();
    expect(sourceDoc.winning_revs_only).toBeNull();
    expect(sourceDoc.since_seq).toBeNull();
  });

  it("omits a field from the request body when it was never loaded in the first place (create mode)", async () => {
    // Contrast with the edit-mode test above: a fresh Create Replication screen has no stored
    // document to silently restore a value from, so an unset field stays omitted, never nulled.
    const stubs = stubReplEditorServices();
    el = document.createElement("cca-repl-editor") as CcaReplEditor;
    document.body.appendChild(el);
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    el.shadowRoot!.querySelector("cca-repl-source-section")!.dispatchEvent(
      new CustomEvent("cca-source-db-change", {
        detail: { sourceDb: "src" },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;

    const form = el.shadowRoot!.querySelector(
      "#replication-editor-form",
    ) as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    expect(
      stubs.createReplication,
      `save blocked: ${(el as unknown as { error: string }).error}`,
    ).toHaveBeenCalled();
    const body = stubs.createReplication.mock.calls[0][0] as Record<string, unknown>;
    expect(body.query_params).toBeUndefined();
    expect(body.winning_revs_only).toBeUndefined();
    expect(body.since_seq).toBeUndefined();
    expect(body).not.toHaveProperty("query_params");
  });

  it("round-trips the three fields through Source JSON", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    const state = el as unknown as {
      sourceDocJson: string;
      queryParamsJson: string;
      winningRevsOnly: boolean;
      sinceSeq: string;
      applySourceToDesign(): boolean;
    };
    expect(JSON.parse(state.sourceDocJson).winning_revs_only).toBe(true);
    expect(JSON.parse(state.sourceDocJson).since_seq).toBe("42-seq");
    expect(JSON.parse(state.sourceDocJson).query_params).toEqual({ level: "high" });

    state.sourceDocJson = JSON.stringify({
      source: { url: "https://a/db", headers: {} },
      target: { url: "https://a/db2", headers: {} },
      continuous: true,
      query_params: { level: "low" },
      winning_revs_only: false,
      since_seq: "7-seq",
    });
    expect(state.applySourceToDesign()).toBe(true);
    expect(JSON.parse(state.queryParamsJson)).toEqual({ level: "low" });
    expect(state.winningRevsOnly).toBe(false);
    expect(state.sinceSeq).toBe("7-seq");

    // Pasting a doc that omits the three fields clears them, same as any
    // other constraint field — there is no CCA-only "formula" concept that
    // suppresses Design fields anymore (Task 3).
    state.sourceDocJson = JSON.stringify({
      source: { url: "https://a/db", headers: {} },
      target: { url: "https://a/db2", headers: {} },
      continuous: true,
    });
    expect(state.applySourceToDesign()).toBe(true);
    expect(state.queryParamsJson).toBe("");
    expect(state.winningRevsOnly).toBe(false);
    expect(state.sinceSeq).toBe("");
  });

  it("safety rails: invalid query params block, filterless query params and since_seq warn", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    const state = el as unknown as {
      queryParamsJson: string;
      filterFn: string;
      sinceSeq: string;
      computeSafetyRails(): { blocking: string[]; warnings: string[] };
    };

    state.queryParamsJson = "{not json";
    expect(
      state.computeSafetyRails().blocking.some((b) => /query params/i.test(b)),
    ).toBe(true);

    state.queryParamsJson = "[1,2]";
    expect(
      state.computeSafetyRails().blocking.some((b) => /object/i.test(b)),
    ).toBe(true);

    state.queryParamsJson = '{"a":1}';
    state.filterFn = "";
    expect(
      state.computeSafetyRails().warnings.some((w) => /filter/i.test(w)),
    ).toBe(true);

    expect(
      state.computeSafetyRails().warnings.some((w) => /since_seq/i.test(w)),
    ).toBe(true);
  });

});
