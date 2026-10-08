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
import "../src/plugins/replication/repl-db-browser";
import type { CcaReplDbBrowser } from "../src/plugins/replication/repl-db-browser";
import {
  CORS_HELP_URL,
  COUCHDB_CORS_DOCS_URL,
  describeEndpointFailure,
} from "../src/plugins/replication/endpoint-errors";
import { ApiError } from "../src/services/api-error";
import { getContext } from "../src/context";

describe("describeEndpointFailure", () => {
  it("tells a 401 as a credentials story, not CORS", () => {
    const f = describeEndpointFailure(new ApiError(401, "Unauthorized", {}));
    expect(f.detail).toMatch(/administrator/i);
    expect(f.detail).toContain(
      "Check the credentials entered in the Authentication dialog for this endpoint.",
    );
    expect(f.corsRelated).toBe(false);
  });

  it("treats a fetch TypeError as CORS-or-unreachable", () => {
    const f = describeEndpointFailure(new TypeError("Failed to fetch"));
    expect(f.corsRelated).toBe(true);
    expect(f.detail).toContain("CORS");
  });

  it("relays the message of any other failure", () => {
    const f = describeEndpointFailure(new ApiError(500, "boom", {}));
    expect(f.detail).toBe("HTTP 500: boom");
    expect(f.corsRelated).toBe(false);
  });

  it("routes a 404 through the tailored not-found copy", () => {
    const f = describeEndpointFailure(new ApiError(404, "Not Found", {}));
    expect(f.detail).toMatch(/no database/i);
    expect(f.corsRelated).toBe(false);
  });

  it("keeps plain errors free of a status prefix", () => {
    expect(describeEndpointFailure(new Error("odd")).detail).toBe("odd");
  });
});

const flush = async (el: CcaReplDbBrowser) => {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r));
  await el.updateComplete;
};

async function mount(): Promise<CcaReplDbBrowser> {
  const el = document.createElement("cca-repl-db-browser") as CcaReplDbBrowser;
  el.endpoint = { serverUrl: "http://remote:5984", headers: {} };
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

const dialogOf = (el: CcaReplDbBrowser) =>
  el.shadowRoot!.querySelector("wa-dialog") as HTMLElement & { open: boolean };

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("cca-repl-db-browser", () => {
  it("lists databases with document counts and picks one", async () => {
    vi.spyOn(getContext().replication, "listDatabases").mockResolvedValue([
      { db_name: "crm", doc_count: 42 },
      { db_name: "orders", doc_count: 7 },
    ]);
    const el = await mount();
    const picks: unknown[] = [];
    el.addEventListener("cca-db-browse-pick", (e) => picks.push((e as CustomEvent).detail));
    await el.show();
    await flush(el);
    const text = el.shadowRoot!.textContent!;
    expect(text).toContain("crm");
    expect(text).toContain("42");
    expect(dialogOf(el).open).toBe(true);
    el.shadowRoot!.querySelector<HTMLElement>('[data-db="crm"]')!.click();
    expect(picks).toEqual([{ database: "crm" }]);
    expect(dialogOf(el).open).toBe(false);
  });

  it("shows an em dash for a database without a count", async () => {
    vi.spyOn(getContext().replication, "listDatabases").mockResolvedValue([
      { db_name: "mystery" },
    ]);
    const el = await mount();
    await el.show();
    await flush(el);
    expect(el.shadowRoot!.querySelector(".count")!.textContent).toBe("—");
  });

  it("says so when the server has no databases", async () => {
    vi.spyOn(getContext().replication, "listDatabases").mockResolvedValue([]);
    const el = await mount();
    await el.show();
    await flush(el);
    expect(el.shadowRoot!.textContent).toContain("This server has no databases.");
  });

  it("explains a 401 with the credentials story and no CORS links", async () => {
    vi.spyOn(getContext().replication, "listDatabases").mockRejectedValue(
      new ApiError(401, "Unauthorized", {}),
    );
    const el = await mount();
    await el.show();
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelector("strong")!.textContent).toBe("The server refused the request");
    expect(root.textContent).toMatch(/administrator/i);
    expect(root.textContent).toContain("Authentication dialog");
    expect(root.querySelector("a")).toBeNull();
  });

  it("explains a TypeError as CORS-or-unreachable with the docs links", async () => {
    vi.spyOn(getContext().replication, "listDatabases").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    const el = await mount();
    await el.show();
    await flush(el);
    const root = el.shadowRoot!;
    expect(root.querySelector("strong")!.textContent).toBe("Could not reach the server");
    expect(root.textContent).toContain("CORS");
    const link = root.querySelector<HTMLAnchorElement>(`a[href="${CORS_HELP_URL}"]`)!;
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(root.querySelector(`a[href="${COUCHDB_CORS_DOCS_URL}"]`)).not.toBeNull();
  });

  it("reloads when shown again after a failure", async () => {
    const spy = vi
      .spyOn(getContext().replication, "listDatabases")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce([{ db_name: "crm", doc_count: 1 }]);
    const el = await mount();
    await el.show();
    await flush(el);
    expect(el.shadowRoot!.querySelector("strong")).not.toBeNull();
    await el.show();
    await flush(el);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(el.shadowRoot!.querySelector('[data-db="crm"]')).not.toBeNull();
    expect(el.shadowRoot!.querySelector("strong")).toBeNull();
  });

  it("ignores a stale response and a stale rejection from an earlier show()", async () => {
    let resolveA!: (v: { db_name: string }[]) => void;
    let rejectB!: (e: unknown) => void;
    vi.spyOn(getContext().replication, "listDatabases")
      .mockImplementationOnce(() => new Promise((res, rej) => { rejectB = rej; void res; }))
      .mockImplementationOnce(() => new Promise((res) => { resolveA = res; }));
    const el = await mount();
    const first = el.show();
    const second = el.show();
    resolveA([{ db_name: "fresh" }]);
    await second;
    rejectB(new TypeError("Failed to fetch"));
    await first;
    await flush(el);
    expect(el.shadowRoot!.querySelector('[data-db="fresh"]')).not.toBeNull();
    expect(el.shadowRoot!.querySelector("strong")).toBeNull();
  });
});
