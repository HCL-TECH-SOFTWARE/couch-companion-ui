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
import { html, css } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { getContext } from "../../context.js";
import { toast } from "../../components/cca-toast.js";
import { ApiError } from "../../services/api-error.js";
import { getLogger } from "../../services/log-service.js";
import { DatabaseAccess } from "./db-permissions.js";
import {
  clearHeaderTitle,
  setHeaderTitle,
} from "../../components/cca-header.js";
import "../../components/cca-header-bar.js";
import "./db-permissions.js";

const log = getLogger("plugins/db-mgmt/manage-permissions");

@customElement("cca-manage-permissions")
export class ManagePermissions extends CcaElement {
  static override get styles() {
    return css`
      :host {
        display: block;
      }
      .content-container {
        height: 65vh;
        overflow-y: auto;
        display: flex;
        gap: 1rem;
        align-items: flex-start;
      }
    `;
  }

  /** Set by the router from the :dbName path param. */
  @property() dbName = "";

  /** Set by the router from the :serverId path param. */
  @property({ type: String }) serverId = "";

  @state() private _databaseAccess: DatabaseAccess = {
    admin: { name: [], roles: [] },
    member: { name: [], roles: [] },
  };

  override connectedCallback() {
    super.connectedCallback();
    setHeaderTitle(`Manage Permissions`);
    this._load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearHeaderTitle();
  }

  private _load() {
    getContext()
      .dbMgmt.listDatabaseAccess(this.serverId, this.dbName)
      .then((access) => {
        this._databaseAccess = access;
        this.dispatchEvent(
          new CustomEvent("access-loaded", { detail: access, bubbles: true }),
        );
      })
      .catch((err: ApiError) => {
        log.error("Failed to load database access", err);
        toast(`Failed to load database access: ${err.message}`, "error");
      });
  }

  private _updateAccess(access: DatabaseAccess) {
    getContext()
      .dbMgmt.updateDatabaseAccess(this.serverId, this.dbName, access)
      .then(() => {
        this._databaseAccess = access;
        toast("Database access updated successfully", "success");
      })
      .catch((err: ApiError) => {
        log.error("Failed to update database access", err);
        toast(`Failed to update database access: ${err.message}`, "error");
      });
  }

  override render() {
    return html`
      <!-- Header bar -->
      <cca-header-bar
        .title=${this.dbName}
        @cca-header-back=${() => getContext().router.back(`/databases/${encodeURIComponent(this.serverId || "$all")}`)}
      ></cca-header-bar>
      <div class="content-container">
        <cca-db-permissions
          .access=${this._databaseAccess}
          @cca-permissions-change=${(e: CustomEvent) => {
            this._databaseAccess = e.detail.access;
          }}
        ></cca-db-permissions>
      </div>
      <div>
        <wa-button @click=${() => this._updateAccess(this._databaseAccess)}
          >Update Access</wa-button
        >
      </div>
    `;
  }
}
