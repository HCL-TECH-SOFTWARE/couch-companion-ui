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
 * Unit tests for CcaReplList.
 *
 * Covers the #640 changes (row-click opens the edit form, the Actions column exposes only a
 * delete control, delete asks for confirmation first) and the #685 migration onto
 * ReplicationService — in particular the list and delete failure paths, which used to be
 * swallowed by a catch-less `try/finally`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockInstance } from "vitest";
import { LitElement, render } from "lit";
import { getContext } from "../src/context";
import { ApiError } from "../src/services/api-error";
import type { TableColumn } from "../src/components/cca-data-table.js";
import type { ReplicatorDoc } from "../src/plugins/replication/types.js";
import "../src/plugins/replication/repl-list.js";
import type { CcaReplList } from "../src/plugins/replication/repl-list.js";
import "../src/components/cca-header.js";
import "../src/components/cca-toast.js";
import type { CcaToast } from "../src/components/cca-toast.js";

// Stub wa-*. cca-data-table is deliberately NOT stubbed here: repl-list.js's own import of it
// registers the real element before this module body runs, so a later `customElements.define`
// attempt is silently skipped (custom elements cannot be redefined) — the real, shadow-DOM-
// encapsulated component always wins. State-column assertions below instead drill into its own
// `shadowRoot`, exactly as test/idp-list.test.ts does for the same reason.
class WaStub extends LitElement {
  createRenderRoot() {
    return this;
  }
}
for (const tag of ["wa-button", "wa-icon", "wa-dialog"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

const MOCK: ReplicatorDoc[] = [
  {
    source: "https://a/db",
    target: { url: "https://b/db" },
    continuous: true,
    cca_server_id: "srv1",
    cca_server_name: "Server 1",
    replicator_doc_id: "repl:1",
  },
];

/** The private surface the tests drive directly. */
type Internals = {
  _confirmDelete: ReplicatorDoc | null;
  _deleting: boolean;
  loading: boolean;
  load: () => Promise<void>;
  _doDelete: () => Promise<void>;
};

let mounted: HTMLElement[] = [];

function mount(serverId = "$all"): CcaReplList {
  const el = document.createElement("cca-repl-list") as CcaReplList;
  (el as unknown as { serverId: string }).serverId = serverId;
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

/** Wait for connectedCallback's load() + the re-render it triggers. */
async function settle(el: CcaReplList) {
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
}

describe("cca-repl-list", () => {
  let el: CcaReplList;
  let internals: Internals;
  let toastEl: CcaToast;
  let listSpy: MockInstance;
  let deleteSpy: MockInstance;

  beforeEach(async () => {
    // Mounted before anything can toast. `toast()` buffers messages when no <cca-toast> exists and
    // flushes them into the next one to connect, which would leak toasts across tests.
    toastEl = document.createElement("cca-toast") as CcaToast;
    document.body.appendChild(toastEl);
    mounted.push(toastEl);
    await toastEl.updateComplete;

    listSpy = vi
      .spyOn(getContext().replication, "listReplications")
      .mockResolvedValue(structuredClone(MOCK));
    deleteSpy = vi
      .spyOn(getContext().replication, "deleteReplication")
      .mockResolvedValue(undefined);

    el = mount();
    internals = el as unknown as Internals;
    await settle(el);
  });

  afterEach(() => {
    for (const node of mounted) {
      node.remove();
    }
    mounted = [];
    vi.restoreAllMocks();
  });

  function table(
    host: CcaReplList = el,
  ): (LitElement & { rows: ReplicatorDoc[]; columns: TableColumn<ReplicatorDoc>[] }) | null {
    return host.shadowRoot!.querySelector("cca-data-table") as never;
  }

  const toastText = (variant: "success" | "error"): string | undefined =>
    toastEl.shadowRoot!.querySelector(`.toast.${variant}`)?.textContent ?? undefined;

  it("renders a cca-data-table populated with replications", () => {
    const t = table();
    expect(t).not.toBeNull();
    expect(listSpy).toHaveBeenCalledOnce();
    expect(t!.rows).toHaveLength(1);
    expect(t!.rows[0].replicator_doc_id).toBe("repl:1");
  });

  it("opens the edit form when a row is clicked", () => {
    const nav = vi
      .spyOn(getContext().router, "navigate")
      .mockImplementation(() => {});
    table()!.dispatchEvent(
      new CustomEvent("cca-row-click", { detail: MOCK[0] }),
    );
    expect(nav).toHaveBeenCalledWith("/replications/srv1/edit/repl%3A1");
  });

  it("exposes only a delete control in the Actions column", () => {
    const cols = table()!.columns;
    const actions = cols.filter((c) => c.label === "Actions");
    expect(actions).toHaveLength(1);
    // There must be no separate view/edit columns any more.
    expect(cols.map((c) => c.label)).toEqual([
      "Source",
      "Target",
      "Type",
      "State",
      "Actions",
    ]);

    const host = document.createElement("div");
    render(actions[0].render!(MOCK[0]) as never, host);
    expect(host.querySelectorAll("wa-button")).toHaveLength(1);
    expect(host.querySelector('wa-icon[name="trash-can"]')).not.toBeNull();
  });

  it("gives the delete control the shared outlined/row-action-button treatment (#112)", () => {
    const actions = table()!.columns.find((c) => c.label === "Actions")!;
    const host = document.createElement("div");
    render(actions.render!(MOCK[0]) as never, host);
    const btn = host.querySelector("wa-button")!;

    expect(btn.getAttribute("appearance")).toBe("outlined");
    expect(btn.classList.contains("row-action-button")).toBe(true);
  });

  it("asks for confirmation on trash click instead of deleting immediately", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted.push(host);
    const actions = table()!.columns.find((c) => c.label === "Actions")!;
    render(actions.render!(MOCK[0]) as never, host);

    expect(internals._confirmDelete).toBeNull();

    host
      .querySelector("wa-button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(internals._confirmDelete).toBe(MOCK[0]);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("registers a New Replication action in the header", async () => {
    const header = document.createElement("cca-header");
    document.body.appendChild(header);
    mounted.push(header);
    await (header as unknown as LitElement).updateComplete;

    const el2 = mount("srv1");
    await el2.updateComplete;
    await (header as unknown as LitElement).updateComplete;

    const action = header.shadowRoot!.querySelector(
      'cca-action[tooltip="New Replication"]',
    );
    expect(action).not.toBeNull();
  });

  it("deletes only after the confirmation is accepted, then reloads", async () => {
    internals._confirmDelete = MOCK[0];
    await internals._doDelete();

    // Raw ids: ReplicationService owns the URL encoding.
    expect(deleteSpy).toHaveBeenCalledWith("srv1", "repl:1");
    expect(toastText("success")).toMatch(/Replication deleted/);
    expect(internals._confirmDelete).toBeNull();
    expect(internals._deleting).toBe(false);
    expect(listSpy).toHaveBeenCalledTimes(2); // initial load + reload
  });

  it("reports a failed delete instead of announcing success", async () => {
    deleteSpy.mockRejectedValue(new ApiError(409, "Document update conflict"));

    internals._confirmDelete = MOCK[0];
    await internals._doDelete();
    await toastEl.updateComplete;

    expect(toastText("success")).toBeUndefined();
    expect(toastText("error")).toMatch(/Document update conflict/);
    // The dialog must be closed before the toast fires: wa-dialog uses showModal(), which dims
    // everything outside the top layer and makes it inert — an error raised while it is still
    // open cannot be dismissed or hovered to pause.
    expect(internals._confirmDelete).toBeNull();
    expect(internals._deleting).toBe(false);
    expect(listSpy).toHaveBeenCalledOnce(); // no reload after a failure
  });

  it("refuses to delete a document that is missing its ids", async () => {
    internals._confirmDelete = { ...MOCK[0], replicator_doc_id: undefined };
    await internals._doDelete();
    await toastEl.updateComplete;

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(toastText("error")).toMatch(/missing its server or document id/);
    expect(internals._confirmDelete).toBeNull();
  });

  it("surfaces a failed load and keeps the rows already on screen", async () => {
    expect(table()!.rows).toHaveLength(1);

    listSpy.mockRejectedValue(new ApiError(500, "Internal Server Error"));
    await internals.load();
    await el.updateComplete;
    await toastEl.updateComplete;

    expect(toastText("error")).toMatch(/Internal Server Error/);
    expect(internals.loading).toBe(false);
    expect(table()!.rows).toHaveLength(1);
  });

  it("renders scheduler state and shows the error for a crashing replication", async () => {
    listSpy.mockResolvedValue([
      {
        ...MOCK[0],
        _id: "ok1",
        replicator_doc_id: "ok1",
        replication_state: "running",
        docs_written: 12,
      },
      {
        ...MOCK[0],
        _id: "bad1",
        replicator_doc_id: "bad1",
        replication_state: "crashing",
        error_count: 3,
        scheduler_error: "unauthorized: nope",
      },
    ]);
    const el2 = mount();

    // cca-data-table renders into its own shadow root (opaque to el2.shadowRoot), and delays its
    // first real render by a microtask (see CcaDataTable.updated) — poll rather than assume one
    // settle() suffices, mirroring test/idp-list.test.ts.
    await vi.waitFor(() => {
      const text = el2.shadowRoot!.querySelector("cca-data-table")!.shadowRoot!.textContent ?? "";
      expect(text).toContain("running");
    });
    const text =
      el2.shadowRoot!.querySelector("cca-data-table")!.shadowRoot!.textContent ?? "";
    expect(text).toContain("crashing");
    expect(text).toMatch(/unauthorized/);
  });

  it("renders an em dash when the scheduler knows nothing about a document", async () => {
    listSpy.mockResolvedValue([{ ...MOCK[0], replication_state: undefined }]);
    const el2 = mount();

    await vi.waitFor(() => {
      const text = el2.shadowRoot!.querySelector("cca-data-table")!.shadowRoot!.textContent ?? "";
      expect(text).toContain("—");
    });
  });
});
