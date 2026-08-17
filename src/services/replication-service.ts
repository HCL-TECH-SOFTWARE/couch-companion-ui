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

import { ApiClient } from './api-client.js';
import { SINGLE_SERVER_ID, labelFor } from './single-server.js';
import { dbPath } from './db-mgmt-service.js';
import type { ReplicatorDoc } from '../plugins/replication/types.js';

const seg = (s: string): string => encodeURIComponent(s);

const REPLICATOR_DB = '/_replicator';

/** Sample size returned to the editor's preview panel. */
const PREVIEW_SAMPLE_SIZE = 5;

/**
 * `_find` cap-detection probe: one more than a round 100. Getting back the full 101 rows means the
 * source has *at least* 100 matching documents but the exact count is unknowable client-side
 * without walking the whole result set, so the estimate is reported as a lower bound instead.
 */
const PREVIEW_FIND_LIMIT = 101;

/** Request driving a client-side {@link ReplicationService.previewReplication} estimate. */
export interface PreviewRequest {
  source_server_id: string;
  source_db: string;
  selector?: Record<string, unknown> | null;
  filter?: string | null;
  doc_ids?: string[] | null;
}

/** Result of a preview / dry run. `warning` is absent when there is nothing to warn about. */
export interface PreviewResult {
  estimated_doc_count: number;
  sample_doc_ids: string[];
  warning?: string;
}

/** CouchDB's standard write acknowledgement, returned by create and update. */
export interface DocWriteResponse {
  ok: boolean;
  id: string;
  rev: string;
}

/** Optional client-side filters for {@link ReplicationService.listReplications}. */
export interface ListReplicationsParams {
  /** Case-insensitive substring over doc id, source and target URLs (#822). */
  filter?: string;
}

/** Fields {@link ReplicationService} annotates onto a raw `_replicator` document; never written back. */
const ANNOTATIONS = [
  'cca_server_id', 'cca_server_name', 'replicator_doc_id', 'replication_state',
  'replication_state_time', 'scheduler_error', 'error_count', 'docs_written', 'changes_pending',
] as const;

/**
 * Replaces URL userinfo with `***`. Raw `_replicator` docs carry the password in the URL;
 * `_scheduler/docs` does not.
 *
 * The `***` sentinel is load-bearing beyond display: {@link ReplicationService.updateReplication}
 * checks for it to recognize a masked endpoint round-tripped from a read (as opposed to a
 * genuinely new one). When the masked endpoint's origin still matches the stored one, only its
 * path/query changed (e.g. the editor's database field) — the stored credentials are spliced back
 * onto that edited path, so the edit is honoured without ever exposing the real credentials to
 * the frontend. When the origin differs, the caller's value is ignored outright and the stored
 * endpoint wins, since the frontend cannot know a different server's credentials. Do not change
 * the mask format here without updating that check.
 */
export function maskUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '***';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

type Endpoint = string | { url: string; [key: string]: unknown };

/** Masks credentials on a `_replicator` endpoint, which is either a bare URL or `{url, headers}`. */
function maskEndpoint(endpoint: Endpoint): Endpoint {
  if (typeof endpoint === 'string') return maskUrlCredentials(endpoint);
  return { ...endpoint, url: maskUrlCredentials(endpoint.url) };
}

/** Reads the URL out of an endpoint, whichever form it takes. */
function endpointUrl(endpoint: Endpoint | undefined): string {
  if (!endpoint) return '';
  return typeof endpoint === 'string' ? endpoint : endpoint.url;
}

/**
 * True when a raw endpoint URL still carries the `***` sentinel {@link maskUrlCredentials}
 * writes. Exported so callers building an endpoint URL client-side (the editor, recombining a
 * loaded — and therefore masked — host with an edited database name) can detect the same
 * condition {@link ReplicationService.updateReplication} will: a URL that still matches this
 * would be silently swapped back to the stored value, discarding whatever else the caller
 * changed alongside it (e.g. the database).
 */
export function isMaskedUrl(url: string): boolean {
  return /\/\/\*\*\*(:|@)/.test(url);
}

/** True when an endpoint's URL still carries the `***` sentinel {@link maskUrlCredentials} writes. */
function isMasked(endpoint: Endpoint | undefined): boolean {
  return isMaskedUrl(endpointUrl(endpoint));
}

/**
 * True when two URLs share scheme+host+port. {@link resolveEndpoint} uses this to tell "same
 * server, edited path" (safe to splice the stored credentials onto) from "a different server"
 * (unsafe — the frontend cannot know that server's credentials, so the caller's value is ignored
 * outright). The editor's own save-blocking rail asks the identical question, via this same
 * function, before a masked endpoint ever reaches this service.
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Splices `stored`'s userinfo (the real credentials, never sent to the frontend) onto `caller`'s
 * URL, keeping caller's path/query/hash. Used by {@link resolveEndpoint} when a masked caller
 * endpoint shares stored's origin, so an edited database name is honoured without the frontend
 * ever needing to know the real credentials. Falls back to `storedUrl` unchanged if either URL
 * fails to parse (should not happen — both already passed {@link sameOrigin}).
 */
function spliceStoredCredentials(storedUrl: string, callerUrl: string): string {
  try {
    const stored = new URL(storedUrl);
    const spliced = new URL(callerUrl);
    spliced.username = stored.username;
    spliced.password = stored.password;
    return spliced.toString();
  } catch {
    return storedUrl;
  }
}

/**
 * Resolves a caller-supplied endpoint for {@link ReplicationService.updateReplication}. A
 * genuinely edited endpoint (new URL, or none at all) passes through unchanged. One that still
 * carries the mask sentinel is a masked value the caller round-tripped from a prior read (e.g.
 * `getReplication` -> edit form -> save) rather than a real credential edit:
 * - same origin as stored: the caller's path/query is a real edit (e.g. a changed database
 *   name), so the stored credentials are spliced onto it — the edit is honoured, the credential
 *   is never overwritten with the placeholder.
 * - different origin: the caller cannot know that server's credentials, so its value is ignored
 *   entirely and the stored endpoint wins.
 * Either way, any other caller-supplied property (e.g. an edited `headers`) is kept.
 */
function resolveEndpoint(stored: Endpoint | undefined, caller: Endpoint | undefined): Endpoint | undefined {
  if (caller === undefined || !isMasked(caller)) return caller;
  const storedUrl = endpointUrl(stored);
  const callerUrl = endpointUrl(caller);
  const resolvedUrl = sameOrigin(storedUrl, callerUrl)
    ? spliceStoredCredentials(storedUrl, callerUrl)
    : storedUrl;
  return typeof caller === 'string' ? resolvedUrl : { ...caller, url: resolvedUrl };
}

/** Drops every {@link ANNOTATIONS} key before a document is written back to CouchDB. */
function stripAnnotations<T extends Record<string, unknown>>(doc: T): T {
  const out = { ...doc };
  for (const key of ANNOTATIONS) delete out[key];
  return out;
}

/**
 * Drops `headers` from an endpoint entirely (URL masking is separate — see {@link maskEndpoint} —
 * and stays). Used by {@link ReplicationService.listReplications} only: the list view (both
 * dashboards and the topology graph) has no use for real header values, unlike
 * {@link ReplicationService.getReplication}, whose edit round-trip needs them intact to resolve a
 * masked `Authorization`/custom-header credential back onto a save. Defense in depth beyond the
 * masking `annotate` already does — the list payload should carry no credential material at all,
 * under any header name.
 */
function stripHeaders(endpoint: Endpoint): Endpoint {
  if (typeof endpoint === 'string') return endpoint;
  const out = { ...endpoint };
  delete out.headers;
  return out;
}

/**
 * Deletes any key whose value is `null` from a merged `_replicator` document before it is PUT.
 * `null` is the sentinel `cca-repl-editor`'s `buildReplicatorDocFromDesign` writes (edit mode
 * only) for a managed key the user explicitly cleared — see that function's doc comment. Without
 * this step, {@link ReplicationService.updateReplication}'s `{...stored, ...safeDoc}` merge would
 * PUT a literal `null` for that key instead of omitting it; CouchDB should see an absent key, the
 * same as if the field had never been set.
 */
function dropNullValues<T extends Record<string, unknown>>(doc: T): T {
  const out = { ...doc };
  for (const key of Object.keys(out)) {
    if (out[key] === null) delete out[key];
  }
  return out;
}

/** One row of `_scheduler/docs`, keyed by `doc_id` (not `_id`) — see module docs on `listReplications`. */
interface SchedulerEntry {
  doc_id: string;
  state?: string;
  last_updated?: string;
  error_count?: number;
  /** A union: healthy stats OR `{error}` when `state` is `crashing`/`failed`. Never both. */
  info?: {
    docs_written?: number;
    changes_pending?: number | null;
    error?: string;
  };
}

/**
 * Replication documents living in the single server's `_replicator` database, joined with live
 * scheduler state from `_scheduler/docs`.
 *
 * @param api - shared ApiClient (token already set by AuthService)
 */
export class ReplicationService {
  constructor(private api: ApiClient) {}

  /**
   * The base URL of the single CouchDB server this deployment manages (spec D2/D3). The editor
   * uses this — never `ApiClient` directly, which stays a service-layer implementation detail —
   * to compute the source endpoint (always local) and the default target endpoint (same server,
   * one click), and to build the "copy as curl" command's host.
   */
  localBaseUrl(): string {
    return this.api.currentBaseUrl;
  }

  /**
   * Reads every replication document: `GET /_replicator/_all_docs?include_docs=true` (design
   * docs dropped), joined against `GET /_scheduler/docs` on `doc_id` for live state, error and
   * progress. The two calls run via `Promise.allSettled`, but only the scheduler side is
   * optional — a scheduler failure must not fail the list, it just leaves the scheduler-only
   * fields undefined. A failed `_all_docs` read is the primary source failing and is re-thrown:
   * callers (the replications list, both dashboards) depend on this rejecting to show their
   * error state instead of silently rendering an empty list. Every document is annotated with
   * the single server (`cca_server_id`/`cca_server_name`/`replicator_doc_id`) and has its
   * `source`/`target` credentials masked; unlike {@link getReplication}, `headers` is dropped
   * from both endpoints entirely — the list view (both dashboards and the topology graph) never
   * needs a real header value, so it never receives one, even a masked placeholder. `params.filter`
   * matches, case-insensitively, against `_id` and both (masked) endpoint URLs.
   */
  async listReplications(params?: ListReplicationsParams): Promise<ReplicatorDoc[]> {
    const [allDocsResult, schedulerResult] = await Promise.allSettled([
      this.api.request<{ rows: Array<{ doc?: ReplicatorDoc & { _id: string } }> }>(
        'GET',
        `${REPLICATOR_DB}/_all_docs?include_docs=true`,
      ),
      this.api.request<{ docs: SchedulerEntry[] }>('GET', '/_scheduler/docs'),
    ]);

    if (allDocsResult.status === 'rejected') throw allDocsResult.reason;

    const rows = allDocsResult.value.rows ?? [];
    const schedulerDocs = schedulerResult.status === 'fulfilled' ? (schedulerResult.value.docs ?? []) : [];
    const byDocId = new Map(schedulerDocs.map((entry) => [entry.doc_id, entry]));

    const serverName = labelFor(this.api.currentBaseUrl);
    const filter = params?.filter?.trim().toLowerCase();

    const result: ReplicatorDoc[] = [];
    for (const row of rows) {
      const doc = row.doc;
      if (!doc || doc._id.startsWith('_design/')) continue;
      const annotated = this.annotate(doc, serverName, byDocId.get(doc._id));
      annotated.source = stripHeaders(annotated.source as Endpoint) as ReplicatorDoc['source'];
      annotated.target = stripHeaders(annotated.target as Endpoint) as ReplicatorDoc['target'];
      if (filter) {
        const haystack = [
          annotated._id ?? '',
          endpointUrl(annotated.source as Endpoint),
          endpointUrl(annotated.target as Endpoint),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(filter)) continue;
      }
      result.push(annotated);
    }
    return result;
  }

  /** A single replication document, by the server it lives on and its `_replicator` doc id. */
  async getReplication(_serverId: string, replId: string): Promise<ReplicatorDoc> {
    const doc = await this.api.request<ReplicatorDoc & { _id: string }>('GET', `${REPLICATOR_DB}/${seg(replId)}`);
    return this.annotate(doc, labelFor(this.api.currentBaseUrl));
  }

  /**
   * Creates a replication document: `PUT /_replicator/{_id}` when the document carries an `_id`,
   * else `POST /_replicator` for a server-generated one. Annotation fields (added by
   * {@link listReplications}/{@link getReplication}) are stripped before the write — they are
   * read-side only and CouchDB does not expect them.
   */
  createReplication(doc: ReplicatorDoc): Promise<DocWriteResponse> {
    const body = stripAnnotations(doc as unknown as Record<string, unknown>);
    if (doc._id) {
      return this.api.request('PUT', `${REPLICATOR_DB}/${seg(doc._id)}`, body);
    }
    return this.api.request('POST', REPLICATOR_DB, body);
  }

  /**
   * Read-modify-write: fetches the stored document, merges the caller's fields over it (the
   * caller's `_rev` wins when supplied, else the stored one is kept), strips annotations, then
   * `PUT /_replicator/{id}`. This is what restores tuning fields the form has no controls for
   * (e.g. `worker_processes`) — they survive because they are never in the caller's partial
   * document, so the stored value passes straight through the merge.
   *
   * `source`/`target` get one more check before the merge: both `getReplication` and
   * `listReplications` mask endpoint credentials, so a caller round-tripping a loaded document
   * (the editor's normal edit flow) would otherwise PUT the `***` placeholder back over the real
   * stored credential. {@link resolveEndpoint} swaps a still-masked endpoint back for the stored
   * one (keeping any other caller-edited property, e.g. `headers`); a genuinely new endpoint
   * value passes through untouched.
   *
   * A caller-supplied `null` on any other key is a different signal: `cca-repl-editor` writes it
   * (edit mode only) to mean "the user explicitly cleared this managed constraint", not "leave it
   * alone" — an omitted key already means the latter. {@link dropNullValues} deletes such keys
   * from the merge result before the PUT, so the clear actually reaches CouchDB as an absent key
   * instead of the read-modify-write merge silently restoring the stored value underneath it.
   */
  async updateReplication(
    _serverId: string,
    replId: string,
    doc: Partial<ReplicatorDoc>,
  ): Promise<DocWriteResponse> {
    const stored = await this.api.request<ReplicatorDoc>('GET', `${REPLICATOR_DB}/${seg(replId)}`);
    const safeDoc: Partial<ReplicatorDoc> = { ...doc };
    if ('source' in safeDoc) {
      safeDoc.source = resolveEndpoint(stored.source as Endpoint, safeDoc.source as Endpoint) as ReplicatorDoc['source'];
    }
    if ('target' in safeDoc) {
      safeDoc.target = resolveEndpoint(stored.target as Endpoint, safeDoc.target as Endpoint) as ReplicatorDoc['target'];
    }
    const merged = dropNullValues(
      stripAnnotations({ ...stored, ...safeDoc } as unknown as Record<string, unknown>),
    );
    return this.api.request('PUT', `${REPLICATOR_DB}/${seg(replId)}`, merged);
  }

  /** Deletes a replication document: reads its current `_rev`, then `DELETE /_replicator/{id}?rev=`. */
  async deleteReplication(_serverId: string, replId: string): Promise<void> {
    const stored = await this.api.request<{ _rev: string }>('GET', `${REPLICATOR_DB}/${seg(replId)}`);
    await this.api.request('DELETE', `${REPLICATOR_DB}/${seg(replId)}?rev=${encodeURIComponent(stored._rev)}`);
  }

  /**
   * Estimates how many documents a replication would move, without creating it. No native
   * CouchDB endpoint does this, so it is approximated client-side against the *source* database:
   * - `doc_ids` set: CouchDB replicates exactly that list (ignoring any selector/filter), so the
   *   count/sample come straight from it.
   * - else a `selector`: `POST /{source_db}/_find` with `fields: ["_id"]` and an explicit
   *   {@link PREVIEW_FIND_LIMIT} (CouchDB silently caps an unspecified `_find` limit at 25). When
   *   the result hits that cap, the true count is unknowable without walking the whole database,
   *   so the estimate is flagged as a lower bound instead of an exact number.
   * - else `GET /{source_db}/_all_docs?limit={@link PREVIEW_SAMPLE_SIZE}`, using CouchDB's own
   *   `total_rows` for an exact count.
   * A `filter` (server-side JS) can never be evaluated in the browser, so its presence always adds
   * a warning that the estimate ignores it, regardless of which branch above ran.
   */
  async previewReplication(req: PreviewRequest): Promise<PreviewResult> {
    const warnings: string[] = [];
    if (req.filter) {
      warnings.push('JS filters run server-side; this estimate ignores it.');
    }

    let estimatedDocCount: number;
    let sampleDocIds: string[];

    if (req.doc_ids && req.doc_ids.length > 0) {
      estimatedDocCount = req.doc_ids.length;
      sampleDocIds = req.doc_ids.slice(0, PREVIEW_SAMPLE_SIZE);
    } else if (req.selector) {
      const resp = await this.api.request<{ docs?: Array<{ _id: string }> }>(
        'POST',
        `${dbPath(req.source_db)}/_find`,
        { selector: req.selector, fields: ['_id'], limit: PREVIEW_FIND_LIMIT },
      );
      const docs = resp.docs ?? [];
      estimatedDocCount = docs.length;
      sampleDocIds = docs.slice(0, PREVIEW_SAMPLE_SIZE).map((doc) => doc._id);
      if (docs.length >= PREVIEW_FIND_LIMIT) {
        warnings.push(`At least ${docs.length} documents match; the preview stopped counting at the cap, so this is a lower bound.`);
      }
    } else {
      const resp = await this.api.request<{ total_rows: number; rows?: Array<{ id: string }> }>(
        'GET',
        `${dbPath(req.source_db)}/_all_docs?limit=${PREVIEW_SAMPLE_SIZE}`,
      );
      estimatedDocCount = resp.total_rows;
      sampleDocIds = (resp.rows ?? []).map((row) => row.id);
    }

    return {
      estimated_doc_count: estimatedDocCount,
      sample_doc_ids: sampleDocIds,
      ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    };
  }

  /** Adds the single-server identity, `replicator_doc_id` and (when found) scheduler state onto a raw doc, masking endpoint credentials. */
  private annotate(
    doc: ReplicatorDoc & { _id: string },
    serverName: string,
    scheduled?: SchedulerEntry,
  ): ReplicatorDoc {
    const annotated: ReplicatorDoc = {
      ...doc,
      source: maskEndpoint(doc.source as Endpoint),
      target: maskEndpoint(doc.target as Endpoint),
      cca_server_id: SINGLE_SERVER_ID,
      cca_server_name: serverName,
      replicator_doc_id: doc._id,
    };
    if (scheduled) {
      annotated.replication_state = scheduled.state;
      annotated.replication_state_time = scheduled.last_updated;
      annotated.error_count = scheduled.error_count;
      if (scheduled.info && 'error' in scheduled.info) {
        annotated.scheduler_error = scheduled.info.error;
      } else if (scheduled.info) {
        annotated.docs_written = scheduled.info.docs_written;
        annotated.changes_pending = scheduled.info.changes_pending;
      }
    }
    return annotated;
  }
}
