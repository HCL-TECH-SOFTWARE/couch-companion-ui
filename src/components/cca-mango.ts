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
import { CcaElement } from "./cca-element.js";
import type { CcaMonacoEditor } from "./cca-monaco-editor.js";
import { createRef, Ref, ref } from "lit/directives/ref.js";
import {
  SUPPORTED_OPERATORS,
  getOperatorMetadata,
  validateSelectorOperators,
  extractOperatorsFromSelector,
} from "./cca-mango-operators.js";
import "./cca-monaco-editor.js";
import "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import "@awesome.me/webawesome/dist/components/badge/badge.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import { CcaExplainQuery } from "../plugins/db-mgmt/explain-query.js";
import { ExplainQueryRequest } from "../plugins/db-mgmt/types.js";
import { toast } from "./cca-toast.js";
import { getContext } from "../context.js";
import "../plugins/db-mgmt/explain-query.js";

declare global {
  interface HTMLElementTagNameMap {
    "cca-mango": CcaMango;
  }
}

interface Condition {
  id: string;
  field: string;
  operator: string;
  value: unknown;
}

interface SelectorGroup {
  id: string;
  operator: "$and" | "$or" | "$nor";
  conditions: Condition[];
  groups: SelectorGroup[];
}

interface SortField {
  id: string;
  field: string;
  direction: "asc" | "desc";
}

// Operator-specific value parsing (like React App.tsx)
function parseValue(val: string, op: string): unknown {
  if (op === "$exists") return val === "true" || val === "1";
  if (op === "$in" || op === "$nin") {
    try {
      return JSON.parse(val);
    } catch {
      return val.split(",").map((v) => v.trim());
    }
  }
  if (!isNaN(Number(val)) && val.trim() !== "") return Number(val);
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null") return null;
  return val;
}

/**
 * CcaMango: Reusable Mango Query Editor Component
 *
 * Features:
 * - 3-panel layout: Builder | JSON Editor | Guidance
 * - Group-based selector with nested $and/$or/$nor support
 * - Sort field management
 * - Query limit, skip, fields, use_index options
 * - Collapsible sections
 * - Bi-directional sync between builder and JSON
 * - Operator-specific value parsing
 */
@customElement("cca-mango")
export class CcaMango extends CcaElement {
  static override get styles() {
    return css`
      :host {
        display: block;
      }

      .container {
        display: grid;
        grid-template-columns: minmax(200px, 400px) 1fr minmax(250px, 350px);
        height: 100%;
        min-height: 300px;
      }

      .builder-panel {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--wa-color-neutral-border-normal);
        padding: 0;
        overflow-y: auto;
        background: var(--wa-color-surface-default);
      }

      .editor-panel {
        display: flex;
        flex-direction: column;
        gap: 0;
        border: 1px solid var(--wa-color-neutral-border-normal);
        background: var(--wa-color-surface-default);
        overflow: hidden;
      }

      .editor-header {
        padding: 0.75rem 1rem;
        background: var(--wa-color-neutral-fill-normal);
        border-bottom: 1px solid var(--wa-color-neutral-border-normal);
        font-size: var(--wa-font-size-s);
        font-weight: var(--wa-font-weight-bold);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--wa-color-text-normal, #333);
      }

      .editor-container {
        flex: 1;
        overflow: hidden;
      }

      .guidance-panel {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--wa-color-neutral-border-normal);
        overflow: hidden;
        background: none;
        overflow-y: auto;
      }

      .builder-section {
        padding: 1rem;
        border-bottom: 1px solid var(--wa-color-neutral-border-normal);
      }

      .builder-section:last-child {
        border-bottom: none;
      }

      .section-header {
        font-size: var(--wa-font-size-s);
        font-weight: var(--wa-font-weight-bold);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 0.75rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        color: var(--wa-color-text-normal, #333);
      }

      .section-number {
        color: var(--wa-color-text-quiet, #999);
        font-weight: var(--wa-font-weight-bold);
        font-size: var(--wa-font-size-s);
      }

      .condition-row {
        display: grid;
        grid-template-columns: 1fr 85px 1fr 32px;
        gap: 0.2rem;
        align-items: center;
        margin-bottom: 0.5rem;
      }

      .condition-row wa-input {
        min-width: 0;
        width: 100%;
      }

      .condition-row wa-select {
        min-width: 0;
        width: 100%;
      }

      .condition-input {
        border-radius: 3px;
        font-size: var(--wa-font-size-s);
        width: 100%;
      }

      .condition-operator {
        font-size: var(--wa-font-size-xs);
        border-radius: 3px !important;
        border: 1px !important;
        background: none !important;
        color: var(--wa-color-text-normal, #333) !important;
      }

      .group-operator-select {
        font-size: var(--wa-font-size-s);
        font-weight: var(--wa-font-weight-bold);
        cursor: pointer;
        min-width: 70px;
        transition: background 0.15s ease-in-out;
      }

      .group-operator-select:hover {
        background: #1a1a1a;
      }

      .group-operator-select:disabled {
        background: #999;
        cursor: not-allowed;
      }

      .group-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0;
        margin-bottom: 0.5rem;
        font-weight: var(--wa-font-weight-bold);
        font-size: var(--wa-font-size-s);
        color: var(--wa-color-text-normal, #333);
      }

      .group-container {
        border: 1px dashed var(--wa-color-neutral-border-normal);
        border-radius: 4px;
        padding: 0.75rem;
        margin: 0.75rem 0;
        --wa-color-surface-default: #fafbfc;
      }

      .root-header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 1rem;
        padding-bottom: 0.75rem;
        border-bottom: 1px solid var(--wa-color-neutral-border-normal);
      }

      .condition-remove-btn {
        background: none;
        border: none;
        color: #d0d7de;
        font-size: var(--wa-font-size-s);
        cursor: pointer;
        padding: 0.25rem;
        border-radius: 3px;
        transition: all 0.15s ease-in-out;
        min-width: 0;
        width: 100%;
      }

      .ghost-row {
        border: 1px solid var(--wa-color-neutral-border-normal);
        color: var(--wa-color-text-normal, #666);
        font-size: var(--wa-font-size-s);
        text-align: center;
        padding: 0.75rem 0.5rem;
        margin-top: 0.75rem;
        background: none;
        border-radius: 3px;
        display: flex;
        gap: 0.5rem;
        justify-content: center;
        align-items: center;
      }

      .sort-placeholder {
        font-size: var(--wa-font-size-s);
        color: #999;
        font-style: italic;
        padding: 0.5rem 0;
      }

      .operators-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 0.5rem;
      }

      .operator-item {
        display: flex;
        gap: 0.5rem;
        font-size: var(--wa-font-size-s);
        line-height: var(--wa-line-height-normal);
        padding: 0.5rem;
        border-radius: 3px;
        background: none;
      }

      .operator-name {
        font-family: var(--wa-font-family-code);
        font-weight: var(--wa-font-weight-bold);
        color: var(--wa-color-text-normal, #0065cc);
        min-width: 50px;
        flex-shrink: 0;
      }

      .operator-desc {
        color: var(--wa-color-text-normal, #666);
        flex: 1;
      }

      .validation-error {
        color: var(--wa-color-text-normal, #d32f2f);
        font-size: var(--wa-font-size-s);
        padding: 0.75rem;
        background: none;
        border-radius: 3px;
        margin-top: 0.5rem;
        border-left: 3px solid #d32f2f;
      }

      wa-tab-group {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .operator-docs {
        font-size: var(--wa-font-size-s);
        padding: 1rem;
        overflow-y: auto;
        color: var(--wa-color-text-normal, #333);
      }

      .operator-doc-item {
        margin-bottom: 1.5rem;
        padding-bottom: 1.5rem;
        border-bottom: 1px solid #e0e0e0;
      }

      .operator-doc-item:last-child {
        border-bottom: none;
        margin-bottom: 0;
        padding-bottom: 0;
      }

      .operator-doc-name {
        font-family: var(--wa-font-family-code);
        font-weight: var(--wa-font-weight-bold);
        color: #0065cc;
        font-size: var(--wa-font-size-s);
      }

      .operator-doc-description {
        font-size: var(--wa-font-size-s);
        color: #666;
        margin-top: 0.25rem;
      }

      .operator-syntax {
        font-family: var(--wa-font-family-code);
        font-size: var(--wa-font-size-s);
        background: none;
        padding: 0.5rem;
        border-radius: 3px;
        margin-top: 0.5rem;
        overflow-x: auto;
        color: var(--wa-color-text-normal, #333);
      }

      .operator-example {
        font-family: var(--wa-font-family-code);
        font-size: var(--wa-font-size-s);
        background: none;
        padding: 0.5rem;
        border-radius: 3px;
        margin-top: 0.5rem;
        overflow-x: auto;
        color: var(--wa-color-text-normal, #333);
      }

      .preview-content {
        padding: 1rem;
        font-family: var(--wa-font-family-code);
        font-size: var(--wa-font-size-s);
        background: #f5f5f5;
        border-radius: 3px;
        max-height: 350px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
        color: var(--wa-color-text-normal, #333);
      }

      .status-line {
        display: flex;
        gap: 1rem;
        align-items: center;
        border: 1px solid #e0e0e0;
        border-top: none;
        background: var(--wa-color-neutral-fill-normal, #f9f9f9);
        padding: 0.5rem 1rem;
        font-size: var(--wa-font-size-s);
        color: var(--wa-color-text-normal, #666);
      }

      .status-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        border: 1px solid #d0d7de;
        background: #fff;
        margin-right: 0.25rem;
        transition: all 0.15s ease-in-out;
      }

      .status-dot.filled {
        background: #333;
        border-color: #333;
      }

      .section-button {
        width: 100%;
        text-align: left;
        padding: 0.75rem 1rem;
        background: none;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-weight: var(--wa-font-weight-bold);
        font-size: var(--wa-font-size-s);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border-bottom: 1px solid #e0e0e0;
        color: var(--wa-color-text-normal, #333);
        transition: background 0.15s ease-in-out;
      }

      .section-button:hover {
        background: #f5f5f5;
      }

      .section-button:active {
        background: #efefef;
      }

      .sort-field-row {
        display: flex;
        gap: 0;
        align-items: stretch;
        margin-bottom: 0.5rem;
        overflow: hidden;
      }

      .sort-field-row wa-input {
        flex: 1;
      }

      .sort-field-row wa-select {
        min-width: 90px;
      }

      .sort-field-row wa-button {
        color: #d0d7de;
        padding: 0 0.5rem;
        background: none;
        cursor: pointer;
        transition: all 0.15s ease-in-out;
      }

      .sort-field-row wa-button:hover {
        color: #d32f2f;
        background: rgba(211, 47, 47, 0.06);
      }

      .field-names-section {
        padding: 1rem;
        border: 1px dashed #d0d7de;
        border-radius: 3px;
        margin: 1rem;
        background: none;
      }

      .field-names-header {
        font-size: var(--wa-font-size-s);
        font-weight: var(--wa-font-weight-bold);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--wa-color-text-normal, #333);
        margin-bottom: 0.75rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .field-names-header-number {
        width: 18px;
        height: 18px;
        border: 1px solid #333;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: var(--wa-font-size-xs);
        font-weight: var(--wa-font-weight-bold);
        flex-shrink: 0;
      }

      .field-names-list {
        font-size: var(--wa-font-size-s);
        color: #666;
        line-height: var(--wa-line-height-normal);
        margin-bottom: 0.75rem;
      }

      .field-names-item {
        display: inline;
        word-break: break-word;
        cursor: pointer;
        padding: 0.2rem 0.4rem;
        border-radius: 3px;
        transition: all 0.15s ease-in-out;
      }

      .field-names-item:hover {
        background: #e8f1ff;
        color: #0065cc;
      }

      .field-names-item.selected {
        background: #0065cc;
        color: #fff;
        font-weight: var(--wa-font-weight-bold);
      }

      .field-names-separator {
        color: #d0d7de;
        margin: 0 0.3rem;
      }

      .resample-box {
        border: 1px dashed #d0d7de;
        border-radius: 3px;
        padding: 0.5rem;
        text-align: center;
        background: none;
      }

      .resample-button {
        background: none;
        border: none;
        color: #0065cc;
        font-size: var(--wa-font-size-s);
        cursor: pointer;
        padding: 0;
        transition: color 0.15s ease-in-out;
        font-weight: var(--wa-font-weight-bold);
      }

      .resample-button:hover {
        color: #004199;
      }

      .preview-result-item {
        background: var(--wa-color-neutral-fill-normal);
        border: 1px solid var(--wa-color-neutral-border-normal, #999);
        border-radius: 4px;
        padding: 1rem 1rem;
        gap: 1rem;
        font-family: var(--wa-font-family-code);
        font-size: var(--wa-font-size-s);
        line-height: var(--wa-line-height-normal);
        margin-bottom: 5px;
      }

      .preview-key {
        --wa-color-text-default: #666;
      }

      .preview-value {
        color: var(--wa-color-text-normal);
      }

      .preview-key-value {
        gap: 0.25rem;
        padding: 0.25rem 0;
      }

      .docs-search-box {
        padding: 1rem;
        border-bottom: 1px solid var(--wa-color-neutral-border-normal, #e0e0e0);
        display: flex;
        gap: 0.5rem;
      }

      .docs-search-input {
        flex: 1;
        padding: 0.5rem 0.75rem;
        font-size: var(--wa-font-size-s);
      }

      .focused-operator-card {
        background: none;
        border: 2px solid var(--wa-color-neutral-border-normal, #0065cc);
        border-color: var(--wa-color-neutral-border-normal, #e0e0e0);
        border-radius: 4px;
        padding: 1rem;
        margin-bottom: 1.5rem;
      }

      .focused-operator-card .operator-doc-name {
        color: #0065cc;
        font-size: var(--wa-font-size-m);
        margin-bottom: 0.5rem;
      }

      .operators-catalogue {
        padding: 0 1rem 1rem 1rem;
      }

      .operator-category {
        margin-bottom: 1.5rem;
      }

      .operator-category-title {
        font-weight: var(--wa-font-weight-bold);
        font-size: var(--wa-font-size-s);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #666;
        margin-bottom: 0.75rem;
        padding-bottom: 0.5rem;
        border-bottom: 1px solid var(--wa-color-neutral-border-normal, #e0e0e0);
      }

      .operator-catalogue-item {
        padding: 0.75rem;
        border-radius: 3px;
        margin-bottom: 0.5rem;
        background: var(--wa-color-neutral-fill-normal, #f9f9f9);
        border-left: 3px solid #d0d7de;
        cursor: pointer;
        transition: all 0.15s ease-in-out;
      }

      .operator-catalogue-item:hover {
        background: #f0f6ff;
        border-left-color: var(--wa-color-neutral-border-normal, #0065cc);
      }

      .operator-catalogue-item.active {
        background: #e8f1ff;
        border-left-color: #0065cc;
      }

      .operator-catalogue-name {
        font-family: var(--wa-font-family-code);
        font-weight: var(--wa-font-weight-bold);
        color: #0065cc;
        font-size: var(--wa-font-size-s);
        margin-bottom: 0.25rem;
      }

      .operator-catalogue-desc {
        font-size: var(--wa-font-size-s);
        color: #666;
        line-height: var(--wa-line-height-normal);
      }

      .no-preview-results {
        color: #999;
        font-style: italic;
        padding: 1rem;
      }

      .docs-link {
        padding: 1rem;
        border-bottom: 1px solid var(--wa-color-neutral-border-normal, #e0e0e0);
      }

      .docs-link a {
        font-size: var(--wa-font-size-xs);
        color: #666;
        text-decoration: underline;
      }

      .docs-link a:hover {
        color: #0065cc;
      }

      .docs-link wa-icon {
        font-size: var(--wa-font-size-xs);
        margin-right: 0.25rem;
      }
    `;
  }
  @property({ type: String }) dbName = "";
  @property({ type: String }) serverId = "";
  @property({ type: Object }) query: Record<string, any> = {};
  @property({ type: Array }) availableFieldNames: string[] = [];
  @property({ type: Boolean }) readOnly = false;
  @property({ type: Boolean }) showOperatorHelp = true;
  @property({ type: Array }) previewResults: Record<string, unknown>[] = [];
  @property({ type: Object }) selectedFieldNames = new Set<string>();
  @property({ type: String }) activeTab = "preview";
  @property({ type: Boolean }) showFieldNames = false;
  @property({ type: Boolean }) showSortFields = false;

  @state() private _rootGroup: SelectorGroup = {
    id: "root",
    operator: "$and",
    conditions: [],
    groups: [],
  };
  @state() private _sortFields: SortField[] = [];
  @state() private _fields = "";
  @state() private _validationErrors: string[] = [];
  @state() private _selectorJson = JSON.stringify(this.query, null, 2);
  @state() private _selectorExpanded = true;
  @state() private _sortExpanded = false;
  @state() private _isValid = false;
  @state() private _docsSearchQuery = "";
  @state() private _focusedOperator: string | null = null;
  @state() private _loading = false;

  _isUpdatingQuery = false;
  private _editorRef = createRef<CcaMonacoEditor>();
  private _explainRef: Ref<CcaExplainQuery> = createRef<CcaExplainQuery>();

  override connectedCallback() {
    super.connectedCallback();
    this._initializeFromQuery();
    window.addEventListener("request-tab-change", this._handleTabRequest);
  }

  override disconnectedCallback() {
    // Clean up to prevent memory leaks
    window.removeEventListener("request-tab-change", this._handleTabRequest);
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>) {
    super.updated(changed);
    if (changed.has("query") && !this._isUpdatingQuery) {
      // If query is a wrapped mango query (has selector property), extract selector
      const selectorOnly = this.query?.selector ?? this.query ?? {};
      this._selectorJson = JSON.stringify(selectorOnly, null, 2);
      this._initializeFromQuery();
      this._isUpdatingQuery = false;
    }
  }

  _handleTabRequest = (e: any) => {
    this.activeTab = e.detail.panel;
  };

  private async _initializeFromQuery() {
    if (typeof this.query === "object" && this.query !== null) {
      // Handle both wrapped query (with selector property) and direct selector
      const selectorOnly = this.query?.selector ?? this.query;
      this._rootGroup = this._parseQueryToGroup(selectorOnly);
    }
  }

  /** Public method to reinitialize the builder from the current query property */
  reinitializeFromQuery() {
    this._isUpdatingQuery = true;
    const selectorOnly = this.query?.selector ?? this.query ?? {};
    this._selectorJson = JSON.stringify(selectorOnly, null, 2);
    this._rootGroup = this._parseQueryToGroup(selectorOnly);
  }

  private _parseQueryToGroup(query: Record<string, any>): SelectorGroup {
    const rootGroup: SelectorGroup = {
      id: "root",
      operator: "$and",
      conditions: [],
      groups: [],
    };

    const keys = Object.keys(query);
    if (
      keys.length === 1 &&
      (keys[0] === "$and" || keys[0] === "$or" || keys[0] === "$nor")
    ) {
      rootGroup.operator = keys[0] as "$and" | "$or" | "$nor";
      const items = query[keys[0]];
      if (Array.isArray(items)) {
        items.forEach((item) => {
          const result = this._parseConditionOrGroup(item);
          if (result) {
            if ("conditions" in result) {
              rootGroup.groups.push(result);
            } else {
              rootGroup.conditions.push(result);
            }
          }
        });
      }
    } else {
      for (const [key, value] of Object.entries(query)) {
        if (key === "$and" || key === "$or" || key === "$nor") {
          if (Array.isArray(value)) {
            const group: SelectorGroup = {
              id: `group-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              operator: key as "$and" | "$or" | "$nor",
              conditions: [],
              groups: [],
            };
            value.forEach((item) => {
              const result = this._parseConditionOrGroup(item);
              if (result) {
                if ("conditions" in result) {
                  group.groups.push(result);
                } else {
                  group.conditions.push(result);
                }
              }
            });
            rootGroup.groups.push(group);
          }
        } else if (typeof value === "object" && value !== null) {
          for (const [op, opValue] of Object.entries(value)) {
            rootGroup.conditions.push({
              id: `cond-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              field: key,
              operator: op,
              value: opValue,
            });
          }
        }
      }
    }

    return rootGroup;
  }

  private _parseConditionOrGroup(item: any): Condition | SelectorGroup | null {
    if (typeof item === "object" && item !== null) {
      const keys = Object.keys(item);
      if (keys.length === 1) {
        const [key, value] = Object.entries(item)[0];
        if (
          (key === "$and" || key === "$or" || key === "$nor") &&
          Array.isArray(value)
        ) {
          const group: SelectorGroup = {
            id: `group-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            operator: key as "$and" | "$or" | "$nor",
            conditions: [],
            groups: [],
          };
          value.forEach((v) => {
            const result = this._parseConditionOrGroup(v);
            if (result) {
              if ("conditions" in result) {
                group.groups.push(result);
              } else {
                group.conditions.push(result);
              }
            }
          });
          return group;
        } else {
          if (typeof value === "object" && value !== null) {
            for (const [op, opValue] of Object.entries(value)) {
              return {
                id: `cond-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                field: key,
                operator: op,
                value: opValue,
              };
            }
          }
        }
      }
    }
    return null;
  }

  private _createAddConditionHandler(groupId: string) {
    return () => this._addCondition(groupId);
  }

  private _createAddGroupHandler(groupId: string) {
    return () => this._addGroup(groupId);
  }

  private _isCondition(item: any): item is Condition {
    return (
      item &&
      typeof item === "object" &&
      "field" in item &&
      "operator" in item &&
      "value" in item
    );
  }

  private _isSelectorGroup(item: any): item is SelectorGroup {
    return (
      item &&
      typeof item === "object" &&
      "operator" in item &&
      Array.isArray(item.conditions) &&
      Array.isArray(item.groups)
    );
  }

  private _addCondition(targetGroupId: string = "root") {
    const newCondition: Condition = {
      id: `cond-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      field: "",
      operator: "$eq",
      value: "",
    };
    this._rootGroup = this._addItemToGroup(
      this._rootGroup,
      targetGroupId,
      newCondition,
    );
    this._updateQuery();
  }

  private _addGroup(targetGroupId: string = "root") {
    const newGroup: SelectorGroup = {
      id: `group-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      operator: "$and",
      conditions: [
        {
          id: `cond-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          field: "",
          operator: "$eq",
          value: "",
        },
      ],
      groups: [],
    };
    this._rootGroup = this._addItemToGroup(
      this._rootGroup,
      targetGroupId,
      newGroup,
    );
    this._updateQuery();
  }

  private _addItemToGroup(
    group: SelectorGroup,
    targetGroupId: string,
    item: Condition | SelectorGroup,
  ): SelectorGroup {
    if (group.id === targetGroupId) {
      // If item has "field" property, it's a Condition; otherwise it's a SelectorGroup
      const hasField =
        typeof item === "object" && item !== null && "field" in item;
      if (hasField) {
        // It's a Condition
        return {
          ...group,
          conditions: [...group.conditions, item as Condition],
        };
      } else {
        // It's a SelectorGroup
        return { ...group, groups: [...group.groups, item as SelectorGroup] };
      }
    }
    return {
      ...group,
      conditions: group.conditions,
      groups: group.groups.map((g) =>
        this._addItemToGroup(g, targetGroupId, item),
      ),
    };
  }

  private _removeFromGroup(groupId: string, itemId: string) {
    if (groupId === "root") {
      this._rootGroup = this._removeItemFromGroup(this._rootGroup, itemId);
    } else {
      this._rootGroup = this._removeItemFromGroup(
        this._rootGroup,
        groupId,
        itemId,
      );
    }
    this._updateQuery();
  }

  private _removeItemFromGroup(
    group: SelectorGroup,
    groupIdOrItemId: string,
    itemId?: string,
  ): SelectorGroup {
    if (itemId === undefined) {
      return {
        ...group,
        conditions: group.conditions.filter((c) => c.id !== groupIdOrItemId),
        groups: group.groups.filter((g) => g.id !== groupIdOrItemId),
      };
    }

    const groupId = groupIdOrItemId;
    if (group.id === groupId) {
      return {
        ...group,
        conditions: group.conditions.filter((c) => c.id !== itemId),
        groups: group.groups.filter((g) => g.id !== itemId),
      };
    }
    return {
      ...group,
      conditions: group.conditions,
      groups: group.groups.map((g) =>
        this._removeItemFromGroup(g, groupId, itemId),
      ),
    };
  }

  private _updateCondition(
    id: string,
    key: "field" | "operator" | "value",
    val: unknown,
  ) {
    this._rootGroup = this._updateConditionInGroup(
      this._rootGroup,
      id,
      key,
      val,
    );
    this._updateQuery();
  }

  private _updateConditionInGroup(
    group: SelectorGroup,
    id: string,
    key: "field" | "operator" | "value",
    val: unknown,
  ): SelectorGroup {
    return {
      ...group,
      conditions: group.conditions.map((c) =>
        c.id === id ? { ...c, [key]: val } : c,
      ),
      groups: group.groups.map((g) =>
        this._updateConditionInGroup(g, id, key, val),
      ),
    };
  }

  private _changeGroupOperator(
    groupId: string,
    operator: "$and" | "$or" | "$nor",
  ) {
    this._rootGroup = this._changeGroupOperatorInGroup(
      this._rootGroup,
      groupId,
      operator,
    );
    this._updateQuery();
  }

  private _changeGroupOperatorInGroup(
    group: SelectorGroup,
    groupId: string,
    operator: "$and" | "$or" | "$nor",
  ): SelectorGroup {
    if (group.id === groupId) {
      return { ...group, operator };
    }
    return {
      ...group,
      conditions: group.conditions,
      groups: group.groups.map((g) =>
        this._changeGroupOperatorInGroup(g, groupId, operator),
      ),
    };
  }

  private _groupToSelector(group: SelectorGroup): Record<string, any> {
    const items: any[] = [];

    for (const cond of group.conditions) {
      const parsed = parseValue(String(cond.value), cond.operator);
      items.push({ [cond.field]: { [cond.operator]: parsed } });
    }

    for (const subgroup of group.groups) {
      items.push(this._groupToSelector(subgroup));
    }

    if (items.length === 0) return {};
    if (items.length === 1 && group.groups.length === 0) return items[0];
    return { [group.operator]: items };
  }

  private _addSortField() {
    const newSort: SortField = {
      id: `sort-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      field: "",
      direction: "asc",
    };
    this._sortFields = [...this._sortFields, newSort];
    this._updateQuery();
  }

  private _removeSortField(id: string) {
    this._sortFields = this._sortFields.filter((s) => s.id !== id);
    this._updateQuery();
  }

  private _updateSortField(
    id: string,
    key: "field" | "direction",
    val: unknown,
  ) {
    this._sortFields = this._sortFields.map((s) =>
      s.id === id ? { ...s, [key]: val } : s,
    );
    this._updateQuery();
  }

  private _countConditions(group: SelectorGroup): number {
    let count = group.conditions.length;
    for (const subgroup of group.groups) {
      count += this._countConditions(subgroup);
    }
    return count;
  }

  private _categorizeOperators(): Record<string, [string, any][]> {
    const categories: Record<string, [string, any][]> = {
      combination: [],
      condition: [],
      array: [],
      meta: [],
    };

    const combinationOps = ["$and", "$or", "$nor"];
    const arrayOps = ["$in", "$nin", "$all"];
    const metaOps = ["$exists"];

    for (const [key, value] of Object.entries(SUPPORTED_OPERATORS)) {
      if (combinationOps.includes(key)) {
        categories.combination.push([key, value]);
      } else if (arrayOps.includes(key)) {
        categories.array.push([key, value]);
      } else if (metaOps.includes(key)) {
        categories.meta.push([key, value]);
      } else {
        categories.condition.push([key, value]);
      }
    }

    return categories;
  }

  private _filterOperators(
    categories: Record<string, [string, any][]>,
    query: string,
  ): Record<string, [string, any][]> {
    if (!query.trim()) return categories;

    const lowerQuery = query.toLowerCase();
    const filtered: Record<string, [string, any][]> = {};

    for (const [category, ops] of Object.entries(categories)) {
      filtered[category] = ops.filter(
        ([key, value]) =>
          key.toLowerCase().includes(lowerQuery) ||
          value.description.toLowerCase().includes(lowerQuery) ||
          value.label.toLowerCase().includes(lowerQuery),
      );
    }

    return filtered;
  }

  private _explainPayload(): ExplainQueryRequest | null {
    try {
      const selector = JSON.parse(this._selectorJson) as Record<
        string,
        unknown
      >;
      return {
        selector,
        fields:
          this._fields.length > 0
            ? this._fields
                .split(",")
                .map((f) => f.trim())
                .filter(Boolean)
            : undefined,
        sort:
          this._sortFields.length > 0
            ? this._sortFields.map((s) => ({ [s.field]: s.direction }))
            : undefined,
        limit: 10,
      };
    } catch {
      return null;
    }
  }

  private async _runExplain() {
    if (!this.serverId) {
      toast("Select a server first.", "info");
      return;
    }
    const payload = this._explainPayload();
    if (!payload) {
      toast("Invalid JSON selector", "error");
      return;
    }

    await this.updateComplete;
    await this._explainRef.value?.runExplain();
  }

  /**
   * Publishes what the builder now describes.
   *
   * The emitted query carries no `limit`/`skip`/`use_index`: this component used to
   * fold three `@state` fields of that name into it, but nothing ever set them and no
   * render method ever showed them — scaffolding for an options panel that was never
   * built. #80 gave those two controls a real home instead, `cca-page-controls` in the
   * results footer of both document-list screens, owned by the screen that pages the
   * results rather than by the selector builder.
   */
  private _updateQuery() {
    const clonedRootGroup = { ...this._rootGroup };
    const selector = this._groupToSelector(clonedRootGroup);
    this._isValid = Object.keys(selector).length > 0;

    const mangoQuery: Record<string, any> = { selector };
    if (
      this._sortFields.length > 0 &&
      this._sortFields.some((s) => s.field.trim())
    ) {
      mangoQuery.sort = this._sortFields
        .filter((s) => s.field.trim())
        .map((s) => ({ [s.field.trim()]: s.direction }));
    }
    if (this._fields.trim()) {
      mangoQuery.fields = this._fields
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    }

    this._selectorJson = JSON.stringify(selector, null, 2);
    this.dispatchEvent(
      new CustomEvent("cca-mango-change", {
        detail: { query: mangoQuery },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onEditorChange(json: string) {
    if (this.readOnly) return;

    try {
      const parsed = JSON.parse(json);
      // Normalize: extract selector if this is a wrapped query
      const selectorOnly = parsed?.selector ?? parsed;
      this._selectorJson = JSON.stringify(selectorOnly, null, 2);

      const validation = validateSelectorOperators(selectorOnly);
      this._validationErrors =
        validation.unsupported.length > 0
          ? [`Unsupported operators: ${validation.unsupported.join(", ")}`]
          : [];

      // Build full mango query for event. Paging is the screen's, not the builder's — see
      // _updateQuery() on why no limit/skip rides along.
      const mangoQuery: Record<string, any> = { selector: selectorOnly };

      this.query = selectorOnly;
      this.dispatchEvent(
        new CustomEvent("cca-mango-change", {
          detail: { query: mangoQuery },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err) {
      this._validationErrors = [`Invalid JSON: ${(err as Error).message}`];
    }
  }

  private async _retrieveAvailableFieldNames() {
    if (!this.serverId || !this.dbName) {
      toast("Select a server and database first.", "info");
      return;
    }
    this._updateQuery();
    this._loading = true;
    let resolveFields: (value: unknown) => void;
    const fieldsPromise = new Promise((resolve) => {
      resolveFields = resolve;
    });
    this.dispatchEvent(
      new CustomEvent("cca-mango-retrieve-fields", {
        detail: {
          serverId: this.serverId,
          dbName: this.dbName,
          resolve: resolveFields!,
        },
        bubbles: true,
        composed: true,
      }),
    );
    const fields = await fieldsPromise;
    this._loading = false;
  }

  private _toggleFieldSelection(field: string) {
    const updated = new Set(this.selectedFieldNames);
    if (updated.has(field)) {
      updated.delete(field);
    } else {
      updated.add(field);
    }
    this.selectedFieldNames = updated;

    // Dispatch event for parent to listen
    this.dispatchEvent(
      new CustomEvent("cca-mango-selected-fields-change", {
        detail: { selectedFields: Array.from(updated) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _renderBuilderGroup(group: SelectorGroup, depth: number = 0): any {
    const isRoot = depth === 0;
    const conditionCount = this._countConditions(group);
    const groupCount = group.groups.length;

    const rootHeader = html`
      <div class="root-header">
        <wa-select
          class="group-operator-select"
          .value=${group.operator}
          @change=${(e: Event) => {
            this._changeGroupOperator(
              group.id,
              (e.target as HTMLSelectElement).value as "$and" | "$or" | "$nor",
            );
          }}
          variant="brand"
          appearance="filled"
          ?disabled=${this.readOnly}
        >
          <wa-option value="$and">$and</wa-option>
          <wa-option value="$or">$or</wa-option>
          <wa-option value="$nor">$nor</wa-option>
        </wa-select>
        <span style="font-size: 0.875rem">
          ${conditionCount} condition${conditionCount !== 1 ? "s" : ""},
          ${groupCount} group${groupCount !== 1 ? "s" : ""}
        </span>
      </div>
    `;

    const nestedHeader = html`
      <div class="group-header">
        <wa-select
          class="group-operator-select"
          .value=${group.operator}
          @change=${(e: Event) => {
            this._changeGroupOperator(
              group.id,
              (e.target as HTMLSelectElement).value as "$and" | "$or" | "$nor",
            );
          }}
          variant="brand"
          appearance="filled"
          ?disabled=${this.readOnly}
        >
          <wa-option value="$and">$and</wa-option>
          <wa-option value="$or">$or</wa-option>
          <wa-option value="$nor">$nor</wa-option>
        </wa-select>
        <span class="group-pill">group</span>
      </div>
    `;

    const conditionRows = group.conditions.map(
      (cond: Condition) => html`
        <div class="condition-row">
          <wa-input
            type="text"
            class="condition-input"
            placeholder="field.name"
            .value=${cond.field}
            @input=${(e: CustomEvent) => this._updateCondition(cond.id, "field", (e.target as any).value)}
            ?disabled=${this.readOnly}
            list="field-suggestions"
          ></wa-input>
          <wa-select
            class="condition-operator"
            .value=${cond.operator}
            @change=${(e: CustomEvent) => this._updateCondition(cond.id, "operator", (e.target as any).value)}
            ?disabled=${this.readOnly}
            variant="brand"
            appearance="filled"
          >
            ${Object.keys(SUPPORTED_OPERATORS).map((op: string) => html`<wa-option value=${op}>${op}</wa-option>`)}
          </wa-select>
          <wa-input
            type="text"
            class="condition-input"
            placeholder="value"
            .value=${String(cond.value)}
            @input=${(e: CustomEvent) => this._updateCondition(cond.id, "value", (e.target as any).value)}
            ?disabled=${this.readOnly}
          ></wa-input>
          <wa-button
            class="condition-remove-btn"
            @click=${() => this._removeFromGroup(group.id, cond.id)}
            ?disabled=${this.readOnly || !this.serverId}
            title="Remove condition"
            variant="danger"
          >
            <wa-icon name="trash" size="small"></wa-icon>
          </wa-button>
        </div>
      `,
    );

    const nestedGroups = group.groups.map(
      (subgroup: SelectorGroup) => html`
        <div class="group-container">
          ${this._renderBuilderGroup(subgroup, depth + 1)}
        </div>
      `,
    );

    const actions = html`
      <div class="ghost-row">
        <wa-button
          style="padding: 0.25rem 0.5rem;"
          size="small"
          @click=${this._createAddConditionHandler(group.id)}
          ?disabled=${this.readOnly || !this.serverId}
          variant="brand"
        >
          + condition
        </wa-button>
        <span style="color: #ccc; margin: 0 0.5rem;">·</span>
        <wa-button
          style="padding: 0.25rem 0.5rem;"
          size="small"
          @click=${this._createAddGroupHandler(group.id)}
          ?disabled=${this.readOnly || !this.serverId}
          variant="brand"
        >
          + group
        </wa-button>
      </div>
    `;

    return isRoot
      ? html`${rootHeader} ${conditionRows} ${nestedGroups} ${actions}`
      : html`${nestedHeader} ${conditionRows} ${nestedGroups} ${actions}`;
  }

  private _renderStatusLine() {
    const errorCount = this._validationErrors.length;
    const status = this._isValid
      ? "✓ valid selector"
      : "⚠ add a field to build selector";

    return html`
      <div class="status-line">
        <span
          ><span class="status-dot ${errorCount > 0 ? "filled" : ""}"></span
          >${errorCount} ${errorCount === 1 ? "warning" : "warnings"}</span
        >
        <span
          ><span class="status-dot ${this._isValid ? "filled" : ""}"></span
          >${status}</span
        >
        <span style="flex: 1;"></span>
        <span>sync: builder ↔ JSON ✓</span>
      </div>
    `;
  }

  private _renderBuilder() {
    const sortFields = html`
      <div
        class="condition-rows"
        style="display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.75rem;"
      >
        ${this._sortFields.map(
          (sf) => html`
            <div class="sort-field-row">
              <wa-input
                class="condition-input"
                type="text"
                placeholder="field.name"
                .value=${sf.field}
                @input=${(e: CustomEvent) =>
                  this._updateSortField(
                    sf.id,
                    "field",
                    (e.target as any).value,
                  )}
                ?disabled=${this.readOnly}
              ></wa-input>
              <wa-select
                class="condition-operator"
                .value=${sf.direction}
                @change=${(e: CustomEvent) =>
                  this._updateSortField(
                    sf.id,
                    "direction",
                    (e.target as any).value,
                  )}
                ?disabled=${this.readOnly}
                appearance="filled"
              >
                <wa-option value="asc">↑ asc</wa-option>
                <wa-option value="desc">↓ desc</wa-option>
              </wa-select>
              <wa-button
                @click=${() => this._removeSortField(sf.id)}
                ?disabled=${this.readOnly}
                variant="danger"
              >
                <wa-icon name="trash" size="small"></wa-icon>
              </wa-button>
            </div>
          `,
        )}
      </div>
    `;

    const availableFields = html`
      ${this.availableFieldNames.map(
        (field, idx) => html`
          ${idx > 0 ? html`<span class="field-names-separator">·</span> ` : ""}
          <span
            class="field-names-item ${this.selectedFieldNames.has(field) ? "selected" : ""}"
            @click=${() => this._toggleFieldSelection(field)}
            title="Click to select/deselect field"
            >${field}</span
          >
        `,
      )}
    `;

    const fieldNamesSection = html`
      <section style="padding: 0; border-bottom: 1px solid #e0e0e0;">
        <div class="editor-header">Field Names (Sampled)</div>
        <div class="field-names-section">
          <div class="field-names-header"></div>
          <div class="field-names-list">
            ${
              this.availableFieldNames.length > 0
                ? availableFields
                : "No field names available. Click 'resample' to fetch from documents."
            }
          </div>
          <div class="resample-box">
            <wa-button
              class="resample-button"
              title="Resample field names from documents"
              @click=${() => this._retrieveAvailableFieldNames()}
              ?disabled=${!this.serverId || this._loading}
              variant="brand"
            >
              ${this._loading ? html`<wa-spinner></wa-spinner>` : "⧉ resample 100 docs"}
            </wa-button>
          </div>
        </div>
      </section>
    `;

    const sortFieldsSection = html`
      <section style="padding: 0; border-bottom: 1px solid #e0e0e0;">
        <div class="editor-header">SORT</div>
        <div style="padding: 1rem;">
          ${
            this._sortFields.length === 0
              ? html`<div class="sort-placeholder">
                  No sort fields — results in natural order.
                </div>`
              : sortFields
          }
          <wa-button
            style="width: 100%;"
            size="small"
            @click=${() => this._addSortField()}
            ?disabled=${this.readOnly || !this.serverId}
            variant="brand"
          >
            + add field
          </wa-button>
        </div>
      </section>
    `;

    return html`
      <div class="builder-panel">
        <!-- SELECTOR SECTION -->
        <section style="padding: 0; border-bottom: 1px solid #e0e0e0;">
          <div class="editor-header">
            <span>Builder</span>
            <span style="color: #666; font-size: var(--wa-font-size-xs);"
              >(selector)</span
            >
          </div>
          <div style="padding: 1rem;">
            ${this._renderBuilderGroup(this._rootGroup)}
          </div>
        </section>

        <!-- FIELD NAMES SECTION -->
        ${this.showFieldNames ? fieldNamesSection : ""}

        <!-- SORT SECTION -->
        ${this.showSortFields ? sortFieldsSection : ""}
      </div>
    `;
  }

  private _renderEditor() {
    return html`
      <div class="editor-panel">
        <div class="editor-header">Selector JSON — Monaco, Editable</div>
        <div class="editor-container">
          <cca-monaco-editor
            ${ref(this._editorRef)}
            .value=${this._selectorJson}
            .language=${"json"}
            ?readOnly=${this.readOnly}
            @cca-editor-change=${(e: CustomEvent) => this._onEditorChange(e.detail.value)}
            style="width: 100%; height: 99%; min-height: 0; display: flex;"
          ></cca-monaco-editor>
        </div>
        ${
          this._validationErrors.length > 0
            ? html`
                <div class="validation-error">
                  ${this._validationErrors.map((err) => html`<div>${err}</div>`)}
                </div>
              `
            : ""
        }
        ${this._renderStatusLine()}
      </div>
    `;
  }

  private _renderSupportedOperators() {
    if (!this._focusedOperator || !SUPPORTED_OPERATORS[this._focusedOperator]) {
      return;
    }

    const meta = SUPPORTED_OPERATORS[this._focusedOperator];

    const example = html`
      <div style="margin-top: 0.5rem; font-size: var(--wa-font-size-xs);">
        <div style="opacity: 0.7; margin-bottom: 0.25rem; color: #666;">
          Example:
        </div>
        <div class="operator-example">
          ${JSON.stringify(meta.examples[0], null, 2)}
        </div>
      </div>
    `;

    return html`
      <div class="focused-operator-card" style="margin: 1rem;">
        <div class="operator-doc-name">${meta.label}</div>
        <div class="operator-doc-description">${meta.description}</div>
        <div class="operator-syntax">${meta.syntaxHelp}</div>
        ${meta.examples.length > 0 ? example : ""}
      </div>
    `;
  }

  private _renderGuidance() {
    const operators = extractOperatorsFromSelector(this.query);
    const usedOperators = operators
      .map((op) => SUPPORTED_OPERATORS[op])
      .filter((op) => op !== undefined);

    const populateUsedOperators = html`
      ${usedOperators.map(
        (meta) => html`
          <div
            class="operator-doc-item"
            style="margin-bottom: 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px solid #e0e0e0;"
          >
            <div
              class="operator-doc-name"
              style="font-size: var(--wa-font-size-xs);"
            >
              ${meta.label}
            </div>
            <div
              class="operator-doc-description"
              style="font-size: var(--wa-font-size-xs);"
            >
              ${meta.description}
            </div>
          </div>
        `,
      )}
    `;

    return html`
      <div class="guidance-panel">
        <div class="editor-header">Guidance</div>
        <wa-tab-group
          style="flex: 1; display: flex; flex-direction: column;"
          .active="${this.activeTab}"
          @wa-tab-show="${(e: CustomEvent) => (this.activeTab = e.detail.name)}"
        >
          <wa-tab slot="nav" panel="docs">Docs</wa-tab>
          <wa-tab slot="nav" panel="explain">Explain</wa-tab>
          <wa-tab slot="nav" panel="preview">Preview</wa-tab>

          <wa-tab-panel name="docs">
            <div class="docs-link">
              <a
                href="https://docs.couchdb.org/en/stable/api/database/find.html#find-selectors"
                target="_blank"
                ><wa-icon name="book"></wa-icon>Official CouchDB Find Selectors
                Documentation</a
              >
              <div class="docs-search-box">
                <wa-input
                  type="text"
                  class="docs-search-input"
                  placeholder="Search operators..."
                  .value=${this._docsSearchQuery}
                  @input=${(e: Event) => {
                    this._docsSearchQuery = (
                      e.target as HTMLInputElement
                    ).value;
                  }}
                ></wa-input>
              </div>

              <div style="flex: 1; overflow-y: auto;">
                ${
                  this._focusedOperator &&
                  SUPPORTED_OPERATORS[this._focusedOperator]
                    ? (() => {
                        return this._renderSupportedOperators();
                      })()
                    : ""
                }

                <div class="operators-catalogue">
                  ${(() => {
                    const categories = this._categorizeOperators();
                    const filtered = this._filterOperators(
                      categories,
                      this._docsSearchQuery,
                    );

                    const categoryLabels: Record<string, string> = {
                      combination: "Combination",
                      condition: "Condition",
                      array: "Array",
                      meta: "Meta",
                    };

                    const rendered: any[] = [];
                    for (const [category, ops] of Object.entries(filtered)) {
                      if (ops.length === 0) continue;

                      rendered.push(html`
                        <div class="operator-category">
                          <div class="operator-category-title">
                            ${categoryLabels[category]}
                          </div>
                          ${ops.map(
                            ([key, value]) => html`
                              <div
                                class="operator-catalogue-item ${
                                  this._focusedOperator === key ? "active" : ""
                                }"
                                @click=${() => {
                                  this._focusedOperator = key;
                                }}
                              >
                                <div class="operator-catalogue-name">
                                  ${key}
                                </div>
                                <div class="operator-catalogue-desc">
                                  ${value.description}
                                </div>
                              </div>
                            `,
                          )}
                        </div>
                      `);
                    }

                    return rendered.length > 0
                      ? rendered
                      : html`
                          <div
                            style="color: #999; font-style: italic; padding: 1rem; text-align: center;"
                          >
                            No operators match your search
                          </div>
                        `;
                  })()}
                </div>
              </div>
            </div>
          </wa-tab-panel>

          <wa-tab-panel name="explain">
            <div class="operator-docs">
              <div
                style="font-size: var(--wa-font-size-s); color: #666; line-height: var(--wa-line-height-normal); padding: 0.5rem 0;"
              >
                <cca-explain-query
                  ${ref(this._explainRef)}
                  .mangoQuery=${this._explainPayload()}
                  .serverId=${this.serverId}
                  .dbName=${this.dbName}
                  .simpleView=${true}
                ></cca-explain-query>
              </div>
              <div>
                <wa-button
                  @click=${() => this._runExplain()}
                  variant="brand"
                  style="margin-top: 0.5rem;"
                  ?disabled=${!this.serverId || !this.dbName}
                  >Explain</wa-button
                >
                <wa-button
                  @click=${() =>
                    getContext().router.navigate(
                      `/databases/${encodeURIComponent(this.serverId || "$all")}/${encodeURIComponent(this.dbName)}/indexes`,
                    )}
                  variant="brand"
                  style="margin-top: 0.5rem;"
                  ?disabled=${!this.serverId || !this.dbName}
                  >Manage Indexes</wa-button
                >
              </div>
              <div
                style="margin-top: 1.5rem; font-weight: var(--wa-font-weight-bold); margin-bottom: 0.75rem; color: #333;"
              >
                Used Operators
              </div>
              ${
                usedOperators.length > 0
                  ? populateUsedOperators
                  : html`<div
                      style="font-size: var(--wa-font-size-xs); color: #999; font-style: italic; padding: 1rem 0;"
                    >
                      No operators used yet
                    </div>`
              }
            </div>
          </wa-tab-panel>

          <wa-tab-panel name="preview">
            <div
              style="padding: 1rem; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 1rem;"
            >
              <div>
                <div
                  style="font-weight: var(--wa-font-weight-bold); margin-bottom: 1rem;"
                >
                  Results (${this.previewResults.length})
                </div>
                <div
                  style="display: flex; flex-direction: column; gap: 0.75rem;"
                >
                  ${this._renderPreviewResults()}
                </div>
              </div>
            </div>
          </wa-tab-panel>
        </wa-tab-group>
      </div>
    `;
  }

  private _renderPreviewResults() {
    const results = this.previewResults.map(
      (result, idx) => html`
        <div class="preview-result-item">
          ${Object.entries(result).map(
            ([key, value]) => html`
              <div class="preview-key-value">
                <span class="preview-key">"${key}":</span>
                <span class="preview-value">
                  ${typeof value === "string" ? `"${value}"` : String(value)}
                </span>
              </div>
            `,
          )}
        </div>
      `,
    );

    const noResults = html`<div class="no-preview-results">
      No results to preview
    </div>`;

    return html`
      <div class="preview-results-panel">
        <div class="preview-results-container">
          ${this.previewResults.length > 0 ? results : noResults}
        </div>
      </div>
    `;
  }

  override render() {
    return html`
      <div class="container">
        ${this._renderBuilder()} ${this._renderEditor()}
        ${this.showOperatorHelp ? this._renderGuidance() : ""}
      </div>
    `;
  }
}
