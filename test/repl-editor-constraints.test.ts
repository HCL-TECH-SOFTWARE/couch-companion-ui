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
import { getContext } from "../src/context";
import { ReplicationService } from "../src/services/replication-service";
import type { ApiClient } from "../src/services/api-client";
import {
  stubReplEditorServices,
  stubDoc,
  STUB_SERVER,
} from "./helpers/repl-editor-stubs";

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
    doc: stubDoc({ doc_ids: ["d1", "d2"] }),
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

describe("cca-repl-editor doc_ids wiring", () => {
  let el: CcaReplEditor;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("loads doc_ids and includes them in the saved request body", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    expect((el as unknown as { docIds: string[] }).docIds).toEqual(["d1", "d2"]);

    const form = el.shadowRoot!.querySelector(
      "#replication-editor-form",
    ) as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    const call = loaded.stubs.updateReplication.mock.calls[0];
    expect(
      call,
      `save blocked: ${(el as unknown as { error: string }).error}`,
    ).toBeDefined();
    const body = call![2] as { doc_ids?: string[] };
    expect(body.doc_ids).toEqual(["d1", "d2"]);
  });

  it("reflects doc-id changes in the generated source document", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    const section = el.shadowRoot!.querySelector("cca-repl-documents-section")!;
    section.dispatchEvent(
      new CustomEvent("cca-doc-ids-change", {
        detail: { docIds: ["only-one"] },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    const sourceJson = (el as unknown as { sourceDocJson: string })
      .sourceDocJson;
    expect(JSON.parse(sourceJson).doc_ids).toEqual(["only-one"]);
  });

  it("shows a success check only on constraints that are set", async () => {
    const loaded = await loadEditor(); // loads doc_ids ["d1","d2"], no selector/filter
    el = loaded.el;
    const r = el.shadowRoot!;
    expect(
      r.querySelector('wa-tab[panel="documents"] wa-icon.constraint-check'),
    ).toBeTruthy();
    expect(
      r.querySelector('wa-tab[panel="selector"] wa-icon.constraint-check'),
    ).toBeFalsy();
    expect(
      r.querySelector('wa-tab[panel="filter"] wa-icon.constraint-check'),
    ).toBeFalsy();
  });

  it("warns when documents are combined with a selector", async () => {
    const loaded = await loadEditor(); // doc_ids already set
    el = loaded.el;
    (el as unknown as { selectorJson: string }).selectorJson =
      '{"type":"invoice"}';
    const rails = (
      el as unknown as {
        computeSafetyRails(): { blocking: string[]; warnings: string[] };
      }
    ).computeSafetyRails();
    expect(rails.warnings.some((w) => /doc_ids|documents/i.test(w))).toBe(true);
  });

  it("populates doc-id pills from doc_ids in the source JSON", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    (el as unknown as { sourceDocJson: string }).sourceDocJson = JSON.stringify({
      source: { url: "https://a/db", headers: {} },
      target: { url: "https://a/db2", headers: {} },
      continuous: true,
      doc_ids: ["x1", "x2", "x3"],
    });
    (el as unknown as { applySourceToDesign(): boolean }).applySourceToDesign();
    expect((el as unknown as { docIds: string[] }).docIds).toEqual([
      "x1",
      "x2",
      "x3",
    ]);
  });

  it("clears doc-id pills when the pasted source JSON omits doc_ids", async () => {
    const loaded = await loadEditor(); // fixture starts with doc_ids ["d1","d2"]
    el = loaded.el;
    (el as unknown as { sourceDocJson: string }).sourceDocJson = JSON.stringify({
      source: { url: "https://a/db", headers: {} },
      target: { url: "https://a/db2", headers: {} },
      continuous: true,
    });
    (el as unknown as { applySourceToDesign(): boolean }).applySourceToDesign();
    expect((el as unknown as { docIds: string[] }).docIds).toEqual([]);
  });

  it("treats a loaded bare-slash filter as unset (no Filter checkmark)", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    (el as unknown as { filterFn: string }).filterFn = "/";
    await el.updateComplete;
    expect(
      el.shadowRoot!.querySelector(
        'wa-tab[panel="filter"] wa-icon.constraint-check',
      ),
    ).toBeFalsy();
  });

  it("does not send a bare-slash filter in the saved request body", async () => {
    const loaded = await loadEditor();
    el = loaded.el;
    (el as unknown as { filterFn: string }).filterFn = "/";
    await el.updateComplete;
    const form = el.shadowRoot!.querySelector(
      "#replication-editor-form",
    ) as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;
    const call = loaded.stubs.updateReplication.mock.calls[0];
    expect(call).toBeDefined();
    const body = call![2] as { filter?: string };
    expect(body.filter).toBeUndefined();
  });

  it("writes a full URL for the local source, since CouchDB has no local endpoints", async () => {
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
    const src =
      typeof body.source === "string"
        ? body.source
        : (body.source as { url: string }).url;
    expect(src).toMatch(/^https?:\/\/.+\/src$/);
  });

  it("accepts an arbitrary remote target URL", async () => {
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
    const targetSection = el.shadowRoot!.querySelector("cca-repl-target-section")!;
    targetSection.dispatchEvent(
      new CustomEvent("cca-target-server-url-change", {
        detail: { targetServerUrl: "https://remote.example:6984" },
        bubbles: true,
        composed: true,
      }),
    );
    targetSection.dispatchEvent(
      new CustomEvent("cca-target-db-change", {
        detail: { targetDb: "mirror" },
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
    const tgt =
      typeof body.target === "string"
        ? body.target
        : (body.target as { url: string }).url;
    expect(tgt).toBe("https://remote.example:6984/mirror");
  });
});

describe("cca-repl-editor masked target credentials", () => {
  let el: CcaReplEditor;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  // getReplication masks endpoint credentials before the editor ever sees
  // them ("***" in place of user:pass). The target's free-text URL field
  // gets seeded from that masked value. ReplicationService.updateReplication
  // splices the stored credentials onto an edited masked URL when its
  // origin still matches the loaded one (a same-server edit, e.g. only the
  // database changed) — but ignores it entirely, keeping the stored
  // endpoint, when the origin differs, since the frontend cannot know a
  // different server's credentials. See task-3-report.md for the full
  // trace, including the source-tab bypass this file also regression-tests
  // below.
  function maskedTargetDoc() {
    return stubDoc({
      target: {
        url: "https://***@remote:5984/db2",
        headers: {},
      },
    });
  }

  async function loadMaskedEditor(): Promise<{
    el: CcaReplEditor;
    stubs: ReturnType<typeof stubReplEditorServices>;
  }> {
    const stubs = stubReplEditorServices({ doc: maskedTargetDoc() });
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

  it("honours a same-origin target-db edit on the Design tab, sending the edited (still-masked) endpoint for the service to splice", async () => {
    const loaded = await loadMaskedEditor();
    el = loaded.el;

    el.shadowRoot!.querySelector("cca-repl-target-section")!.dispatchEvent(
      new CustomEvent("cca-target-db-change", {
        detail: { targetDb: "mirror" },
        bubbles: true,
        composed: true,
      }),
    );
    await el.updateComplete;

    const state = el as unknown as {
      computeSafetyRails(): { blocking: string[]; warnings: string[] };
    };
    expect(
      state.computeSafetyRails().blocking.some((b) => /masked credential/i.test(b)),
    ).toBe(false);

    const form = el.shadowRoot!.querySelector(
      "#replication-editor-form",
    ) as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    expect(
      loaded.stubs.updateReplication,
      `save blocked: ${(el as unknown as { error: string }).error}`,
    ).toHaveBeenCalled();
    const body = loaded.stubs.updateReplication.mock.calls[0][2] as {
      target: { url: string };
    };
    // Still masked (the editor never learns the real credentials) but with
    // the edited path — the service is what splices real credentials on.
    expect(body.target.url).toBe("https://***@remote:5984/mirror");
  });

  it("does not block saving when the masked target endpoint is left untouched", async () => {
    const loaded = await loadMaskedEditor();
    el = loaded.el;

    const state = el as unknown as {
      computeSafetyRails(): { blocking: string[]; warnings: string[] };
    };
    expect(
      state.computeSafetyRails().blocking.some((b) => /masked credential/i.test(b)),
    ).toBe(false);

    const form = el.shadowRoot!.querySelector(
      "#replication-editor-form",
    ) as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    expect(
      loaded.stubs.updateReplication,
      `save blocked: ${(el as unknown as { error: string }).error}`,
    ).toHaveBeenCalled();
  });

  // Regression for the bypass found in review of 2e609d5: computeSafetyRails ran BEFORE
  // applySourceToDesign, so an edit made through the Source JSON textarea (a supported flow —
  // the header's Update button submits regardless of which tab is active) was checked against
  // stale, pre-edit state and always passed. Reproduced with a cross-origin edit specifically
  // because that's the one case where fixing only the ordering (and not also relaxing the rail
  // for same-origin edits) is observable: a same-origin Source-tab edit would have been let
  // through by the old buggy ordering too (see the "reviewer's reproduction" test below for that
  // path) — it's a *different* server that the fixed rail must catch and the old, un-reordered
  // rail could not, because it never saw the post-edit value at all.
  it("blocks a save when the Source tab's edited target points at a different server (closes the ordering bypass)", async () => {
    const loaded = await loadMaskedEditor();
    el = loaded.el;

    (el as unknown as { activeTab: string }).activeTab = "source";
    await el.updateComplete;
    const parsed = JSON.parse(
      (el as unknown as { sourceDocJson: string }).sourceDocJson,
    ) as { target: { url: string } };
    expect(parsed.target.url).toBe("https://***@remote:5984/db2");
    parsed.target.url = "https://***@otherhost:5984/mirror";
    (el as unknown as { sourceDocJson: string }).sourceDocJson =
      JSON.stringify(parsed);

    const form = el.shadowRoot!.querySelector(
      "#replication-editor-form",
    ) as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    expect(
      (el as unknown as { error: string }).error,
    ).toMatch(/masked credential/i);
    expect(loaded.stubs.updateReplication).not.toHaveBeenCalled();
  });

  // The reviewer's exact reproduction: edit mode, masked target, switch to the Source tab, edit
  // only the database (leaving the "***" credentials and host untouched), submit. Drives the
  // REAL ReplicationService (mocked only at the ApiClient network boundary, not at
  // ctx.replication.updateReplication) so the assertion covers the full round trip: the final PUT
  // to CouchDB must carry the real, spliced-in credentials and the edited database — never the
  // "***" placeholder — proving the target database change is honoured rather than silently
  // dropped while the UI still reports success.
  it("splices real credentials onto a same-origin target-db edit made via the Source tab (reviewer's reproduction)", async () => {
    const ctx = getContext();
    const storedDoc = {
      _id: "r", _rev: "1-x", continuous: true,
      source: "https://a/db",
      target: { url: "https://realuser:realpass@remote:5984/db2", headers: {} },
    };
    const apiRequest = vi.fn((method: string, path: string) => {
      if (method === "GET" && path === "/_replicator/r") {
        return Promise.resolve(storedDoc);
      }
      if (method === "PUT" && path === "/_replicator/r") {
        return Promise.resolve({ ok: true, id: "r", rev: "2-y" });
      }
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    const fakeApi = {
      request: apiRequest,
      currentBaseUrl: STUB_SERVER.url,
    } as unknown as ApiClient;
    const realReplication = new ReplicationService(fakeApi);
    const originalReplication = ctx.replication;
    (ctx as unknown as { replication: ReplicationService }).replication =
      realReplication;
    vi.spyOn(ctx.serverMgmt, "listServers").mockResolvedValue({
      servers: [STUB_SERVER],
      nextBookmark: "",
    });
    vi.spyOn(ctx.serverMgmt, "getDatabases").mockResolvedValue([{ name: "db" }]);

    try {
      el = document.createElement("cca-repl-editor") as CcaReplEditor;
      (el as unknown as { serverId: string }).serverId = "s";
      (el as unknown as { replId: string }).replId = "r";
      document.body.appendChild(el);
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;

      (el as unknown as { activeTab: string }).activeTab = "source";
      await el.updateComplete;
      const parsed = JSON.parse(
        (el as unknown as { sourceDocJson: string }).sourceDocJson,
      ) as { target: { url: string } };
      expect(parsed.target.url).toBe("https://***@remote:5984/db2");
      parsed.target.url = "https://***@remote:5984/mirror"; // db only, same host
      (el as unknown as { sourceDocJson: string }).sourceDocJson =
        JSON.stringify(parsed);

      const form = el.shadowRoot!.querySelector(
        "#replication-editor-form",
      ) as HTMLFormElement;
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;

      expect(
        (el as unknown as { error: string }).error,
        `save unexpectedly blocked`,
      ).toBe("");

      const putCall = apiRequest.mock.calls.find((c) => c[0] === "PUT");
      expect(putCall, "no PUT sent").toBeDefined();
      const body = putCall![2] as { target: { url: string } };
      expect(body.target.url).toBe(
        "https://realuser:realpass@remote:5984/mirror",
      );
      expect(body.target.url).not.toContain("***");
    } finally {
      (ctx as unknown as { replication: ReplicationService }).replication =
        originalReplication;
    }
  });
});

describe("cca-repl-editor masked source credentials", () => {
  let el: CcaReplEditor;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  // Mirrors "cca-repl-editor masked target credentials" above (finding #3 of the Phase 4
  // final-review wave): a loaded SOURCE endpoint can carry userinfo too (any externally-created
  // pull replication), so the identical masked-credential safety rail on effectiveTargetUrl()
  // must also guard effectiveSourceUrl() — see `loadedSourceUrl` and computeSafetyRails.
  function maskedSourceDoc() {
    return stubDoc({
      source: { url: "https://***@remote:5984/db1", headers: {} },
      target: { url: "https://a/db2", headers: {} },
    });
  }

  async function loadMaskedSourceEditor(): Promise<{
    el: CcaReplEditor;
    stubs: ReturnType<typeof stubReplEditorServices>;
  }> {
    const stubs = stubReplEditorServices({ doc: maskedSourceDoc() });
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

  it("does not block saving when the masked source endpoint is left untouched", async () => {
    const loaded = await loadMaskedSourceEditor();
    el = loaded.el;

    const state = el as unknown as {
      computeSafetyRails(): { blocking: string[]; warnings: string[] };
    };
    expect(
      state.computeSafetyRails().blocking.some((b) => /masked credential/i.test(b)),
    ).toBe(false);

    const form = el.shadowRoot!.querySelector(
      "#replication-editor-form",
    ) as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    expect(
      loaded.stubs.updateReplication,
      `save blocked: ${(el as unknown as { error: string }).error}`,
    ).toHaveBeenCalled();
  });

  it("blocks a save when the Source tab's edited source points at a different server", async () => {
    const loaded = await loadMaskedSourceEditor();
    el = loaded.el;

    (el as unknown as { activeTab: string }).activeTab = "source";
    await el.updateComplete;
    const parsed = JSON.parse(
      (el as unknown as { sourceDocJson: string }).sourceDocJson,
    ) as { source: { url: string } };
    expect(parsed.source.url).toBe("https://***@remote:5984/db1");
    parsed.source.url = "https://***@otherhost:5984/mirror";
    (el as unknown as { sourceDocJson: string }).sourceDocJson =
      JSON.stringify(parsed);

    const form = el.shadowRoot!.querySelector(
      "#replication-editor-form",
    ) as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    expect((el as unknown as { error: string }).error).toMatch(/masked credential/i);
    expect(loaded.stubs.updateReplication).not.toHaveBeenCalled();
  });
});

describe("cca-repl-editor clearing a stored constraint", () => {
  let el: CcaReplEditor;
  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  // Finding #1 of the Phase 4 final-review wave: omitting a cleared managed key let
  // ReplicationService.updateReplication's `{...stored, ...safeDoc}` merge silently restore the
  // old value while the UI still reported success. Drives the REAL ReplicationService (mocked
  // only at the ApiClient boundary) so the assertion covers the full round trip, not just what
  // the editor builds client-side.
  it("writes an absent filter — not a restored stale one — when a stored filter is cleared, and keeps an untouched tuning field", async () => {
    const ctx = getContext();
    const storedDoc = {
      _id: "r", _rev: "1-x", continuous: true,
      source: "https://a/db", target: "https://a/db2",
      filter: "ddoc/by_status",
      worker_processes: 4, // untouched tuning field: the editor has no control for it, but the
                            // existing Task-1 read-modify-write guarantee must not regress.
    };
    const apiRequest = vi.fn((method: string, path: string) => {
      if (method === "GET" && path === "/_replicator/r") return Promise.resolve(storedDoc);
      if (method === "PUT" && path === "/_replicator/r") {
        return Promise.resolve({ ok: true, id: "r", rev: "2-y" });
      }
      return Promise.reject(new Error(`unexpected ${method} ${path}`));
    });
    const fakeApi = { request: apiRequest, currentBaseUrl: STUB_SERVER.url } as unknown as ApiClient;
    const originalReplication = ctx.replication;
    (ctx as unknown as { replication: ReplicationService }).replication =
      new ReplicationService(fakeApi);
    vi.spyOn(ctx.serverMgmt, "listServers").mockResolvedValue({
      servers: [STUB_SERVER],
      nextBookmark: "",
    });
    vi.spyOn(ctx.serverMgmt, "getDatabases").mockResolvedValue([{ name: "db" }]);

    try {
      el = document.createElement("cca-repl-editor") as CcaReplEditor;
      (el as unknown as { serverId: string }).serverId = "s";
      (el as unknown as { replId: string }).replId = "r";
      document.body.appendChild(el);
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;

      expect((el as unknown as { filterFn: string }).filterFn).toBe("ddoc/by_status");

      // User clears the filter on the Design tab.
      (el as unknown as { filterFn: string }).filterFn = "";
      await el.updateComplete;

      const form = el.shadowRoot!.querySelector(
        "#replication-editor-form",
      ) as HTMLFormElement;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await el.updateComplete;
      await Promise.resolve();
      await el.updateComplete;

      expect((el as unknown as { error: string }).error, "save unexpectedly blocked").toBe("");

      const putCall = apiRequest.mock.calls.find((c) => c[0] === "PUT");
      expect(putCall, "no PUT sent").toBeDefined();
      const body = putCall![2] as Record<string, unknown>;
      expect(body).not.toHaveProperty("filter");
      expect(body.worker_processes).toBe(4);
    } finally {
      (ctx as unknown as { replication: ReplicationService }).replication =
        originalReplication;
    }
  });

  it("never sends a managed key as null when it was never present on the loaded doc", async () => {
    // Default stubDoc() carries no selector/filter/doc_ids/query_params/winning_revs_only/
    // since_seq at all — none of them were ever "loaded", so clearing (or simply never setting)
    // the corresponding form field must leave the key omitted, not nulled.
    const stubs = stubReplEditorServices({ doc: stubDoc() });
    el = document.createElement("cca-repl-editor") as CcaReplEditor;
    (el as unknown as { serverId: string }).serverId = "s";
    (el as unknown as { replId: string }).replId = "r";
    document.body.appendChild(el);
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;
    await Promise.resolve();
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
      stubs.updateReplication,
      `save blocked: ${(el as unknown as { error: string }).error}`,
    ).toHaveBeenCalled();
    const body = stubs.updateReplication.mock.calls[0][2] as Record<string, unknown>;
    for (const key of ["filter", "selector", "doc_ids", "query_params", "since_seq", "winning_revs_only"]) {
      expect(body).not.toHaveProperty(key);
    }
  });
});
