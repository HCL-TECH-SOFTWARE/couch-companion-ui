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

import { CcaElement } from "../../components/cca-element.js";
import type { CcaIndexList } from "./index-list.js";
import type { CcaCreateIndex } from "./create-index.js";
import { state } from "@lit/reactive-element/decorators/state.js";
import { DatabaseServerInfo } from "./types";
import { property } from "@lit/reactive-element/decorators/property.js";
import { getContext } from "../../context";
import { toast } from "../../components/cca-toast.js";
import { html, css } from "lit-element/lit-element.js";
import { customElement } from "@lit/reactive-element/decorators/custom-element.js";
import "../../components/cca-header-bar.js";
import { query } from "lit/decorators.js";

@customElement("cca-index-manage")
export class CcaManageIndex extends CcaElement {
  static override get styles() {
    return css`
      :host {
        display: block;
      }
    `;
  }

  @property() dbName = "";

  /** Set by the router from the :serverId path param. */
  @property({ type: String }) serverId = "";

  @state() private _isEditingIndex = false;
  @query("cca-index-list") private _indexListComponent?: CcaIndexList;
  @query("cca-create-index") private _createIndexComponent?: CcaCreateIndex;

  override connectedCallback() {
    super.connectedCallback();

    // Listen for index edit requests from the index list
    this.addEventListener(
      "cca-index-edit-requested",
      this._handleIndexEditRequest.bind(this),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener(
      "cca-index-edit-requested",
      this._handleIndexEditRequest.bind(this),
    );
  }

  private _handleIndexEditRequest(e: Event) {
    const customEvent = e as CustomEvent<{ index: any }>;
    const indexInfo = customEvent.detail.index;
    this._isEditingIndex = true;

    if (
      this._createIndexComponent &&
      this._createIndexComponent.populateFromIndexInfo
    ) {
      this._createIndexComponent.populateFromIndexInfo(indexInfo);
    }
  }

  private _load() {
    this.requestUpdate();
  }

  private _refreshIndexList() {
    const list = this._indexListComponent as {
      refresh?: () => void;
    } | null;
    list?.refresh?.();
  }

  private _onIndexCreated(deleteIndex: boolean) {
    // If we're in edit mode, complete the edit (which may delete the old index)
    if (this._isEditingIndex && deleteIndex) {
      if (
        this._indexListComponent &&
        this._indexListComponent.completeIndexEdit
      ) {
        this._indexListComponent
          .completeIndexEdit()
          .then(() => {
            this._isEditingIndex = false;
            this._refreshIndexList();
          })
          .catch((err: any) => {
            toast(
              `Failed to complete index edit: ${err?.message ?? err}`,
              "error",
            );
            this._isEditingIndex = false;
            this._refreshIndexList();
          });
      }
    } else {
      this._refreshIndexList();
    }
  }

  private _scrollToTop() {
    const scrollContainer = document.querySelector("cca-index-manage");

    if (scrollContainer) {
      scrollContainer.scrollTo({
        top: 0,
        behavior: "smooth",
      });
    } else {
      // Fallback if no container is caught
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  public cancelIndexEdit() {
    if (this._isEditingIndex) {
      this._indexListComponent?.cancelIndexEdit?.();
      this._createIndexComponent?.resetForm?.();
      this._isEditingIndex = false;
    }
  }

  override render() {
    return html`
      <!-- Header bar -->
      <cca-header-bar
        .title=${this.dbName}
        @cca-header-back=${() => getContext().router.back(`/databases/${encodeURIComponent(this.serverId || "$all")}/${encodeURIComponent(this.dbName)}/documents`)}
      ></cca-header-bar>
      <div
        style="height:65vh;overflow-y:auto;padding:1rem;display:flex;gap:1rem;align-items:flex-start"
      >
        <section style="flex:1 1 25%;min-width:18rem;max-width:24rem">
          <cca-create-index
            .dbName=${this.dbName}
            .serverId=${this.serverId}
            @index-created=${(e: CustomEvent) => this._onIndexCreated(e.detail.deleteCreateIndex)}
          ></cca-create-index>
        </section>
        <section
          style="flex:1 1 70%;min-width:0;display:flex;flex-direction:column;"
        >
          <cca-index-list
            .dbName=${this.dbName}
            .serverId=${this.serverId}
            @cca-index-scroll-top=${() => this._scrollToTop()}
          ></cca-index-list>
        </section>
      </div>
    `;
  }
}
