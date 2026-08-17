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

import { ApiClient } from "./api-client.js";
import { SINGLE_SERVER_ID, labelFor } from "./single-server.js";
import type {
  DatabaseOverview,
  DatabaseServerInfo,
  AllDocsResponse,
  CreateDatabaseRequest,
  DocumentResponse,
  MangoQueryRequest,
  ExplainQueryRequest,
  ExplainResponse,
  SaveDocumentRequest,
  SaveDocumentResponse,
  BulkDeleteDocumentResponse,
  BulkDeleteDocumentRequest,
  ErrorDetails,
  CreateIndexRequest,
  CreateIndexResponse,
  ListIndexesResponse,
  IndexInfo,
  DatabaseAccess,
  DatabaseRoles,
  DatabaseInfoResponse,
} from "../plugins/db-mgmt/types.js";

/** Default page size for {@link DbMgmtService.listDocuments} when the caller
 * omits `limit` — mirrors `doc-browser`'s own `PAGE_SIZE`, the only real
 * caller-supplied default in play today. */
const DEFAULT_LIST_LIMIT = 25;

export interface ListDatabasesParams {
  sort_by?: "db_name" | "doc_count" | "size_bytes" | "server_name";
  sort_order?: "asc" | "desc";
  filter_name?: "db_name" | "server_id" | "server_name";
  filter_value?: string;
}

/** CouchDB accepts at most 100 keys per `_dbs_info` request. */
const DBS_INFO_CHUNK_SIZE = 100;

/** CouchDB's `_find` caps an unspecified limit at 25 documents, silently. */
const FIND_DEFAULT_LIMIT = 200;

/**
 * Call sites disagree on selector nesting: some pass `{selector: {...}}` inside
 * the request's `selector` field, others pass it flat. The retired backend
 * accepted both; CouchDB's `_find` does not. Unwrap exactly one redundant
 * layer — a real selector whose only top-level field is literally named
 * "selector" is not expressible in Mango, so this is unambiguous.
 */
function normalizeSelector(selector: unknown): Record<string, unknown> {
  if (selector && typeof selector === "object" && !Array.isArray(selector)) {
    const keys = Object.keys(selector as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === "selector") {
      const inner = (selector as Record<string, unknown>).selector;
      if (inner && typeof inner === "object") return inner as Record<string, unknown>;
    }
    return selector as Record<string, unknown>;
  }
  return {};
}

/** Builds `/{db}` with `db` percent-encoded — the base path every database-level CouchDB call starts from. */
export const dbPath = (db: string) => `/${encodeURIComponent(db)}`;

/**
 * Builds `/{db}/{docId}` with both segments percent-encoded, but restores the
 * literal `_design/` prefix that `encodeURIComponent` would otherwise escape —
 * design-doc ids look like `_design/name` and CouchDB requires that `/` raw.
 * Only a leading `_design/` is restored (anchored `^`), so an ordinary id that
 * merely contains a `/` (e.g. `a/b`) stays fully encoded (`a%2Fb`).
 */
export const docPath = (db: string, docId: string) =>
  `${dbPath(db)}/${encodeURIComponent(docId).replace(/^_design%2F/, "_design/")}`;

/** Splits `items` into chunks of at most `size` (used to respect CouchDB's `_dbs_info` cap). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Opaque, replayable page token. `_all_docs` has no bookmark of its own — the
 * canonical CouchDB recipe is `startkey` + fetching one row beyond the page —
 * but `doc-browser` keeps one token per visited page and replays it when the
 * user pages backwards, so the token must encode position, not a cursor the
 * server owns.
 */
const encodePageToken = (startkey: string): string => btoa(JSON.stringify({ startkey }));

const decodePageToken = (token: string | undefined): string | null => {
  if (!token) return null;
  try {
    const parsed = JSON.parse(atob(token)) as { startkey?: unknown };
    return typeof parsed.startkey === "string" ? parsed.startkey : null;
  } catch {
    return null;
  }
};

interface CouchSecuritySection {
  names: string[];
  roles: string[];
}

interface CouchSecurityDoc {
  admins: CouchSecuritySection;
  members: CouchSecuritySection;
}

/**
 * Maps the UI's {@link DatabaseAccess} shape onto CouchDB's native `_security`
 * document shape (`admins`/`members`, each with `names`/`roles`). Shared by
 * `createDatabase` here and by the database-access read/write path.
 */
export function toSecurityDoc(access: DatabaseAccess): CouchSecurityDoc {
  return {
    admins: { names: access.admin.name, roles: access.admin.roles },
    members: { names: access.member.name, roles: access.member.roles },
  };
}

interface RawSecuritySection {
  names?: string[];
  roles?: string[];
}

interface RawSecurityDoc {
  admins?: RawSecuritySection;
  members?: RawSecuritySection;
}

/**
 * Inverse of {@link toSecurityDoc}: maps CouchDB's native `_security` document shape (which may
 * omit `admins`/`members` entirely on a database with no restrictions, or omit their `names`/
 * `roles` individually) back onto the UI's {@link DatabaseAccess}, defaulting every missing half
 * to an empty array.
 */
export function fromSecurityDoc(doc: RawSecurityDoc | undefined | null): DatabaseAccess {
  return {
    admin: { name: doc?.admins?.names ?? [], roles: doc?.admins?.roles ?? [] },
    member: { name: doc?.members?.names ?? [], roles: doc?.members?.roles ?? [] },
  };
}

/**
 * Whether `username`/`roles` names a *database* admin per `access.admin` — distinct from, and not
 * a superset of, a *server* admin (`AuthService.isAdmin`, the `_admin` role). CouchDB grants a
 * database admin (named in `{db}/_security.admins` by name or by a shared role) the same write
 * access as a server admin **within that one database**, including design documents — verified
 * live: only "not a db or server admin" 403s a `PUT _design/*`, and a db admin is exactly one of
 * those two things. Callers check `AuthService.isAdmin` separately first (server admin bypasses
 * every database's security document, so there is nothing to read); this function only answers
 * the narrower, per-database question.
 *
 * An empty `access.admin` (no names, no roles — the default for a newly created, otherwise-"public"
 * database) correctly returns `false`: CouchDB's "public" default only widens *read* and ordinary
 * *document* write access to any authenticated user, never design-document write access, which
 * stays admin-only regardless of how open the rest of the database is.
 */
export function isDatabaseAdmin(access: DatabaseAccess, username: string | null, roles: string[]): boolean {
  if (username && access.admin.name.includes(username)) return true;
  return access.admin.roles.some((role) => roles.includes(role));
}

interface DbsInfoEntry {
  key: string;
  info?: {
    db_name: string;
    doc_count: number;
    sizes?: { file?: number };
    props?: { partitioned?: boolean };
  };
  error?: string;
}

/**
 * Encapsulates all database-management API calls.
 * @param api - shared ApiClient (token already set by AuthService)
 */
export class DbMgmtService {
  constructor(private api: ApiClient) {}

  /**
   * Lists every database on the single server: `GET /_all_dbs`, then the names are chunked into
   * `POST /_dbs_info` calls (CouchDB accepts at most 100 keys per request) and mapped into
   * {@link DatabaseOverview}, each carrying exactly one {@link DatabaseServerInfo} for the
   * synthesized server. Filtering and sorting happen client-side since CouchDB has no
   * equivalent query parameters for this endpoint.
   */
  async listDatabases(params?: ListDatabasesParams): Promise<DatabaseOverview[]> {
    const names = await this.api.request<string[]>("GET", "/_all_dbs");
    const serverName = labelFor(this.api.currentBaseUrl);

    const all: DatabaseOverview[] = [];
    for (const keys of chunk(names, DBS_INFO_CHUNK_SIZE)) {
      const entries = await this.api.request<DbsInfoEntry[]>("POST", "/_dbs_info", {
        keys,
      });
      for (const entry of entries) {
        if (!entry.info) continue;
        const server: DatabaseServerInfo = {
          server_id: SINGLE_SERVER_ID,
          server_name: serverName,
          doc_count: entry.info.doc_count,
          size_bytes: entry.info.sizes?.file,
          partitioned: entry.info.props?.partitioned === true,
        };
        all.push({ db_name: entry.info.db_name, servers: [server] });
      }
    }

    // There's only one server (spec D3), so `filter_name`/`sort_by` values of
    // `server_id`/`server_name` are accepted for call-site compatibility but
    // have nothing meaningful to filter/sort on; only `db_name` acts.
    let result = all;
    if (params?.filter_value) {
      const needle = params.filter_value.toLowerCase();
      result = result.filter((d) => d.db_name.toLowerCase().includes(needle));
    }
    if (params?.sort_by) {
      const field = params.sort_by;
      const dir = params.sort_order === "desc" ? -1 : 1;
      result = [...result].sort((a, b) => {
        const av = sortValue(a, field);
        const bv = sortValue(b, field);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return result;
  }

  /**
   * Creates the database on the single server: a plain `PUT /{db}` (spec D3 — the
   * multi-server co-create/replication form is gone, so `setup_replication` and
   * `replication_pairs` are accepted for call-site compatibility but ignored).
   * `skip_existing` is likewise intentionally ignored: CouchDB answers 412 on an
   * already-existing database, and that error surfaces to the caller as-is rather
   * than being swallowed.
   * When the (only) server entry carries `access`, follows up with a `PUT
   * /{db}/_security` built by {@link toSecurityDoc}.
   * @param req - database name, the single target server config, and (ignored) replication intent
   */
  async createDatabase(req: CreateDatabaseRequest): Promise<DatabaseOverview> {
    const server = req.servers[0];
    const partitioned = server?.partitioned === true;
    const qs = partitioned ? "?partitioned=true" : "";
    await this.api.request("PUT", `${dbPath(req.db_name)}${qs}`);

    if (server?.access) {
      await this.api.request(
        "PUT",
        `${dbPath(req.db_name)}/_security`,
        toSecurityDoc(server.access),
      );
    }

    return {
      db_name: req.db_name,
      servers: [
        {
          server_id: SINGLE_SERVER_ID,
          server_name: labelFor(this.api.currentBaseUrl),
          doc_count: 0,
          size_bytes: 0,
          partitioned,
        },
      ],
    };
  }

  /**
   * @param _serverId - inert (spec D2/D3)
   */
  deleteDatabase(dbName: string, _serverId: string): Promise<void> {
    return this.api.request("DELETE", dbPath(dbName));
  }

  /**
   * Reads one database's info document: `GET /{db}`, returned as-is. This is also the *existence
   * and access probe* for a database name the user typed by hand — `_all_dbs` is admin-only, so a
   * non-admin's database list is empty and the name never came from a picker (issue #5).
   *
   * Errors propagate untouched, deliberately: only the {@link ApiError} status separates the two
   * "no" answers CouchDB gives a non-admin, and they need different words in the UI — 404
   * (`Database does not exist.`) means the name is wrong, 403 (`You are not allowed to access this
   * db.`) means the name is right and the user is not a member of it. Catching or remapping here
   * would collapse that distinction back into the vague failure this method exists to replace.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   * @param dbName    - CouchDB database name, percent-encoded here (a name may contain `/`)
   */
  getDatabaseInfo(
    _serverId: string,
    dbName: string,
  ): Promise<DatabaseInfoResponse> {
    return this.api.request("GET", dbPath(dbName));
  }

  /**
   * Pages `_all_docs`, translating it into the `DocumentResponse` shape the UI
   * already understands. Fetches `limit + 1` rows (the lookahead recipe): when
   * the extra row exists, it is dropped from the returned page and its id
   * becomes the next {@link encodePageToken page token}, so `documents` is
   * exactly `limit` long whenever more pages exist — matching `doc-browser`'s
   * `_hasMore = rows.length === PAGE_SIZE` check. `scope: "raw"` skips
   * `include_docs` and yields `{_id, _rev}` rows only; the same fallback also
   * covers a deleted row that CouchDB returned without a `doc` despite
   * `include_docs=true`.
   *
   * `skip` is an offset from the *start of the database*, the user-facing meaning
   * of the skip box (#80) — so it is sent only when no page token is being
   * replayed. A token is a `startkey` taken from a page that was itself already
   * offset, so sending `skip` alongside it would skip that many rows a second
   * time, once per page.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  async listDocuments(
    _serverId: string,
    dbName: string,
    params?: {
      limit?: number;
      skip?: number;
      bookmark?: string;
      scope?: "raw" | "full";
    },
  ): Promise<DocumentResponse> {
    const limit = params?.limit ?? DEFAULT_LIST_LIMIT;
    const startkey = decodePageToken(params?.bookmark);
    const skip = startkey == null ? (params?.skip ?? 0) : 0;
    const qs = buildQuery({
      limit: String(limit + 1),
      skip: skip > 0 ? String(skip) : undefined,
      include_docs: params?.scope === "raw" ? undefined : "true",
      startkey: startkey != null ? JSON.stringify(startkey) : undefined,
    });
    const resp = await this.api.request<AllDocsResponse>(
      "GET",
      `${dbPath(dbName)}/_all_docs${qs}`,
    );
    const rows = resp.rows ?? [];
    const hasMore = rows.length > limit;
    const documents = rows
      .slice(0, limit)
      .map((row) => row.doc ?? { _id: row.id, _rev: row.value?.rev });
    return {
      documents,
      total_count: resp.total_rows,
      bookmark: hasMore ? encodePageToken(rows[limit].id) : undefined,
    };
  }

  /**
   * Fetches a single document by ID.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   * @param dbName    - CouchDB database name
   * @param docId     - CouchDB document ID
   */
  getDoc(
    _serverId: string,
    dbName: string,
    docId: string,
  ): Promise<Record<string, unknown>> {
    return this.api.request("GET", docPath(dbName, docId));
  }

  /**
   * Deletes a document.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   * @param dbName    - CouchDB database name
   * @param docId     - CouchDB document ID
   * @param rev       - CouchDB document revision (required by CouchDB unless the id was never saved)
   */
  deleteDoc(
    _serverId: string,
    dbName: string,
    docId: string,
    rev?: string,
  ): Promise<Record<string, unknown>> {
    const qs = rev ? `?rev=${encodeURIComponent(rev)}` : "";
    return this.api.request("DELETE", `${docPath(dbName, docId)}${qs}`);
  }

  /**
   * Runs a Mango query: `POST /{db}/_find`. Normalizes the selector (see
   * {@link normalizeSelector} — call sites disagree on whether it's
   * double-wrapped) and always sends an explicit `limit`, since CouchDB
   * silently caps an unspecified one at 25. `scope: "raw"` projects to
   * `_id`/`_rev` via `fields` (unless the caller already set `fields`);
   * `scope` itself is never forwarded — CouchDB doesn't know it.
   * `_find` returns a real `bookmark` (unlike `_all_docs`), passed straight
   * through, and no total count, so `total_count` is left undefined —
   * `doc-query` already ignores it.
   *
   * `skip` offsets from the start of the result set (#80), so — exactly as in
   * {@link listDocuments} — it is sent only on a request that replays no
   * bookmark: `_find` applies `skip` *after* the bookmark's position, so pairing
   * the two would re-skip on every page.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  queryDocuments(
    _serverId: string,
    dbName: string,
    request: MangoQueryRequest,
  ): Promise<DocumentResponse> {
    const fields = request.scope === "raw" ? (request.fields ?? ["_id", "_rev"]) : request.fields;
    const body: Record<string, unknown> = {
      selector: normalizeSelector(request.selector),
      limit: request.limit ?? FIND_DEFAULT_LIMIT,
    };
    if (request.bookmark === undefined && request.skip) body.skip = request.skip;
    if (request.sort !== undefined) body.sort = request.sort;
    if (fields !== undefined) body.fields = fields;
    if (request.bookmark !== undefined) body.bookmark = request.bookmark;

    return this.api
      .request<{ docs?: Record<string, unknown>[]; bookmark?: string }>(
        "POST",
        `${dbPath(dbName)}/_find`,
        body,
      )
      .then((resp) => ({ documents: resp.docs ?? [], bookmark: resp.bookmark }));
  }

  /**
   * Explains a Mango query: `POST /{db}/_explain`, returning CouchDB's
   * response as-is. Same selector normalization as {@link queryDocuments}.
   * `ExplainResponse.condition`/`index_candidates` are CCA-only fields
   * CouchDB never sends; the component already treats them as optional.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  explainQuery(
    _serverId: string,
    dbName: string,
    request: ExplainQueryRequest,
  ): Promise<ExplainResponse> {
    const body: Record<string, unknown> = {
      ...request,
      selector: normalizeSelector(request.selector),
    };
    return this.api.request("POST", `${dbPath(dbName)}/_explain`, body);
  }

  /**
   * Saves a document: `PUT /{db}/{id}` when `request.id` is given (update or
   * caller-chosen id), else `POST /{db}` for a server-generated id. Both
   * verbs return CouchDB's native `{ok, id, rev}`; only `{id, rev}` is
   * surfaced, matching {@link SaveDocumentResponse}.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  async saveDocument(
    _serverId: string,
    dbName: string,
    request: SaveDocumentRequest,
  ): Promise<SaveDocumentResponse> {
    const path = request.id ? docPath(dbName, request.id) : dbPath(dbName);
    const method = request.id ? "PUT" : "POST";
    const { id, rev } = await this.api.request<{ id: string; rev: string }>(
      method,
      path,
      request.body,
    );
    return { id, rev };
  }

  /**
   * Bulk-deletes documents via `POST /{db}/_bulk_docs`, marking each row
   * `_deleted: true`. Counts rows with `ok: true` as deleted; every other row
   * (CouchDB's `{id, error, reason}` conflict shape) is mapped onto
   * {@link ErrorDetails}: the row's `error` code (e.g. `"conflict"`) becomes
   * `title`, its `reason` becomes `detail`, and the row's `id` is preserved in
   * `ErrorDetails.error` so the caller can tell which document needs a retry.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  async deleteDocuments(
    _serverId: string,
    dbName: string,
    docs: BulkDeleteDocumentRequest,
  ): Promise<BulkDeleteDocumentResponse> {
    const bulkDocs = docs.documents.map((d) => ({
      _id: d.id,
      _rev: d.rev,
      _deleted: true,
    }));
    const results = await this.api.request<
      Array<{ ok?: boolean; id: string; rev?: string; error?: string; reason?: string }>
    >("POST", `${dbPath(dbName)}/_bulk_docs`, { docs: bulkDocs });

    const deleted = results.filter((r) => r.ok === true).length;
    const errors: ErrorDetails[] = results
      .filter((r) => r.ok !== true)
      .map((r) => ({
        title: r.error ?? "error",
        detail: r.reason ?? "No reason provided",
        error: r.id,
      }));
    return { deleted, errors };
  }

  /**
   * Creates a Mango index: `POST /{db}/_index` with `{index: {fields, partial_filter_selector?},
   * name, type?, ddoc?}`. `partial_filter_selector` arrives as a JSON string (the create-index UI
   * hands over raw editor text, not a parsed object) and is parsed here; a parse failure rejects
   * with a message naming the field, before any request is sent. The response maps CouchDB's
   * native `{id, name, result}` onto {@link CreateIndexResponse}, echoing `fields`/`ddoc` back from
   * the request and defaulting `type` to `'json'` (CouchDB's own default when it's omitted).
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  async createIndex(
    _serverId: string,
    dbName: string,
    request: CreateIndexRequest,
  ): Promise<CreateIndexResponse> {
    const index: Record<string, unknown> = { fields: request.fields };
    if (request.partial_filter_selector) {
      try {
        index.partial_filter_selector = JSON.parse(request.partial_filter_selector);
      } catch {
        throw new Error(
          "Invalid partial filter selector: must be valid JSON.",
        );
      }
    }
    const body: Record<string, unknown> = { index, name: request.name };
    if (request.type) body.type = request.type;
    if (request.ddoc) body.ddoc = request.ddoc;

    const resp = await this.api.request<{ id: string; name: string; result?: string }>(
      "POST",
      `${dbPath(dbName)}/_index`,
      body,
    );
    return {
      id: resp.id,
      name: resp.name,
      type: request.type ?? "json",
      fields: request.fields,
      ddoc: request.ddoc,
      result: resp.result,
    };
  }

  /**
   * Lists a database's Mango indexes: `GET /{db}/_index` → CouchDB's native `{total_rows,
   * indexes}`. `total_count` is `total_rows`, falling back to `indexes.length` if CouchDB ever
   * omits it. `skip`/`limit` are applied client-side — `_index` has no paging parameters of its own.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  async listIndexes(
    _serverId: string,
    dbName: string,
    params?: { skip?: number; limit?: number },
  ): Promise<ListIndexesResponse> {
    const resp = await this.api.request<{ total_rows?: number; indexes: IndexInfo[] }>(
      "GET",
      `${dbPath(dbName)}/_index`,
    );
    const indexes = resp.indexes ?? [];
    const skip = params?.skip ?? 0;
    const page =
      params?.limit != null
        ? indexes.slice(skip, skip + params.limit)
        : indexes.slice(skip);
    return { indexes: page, total_count: resp.total_rows ?? indexes.length };
  }

  /**
   * Deletes each given index: `DELETE /{db}/_index/{ddoc}/json/{name}`, sequentially, one request
   * per entry. `index-list.ts` is the only caller and repurposes {@link BulkDeleteDocumentRequest}'s
   * `{id, rev}` shape for indexes — `id` carries the design-doc id (e.g. `_design/abc`) and `rev`
   * carries the index *name* (indexes have no CouchDB revision to put there). The design-doc
   * segment keeps its literal `/` after encoding — it's a path segment, not an opaque doc id.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  async deleteIndexes(
    _serverId: string,
    dbName: string,
    documents: BulkDeleteDocumentRequest,
  ): Promise<void> {
    for (const doc of documents.documents) {
      const ddoc = encodeURIComponent(doc.id ?? "").replace(/^_design%2F/, "_design/");
      await this.api.request(
        "DELETE",
        `${dbPath(dbName)}/_index/${ddoc}/json/${encodeURIComponent(doc.rev)}`,
      );
    }
  }

  /**
   * Reads a database's access control: `GET /{db}/_security`, mapped via {@link fromSecurityDoc}.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  listDatabaseAccess(
    _serverId: string,
    dbName: string,
  ): Promise<DatabaseAccess> {
    return this.api
      .request<RawSecurityDoc>("GET", `${dbPath(dbName)}/_security`)
      .then(fromSecurityDoc);
  }

  /**
   * Unions the roles referenced by every database's `_security` (`admins.roles` +
   * `members.roles`) across the whole server: `GET /_all_dbs`, then one `GET /{db}/_security` per
   * database with bounded concurrency (8 in flight at a time — `_all_dbs` can return hundreds of
   * names). A database whose `_security` cannot be read (a non-admin user gets 403 on databases
   * they lack access to) is skipped rather than failing the whole scan, so the permissions screen
   * still works for non-admin users.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  async listDatabaseRoles(_serverId: string): Promise<DatabaseRoles> {
    const names = await this.api.request<string[]>("GET", "/_all_dbs");
    const roles = new Set<string>();
    const CONCURRENCY = 8;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < names.length) {
        const dbName = names[cursor++];
        try {
          const doc = await this.api.request<RawSecurityDoc>(
            "GET",
            `${dbPath(dbName)}/_security`,
          );
          for (const r of doc.admins?.roles ?? []) roles.add(r);
          for (const r of doc.members?.roles ?? []) roles.add(r);
        } catch {
          // Non-admin users get 403 on databases they can't read; skip and keep scanning.
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker),
    );
    return { roles: [...roles].sort() };
  }

  /**
   * Writes a database's access control: `PUT /{db}/_security`, built by {@link toSecurityDoc}.
   * @param _serverId - inert (single-server product; kept for call-site compatibility)
   */
  updateDatabaseAccess(
    _serverId: string,
    dbName: string,
    access: DatabaseAccess,
  ): Promise<void> {
    return this.api.request(
      "PUT",
      `${dbPath(dbName)}/_security`,
      toSecurityDoc(access),
    );
  }
}

function buildQuery(
  params: Record<string, string | undefined> | undefined,
): string {
  if (!params) return "";
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== "",
  );
  if (entries.length === 0) return "";
  return (
    "?" +
    entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
      .join("&")
  );
}

/** Reads the field a `listDatabases` sort key sorts on. `server_name` is constant across every
 * entry (single server), so sorting by it compares equal and leaves order untouched. */
function sortValue(
  d: DatabaseOverview,
  field: NonNullable<ListDatabasesParams["sort_by"]>,
): string | number | undefined {
  if (field === "db_name") return d.db_name;
  return d.servers[0]?.[field];
}
