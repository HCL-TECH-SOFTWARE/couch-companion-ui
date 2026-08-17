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
 * Managing attachments: upload, download and delete (#120).
 *
 * #84 put a paperclip on the screens that list documents; this is the half that changes
 * something. Four operations, and one problem underneath all of them — every write bumps
 * `_rev` while the editor may be holding unsaved JSON — which the editor answers by refusing
 * to write while the buffer differs from the stored document, and re-reading the document
 * after every write that lands.
 *
 * The request and error shapes asserted here were taken from a real CouchDB 3.5.2, not from
 * the documentation: a stale-revision `PUT`/`DELETE` answers 409 `{"error":"conflict"}`, an
 * oversized attachment answers 413 `{"error":"attachment_too_large","reason":"<filename>"}`
 * (the reason really is only the filename, which is why nothing shows it raw), and a
 * standalone attachment `PUT` answers 201 whether or not it replaced something.
 *
 * There is deliberately no viewer here, and no test asking for one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LitElement } from "lit";

// The real wa-icon fetches each SVG; happy-dom has no server to answer, so the in-flight
// requests abort on teardown and log DOMException noise. Must precede the imports that pull
// it in transitively.
vi.mock("@awesome.me/webawesome/dist/components/icon/icon.js", () => ({}));
// Monaco crashes in happy-dom (canvas pixel ratio); the editor renders it.
vi.mock("../src/components/cca-monaco-editor.js", () => ({}));

import { getContext } from "../src/context";
import { ApiClient } from "../src/services/api-client";
import { ApiError } from "../src/services/api-error";
import {
  AttachmentService,
  attachmentErrorMessage,
  attachmentPath,
  listAttachments,
} from "../src/services/attachments";
import { jsonResponse, couchError } from "./helpers/response";
import type { CcaDocEditor } from "../src/plugins/db-mgmt/doc-editor.js";
import "../src/plugins/db-mgmt/doc-editor.js";
import "../src/components/cca-toast.js";

// ---------------------------------------------------------------------------
// Stubs: the editor's own template only needs these tags to exist and to render
// their children where the queries below can find them.
// ---------------------------------------------------------------------------
class WaStubAttachments extends LitElement {
  createRenderRoot() {
    return this;
  }
}

for (const tag of [
  "wa-button",
  "wa-dialog",
  "wa-icon",
  "wa-spinner",
  "wa-format-bytes",
  "cca-monaco-editor",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStubAttachments {});
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A document with two attachments, exactly as CouchDB 3.5.2 returns the stubs. */
const DOC_V1 = {
  _id: "doc1",
  _rev: "2-93d8",
  title: "probe",
  _attachments: {
    "notes.txt": {
      content_type: "text/plain",
      revpos: 2,
      digest: "md5-yeCY/YBrDRwAEyX6ppHg9A==",
      length: 65,
      stub: true,
    },
    "logo.png": {
      content_type: "image/png",
      revpos: 2,
      digest: "md5-aaaa",
      length: 903,
      stub: true,
    },
  },
};

/** The same document one attachment later — what the re-read after a write returns. */
const DOC_V2 = {
  ...DOC_V1,
  _rev: "3-cb23",
  _attachments: {
    ...DOC_V1._attachments,
    "report.pdf": {
      content_type: "application/pdf",
      revpos: 3,
      digest: "md5-bbbb",
      length: 4096,
      stub: true,
    },
  },
};

const file = (name: string, type = "text/plain", body = "hello") =>
  new File([body], name, { type });

// ===========================================================================
describe("ApiClient: binary bodies and blob responses (#120)", () => {
  let client: ApiClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new ApiClient("http://test");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The single argument object the client handed to fetch. */
  const callInit = () => fetchSpy.mock.calls[0][1] as RequestInit;
  const callUrl = () => fetchSpy.mock.calls[0][0] as string;
  const callHeaders = () => callInit().headers as Record<string, string>;

  describe("requestBinary", () => {
    beforeEach(() => {
      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse({ ok: true, id: "doc1", rev: "3-cb23" }, 201));
    });

    it("sends the bytes unserialised — a JSON.stringify here would upload the string \"[object File]\"", async () => {
      const f = file("notes.txt");
      await client.requestBinary("PUT", "/db/doc1/notes.txt?rev=2-93d8", f);
      expect(callInit().body).toBe(f);
      expect(typeof callInit().body).not.toBe("string");
    });

    it("labels the body with the file's own type — CouchDB stores it and serves it back", async () => {
      await client.requestBinary(
        "PUT",
        "/db/doc1/logo.png",
        file("logo.png", "image/png"),
      );
      expect(callHeaders()["Content-Type"]).toBe("image/png");
    });

    it("falls back to application/octet-stream for a file the OS could not type", async () => {
      await client.requestBinary("PUT", "/db/doc1/thing.xyz", file("thing.xyz", ""));
      expect(callHeaders()["Content-Type"]).toBe("application/octet-stream");
    });

    it("lets an explicit content type win over the blob's", async () => {
      await client.requestBinary(
        "PUT",
        "/db/doc1/notes.txt",
        file("notes.txt", "text/plain"),
        "text/markdown",
      );
      expect(callHeaders()["Content-Type"]).toBe("text/markdown");
    });

    it("returns CouchDB's JSON answer — the response half is still JSON", async () => {
      const body = await client.requestBinary<{ rev: string }>(
        "PUT",
        "/db/doc1/notes.txt",
        file("notes.txt"),
      );
      expect(body.rev).toBe("3-cb23");
    });

    it("keeps sending credentials and the session's Authorization header", async () => {
      client.setToken("jwt-123");
      await client.requestBinary("PUT", "/db/doc1/notes.txt", file("notes.txt"));
      expect(callInit().credentials).toBe("include");
      expect(callHeaders()["Authorization"]).toBe("Bearer jwt-123");
    });

    it("raises ApiError carrying CouchDB's body, so a 413 can still be told apart", async () => {
      fetchSpy.mockResolvedValue(
        couchError(413, "attachment_too_large", "report.pdf"),
      );
      const err = await client
        .requestBinary("PUT", "/db/doc1/report.pdf", file("report.pdf"))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(413);
      expect((err as ApiError).body).toEqual({
        error: "attachment_too_large",
        reason: "report.pdf",
      });
    });
  });

  describe("requestBlob", () => {
    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("file contents", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      );
    });

    it("returns the bytes rather than trying to parse them as JSON", async () => {
      const { data } = await client.requestBlob("/db/doc1/notes.txt");
      expect(await data.text()).toBe("file contents");
      expect(data.type).toBe("text/plain");
    });

    /**
     * #36: a Content-Type on a bodyless GET takes the request out of the CORS-simple set, so
     * in SPA mode every single read becomes a preflight pair. A download has no body to
     * describe, so it must not carry one.
     */
    it("sends no Content-Type — a download describes nothing to the server (#36)", async () => {
      await client.requestBlob("/db/doc1/notes.txt");
      expect(callInit().method).toBe("GET");
      expect(callHeaders()["Content-Type"]).toBeUndefined();
      expect(callInit().credentials).toBe("include");
    });

    it("honours the base URL, so SPA mode downloads from the chosen server", async () => {
      client.setBaseUrl("https://couch.example.com/");
      await client.requestBlob("/db/doc1/notes.txt");
      expect(callUrl()).toBe("https://couch.example.com/db/doc1/notes.txt");
    });

    it("raises ApiError on a 403 rather than downloading the error page as a file", async () => {
      fetchSpy.mockResolvedValue(
        couchError(403, "forbidden", "You are not allowed to access this db."),
      );
      const err = await client
        .requestBlob("/db/doc1/notes.txt")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(403);
      expect((err as ApiError).message).toBe(
        "You are not allowed to access this db.",
      );
    });
  });

  /**
   * The three entry points share one `send`, so the D9 behaviour has to hold on all of them —
   * it is exactly the sort of thing a second copy of the fetch would have quietly dropped.
   */
  it("still probes /_session before logging out on a 401, on the binary paths too", async () => {
    const onUnauthorized = vi.fn();
    const authed = new ApiClient("http://test", onUnauthorized);
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url.endsWith("/_session")) return couchError(401, "unauthorized", "dead");
      return couchError(401, "unauthorized", "You are not authorized.");
    }) as typeof fetch);

    await expect(
      authed.requestBlob("/db/doc1/notes.txt"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalled();
  });
});

// ===========================================================================
describe("AttachmentService (#120)", () => {
  const api = {
    request: vi.fn(),
    requestBinary: vi.fn(),
    requestBlob: vi.fn(),
  };
  const service = new AttachmentService(api as unknown as ApiClient);

  beforeEach(() => {
    api.request.mockReset().mockResolvedValue({ ok: true, id: "doc1", rev: "4-dddd" });
    api.requestBinary
      .mockReset()
      .mockResolvedValue({ ok: true, id: "doc1", rev: "3-cb23" });
    api.requestBlob
      .mockReset()
      .mockResolvedValue({ data: new Blob(["bytes"]), headers: new Headers() });
  });

  it("downloads with GET /{db}/{docid}/{attname}", async () => {
    const blob = await service.download("mydb", "doc1", "notes.txt");
    expect(api.requestBlob).toHaveBeenCalledWith("/mydb/doc1/notes.txt");
    expect(await blob.text()).toBe("bytes");
  });

  it("uploads with PUT …?rev= and reports the revision the document is now at", async () => {
    const f = file("notes.txt");
    const rev = await service.upload("mydb", "doc1", "notes.txt", f, "2-93d8");
    expect(api.requestBinary).toHaveBeenCalledWith(
      "PUT",
      "/mydb/doc1/notes.txt?rev=2-93d8",
      f,
      undefined,
    );
    expect(rev).toBe("3-cb23");
  });

  it("deletes with DELETE …?rev= and reports the new revision", async () => {
    const rev = await service.remove("mydb", "doc1", "notes.txt", "3-cb23");
    expect(api.request).toHaveBeenCalledWith(
      "DELETE",
      "/mydb/doc1/notes.txt?rev=3-cb23",
    );
    expect(rev).toBe("4-dddd");
  });

  it("sends the revision it was given, never one it fetched for itself", async () => {
    await service.remove("mydb", "doc1", "notes.txt", "1-stale");
    expect(api.request).toHaveBeenCalledWith(
      "DELETE",
      "/mydb/doc1/notes.txt?rev=1-stale",
    );
    // Nothing read the document first — a self-fetched rev would overwrite whoever wrote last.
    expect(api.requestBlob).not.toHaveBeenCalled();
  });

  it("lets a 409 out untouched, so the caller can say what it means", async () => {
    api.requestBinary.mockRejectedValue(
      new ApiError(409, "Document update conflict.", {
        error: "conflict",
        reason: "Document update conflict.",
      }),
    );
    await expect(
      service.upload("mydb", "doc1", "notes.txt", file("notes.txt"), "1-stale"),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ===========================================================================
describe("attachmentPath", () => {
  it("percent-encodes the database, document and attachment names", () => {
    expect(attachmentPath("my db", "doc 1", "my report.txt")).toBe(
      "/my%20db/doc%201/my%20report.txt",
    );
  });

  /**
   * Verified against 3.5.2: PUT of `dir%2Ffile.txt` stores the name `dir/file.txt`, and a GET
   * with the same encoding fetches it back. A raw slash would be read as a path separator.
   */
  it("encodes a slash inside an attachment name rather than letting it split the path", () => {
    expect(attachmentPath("mydb", "doc1", "dir/file.txt")).toBe(
      "/mydb/doc1/dir%2Ffile.txt",
    );
  });

  it("keeps a design document's literal _design/ prefix, as docPath does", () => {
    expect(attachmentPath("mydb", "_design/views", "logo.png")).toBe(
      "/mydb/_design/views/logo.png",
    );
  });
});

// ===========================================================================
describe("listAttachments", () => {
  it("lists name, type and size from the stubs already in hand", () => {
    expect(listAttachments(DOC_V1)).toEqual([
      {
        name: "logo.png",
        contentType: "image/png",
        length: 903,
        digest: "md5-aaaa",
        revpos: 2,
      },
      {
        name: "notes.txt",
        contentType: "text/plain",
        length: 65,
        digest: "md5-yeCY/YBrDRwAEyX6ppHg9A==",
        revpos: 2,
      },
    ]);
  });

  it("sorts by name, so a list does not reshuffle itself after every upload", () => {
    const doc = { _attachments: { "z.txt": {}, "a.txt": {}, "m.txt": {} } };
    expect(listAttachments(doc).map((a) => a.name)).toEqual([
      "a.txt",
      "m.txt",
      "z.txt",
    ]);
  });

  it("falls back to octet-stream and zero for a hand-written stub that says neither", () => {
    expect(listAttachments({ _attachments: { "x.bin": {} } })[0]).toMatchObject({
      contentType: "application/octet-stream",
      length: 0,
    });
  });

  it("is empty for a document with no attachments, and for a malformed one", () => {
    expect(listAttachments({ _id: "a" })).toEqual([]);
    expect(listAttachments({ _attachments: [] })).toEqual([]);
    expect(listAttachments(null)).toEqual([]);
  });
});

// ===========================================================================
describe("attachmentErrorMessage", () => {
  /**
   * CouchDB's `reason` for this one is *the filename alone* — surfacing it verbatim produces
   * "Failed to upload: report.pdf", which names no cause at all.
   */
  it("says the file is over the server's attachment limit, and which setting that is", () => {
    const msg = attachmentErrorMessage(
      new ApiError(413, "report.pdf", {
        error: "attachment_too_large",
        reason: "report.pdf",
      }),
      "upload",
      "report.pdf",
    );
    expect(msg).toContain("too large");
    expect(msg).toContain("max_attachment_size");
    expect(msg).toContain("report.pdf");
  });

  it("names the request-size limit instead when that is the one that tripped", () => {
    const msg = attachmentErrorMessage(
      new ApiError(413, "the request entity is too large", {
        error: "too_large",
        reason: "the request entity is too large",
      }),
      "upload",
      "big.bin",
    );
    expect(msg).toContain("max_http_request_size");
  });

  it("still says too large for a 413 whose body is not CouchDB's (a proxy in front of it)", () => {
    const msg = attachmentErrorMessage(
      new ApiError(413, "Request Entity Too Large", {
        reason: "Request Entity Too Large",
      }),
      "upload",
      "big.bin",
    );
    expect(msg).toContain("too large");
  });

  it("turns a 409 into the thing to do about it", () => {
    const msg = attachmentErrorMessage(
      new ApiError(409, "Document update conflict.", {
        error: "conflict",
        reason: "Document update conflict.",
      }),
      "delete",
      "notes.txt",
    );
    expect(msg).toContain("changed on the server");
    expect(msg).toContain("Reload");
  });

  it("passes CouchDB's own words through for everything else", () => {
    const msg = attachmentErrorMessage(
      new ApiError(403, "You are not allowed to access this db.", {
        error: "forbidden",
        reason: "You are not allowed to access this db.",
      }),
      "download",
      "notes.txt",
    );
    expect(msg).toContain("You are not allowed to access this db.");
  });
});

// ===========================================================================
describe("doc-editor's attachment panel (#120)", () => {
  let element: CcaDocEditor;
  let getDoc: ReturnType<typeof vi.spyOn>;
  let toastSpy: ReturnType<typeof vi.spyOn>;

  const q = (sel: string) => element.shadowRoot!.querySelector(sel);
  const qa = (sel: string) => [...element.shadowRoot!.querySelectorAll(sel)];
  const rowNames = () =>
    qa("[data-attachment-row]").map((r) => r.getAttribute("data-attachment-row"));
  const click = (sel: string) => (q(sel) as HTMLElement).click();
  const toasts = () => toastSpy.mock.calls.map((c) => String(c[0]));

  async function settle() {
    for (let i = 0; i < 6; i++) {
      await element.updateComplete;
      await Promise.resolve();
    }
    await new Promise((r) => setTimeout(r, 0));
    await element.updateComplete;
  }

  async function mount(docId = "doc1") {
    element = document.createElement("cca-doc-editor") as CcaDocEditor;
    element.serverId = "srv1";
    element.dbName = "mydb";
    element.docId = docId;
    document.body.appendChild(element);
    await settle();
  }

  /** Types into the buffer, the way the Monaco element reports it. */
  async function typeInEditor(text: string) {
    q("cca-monaco-editor")!.dispatchEvent(
      new CustomEvent("change", {
        detail: { value: text },
        bubbles: true,
        composed: true,
      }),
    );
    await settle();
  }

  /** Hands the component a file as if the user had picked it. */
  async function pick(f: File) {
    const input = q("[data-attachment-file-input]") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [f], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  }

  beforeEach(async () => {
    if (!document.querySelector("cca-router-provider")) {
      document.body.appendChild(document.createElement("cca-router-provider"));
    }
    toastSpy = vi.spyOn(await import("../src/components/cca-toast.js"), "toast");
    getDoc = vi
      .spyOn(getContext().dbMgmt, "getDoc")
      .mockResolvedValue(structuredClone(DOC_V1) as never);
    vi.spyOn(getContext().attachments, "upload").mockResolvedValue("3-cb23");
    vi.spyOn(getContext().attachments, "remove").mockResolvedValue("3-cb23");
    vi.spyOn(getContext().attachments, "download").mockResolvedValue(
      new Blob(["file contents"], { type: "text/plain" }),
    );
  });

  afterEach(() => {
    element?.remove();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("listing", () => {
    it("lists what the document already carries, from the stubs the load returned", async () => {
      await mount();
      expect(rowNames()).toEqual(["logo.png", "notes.txt"]);
      expect(q("[data-attachment-row='notes.txt']")!.textContent).toContain(
        "text/plain",
      );
      // wa-format-bytes renders into its own shadow root, so the value attribute is the
      // assertable part (the same reason the dashboard's storage tests read it).
      expect(
        q("[data-attachment-row='logo.png'] wa-format-bytes")!.getAttribute(
          "value",
        ),
      ).toBe("903");
    });

    it("costs no extra request — the stubs came with the document", async () => {
      await mount();
      expect(getDoc).toHaveBeenCalledOnce();
    });

    it("says so, rather than showing an empty panel, when there are none", async () => {
      getDoc.mockResolvedValue({ _id: "doc1", _rev: "1-a" } as never);
      await mount();
      expect(rowNames()).toEqual([]);
      expect(q("[data-attachments-empty]")).not.toBeNull();
    });

    it("in create mode says to save first, and offers no upload button to press", async () => {
      await mount("new");
      expect(q("[data-attachments-blocked]")!.textContent).toContain(
        "Save the document",
      );
      expect((q("[data-attachment-add]") as HTMLElement).hasAttribute("disabled")).toBe(
        true,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("download", () => {
    it("fetches through the app's client and hands the bytes to the browser", async () => {
      const createUrl = vi
        .spyOn(URL, "createObjectURL")
        .mockReturnValue("blob:fake");
      const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click");
      await mount();

      click("[data-attachment-row='notes.txt'] [data-attachment-download]");
      await settle();

      expect(getContext().attachments.download).toHaveBeenCalledWith(
        "mydb",
        "doc1",
        "notes.txt",
      );
      expect(createUrl).toHaveBeenCalledOnce();
      expect(anchorClick).toHaveBeenCalledOnce();
      const link = anchorClick.mock.contexts?.[0] as HTMLAnchorElement | undefined;
      if (link) expect(link.download).toBe("notes.txt");
    });

    it("is allowed with unsaved edits — reading bytes needs no revision", async () => {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
      await mount();
      await typeInEditor('{"title":"edited"}');

      expect(
        (
          q(
            "[data-attachment-row='notes.txt'] [data-attachment-download]",
          ) as HTMLElement
        ).hasAttribute("disabled"),
      ).toBe(false);
      click("[data-attachment-row='notes.txt'] [data-attachment-download]");
      await settle();
      expect(getContext().attachments.download).toHaveBeenCalled();
    });

    it("reports a refusal instead of saving an error page under the file's name", async () => {
      vi.spyOn(getContext().attachments, "download").mockRejectedValue(
        new ApiError(403, "You are not allowed to access this db.", {
          error: "forbidden",
        }),
      );
      await mount();
      click("[data-attachment-row='notes.txt'] [data-attachment-download]");
      await settle();
      expect(toasts().join(" ")).toContain("You are not allowed to access this db.");
    });
  });

  // -------------------------------------------------------------------------
  describe("upload", () => {
    it("uploads a new name straight away, against the loaded revision", async () => {
      await mount();
      await pick(file("report.pdf", "application/pdf"));

      expect(getContext().attachments.upload).toHaveBeenCalledWith(
        "mydb",
        "doc1",
        "report.pdf",
        expect.any(File),
        "2-93d8",
      );
    });

    it("re-reads the document afterwards, so the list and the badge follow", async () => {
      getDoc
        .mockResolvedValueOnce(structuredClone(DOC_V1) as never)
        .mockResolvedValueOnce(structuredClone(DOC_V2) as never);
      await mount();
      expect(rowNames()).toEqual(["logo.png", "notes.txt"]);

      await pick(file("report.pdf", "application/pdf"));

      expect(getDoc).toHaveBeenCalledTimes(2);
      expect(rowNames()).toEqual(["logo.png", "notes.txt", "report.pdf"]);
      // #84's indicator counts what is now there.
      expect(
        (q("cca-attachment-count") as HTMLElement & { count: number }).count,
      ).toBe(3);
    });

    /**
     * The revision churn this issue is really about: the next write must use the revision the
     * upload produced, not the one the page was loaded with, or it 409s on the user.
     */
    it("adopts the revision the write returned, so the next write is not stale", async () => {
      // The re-read answers with the document the upload produced — rev 3, three attachments —
      // which is what makes the second write's ?rev= the new one rather than the loaded one.
      getDoc
        .mockResolvedValueOnce(structuredClone(DOC_V1) as never)
        .mockResolvedValue(structuredClone(DOC_V2) as never);
      await mount();
      await pick(file("report.pdf", "application/pdf"));

      click("[data-attachment-row='notes.txt'] [data-attachment-delete]");
      await settle();
      click("[data-attachment-delete-confirm]");
      await settle();

      expect(getContext().attachments.remove).toHaveBeenCalledWith(
        "mydb",
        "doc1",
        "notes.txt",
        "3-cb23",
      );
    });

    it("keeps the new revision even when the re-read fails", async () => {
      getDoc
        .mockResolvedValueOnce(structuredClone(DOC_V1) as never)
        .mockRejectedValueOnce(new Error("network gone"));
      await mount();
      await pick(file("report.pdf", "application/pdf"));

      // @ts-expect-error — the revision the next write would be sent with
      expect(element._loadedRev).toBe("3-cb23");
    });
  });

  // -------------------------------------------------------------------------
  describe("overwrite confirmation", () => {
    it("asks before replacing a name that is already taken, and uploads nothing yet", async () => {
      await mount();
      await pick(file("notes.txt"));

      expect(q("[data-overwrite-dialog]")!.hasAttribute("open")).toBe(true);
      expect(getContext().attachments.upload).not.toHaveBeenCalled();
    });

    it("uploads once the replacement is confirmed", async () => {
      await mount();
      await pick(file("notes.txt"));
      click("[data-overwrite-confirm]");
      await settle();

      expect(getContext().attachments.upload).toHaveBeenCalledWith(
        "mydb",
        "doc1",
        "notes.txt",
        expect.any(File),
        "2-93d8",
      );
    });

    it("uploads nothing when the replacement is cancelled", async () => {
      await mount();
      await pick(file("notes.txt"));
      click("[data-overwrite-cancel]");
      await settle();

      expect(getContext().attachments.upload).not.toHaveBeenCalled();
      expect(q("[data-overwrite-dialog]")!.hasAttribute("open")).toBe(false);
    });

    it("does not ask for a name nothing else uses", async () => {
      await mount();
      await pick(file("fresh.txt"));
      expect(q("[data-overwrite-dialog]")!.hasAttribute("open")).toBe(false);
      expect(getContext().attachments.upload).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("delete", () => {
    it("asks first, and deletes nothing until the dialog is confirmed", async () => {
      await mount();
      click("[data-attachment-row='notes.txt'] [data-attachment-delete]");
      await settle();

      expect(q("[data-attachment-delete-dialog]")!.hasAttribute("open")).toBe(true);
      expect(getContext().attachments.remove).not.toHaveBeenCalled();

      click("[data-attachment-delete-confirm]");
      await settle();
      expect(getContext().attachments.remove).toHaveBeenCalledWith(
        "mydb",
        "doc1",
        "notes.txt",
        "2-93d8",
      );
    });

    it("deletes nothing when the dialog is cancelled", async () => {
      await mount();
      click("[data-attachment-row='logo.png'] [data-attachment-delete]");
      await settle();
      click("[data-attachment-delete-cancel]");
      await settle();
      expect(getContext().attachments.remove).not.toHaveBeenCalled();
    });

    it("re-reads the document afterwards, so the list and the badge follow", async () => {
      getDoc
        .mockResolvedValueOnce(structuredClone(DOC_V2) as never)
        .mockResolvedValueOnce(structuredClone(DOC_V1) as never);
      await mount();
      expect(rowNames()).toEqual(["logo.png", "notes.txt", "report.pdf"]);

      click("[data-attachment-row='report.pdf'] [data-attachment-delete]");
      await settle();
      click("[data-attachment-delete-confirm]");
      await settle();

      expect(rowNames()).toEqual(["logo.png", "notes.txt"]);
      expect(
        (q("cca-attachment-count") as HTMLElement & { count: number }).count,
      ).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe("unsaved edits block attachment writes", () => {
    it("disables both write actions and says why", async () => {
      await mount();
      await typeInEditor('{"title":"edited"}');

      expect(q("[data-attachments-blocked]")!.textContent).toContain(
        "Save or undo your edits",
      );
      expect(
        (q("[data-attachment-add]") as HTMLElement).hasAttribute("disabled"),
      ).toBe(true);
      expect(
        (
          q(
            "[data-attachment-row='notes.txt'] [data-attachment-delete]",
          ) as HTMLElement
        ).hasAttribute("disabled"),
      ).toBe(true);
    });

    it("refuses the upload rather than writing against a revision about to change", async () => {
      await mount();
      await typeInEditor('{"title":"edited"}');
      await pick(file("fresh.txt"));

      expect(getContext().attachments.upload).not.toHaveBeenCalled();
      expect(toasts().join(" ")).toContain("Save or undo your edits");
    });

    it("counts unparseable text as an edit — that is exactly the state not to write from", async () => {
      await mount();
      await typeInEditor("{not json");
      expect(q("[data-attachments-blocked]")).not.toBeNull();
    });

    it("does not count reformatting as an edit — Prettify changes no document", async () => {
      await mount();
      await typeInEditor(JSON.stringify(DOC_V1));
      expect(q("[data-attachments-blocked]")).toBeNull();
      await pick(file("fresh.txt"));
      expect(getContext().attachments.upload).toHaveBeenCalled();
    });

    it("unblocks again once the re-read makes the buffer the document", async () => {
      await mount();
      await typeInEditor('{"title":"edited"}');
      expect(q("[data-attachments-blocked]")).not.toBeNull();

      // @ts-expect-error — private reload, as an attachment write performs
      await element._loadForEdit();
      await settle();
      expect(q("[data-attachments-blocked]")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("errors say what happened", () => {
    it("explains a stale revision instead of showing 'Document update conflict.'", async () => {
      vi.spyOn(getContext().attachments, "remove").mockRejectedValue(
        new ApiError(409, "Document update conflict.", {
          error: "conflict",
          reason: "Document update conflict.",
        }),
      );
      await mount();
      click("[data-attachment-row='notes.txt'] [data-attachment-delete]");
      await settle();
      click("[data-attachment-delete-confirm]");
      await settle();

      const said = toasts().join(" ");
      expect(said).toContain("changed on the server");
      expect(said).toContain("Reload");
    });

    it("names the size limit for a 413, rather than repeating the filename back", async () => {
      vi.spyOn(getContext().attachments, "upload").mockRejectedValue(
        new ApiError(413, "report.pdf", {
          error: "attachment_too_large",
          reason: "report.pdf",
        }),
      );
      await mount();
      await pick(file("report.pdf", "application/pdf"));

      const said = toasts().join(" ");
      expect(said).toContain("too large");
      expect(said).toContain("max_attachment_size");
    });

    it("leaves the document alone when a write fails — no reload, no phantom revision", async () => {
      vi.spyOn(getContext().attachments, "upload").mockRejectedValue(
        new ApiError(413, "report.pdf", { error: "attachment_too_large" }),
      );
      await mount();
      await pick(file("report.pdf", "application/pdf"));

      expect(getDoc).toHaveBeenCalledOnce();
      // @ts-expect-error — unchanged, so the next attempt is still against a live revision
      expect(element._loadedRev).toBe("2-93d8");
    });
  });
});
