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

import { html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CcaElement } from "../../components/cca-element.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import { getLogger } from "../../services/log-service.js";
import { ApiError } from "../../services/api-error.js";
import {
  describeDbAccessError,
  isEnumerationDenied,
} from "../../services/db-enumeration.js";
import { SINGLE_SERVER_ID, serverKey } from "../../services/single-server.js";
import "../../webawesome.js";
import {
  addHeaderActions,
  clearHeaderActions,
  setHeaderTitle,
  clearHeaderTitle,
} from "../../components/cca-header.js";

const log = getLogger("plugins/replication/repl-editor");
import "./repl-source-section.js";
import "./repl-target-section.js";
import "./repl-selector-section.js";
import "./repl-filter-section.js";
import "./repl-documents-section.js";
import "./repl-behavior-section.js";
import "./repl-query-params-section.js";
import "./repl-winning-revs-section.js";
import "./repl-since-seq-section.js";
import "./repl-issues-panel.js";
import type { Server, ReplicatorDoc } from "./types.js";
import {
  buildReplicatorCurl,
  CREDENTIAL_PLACEHOLDER,
  maskHeaderValues,
} from "./replicator-curl.js";
import {
  isMaskedUrl,
  sameOrigin,
  type PreviewResult,
} from "../../services/replication-service.js";
import type { ReplAuthChangeDetail } from "./repl-auth-panel.ts";

/**
 * Replicator fields the editor has no form controls for but must not drop:
 * loaded doc -> Source JSON / copy-as-curl -> Source-tab edits, and now the
 * saved document itself. `buildReplicatorDocFromDesign` writes them straight
 * through to the native `_replicator` document alongside the fields the
 * editor does have controls for.
 */
const REPLICATION_TUNING_KEYS = [
  "use_checkpoints",
  "checkpoint_interval",
  "retries_per_request",
  "worker_processes",
  "worker_batch_size",
  "http_connections",
] as const;

/**
 * Every key `buildReplicatorDocFromDesign` can either write or explicitly clear. Clearing a
 * loaded value (selector, filter, doc_ids, query_params, winning_revs_only, since_seq, or a
 * tuning key removed via the Source JSON textarea) must reach the saved document as a literal
 * `null`, not an omitted property — omitting it would let `ReplicationService.updateReplication`'s
 * read-modify-write merge silently restore the stored value even though the UI reported success.
 * See `loadedManagedKeys` (the load-time baseline this compares against) and
 * `buildReplicatorDocFromDesign`.
 */
const MANAGED_CLEARABLE_KEYS = [
  "selector",
  "filter",
  "doc_ids",
  "query_params",
  "winning_revs_only",
  "since_seq",
  ...REPLICATION_TUNING_KEYS,
] as const;

@customElement("cca-repl-editor")
export class CcaReplEditor extends CcaElement {
  static styles = css`
    :host {
      display: block;
      color: var(--wa-color-text-normal);
    }

    .editor {
      display: grid;
      gap: 1rem;
    }

    .toolbar {
      border: 1px solid var(--wa-color-surface-border);
      border-radius: 10px;
      background: var(--wa-color-surface-default);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
      padding: 0.9rem 1rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .title {
      font-size: var(--wa-font-size-m);
      font-weight: var(--wa-font-weight-bold);
    }

    .toolbar-actions {
      display: flex;
      gap: 0.6rem;
      flex-wrap: wrap;
    }

    .tabs {
      border: 1px solid var(--wa-color-surface-border);
      border-radius: 10px;
      overflow: hidden;
      background: var(--wa-color-surface-default);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }

    .tab-list {
      display: flex;
      border-bottom: 1px solid var(--wa-color-surface-border);
      background: var(--wa-color-surface-raised);
    }

    .tab {
      border: 0;
      border-radius: 0;
      border-right: 1px solid var(--wa-color-surface-border);
      background: transparent;
      padding: 0.6rem 1rem;
      color: var(--wa-color-text-normal);
      font-size: var(--wa-font-size-s);
      font-weight: var(--wa-font-weight-bold);
      letter-spacing: 0.02em;
    }

    .tab.active {
      color: var(--wa-color-text-link);
      background: var(--wa-color-surface-default);
      box-shadow: inset 0 -2px 0 var(--wa-color-brand-fill-loud);
    }

    .panel {
      padding: 0;
    }

    .tabs-content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 1rem;
      align-items: start;
      padding: 1rem;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    wa-textarea {
      width: 100%;
    }

    .source-editor::part(textarea) {
      min-height: 420px;
      resize: vertical;
      font-family: var(--wa-font-family-code);
      font-size: var(--wa-font-size-s);
      line-height: var(--wa-line-height-normal);
    }

    .actions {
      display: flex;
      gap: 0.75rem;
      margin-top: 0.2rem;
      flex-wrap: wrap;
    }

    .preview-box {
      padding: 1rem;
      background: var(--wa-color-surface-raised);
      border-radius: var(--wa-border-radius-m);
      font-size: var(--wa-font-size-s);
    }
    .warning {
      color: var(--wa-color-warning-60);
      font-size: var(--wa-font-size-s);
    }
    .error {
      color: var(--wa-color-brand-fill-loud);
      font-size: var(--wa-font-size-s);
    }

    .hint {
      margin: 0;
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-quiet);
    }

    .constraint-check {
      color: var(--wa-color-success-fill-loud);
      margin-inline-start: 0.35rem;
    }

    @media (max-width: 820px) {
      .tabs-content {
        grid-template-columns: 1fr;
      }
    }
  `;

  @property({ type: String }) serverId = "";
  @property({ type: String }) replId = "";

  @state() private servers: Server[] = [];
  @state() private databases: string[] = [];
  /**
   * True when {@link databases} is empty because the list could not be fetched, rather than
   * because the server has none. `GET /_all_dbs` is admin-only by CouchDB's own default, so
   * this is the ordinary state for a signed-in non-admin — and the reason the Source Database
   * control must offer free text instead of a dropdown that can never fill (#5).
   *
   * Set only from the error `loadDatabases` actually received. Never from `auth.isAdmin`:
   * `[chttpd] admin_only_all_dbs = false` is a legitimate deployment where a non-admin's
   * `_all_dbs` returns 200, and pre-gating would hide a list the server was willing to serve.
   */
  @state() private databasesUnavailable = false;
  /** Why {@link databasesUnavailable} is set — shown under the free-text field. */
  @state() private databasesReason = "";
  @state() private preview: PreviewResult | null = null;
  @state() private submitting = false;
  @state() private error = "";
  @state() private loading = false;
  @state() private activeTab: "design" | "source" = "design";
  @state() private sourceDocJson = "";

  // Form state
  @state() private sourceServer = SINGLE_SERVER_ID;
  @state() private sourceDb = "";
  /** Base URL the target endpoint is built from; free text, defaults to the local server so a same-server replication is one click (CouchDB 3 has no local endpoints). */
  @state() private targetServerUrl = getContext().replication.localBaseUrl();
  @state() private targetDb = "";
  /**
   * Loaded verbatim from `source.headers` and never decoded — `cca-repl-auth-panel` renders a
   * "credentials stored" state instead of revealing the value, and only overwrites this field
   * via `cca-auth-change` (see `handleSourceAuthChange`). A save with the panel left untouched
   * re-emits the same object, so `buildReplicatorDocFromDesign`'s `headers` comes out
   * byte-identical to what was loaded and the stored credential round-trips unchanged; an
   * explicit Clear in the panel is what produces `{}` here.
   *
   * Defaults to `{}` — a fresh Create Replication screen has nothing stored. This used to
   * default to `{ Authorization: "Bearer " }`, a placeholder with no real token; the auth
   * panel's `deriveMode` now treats a bare `Bearer `/`Basic ` scheme as "no credential" too
   * (see `hasAuthorizationContent`), but there is no reason to manufacture that placeholder
   * here in the first place — the section components already default their own `auth` prop
   * to `{}`.
   */
  @state() private sourceAuth: Record<string, string> = {};
  /** Same contract as {@link sourceAuth}, for `target.headers`. */
  @state() private targetAuth: Record<string, string> = {};
  @state() private continuous = true;
  @state() private createTarget = true;
  @state() private selectorJson = "";
  @state() private filterFn = "";
  @state() private docIds: string[] = [];
  @state() private verifyingDocs = false;
  @state() private missingDocIds: string[] | null = null;
  @state() private tuningFields: Record<string, unknown> = {};
  @state() private queryParamsJson = "";
  @state() private winningRevsOnly = false;
  @state() private sinceSeq = "";
  @state() private owner = getContext().auth.state.username || "admin";
  @state() private loadedRevision = "";
  @state() private sourceUrlValue = "";
  @state() private targetUrlValue = "";
  /**
   * The target endpoint URL exactly as loaded (or last applied from Source
   * JSON) — the baseline `effectiveTargetUrl()` is compared against to
   * detect a masked target that would silently drop an edit. See
   * `computeSafetyRails`'s masked-target-url check.
   */
  @state() private loadedTargetUrl = "";
  /** Same contract as {@link loadedTargetUrl}, for `effectiveSourceUrl()` — a loaded source can
   * carry userinfo too (any externally-created pull replication), and the identical
   * masked-credential rail must guard it. */
  @state() private loadedSourceUrl = "";

  /**
   * The subset of {@link MANAGED_CLEARABLE_KEYS} actually present on the document as loaded
   * (edit mode only) — see that constant's doc comment. Populated once in `populateFormFromDoc`
   * and, like `loadedRevision`/`loadedTargetUrl`, deliberately NOT updated by
   * `applySourceToDesign`: it is the load-time baseline a save is judged against, not a running
   * total of edits made since.
   */
  private loadedManagedKeys = new Set<string>();

  private syncingFromSource = false;

  private cleanAuthObject(
    auth: Record<string, string>,
  ): Record<string, string> {
    return Object.entries(auth).reduce<Record<string, string>>(
      (acc, [key, value]) => {
        const k = key.trim();
        const v = String(value ?? "").trim();
        if (k && v) acc[k] = v;
        return acc;
      },
      {},
    );
  }

  private selectorStringOrUndefined(input: string): string | undefined {
    const trimmed = input.trim();
    if (!trimmed) return undefined;
    return JSON.stringify(JSON.parse(trimmed));
  }

  /** Parsed query_params object, or undefined when blank. Throws on invalid JSON
      (computeSafetyRails blocks save/preview first, mirroring the selector). */
  private queryParamsOrUndefined(): Record<string, unknown> | undefined {
    const trimmed = this.queryParamsJson.trim();
    if (!trimmed) return undefined;
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("query_params must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * The filter as "designdoc/function", or '' when it carries no real content.
   * A bare '/' (both parts empty) — which older docs may have persisted — is
   * not a usable filter, so it must not light the checkmark or be sent.
   */
  private effectiveFilter(): string {
    const trimmed = this.filterFn.trim();
    return trimmed.split("/").some((part) => part.trim().length > 0)
      ? trimmed
      : "";
  }

  /**
   * Target URL field validation (`<wa-input type="url">` in repl-target-section.ts's own
   * constraint is presentational only — this is what actually gates save). `new URL()` alone
   * accepts non-special schemes like "couchdb:5984" as an opaque-path URL with no host, which
   * would silently build a broken `_replicator` endpoint — require `http`/`https` and a host.
   */
  private isValidUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.host.length > 0;
    } catch {
      return false;
    }
  }

  private handleSourceAuthChange(e: CustomEvent<ReplAuthChangeDetail>) {
    this.sourceAuth = { ...e.detail.auth };
  }

  private handleTargetAuthChange(e: CustomEvent<ReplAuthChangeDetail>) {
    this.targetAuth = { ...e.detail.auth };
  }

  private handleSourceDbChange(e: CustomEvent<{ sourceDb: string }>) {
    this.missingDocIds = null;
    this.sourceDb = this.coerceDatabaseName(e.detail.sourceDb);
    this.sourceUrlValue = "";
  }

  private handleTargetServerUrlChange(
    e: CustomEvent<{ targetServerUrl: string }>,
  ) {
    this.targetServerUrl = e.detail.targetServerUrl || "";
    this.targetUrlValue = "";
  }

  private handleTargetDbChange(e: CustomEvent<{ targetDb: string }>) {
    this.targetDb = this.coerceDatabaseName(e.detail.targetDb);
    this.targetUrlValue = "";
  }

  private coerceDatabaseName(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }

    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const candidate =
        record.name ??
        record.db ??
        record.database ??
        record.db_name ??
        record.database_name ??
        record._id ??
        record.value;
      if (typeof candidate === "string") {
        return candidate;
      }
    }

    return "";
  }

  private normalizeDatabaseNames(payload: unknown): string[] {
    const names: string[] = [];

    const collect = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach((item) => collect(item));
        return;
      }

      const direct = this.coerceDatabaseName(value);
      if (direct) {
        names.push(direct);
        return;
      }

      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.databases) {
          collect(record.databases);
        }
      }
    };

    collect(payload);
    return Array.from(new Set(names));
  }

  private selectorJsonFromUnknown(selector: unknown): string {
    if (selector == null) {
      return "";
    }

    if (typeof selector === "string") {
      const trimmed = selector.trim();
      if (!trimmed) {
        return "";
      }

      try {
        const parsed = JSON.parse(trimmed);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return trimmed;
      }
    }

    try {
      return JSON.stringify(selector, null, 2);
    } catch {
      return "";
    }
  }

  private tuningFieldsFrom(
    doc: Record<string, unknown>,
  ): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const key of REPLICATION_TUNING_KEYS) {
      const value = doc[key];
      if (value !== undefined && value !== null) {
        picked[key] = value;
      }
    }
    return picked;
  }

  /**
   * True when `key` (one of {@link MANAGED_CLEARABLE_KEYS}) carries a real value on the raw
   * loaded doc — mirrors the presence check each field's own loader above already applies
   * (`selectorValue != null`, `Array.isArray(doc.doc_ids)`, `doc.winning_revs_only === true`,
   * ...), so `loadedManagedKeys` agrees with what the form actually shows as "set" right after
   * load.
   */
  private managedKeyPresentInDoc(
    doc: Record<string, unknown>,
    key: string,
  ): boolean {
    const value = doc[key];
    switch (key) {
      case "selector":
      case "query_params":
        return value != null;
      case "filter":
      case "since_seq":
        return typeof value === "string" && value.length > 0;
      case "doc_ids":
        return Array.isArray(value) && value.length > 0;
      case "winning_revs_only":
        return value === true;
      default: // tuning keys
        return value !== undefined && value !== null;
    }
  }

  private handleSelectorJsonChange(e: CustomEvent<{ selectorJson: string }>) {
    this.selectorJson = e.detail.selectorJson || "";
  }

  private handleQueryParamsChange(e: CustomEvent<{ queryParamsJson: string }>) {
    this.queryParamsJson = e.detail.queryParamsJson;
  }

  private handleWinningRevsChange(
    e: CustomEvent<{ winningRevsOnly: boolean }>,
  ) {
    this.winningRevsOnly = e.detail.winningRevsOnly;
  }

  private handleSinceSeqChange(e: CustomEvent<{ sinceSeq: string }>) {
    this.sinceSeq = e.detail.sinceSeq;
  }

  private handleFilterFnChange(e: CustomEvent<{ filterFn: string }>) {
    this.filterFn = e.detail.filterFn || "";
  }

  private handleDocIdsChange(e: CustomEvent<{ docIds: string[] }>) {
    this.missingDocIds = null;
    this.docIds = [...e.detail.docIds];
  }

  private async handleVerifyDocs() {
    if (
      !this.sourceServer ||
      !this.sourceDb ||
      this.docIds.length === 0 ||
      !this.sourceSelectionIsEffective()
    )
      return;
    const ids = [...this.docIds];
    const server = this.sourceServer;
    const db = this.sourceDb;
    // If the source or the doc list changed while this verify was in
    // flight, the results below no longer describe the current form
    // state — drop them instead of clobbering a newer reset/verify.
    const stillCurrent = () =>
      server === this.sourceServer &&
      db === this.sourceDb &&
      ids.length === this.docIds.length &&
      ids.every((id, i) => id === this.docIds[i]);
    this.verifyingDocs = true;
    try {
      const found = new Set<string>();
      // Mango _find never returns _design docs and silently caps at 25 rows
      // without an explicit limit — hence the split and the limit.
      const designIds = ids.filter((id) => id.startsWith("_design/"));
      const regularIds = ids.filter((id) => !id.startsWith("_design/"));
      if (regularIds.length > 0) {
        const resp = await getContext().dbMgmt.queryDocuments(server, db, {
          selector: { _id: { $in: regularIds } },
          scope: "raw",
          limit: regularIds.length,
        });
        for (const doc of resp.documents ?? []) {
          if (typeof doc._id === "string") found.add(doc._id);
        }
      }
      for (const id of designIds) {
        try {
          await getContext().dbMgmt.getDoc(server, db, id);
          found.add(id);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
      }
      if (stillCurrent()) {
        this.missingDocIds = ids.filter((id) => !found.has(id));
      }
    } catch (err) {
      // Same staleness guard as the success path: a superseded request's
      // failure must not clobber a newer reset/verify with a stray toast.
      if (stillCurrent()) {
        this.missingDocIds = null;
        toast(
          err instanceof Error ? err.message : "Failed to verify documents",
          "error",
        );
      }
    } finally {
      this.verifyingDocs = false;
    }
  }

  private handleBehaviorContinuousChange(
    e: CustomEvent<{ continuous: boolean }>,
  ) {
    this.continuous = e.detail.continuous;
  }

  private handleBehaviorCreateTargetChange(
    e: CustomEvent<{ createTarget: boolean }>,
  ) {
    this.createTarget = e.detail.createTarget;
  }

  private isEditMode() {
    return this.serverId && this.replId;
  }

  /** True when (the local server, sourceDb) actually is the effective source endpoint. */
  private sourceSelectionIsEffective(): boolean {
    return (
      !this.sourceUrlValue ||
      this.sourceUrlValue ===
        this.endpointUrl(getContext().replication.localBaseUrl(), this.sourceDb)
    );
  }

  async connectedCallback() {
    super.connectedCallback();
    this._updateHeaderActions();
    try {
      const { servers } = await getContext().serverMgmt.listServers();
      this.servers = servers;
    } catch {
      this.servers = [];
    }
    if (this.isEditMode()) {
      await this.loadReplication();
    } else {
      // Source is always this deployment's one server (spec D2/D3), so its
      // databases can load immediately — no server picker to wait on.
      const sourceDb = getContext().router.currentQuery().get("source_db");
      if (sourceDb) {
        this.sourceDb = sourceDb;
      }
      void this.loadDatabases(this.sourceServer);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderActions();
    clearHeaderTitle();
  }

  updated(changed: Map<string, unknown>) {
    if (
      (changed.has("serverId") || changed.has("replId")) &&
      this.serverId &&
      this.replId
    ) {
      void this.loadReplication();
    }

    if (this.syncingFromSource) {
      return;
    }

    const designKeys = [
      "sourceServer",
      "sourceDb",
      "targetServerUrl",
      "targetDb",
      "sourceUrlValue",
      "targetUrlValue",
      "sourceAuth",
      "targetAuth",
      "continuous",
      "createTarget",
      "owner",
      "selectorJson",
      "filterFn",
      "docIds",
      "queryParamsJson",
      "winningRevsOnly",
      "sinceSeq",
      "tuningFields",
    ];

    if (designKeys.some((key) => changed.has(key))) {
      this.syncSourceFromDesign();
    }

    if (
      [...designKeys, "submitting", "loading", "serverId", "replId"].some(
        (key) => changed.has(key),
      )
    ) {
      this._updateHeaderActions();
    }
  }

  private async loadReplication() {
    this.loading = true;
    this.error = "";
    try {
      const doc = await getContext().replication.getReplication(
        this.serverId,
        this.replId,
      );
      // `?logLevel=debug` is a production-reachable opt-in — a stored credential (any header
      // name) must never land in the console, so log the masked view, not the raw doc.
      log.debug("loaded replication doc", {
        doc: this.maskDocEndpointHeaders(doc as unknown as Record<string, unknown>),
      });
      this.populateFormFromDoc(doc);
    } catch (err) {
      this.error =
        err instanceof Error ? err.message : "Failed to load replication";
    } finally {
      this.loading = false;
    }
  }

  private populateFormFromDoc(doc: ReplicatorDoc) {
    const legacyDoc = doc as ReplicatorDoc & {
      source_db?: string | { url?: string };
      target_db?: string | { url?: string };
      owner?: string;
    };
    const sourceEndpoint = legacyDoc.source ?? legacyDoc.source_db;
    const targetEndpoint = legacyDoc.target ?? legacyDoc.target_db;
    const sourceUrl =
      typeof sourceEndpoint === "string"
        ? sourceEndpoint
        : sourceEndpoint?.url || "";
    const targetUrl =
      typeof targetEndpoint === "string"
        ? targetEndpoint
        : targetEndpoint?.url || "";

    this.sourceServer =
      doc.cca_server_id ||
      this.serverId ||
      this.inferServerIdFromUrl(this.baseUrlFromEndpoint(sourceEndpoint));
    this.sourceDb = this.dbNameFromEndpoint(sourceEndpoint);
    this.targetDb = this.dbNameFromEndpoint(targetEndpoint);
    this.continuous = doc.continuous ?? true;
    this.createTarget = doc.create_target === true;
    this.loadedRevision = doc._rev || "";
    this.sourceUrlValue = sourceUrl;
    this.targetUrlValue = targetUrl;
    this.loadedTargetUrl = targetUrl;
    this.loadedSourceUrl = sourceUrl;
    this.owner =
      legacyDoc.owner?.toString() ||
      getContext().auth.state.username ||
      "admin";

    // No `headers` at all (an edit-mode doc that never had auth configured) is "no stored
    // credential", not the old `{ Authorization: "Bearer " }` placeholder — see `sourceAuth`'s
    // doc comment.
    this.sourceAuth = {
      ...((typeof sourceEndpoint === "object"
        ? (sourceEndpoint as { headers?: Record<string, string> }).headers
        : undefined) || {}),
    };
    this.targetAuth = {
      ...((typeof targetEndpoint === "object"
        ? (targetEndpoint as { headers?: Record<string, string> }).headers
        : undefined) || {}),
    };
    const selectorValue = doc.selector;
    if (selectorValue != null) {
      this.selectorJson = this.selectorJsonFromUnknown(selectorValue);
    } else {
      this.selectorJson = "";
    }
    this.filterFn = doc.filter ?? "";
    this.docIds = Array.isArray(doc.doc_ids) ? doc.doc_ids.map(String) : [];
    this.missingDocIds = null;
    this.queryParamsJson = this.selectorJsonFromUnknown(doc.query_params);
    this.winningRevsOnly = doc.winning_revs_only === true;
    this.sinceSeq = typeof doc.since_seq === "string" ? doc.since_seq : "";
    this.tuningFields = this.tuningFieldsFrom(
      doc as unknown as Record<string, unknown>,
    );
    this.loadedManagedKeys = new Set(
      MANAGED_CLEARABLE_KEYS.filter((key) =>
        this.managedKeyPresentInDoc(doc as unknown as Record<string, unknown>, key),
      ),
    );
    // The target's own base URL (its host/port, without the db path) is what
    // the free-text URL field shows; fall back to whatever it already held
    // (the local base URL, from the field initializer) when the doc has no
    // target endpoint at all.
    if (targetUrl) {
      this.targetServerUrl =
        this.baseUrlFromEndpoint(targetEndpoint) || this.targetServerUrl;
    }
    // Load databases for the source server
    if (this.sourceServer) {
      void this.loadDatabases(this.sourceServer);
    }

    this.syncSourceFromDesign();
  }

  private dbNameFromEndpoint(
    endpoint: string | { url?: string } | undefined,
  ): string {
    const url = typeof endpoint === "string" ? endpoint : endpoint?.url || "";
    return url.split("/").filter(Boolean).pop() || "";
  }

  private baseUrlFromEndpoint(
    endpoint: string | { url?: string } | undefined,
  ): string {
    const url = typeof endpoint === "string" ? endpoint : endpoint?.url || "";
    return url.split("/").slice(0, 3).join("/");
  }

  /**
   * The server whose `_replicator` db hosts this replication. CouchDB 3 has
   * no local endpoints (verified live), so both create and edit always write
   * through this deployment's one server (spec D2/D3) — never a picked
   * "source server" id, which is otherwise inert bookkeeping.
   */
  private replicatorHostUrl(): string {
    return getContext().replication.localBaseUrl();
  }

  private async handleCopyCurl() {
    let doc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(this.sourceDocJson);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("replicator document must be a JSON object");
      }
      doc = parsed as Record<string, unknown>;
    } catch {
      toast("Source JSON is invalid", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(
        buildReplicatorCurl(this.replicatorHostUrl(), doc),
      );
      toast("curl command copied", "success");
    } catch {
      toast("Failed to copy curl command", "error");
    }
  }

  /** Joins a base URL and a database name into a full endpoint URL, the way every `_replicator` endpoint must be written (CouchDB 3 has no local endpoints). */
  private endpointUrl(base: string, dbName: string): string {
    if (!base) return "";
    const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
    return dbName ? `${normalizedBase}/${dbName}` : normalizedBase;
  }

  /**
   * `SINGLE_SERVER_ID` when `url` is this deployment's own server, else `""`.
   * There is only ever one real server now, so this is a straight comparison
   * against {@link ReplicationService.localBaseUrl} — no registry to search.
   *
   * Compared on {@link serverKey}, the same reading the topology graph uses (#59). This used to
   * chop the URL at the third `/` and string-compare, which called four kinds of "our own server"
   * foreign: a differently-cased host, an explicitly written default port, a loopback alias
   * (`127.0.0.1` for `localhost` — routine in the devcontainer), and — most often — any endpoint
   * carrying credentials, since stored endpoints arrive `***`-masked as `http://***@host/db` and
   * userinfo is part of neither `serverKey` nor an origin.
   *
   * Not to be confused with `replication-service.ts#sameOrigin`, which looks like the same
   * question and must *not* be relaxed this way: it gates splicing real stored credentials onto a
   * caller-supplied URL, where exact-origin equality is the security property.
   */
  private inferServerIdFromUrl(url: string): string {
    const key = serverKey(url);
    const local = serverKey(getContext().replication.localBaseUrl());
    return key && key === local ? SINGLE_SERVER_ID : "";
  }

  /**
   * Fills the Source Database control, and — when CouchDB will not produce the list — says so
   * out loud instead of leaving an empty dropdown behind (#5).
   *
   * Two failures, told apart by {@link isEnumerationDenied} and treated differently on purpose:
   *
   *  * **Refused (401/403).** The everyday answer for a non-admin, and not an error: nothing is
   *    broken and nothing the user can fix. It degrades to free text carrying its own
   *    explanation, with no toast — one on every visit to this screen would be noise.
   *  * **Anything else** (500, network, a malformed response). Unexpected, so it is *shown*.
   *    A `log.warn` nobody has a console open for was the whole defect here.
   *
   * Both degrade to free text, because either way the user still knows the database name they
   * want and a dropdown that cannot be filled is a dead end. Only the toast distinguishes them.
   */
  private async loadDatabases(serverId: string) {
    if (!serverId) return;
    try {
      const dbs = await getContext().serverMgmt.getDatabases(serverId);
      this.databases = this.normalizeDatabaseNames(dbs);
      this.databasesUnavailable = false;
      this.databasesReason = "";
    } catch (err) {
      log.warn("failed to load databases", err as Error);
      this.databases = [];
      this.databasesUnavailable = true;
      this.databasesReason = describeDbAccessError(err);
      if (!isEnumerationDenied(err)) {
        toast(this.databasesReason, "error");
      }
    }
  }

  /** The source endpoint URL that would actually be saved right now. */
  private effectiveSourceUrl(): string {
    const computed = this.endpointUrl(
      getContext().replication.localBaseUrl(),
      this.sourceDb,
    );
    return this.sourceUrlValue || computed;
  }

  /**
   * The target endpoint URL that would actually be saved right now:
   * `targetUrlValue`'s override when set (loaded verbatim, or a Source-tab
   * edit), else built fresh from the free-text server URL field + the
   * database. Shared by `buildReplicatorDocFromDesign` and
   * `computeSafetyRails`'s masked-target-url check, so both always agree on
   * what is about to be sent.
   */
  private effectiveTargetUrl(): string {
    const computed = this.endpointUrl(
      this.targetServerUrl,
      this.targetDb || this.sourceDb,
    );
    return this.targetUrlValue || computed;
  }

  /**
   * Builds the native `_replicator` document to save — this is the only
   * request body the editor produces now (Task 3): source is always this
   * deployment's one server, since CouchDB 3 has no local endpoints and
   * every endpoint, same-server or not, needs a full URL.
   */
  private buildReplicatorDocFromDesign() {
    const sourceUrl = this.effectiveSourceUrl();
    const targetUrl = this.effectiveTargetUrl();

    const doc: Record<string, unknown> = {
      source: {
        url: sourceUrl,
        headers: this.cleanAuthObject(this.sourceAuth),
      },
      target: {
        url: targetUrl,
        headers: this.cleanAuthObject(this.targetAuth),
      },
      create_target: this.createTarget,
      continuous: this.continuous,
      owner: this.owner || getContext().auth.state.username || "admin",
    };

    const editMode = this.isEditMode();
    if (editMode) {
      doc._id = this.replId;
      if (this.loadedRevision) {
        doc._rev = this.loadedRevision;
      }
    }

    /**
     * Writes `value` when the field is set; otherwise, in edit mode only, writes an explicit
     * `null` if `key` WAS present on the loaded doc ({@link loadedManagedKeys}) — omitting it
     * would let `ReplicationService.updateReplication`'s read-modify-write merge silently
     * restore the stored value even though the Source JSON (and the "Replication updated" toast)
     * told the user it was gone. `updateReplication` strips `null`-valued keys before the PUT, so
     * CouchDB receives an absent key, not a literal `null`. Create mode has no stored document to
     * resurrect a value from, so an omitted key there is already correct — never nulled.
     */
    const setOrClearManaged = (key: string, isSet: boolean, value?: unknown) => {
      if (isSet) {
        doc[key] = value;
      } else if (editMode && this.loadedManagedKeys.has(key)) {
        doc[key] = null;
      }
    };

    const selector = this.selectorStringOrUndefined(this.selectorJson);
    setOrClearManaged("selector", Boolean(selector), selector ? JSON.parse(selector) : undefined);

    const filter = this.effectiveFilter();
    setOrClearManaged("filter", Boolean(filter), filter);

    setOrClearManaged("doc_ids", this.docIds.length > 0, this.docIds);

    const queryParams = this.queryParamsOrUndefined();
    setOrClearManaged("query_params", Boolean(queryParams), queryParams);

    setOrClearManaged("winning_revs_only", this.winningRevsOnly, true);

    const sinceSeq = this.sinceSeq.trim();
    setOrClearManaged("since_seq", sinceSeq.length > 0, sinceSeq);

    for (const key of REPLICATION_TUNING_KEYS) {
      setOrClearManaged(key, key in this.tuningFields, this.tuningFields[key]);
    }

    return doc;
  }

  /**
   * Masks every header value on both `source`/`target` endpoints of a `_replicator`-shaped
   * document with {@link CREDENTIAL_PLACEHOLDER} (via {@link maskHeaderValues} — key-generic,
   * not just `Authorization`), leaving everything else untouched. Shared by
   * {@link buildReplicatorDocForDisplay} (what the Source JSON tab renders) and
   * `loadReplication`'s debug log, so a stored credential under any header name reaches neither
   * the screen nor the console.
   */
  private maskDocEndpointHeaders(
    doc: Record<string, unknown> & {
      source?: Record<string, unknown> & { headers?: unknown };
      target?: Record<string, unknown> & { headers?: unknown };
    },
  ): Record<string, unknown> {
    const masked = { ...doc };
    if (masked.source) {
      masked.source = { ...masked.source, headers: maskHeaderValues(masked.source.headers) };
    }
    if (masked.target) {
      masked.target = { ...masked.target, headers: maskHeaderValues(masked.target.headers) };
    }
    return masked;
  }

  /**
   * Same document as {@link buildReplicatorDocFromDesign}, but with every header value in
   * `source.headers`/`target.headers` masked (see {@link maskDocEndpointHeaders}). Used only for
   * what the Source JSON tab *displays* (`syncSourceFromDesign`): the app does not render a
   * stored credential back to the screen, mirroring `cca-repl-auth-panel`'s own contract.
   * `applySourceToDesign` is the other half — it resolves the sentinel back to the real value
   * (via `resolveDisplayedHeaders`) so an edit to some other field doesn't silently overwrite the
   * stored credential with the placeholder. `handleSubmit` always builds what it actually saves
   * from `buildReplicatorDocFromDesign` directly (the unmasked one), never from this display copy.
   */
  private buildReplicatorDocForDisplay(): Record<string, unknown> {
    return this.maskDocEndpointHeaders(this.buildReplicatorDocFromDesign());
  }

  private syncSourceFromDesign() {
    try {
      this.sourceDocJson = JSON.stringify(
        this.buildReplicatorDocForDisplay(),
        null,
        2,
      );
    } catch {
      // Keep the existing source text while design has invalid JSON (e.g. selector typing).
    }
  }

  /**
   * Resolves headers parsed back from the (masked) Source JSON textarea: a value still
   * carrying {@link CREDENTIAL_PLACEHOLDER} is swapped for the matching key's real value
   * already held in `current` (this component's own `sourceAuth`/`targetAuth`, which the
   * masked view never actually removed it from) rather than being written through as the
   * literal placeholder string — the same splice `resolveEndpoint` performs server-side for a
   * masked endpoint URL. Any value the user actually changed (including a genuinely typed
   * `REPLACE_WITH_CREDENTIALS`, on the off chance — `key in current` also has to hold) passes
   * through untouched. Falls back to `{}` when the parsed document carries no headers object
   * for that endpoint at all.
   */
  private resolveDisplayedHeaders(
    parsedHeaders: Record<string, unknown> | undefined,
    current: Record<string, string>,
  ): Record<string, string> {
    if (!parsedHeaders) return {};
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsedHeaders)) {
      const strValue = String(value ?? "");
      resolved[key] =
        strValue === CREDENTIAL_PLACEHOLDER && key in current ? current[key] : strValue;
    }
    return resolved;
  }

  private applySourceToDesign() {
    let parsed: any;
    try {
      parsed = JSON.parse(this.sourceDocJson);
    } catch (err) {
      this.error =
        err instanceof Error
          ? `Invalid source JSON: ${err.message}`
          : "Invalid source JSON";
      return false;
    }

    this.syncingFromSource = true;
    this.error = "";

    const sourceUrl =
      typeof parsed.source === "string"
        ? parsed.source
        : (parsed.source?.url?.toString() ?? "");
    const targetUrl =
      typeof parsed.target === "string"
        ? parsed.target
        : (parsed.target?.url?.toString() ?? "");

    const inferredSourceServer = this.inferServerIdFromUrl(sourceUrl);
    const inferredSourceDb = this.dbNameFromEndpoint(sourceUrl);
    const inferredTargetDb = this.dbNameFromEndpoint(targetUrl);

    this.sourceServer = inferredSourceServer || this.sourceServer;
    this.targetServerUrl = this.baseUrlFromEndpoint(targetUrl) || this.targetServerUrl;
    this.sourceDb = inferredSourceDb || this.sourceDb;
    this.targetDb = inferredTargetDb || this.targetDb;
    this.sourceUrlValue = sourceUrl;
    // loadedTargetUrl is NOT updated here. It is the masked-target-url
    // check's load baseline — only a genuine document load
    // (populateFormFromDoc) may move it. If applying Source JSON also
    // moved it, pasting an edited (still-masked) target straight into the
    // baseline would make it match itself and the check would never fire —
    // exactly the bypass this field exists to close.
    this.targetUrlValue = targetUrl;
    this.continuous = parsed.continuous ?? true;
    this.createTarget = parsed.create_target ?? true;
    this.owner =
      parsed.owner?.toString() || getContext().auth.state.username || "admin";
    this.loadedRevision = parsed._rev?.toString() || "";

    this.selectorJson = this.selectorJsonFromUnknown(parsed.selector);
    this.filterFn = typeof parsed.filter === "string" ? parsed.filter : "";
    this.docIds = Array.isArray(parsed.doc_ids)
      ? parsed.doc_ids.map(String)
      : [];
    this.missingDocIds = null;
    this.queryParamsJson = this.selectorJsonFromUnknown(parsed.query_params);
    this.winningRevsOnly = parsed.winning_revs_only === true;
    this.sinceSeq =
      typeof parsed.since_seq === "string" ? parsed.since_seq : "";
    this.tuningFields = this.tuningFieldsFrom(
      parsed as Record<string, unknown>,
    );

    const sourceHeadersObject =
      typeof parsed.source === "object" && parsed.source?.headers
        ? (parsed.source.headers as Record<string, unknown>)
        : undefined;
    const targetHeadersObject =
      typeof parsed.target === "object" && parsed.target?.headers
        ? (parsed.target.headers as Record<string, unknown>)
        : undefined;

    // The JSON just parsed came from the masked Source JSON view (see
    // `buildReplicatorDocForDisplay`) — resolve the placeholder back to the real stored value
    // rather than writing it through, same contract as a masked endpoint URL.
    this.sourceAuth = this.resolveDisplayedHeaders(
      sourceHeadersObject,
      this.sourceAuth,
    );
    this.targetAuth = this.resolveDisplayedHeaders(
      targetHeadersObject,
      this.targetAuth,
    );

    if (this.sourceServer) {
      void this.loadDatabases(this.sourceServer);
    }

    this.syncSourceFromDesign();
    this.syncingFromSource = false;
    return true;
  }

  private async handlePreview() {
    this.error = "";
    try {
      if (this.activeTab === "source" && !this.applySourceToDesign()) {
        return;
      }
      // Preview queries the LOCAL server's `_find`/`_all_docs` directly against `sourceDb` — see
      // ReplicationService.previewReplication. For a legacy/remote source (an edit-mode doc
      // whose source endpoint isn't actually this deployment's one server) that bare db name
      // would target the wrong database on the local server instead of the real remote one. Gate
      // this the same way the filter/documents sections already do.
      if (!this.sourceSelectionIsEffective()) {
        return;
      }

      const body: any = {
        source_server_id: this.sourceServer,
        source_db: this.sourceDb,
      };
      const selector = this.selectorStringOrUndefined(this.selectorJson);
      if (selector) {
        body.selector = JSON.parse(selector);
      }
      const filter = this.effectiveFilter();
      if (filter) {
        body.filter = filter;
      }
      if (this.docIds.length > 0) {
        body.doc_ids = this.docIds;
      }
      this.preview = await getContext().replication.previewReplication(body);
    } catch (err) {
      this.error =
        err instanceof SyntaxError
          ? "Invalid JSON in selector"
          : "Preview failed";
    }
  }

  private async handleSubmit(e: Event) {
    e.preventDefault();
    this.error = "";
    // Rails must run against the state that will actually be sent. On the
    // Source tab, the textarea's edits (including anything that changes
    // what buildReplicatorDocFromDesign would produce, e.g. the masked-
    // target-url check below) only land in that state via
    // applySourceToDesign — so it has to run first, not after the rail
    // check passed against stale pre-edit state.
    if (this.activeTab === "source" && !this.applySourceToDesign()) {
      return;
    }
    const rails = this.computeSafetyRails();
    if (rails.blocking.length > 0) {
      this.error = rails.blocking[0];
      return;
    }
    this.submitting = true;
    try {
      const doc = this.buildReplicatorDocFromDesign();

      if (this.isEditMode()) {
        await getContext().replication.updateReplication(
          this.serverId,
          this.replId,
          doc as unknown as Partial<ReplicatorDoc>,
        );
        toast("Replication updated", "success");
      } else {
        await getContext().replication.createReplication(
          doc as unknown as ReplicatorDoc,
        );
        toast("Replication created", "success");
      }
      getContext().router.navigate(
        `/replications/${encodeURIComponent(this.serverId || "$all")}`,
      );
    } catch (err) {
      this.error = err instanceof Error ? err.message : "Failed";
    } finally {
      this.submitting = false;
    }
  }

  private _updateHeaderActions() {
    if (!this.isConnected) return;
    setHeaderTitle(
      this.isEditMode() ? "Edit Replication" : "Create Replication",
    );
    clearHeaderActions();
    const rails = this.computeSafetyRails();
    const canPreview =
      this.sourceServer.length > 0 &&
      this.sourceDb.length > 0 &&
      this.sourceSelectionIsEffective() &&
      !rails.blocking.some((msg) => msg.includes("Selector JSON is invalid"));
    const canSave = rails.blocking.length === 0;
    addHeaderActions([
      {
        id: "repl-preview",
        icon: "magnifying-glass",
        tooltip: "Preview",
        label: "Preview",
        variant: "neutral",
        disabled: !canPreview,
        action: () => void this.handlePreview(),
      },
      {
        id: "repl-save",
        icon: "floppy-disk",
        tooltip: this.isEditMode()
          ? "Update Replication"
          : "Create Replication",
        label: this.isEditMode() ? "Update Replication" : "Create Replication",
        variant: "brand",
        disabled: this.submitting || !canSave,
        action: () => this.requestSave(),
      },
      {
        id: "repl-cancel",
        icon: "xmark",
        tooltip: "Cancel",
        label: "Cancel",
        variant: "neutral",
        action: () =>
          getContext().router.navigate(
            `/replications/${encodeURIComponent(this.serverId || "$all")}`,
          ),
      },
    ]);
  }

  /** Submits through the form so native constraint validation still runs. */
  private requestSave() {
    this.shadowRoot
      ?.querySelector<HTMLFormElement>("#replication-editor-form")
      ?.requestSubmit();
  }

  private computeSafetyRails(): { blocking: string[]; warnings: string[] } {
    const blocking: string[] = [];
    const warnings: string[] = [];

    if (!this.sourceDb) {
      blocking.push("Select a source database before preview or save.");
    } else {
      // Same rail as the target-url check below, mirrored for the source: a loaded SOURCE
      // endpoint can carry userinfo too (any externally-created pull replication), and
      // ReplicationService.updateReplication's resolveEndpoint applies the identical
      // splice-if-same-origin / ignore-if-not logic to `source`. Without this check, editing a
      // masked source to point at a different host would silently keep the stored source while
      // still reporting success.
      const effectiveSourceUrl = this.effectiveSourceUrl();
      if (
        isMaskedUrl(effectiveSourceUrl) &&
        !sameOrigin(effectiveSourceUrl, this.loadedSourceUrl)
      ) {
        blocking.push(
          "Source URL still shows a masked credential (***) for a different server. Enter the real source URL to change the source.",
        );
      }
    }
    const targetServerUrl = this.targetServerUrl.trim();
    if (!targetServerUrl) {
      blocking.push("Enter a target URL before saving.");
    } else if (!this.isValidUrl(targetServerUrl)) {
      blocking.push("Target URL is invalid.");
    } else {
      // A loaded target endpoint's credentials come back masked ("***").
      // ReplicationService.updateReplication's resolveEndpoint splices the
      // stored credentials onto an edited masked URL when its origin still
      // matches the loaded one (a same-server edit, e.g. only the database
      // changed) — that case is safe to save. When the origin differs, the
      // frontend cannot know that server's real credentials, so
      // resolveEndpoint ignores the caller's value outright; saving would
      // silently revert the whole endpoint while still reporting success.
      // Block that case here instead of lying about it.
      const effectiveTargetUrl = this.effectiveTargetUrl();
      if (
        isMaskedUrl(effectiveTargetUrl) &&
        !sameOrigin(effectiveTargetUrl, this.loadedTargetUrl)
      ) {
        blocking.push(
          "Target URL still shows a masked credential (***) for a different server. Enter the real target URL to change the target.",
        );
      }
    }

    const selector = this.selectorJson.trim();
    if (selector) {
      try {
        JSON.parse(selector);
      } catch {
        blocking.push(
          "Selector JSON is invalid. Fix it before preview or save.",
        );
      }
    }

    if (this.queryParamsJson.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(this.queryParamsJson);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          blocking.push("Query params must be a JSON object.");
        } else if (this.effectiveFilter().length === 0) {
          warnings.push(
            "query_params have no effect without a filter function.",
          );
        }
      } catch {
        blocking.push("Query params JSON is invalid.");
      }
    }
    if (this.sinceSeq.trim().length > 0) {
      warnings.push("Preview and estimates do not account for since_seq.");
    }

    if (selector && this.effectiveFilter()) {
      warnings.push(
        "Both selector and filter are set. CouchDB applies both constraints, which can reduce matched docs more than expected.",
      );
    }

    if (this.docIds.length > 0 && (selector || this.effectiveFilter())) {
      warnings.push(
        "Documents (doc_ids) are set alongside a selector or filter. CouchDB replicates the explicit id list; the selector/filter may be ignored.",
      );
    }

    if (!this.targetDb.trim()) {
      warnings.push(
        "Target database is empty, so source database name will be used.",
      );
    }

    return { blocking, warnings };
  }

  private behaviorSummary(): string {
    const mode = this.continuous ? "continuous sync" : "one-time run";
    const target =
      this.targetDb.trim() || this.sourceDb.trim() || "source database name";
    const create = this.createTarget
      ? "auto-create target if missing"
      : "do not auto-create target";
    return `Configured for ${mode} to \"${target}\" and will ${create}.`;
  }

  private renderSourceSection() {
    return html`
      <cca-repl-source-section
        .servers=${this.servers}
        .databases=${this.databases}
        .databasesUnavailable=${this.databasesUnavailable}
        .databasesReason=${this.databasesReason}
        .sourceServer=${this.sourceServer}
        .sourceDb=${this.sourceDb}
        .auth=${this.sourceAuth}
        @cca-source-db-change=${this.handleSourceDbChange}
        @cca-source-auth-change=${this.handleSourceAuthChange}
      ></cca-repl-source-section>
    `;
  }

  private renderTargetSection() {
    return html`
      <cca-repl-target-section
        .targetServerUrl=${this.targetServerUrl}
        .targetDb=${this.targetDb}
        .auth=${this.targetAuth}
        @cca-target-server-url-change=${this.handleTargetServerUrlChange}
        @cca-target-db-change=${this.handleTargetDbChange}
        @cca-target-auth-change=${this.handleTargetAuthChange}
      ></cca-repl-target-section>
    `;
  }

  private renderSelectorSection() {
    return html`
      <cca-repl-selector-section
        .selectorJson=${this.selectorJson}
        .dbName=${this.sourceDb}
        .serverId=${this.sourceServer}
        @cca-selector-json-change=${this.handleSelectorJsonChange}
      ></cca-repl-selector-section>
    `;
  }

  private renderQueryParamsSection() {
    return html`
      <cca-repl-query-params-section
        .queryParamsJson=${this.queryParamsJson}
        @cca-query-params-change=${this.handleQueryParamsChange}
      ></cca-repl-query-params-section>
    `;
  }

  private renderWinningRevsSection() {
    return html`
      <cca-repl-winning-revs-section
        .winningRevsOnly=${this.winningRevsOnly}
        @cca-winning-revs-change=${this.handleWinningRevsChange}
      ></cca-repl-winning-revs-section>
    `;
  }

  private renderSinceSeqSection() {
    return html`
      <cca-repl-since-seq-section
        .sinceSeq=${this.sinceSeq}
        @cca-since-seq-change=${this.handleSinceSeqChange}
      ></cca-repl-since-seq-section>
    `;
  }

  private renderFilterSection() {
    const sourceIsEffective = this.sourceSelectionIsEffective();
    return html`
      <cca-repl-filter-section
        .filterFn=${this.filterFn}
        .sourceServer=${sourceIsEffective ? this.sourceServer : ""}
        .sourceDb=${sourceIsEffective ? this.sourceDb : ""}
        @cca-filter-fn-change=${this.handleFilterFnChange}
      ></cca-repl-filter-section>
    `;
  }

  private renderDocumentsSection() {
    return html`
      <cca-repl-documents-section
        .docIds=${this.docIds}
        .canVerify=${Boolean(this.sourceServer && this.sourceDb) && this.sourceSelectionIsEffective()}
        .verifying=${this.verifyingDocs}
        .missingIds=${this.missingDocIds}
        @cca-doc-ids-change=${this.handleDocIdsChange}
        @cca-verify-docs=${() => void this.handleVerifyDocs()}
      ></cca-repl-documents-section>
    `;
  }

  private renderConstraintTab(label: string, panel: string, isSet: boolean) {
    return html`
      <wa-tab panel=${panel}>
        ${label}${
          isSet
            ? html`<wa-icon
                name="circle-check"
                class="constraint-check"
                aria-label="set"
              ></wa-icon>`
            : ""
        }
      </wa-tab>
    `;
  }

  private renderBehaviorSection() {
    return html`
      <cca-repl-behavior-section
        .continuous=${this.continuous}
        .createTarget=${this.createTarget}
        .behaviorSummary=${this.behaviorSummary()}
        @cca-behavior-continuous-change=${this.handleBehaviorContinuousChange}
        @cca-behavior-create-target-change=${this.handleBehaviorCreateTargetChange}
      ></cca-repl-behavior-section>
    `;
  }

  private renderDesignTab() {
    return html`
      ${this.renderSourceSection()} ${this.renderTargetSection()}
      <h3>Options</h3>
      ${this.renderBehaviorSection()} ${this.renderWinningRevsSection()}
      <h3>Replication Constraints</h3>
      <wa-tab-group placement="start">
        ${this.renderConstraintTab("Selector", "selector", this.selectorJson.trim().length > 0)}
        ${this.renderConstraintTab("Filter", "filter", this.effectiveFilter().length > 0)}
        ${this.renderConstraintTab("Documents", "documents", this.docIds.length > 0)}
        ${this.renderConstraintTab("Query Params", "query-params", this.queryParamsJson.trim().length > 0)}
        ${this.renderConstraintTab("Since Seq", "since-seq", this.sinceSeq.trim().length > 0)}
        <wa-tab-panel name="selector"
          >${this.renderSelectorSection()}</wa-tab-panel
        >
        <wa-tab-panel name="filter">${this.renderFilterSection()}</wa-tab-panel>
        <wa-tab-panel name="documents"
          >${this.renderDocumentsSection()}</wa-tab-panel
        >
        <wa-tab-panel name="query-params"
          >${this.renderQueryParamsSection()}</wa-tab-panel
        >
        <wa-tab-panel name="since-seq"
          >${this.renderSinceSeqSection()}</wa-tab-panel
        >
      </wa-tab-group>
    `;
  }

  private renderSourceTab() {
    return html`
      <p class="hint">
        Source JSON is generated from Design. Edit JSON and click Apply to sync
        back.
      </p>
      <wa-textarea
        class="source-editor"
        .value=${this.sourceDocJson}
        @input=${(e: Event) => {
          const target = e.target as HTMLTextAreaElement;
          this.sourceDocJson = target.value || "";
        }}
      ></wa-textarea>
      <div class="actions">
        <wa-button
          variant="neutral"
          type="button"
          @click=${() => {
            this.applySourceToDesign();
            this.activeTab = "design";
          }}
        >
          Apply To Design
        </wa-button>
        <wa-button
          class="copy-curl"
          variant="neutral"
          type="button"
          ?disabled=${!this.replicatorHostUrl()}
          @click=${() => void this.handleCopyCurl()}
        >
          Copy as curl
        </wa-button>
      </div>
    `;
  }

  private renderPreview() {
    if (!this.preview) return "";
    return html`
      <div class="preview-box">
        <strong>Preview:</strong> ~${this.preview.estimated_doc_count} documents
        ${this.preview.warning ? html`<p class="warning">${this.preview.warning}</p>` : ""}
        ${
          this.preview.sample_doc_ids.length > 0
            ? html`
                <p>
                  Sample:
                  ${this.preview.sample_doc_ids.slice(0, 5).join(", ")}${this.preview.sample_doc_ids.length > 5 ? "..." : ""}
                </p>
              `
            : ""
        }
      </div>
    `;
  }

  render() {
    if (this.loading) {
      return html`<div class="editor"><p>Loading replication...</p></div>`;
    }

    const rails = this.computeSafetyRails();

    return html`
      <div class="editor">
        <div class="tabs">
          <div class="tab-list">
            <wa-button
              type="button"
              variant="neutral"
              class="tab ${this.activeTab === "design" ? "active" : ""}"
              @click=${() => {
                if (
                  this.activeTab === "source" &&
                  !this.applySourceToDesign()
                ) {
                  return;
                }
                this.activeTab = "design";
              }}
            >
              Design
            </wa-button>
            <wa-button
              type="button"
              variant="neutral"
              class="tab ${this.activeTab === "source" ? "active" : ""}"
              @click=${() => {
                this.activeTab = "source";
                this.syncSourceFromDesign();
              }}
            >
              Source
            </wa-button>
          </div>

          <div class="tabs-content">
            <div class="panel">
              <form id="replication-editor-form" @submit=${this.handleSubmit}>
                ${this.activeTab === "design" ? this.renderDesignTab() : this.renderSourceTab()}
                ${this.error ? html`<p class="error">${this.error}</p>` : ""}
                ${this.renderPreview()}
              </form>
            </div>
            <cca-repl-issues-panel
              .blocking=${rails.blocking}
              .warnings=${rails.warnings}
            ></cca-repl-issues-panel>
          </div>
        </div>
      </div>
    `;
  }
}
