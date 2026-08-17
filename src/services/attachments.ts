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
 * Attachments: counting them (#84), and managing them (#120).
 *
 * CouchDB puts them in `_attachments`, an object keyed by filename whose values are the
 * stubs `_all_docs?include_docs=true` and a plain document GET both return — so the count,
 * and the whole list with its types and sizes, is `Object.keys()` on a field that is already
 * in hand. Nothing here fetches to *list*: since #79 both document lists ask for whole
 * documents, which is what made the indicator possible without the companion projection
 * query #84 had planned for, and what makes {@link listAttachments} free in the editor.
 *
 * Three operations do reach the network, and they are the whole of #120:
 *
 * | Operation | Request                                       |
 * |-----------|-----------------------------------------------|
 * | download  | `GET /{db}/{docid}/{attname}`                 |
 * | upload    | `PUT /{db}/{docid}/{attname}?rev={rev}`       |
 * | delete    | `DELETE /{db}/{docid}/{attname}?rev={rev}`    |
 *
 * *Viewing* an attachment is deliberately not among them: the user downloads the file and
 * opens it in the application that owns the format. Rendering images, PDFs and text inline
 * is a viewer, and this is not one.
 */

import type { ApiClient } from "./api-client.js";
import { ApiError } from "./api-error.js";
import { docPath } from "./db-mgmt-service.js";

/** The field CouchDB stores attachment stubs in. Named once so nothing spells it twice. */
export const ATTACHMENTS_FIELD = "_attachments";

/**
 * How many attachments `doc` carries, or `0` when it carries none *and* when the field is
 * simply not there.
 *
 * The two cases collapse deliberately: both render nothing (see `cca-attachment-count`),
 * because a document that arrived without `_attachments` is not a document with zero
 * attachments. A Mango query with a `fields` projection returns exactly the fields asked
 * for, so `_attachments` is absent from every row however many attachments those documents
 * have — and "0 attachments" there would be a confident lie. Absence says nothing, and
 * showing nothing is how it says it.
 */
export function attachmentCount(doc: unknown): number {
  return Object.keys(stubsOf(doc)).length;
}

/** Whether any document on a page carries attachments — i.e. whether a column is worth a header. */
export function anyHaveAttachments(docs: readonly unknown[]): boolean {
  return docs.some((doc) => attachmentCount(doc) > 0);
}

/**
 * `doc._attachments` when it is the object CouchDB sends, and an empty one in every other
 * case — missing, null, or malformed.
 *
 * Arrays are excluded rather than tolerated: `Object.keys([])` counts indices, so a
 * malformed `_attachments: []` would otherwise report a length as an attachment count and
 * a list of numbers as filenames.
 */
function stubsOf(doc: unknown): Record<string, AttachmentStub> {
  if (!doc || typeof doc !== "object") return {};
  const stubs = (doc as Record<string, unknown>)[ATTACHMENTS_FIELD];
  if (!stubs || typeof stubs !== "object" || Array.isArray(stubs)) return {};
  return stubs as Record<string, AttachmentStub>;
}

/**
 * One entry of `_attachments` as CouchDB returns it on an ordinary document read.
 *
 * Every field is optional because none of them is this app's to guarantee — the document may
 * have been written by anything, including a `_bulk_docs` that inlined an attachment by hand.
 * `length` is the **decoded** size: CouchDB gzips compressible types on the way in and reports
 * the compressed size separately as `encoded_length`, and only when the read asked for
 * `att_encoding_info=true` (verified against 3.5.2 — a 65-byte text attachment reports
 * `length: 65` and `encoded_length: 70`). So `length` is what to show a user: it is the size
 * of the file they would get back.
 */
export interface AttachmentStub {
  content_type?: string;
  length?: number;
  digest?: string;
  revpos?: number;
  stub?: boolean;
}

/** One attachment, as a screen needs it: named, typed and sized, with nothing optional left. */
export interface AttachmentInfo {
  name: string;
  /** What CouchDB will serve it back as; `application/octet-stream` when the stub says nothing. */
  contentType: string;
  /** Decoded size in bytes — see {@link AttachmentStub.length}. `0` when the stub omits it. */
  length: number;
  /** CouchDB's MD5, e.g. `md5-yeCY/…`. Absent from a hand-written `_attachments`. */
  digest?: string;
  /** The document revision this attachment last changed in. */
  revpos?: number;
}

/** The type an attachment is treated as when its stub declares none. */
export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * Every attachment on a loaded document, in filename order.
 *
 * Sorted because `_attachments` is a JSON object and its key order is whatever the last write
 * left behind — a list that reshuffles itself after each upload is a list nobody can scan.
 *
 * Takes the whole document rather than the stubs so a caller never has to know the field name
 * or repeat {@link stubsOf}'s malformed-input reasoning.
 */
export function listAttachments(doc: unknown): AttachmentInfo[] {
  return Object.entries(stubsOf(doc))
    .map(([name, stub]) => ({
      name,
      contentType: stub?.content_type || DEFAULT_CONTENT_TYPE,
      length: typeof stub?.length === "number" ? stub.length : 0,
      digest: stub?.digest,
      revpos: stub?.revpos,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `/{db}/{docid}/{attname}` — the URL all three operations act on.
 *
 * The name is percent-encoded whole, `/` included. CouchDB's attachment names may contain
 * slashes, and a raw one would be read as a path separator; `%2F` round-trips exactly
 * (verified against 3.5.2: `PUT …/dir%2Ffile.txt` stores the name `dir/file.txt`, and a `GET`
 * with the same encoding fetches it back). The database and document segments come from
 * {@link docPath}, which already knows the one place a literal `/` must survive — the
 * `_design/` prefix of a design document's id.
 */
export function attachmentPath(
  dbName: string,
  docId: string,
  name: string,
): string {
  return `${docPath(dbName, docId)}/${encodeURIComponent(name)}`;
}

/** What an attachment operation was trying to do, for the sentence an error turns into. */
export type AttachmentAction = "upload" | "download" | "delete";

/**
 * The sentence to show a user when an attachment operation fails.
 *
 * Three of CouchDB's answers mean something specific enough that the raw `reason` would
 * mislead, and all three were confirmed against a real 3.5.2:
 *
 *  - **413 `attachment_too_large`** — the file is over `[couchdb] max_attachment_size`. Its
 *    `reason` is *the filename alone*, so surfacing CouchDB's message verbatim produces
 *    "Failed to upload: report.pdf", which reads like a mystery rather than a size limit.
 *  - **413 `too_large`** — the request is over `[chttpd] max_http_request_size`
 *    ("the request entity is too large"). A standalone attachment `PUT` is streamed and is
 *    *not* subject to that cap — only `max_attachment_size` stops it — so this status
 *    normally arrives from a reverse proxy in front of CouchDB, whose body is often not even
 *    JSON. It is handled anyway because from the user's chair it is the same problem, and a
 *    413 with no recognisable body must still say "too large" rather than "Request failed".
 *  - **409** — every write carries `?rev=`, so a conflict means the document moved on since
 *    it was loaded. The fix is to reload, which is worth saying.
 *
 * A 404 on a delete is ambiguous in CouchDB's own answers and is left to speak for itself:
 * deleting an attachment against a *stale* revision that never had it returns 404
 * "Document is missing attachment", while the same request against a revision that did have
 * it returns 409. Nothing here can tell those apart from the status alone, and CouchDB's
 * reason is accurate in both.
 *
 * Everything else — 403 "You are not allowed to access this db.", 401, 500 — passes through
 * untouched. CouchDB's permission answers are not reliably the status you would expect (a
 * non-admin `POST /{db}/_index` returns 500, not 403), so nothing here branches on status to
 * *guess* at a permission problem; the server's own words are better than an invented gloss.
 */
export function attachmentErrorMessage(
  err: unknown,
  action: AttachmentAction,
  name: string,
): string {
  if (err instanceof ApiError) {
    if (err.status === 413) return tooLargeMessage(err, name);
    if (err.status === 409) {
      return `Could not ${action} “${name}”: the document changed on the server since it was loaded. Reload the document and try again.`;
    }
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `Could not ${action} “${name}”: ${detail}`;
}

/** The two size limits, told apart by CouchDB's `error` code — see {@link attachmentErrorMessage}. */
function tooLargeMessage(err: ApiError, name: string): string {
  const code = (err.body as { error?: string } | null)?.error;
  const limit =
    code === "too_large"
      ? "the server's maximum request size ([chttpd] max_http_request_size)"
      : "the server's maximum attachment size ([couchdb] max_attachment_size)";
  return `“${name}” is too large to upload: it exceeds ${limit}. Upload a smaller file, or ask an administrator to raise the limit.`;
}

/**
 * The three attachment operations, over the app's one HTTP client.
 *
 * Going through {@link ApiClient} is not a style preference: it is the only thing that carries
 * the session. A bare `<a href download>` sends no `Authorization` header at all, so a JWT
 * deployment downloads a 401 error page under the file's name, and in SPA mode (spec D5) the
 * navigation is not the app's `fetch` and lands under different CORS and cookie rules again.
 * See {@link ApiClient.requestBlob}.
 *
 * Every method takes the revision explicitly rather than reading the document first. A write
 * that fetched its own `?rev=` would silently overwrite whatever the last writer did in the
 * gap; taking it from the caller means the caller's view of the document is what CouchDB
 * checks, and a 409 stays the honest answer it should be.
 */
export class AttachmentService {
  constructor(private api: ApiClient) {}

  /**
   * The bytes of one attachment: `GET /{db}/{docid}/{attname}`.
   *
   * The blob's `type` is CouchDB's stored `content_type`, straight off the response header.
   */
  async download(dbName: string, docId: string, name: string): Promise<Blob> {
    const { data } = await this.api.requestBlob(
      attachmentPath(dbName, docId, name),
    );
    return data;
  }

  /**
   * Writes one attachment: `PUT /{db}/{docid}/{attname}?rev={rev}`, returning the revision
   * the document is now at.
   *
   * **An existing name is replaced, not added to** — CouchDB has no other behaviour to offer,
   * and it answers `201 Created` either way, so nothing in the response distinguishes the two.
   * Asking the user first is therefore the caller's job, and there is no second chance to do
   * it afterwards.
   *
   * @param name - the attachment name to write, which need not be `file.name`
   * @param file - the bytes; its `type` labels them unless `contentType` overrides it
   */
  async upload(
    dbName: string,
    docId: string,
    name: string,
    file: Blob,
    rev: string,
    contentType?: string,
  ): Promise<string> {
    const { rev: newRev } = await this.api.requestBinary<{ rev: string }>(
      "PUT",
      `${attachmentPath(dbName, docId, name)}?rev=${encodeURIComponent(rev)}`,
      file,
      contentType,
    );
    return newRev;
  }

  /**
   * Removes one attachment: `DELETE /{db}/{docid}/{attname}?rev={rev}`, returning the revision
   * the document is now at. CouchDB answers `200` with `{ok, id, rev}` — not `204`.
   */
  async remove(
    dbName: string,
    docId: string,
    name: string,
    rev: string,
  ): Promise<string> {
    const { rev: newRev } = await this.api.request<{ rev: string }>(
      "DELETE",
      `${attachmentPath(dbName, docId, name)}?rev=${encodeURIComponent(rev)}`,
    );
    return newRev;
  }
}
