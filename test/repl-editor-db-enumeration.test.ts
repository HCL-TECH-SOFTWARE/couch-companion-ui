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
 * `GET /_all_dbs` is admin-only by CouchDB's own default, so a non-admin gets 401 and the
 * editor's `loadDatabases` used to swallow it with a `log.warn` — leaving the Source Database
 * dropdown silently empty with no way forward. These tests pin what the editor must hand the
 * source section instead: an explicit "the list is unavailable, here is why" state for a
 * refusal, and a visible error for a genuine fault. See src/services/db-enumeration.ts.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { LitElement } from "lit";
import "../src/plugins/replication/repl-editor.js";
import type { CcaReplEditor } from "../src/plugins/replication/repl-editor.js";
import { ApiError } from "../src/services/api-error";
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
  "cca-repl-issues-panel",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends Stub {});
  }
}

type SourceSection = HTMLElement & {
  databases: string[];
  databasesUnavailable: boolean;
  databasesReason: string;
};

function sourceSection(el: CcaReplEditor): SourceSection {
  const found = el.shadowRoot?.querySelector("cca-repl-source-section");
  if (!found) throw new Error("expected cca-repl-source-section");
  return found as SourceSection;
}

/** Mounts the editor in edit mode (the path that loads the source server's databases). */
async function loadEditor(
  failure?: unknown,
): Promise<CcaReplEditor> {
  const stubs = stubReplEditorServices({ doc: stubDoc() });
  if (failure !== undefined) {
    stubs.getDatabases.mockRejectedValue(failure);
  }
  const el = document.createElement("cca-repl-editor") as CcaReplEditor;
  (el as unknown as { serverId: string }).serverId = "s";
  (el as unknown as { replId: string }).replId = "r";
  document.body.appendChild(el);
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  await Promise.resolve();
  await el.updateComplete;
  return el;
}

async function toastSpy() {
  return vi.spyOn(await import("../src/components/cca-toast.js"), "toast");
}

describe("cca-repl-editor database enumeration", () => {
  let el: CcaReplEditor;

  afterEach(() => {
    el?.remove();
    vi.restoreAllMocks();
  });

  it("hands the fetched list to the source section and reports it available", async () => {
    el = await loadEditor();

    await vi.waitFor(() =>
      expect(sourceSection(el).databases).toEqual(["db"]),
    );
    expect(sourceSection(el).databasesUnavailable).toBe(false);
    expect(sourceSection(el).databasesReason).toBe("");
  });

  it("marks the list unavailable with an explanation when _all_dbs answers 401", async () => {
    const toast = await toastSpy();
    el = await loadEditor(
      new ApiError(401, "unauthorized: You are not a server admin."),
    );

    await vi.waitFor(() =>
      expect(sourceSection(el).databasesUnavailable).toBe(true),
    );
    expect(sourceSection(el).databases).toEqual([]);
    expect(sourceSection(el).databasesReason).toMatch(
      /server-administrator action/i,
    );
    // A refusal is expected on a stock CouchDB, and the field explains itself —
    // an error toast on every visit would be noise, not information.
    expect(toast).not.toHaveBeenCalled();
  });

  it("treats a 403 the same way (a proxy may substitute it for the same refusal)", async () => {
    el = await loadEditor(new ApiError(403, "forbidden"));

    await vi.waitFor(() =>
      expect(sourceSection(el).databasesUnavailable).toBe(true),
    );
    expect(sourceSection(el).databasesReason).not.toBe("");
  });

  it("surfaces a non-denial failure to the user instead of only logging it", async () => {
    const toast = await toastSpy();
    el = await loadEditor(new ApiError(500, "Internal server error"));

    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.stringContaining("Internal server error"),
        "error",
      ),
    );
    // …and the user still gets a way to name a database by hand rather than a
    // dropdown that can never be filled.
    expect(sourceSection(el).databasesUnavailable).toBe(true);
  });
});
