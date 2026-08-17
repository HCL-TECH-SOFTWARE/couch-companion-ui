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

import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getContext } from "../../context.js";
import { getLogger } from "../../services/log-service.js";
import { buildTopology } from "../../services/topology-model.js";
import { SINGLE_SERVER_ID } from "../../services/single-server.js";
import type { TopologyData } from "./types.js";
import { renderTopology, serverSymbolPath } from "./topology-graph.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/icon/icon.js";

const log = getLogger("plugins/server-mgmt/server-topology");

/**
 * The legend's server swatch at text size — `d3.symbol` sizes are areas, and 80px² puts the wye's
 * tips ~7px from its centre. The `viewBox` runs negative because the path is centred on the origin.
 */
const LEGEND_GLYPH_PATH = serverSymbolPath(80);

/**
 * One server swatch for the legend, drawn from the graph's own `d3.symbol` path rather than
 * approximated in CSS, so a change to the node shape cannot leave the legend describing the old one.
 */
function serverGlyph(variant: "server" | "down") {
  return html`<svg
    class="glyph ${variant}"
    viewBox="-8 -8 16 16"
    aria-hidden="true"
  >
    <path d=${LEGEND_GLYPH_PATH}></path>
  </svg>`;
}

/**
 * `ApiError.message` can be the empty string when the response carries no statusText — branching
 * on truthiness downstream would then render a *failed* load as an empty message (#688).
 * Normalize once here and always branch on `error !== null` instead.
 */
function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.trim() === "" ? "Request failed." : raw;
}

@customElement("cca-server-topology")
export class CcaServerTopology extends LitElement {
  static styles = css`
    :host {
      display: block;
      height: 100%;
    }
    .container {
      width: 100%;
      height: calc(100vh - 120px);
      background: var(--wa-color-surface-default);
      border-radius: var(--wa-border-radius-m);
      overflow: hidden;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5rem;
      padding: 0.75rem 1rem;
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
      border-bottom: 1px solid var(--wa-color-border-quiet);
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }
    .glyph {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
    }
    .glyph.server path {
      fill: var(--wa-color-neutral-fill-loud);
    }
    .glyph.down path {
      fill: var(--wa-color-danger-fill-loud);
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex: 0 0 auto;
      border: 2px solid var(--wa-color-surface-default);
    }
    .dot.outgoing {
      background: var(--wa-color-brand-fill-loud);
    }
    .dot.incoming {
      background: var(--wa-color-success-fill-loud);
    }
    .dot.both {
      background: var(--wa-color-warning-fill-loud);
    }
    /* The dashed outline and washed-out fill the graph gives a node it never contacted. */
    .dot.remote {
      background: var(--wa-color-neutral-fill-loud);
      border: 2px dashed var(--wa-color-neutral-border-loud);
      opacity: 0.55;
    }
    .line-solid {
      width: 20px;
      height: 2px;
      background: var(--wa-color-neutral-fill-loud);
    }
    .line-dashed {
      width: 20px;
      height: 0;
      border-top: 1px dashed var(--wa-color-neutral-fill-loud);
    }
    .line-hosts {
      width: 20px;
      height: 1px;
      background: var(--wa-color-neutral-border-loud);
    }
    .graph {
      width: 100%;
      height: calc(100% - 40px);
    }
    wa-callout {
      margin: 1rem;
    }
  `;

  @state() private data: TopologyData | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;

  async connectedCallback() {
    super.connectedCallback();
    await this.loadTopology();
  }

  private get replicationService() {
    return getContext().replication;
  }

  private get serverMgmtService() {
    return getContext().serverMgmt;
  }

  /**
   * The topology picture is derived entirely from the local `_replicator` database (spec D10):
   * list its documents, fetch the single local server record, and fold both into a
   * `TopologyData` client-side with `buildTopology`. Remote endpoints named by a replication are
   * drawn as synthesized nodes but this call never contacts them.
   */
  private async loadTopology() {
    this.loading = true;
    this.error = null;
    try {
      const [docs, localServer] = await Promise.all([
        this.replicationService.listReplications(),
        this.serverMgmtService.getServer(SINGLE_SERVER_ID),
      ]);
      this.data = buildTopology(docs, localServer);
    } catch (err) {
      log.error("Failed to load topology", err as Error);
      this.error = messageOf(err);
      this.data = null;
    } finally {
      this.loading = false;
    }
  }

  updated() {
    if (!this.loading && this.error === null && this.data) {
      const container = this.shadowRoot?.querySelector(".graph") as HTMLElement;
      if (container) {
        renderTopology(container, this.data);
      }
    }
  }

  render() {
    if (this.loading) return html`<p>Loading topology...</p>`;

    // `!== null`, never a truthiness check: an empty message is still an error (#688).
    if (this.error !== null) {
      return html`
        <wa-callout data-error variant="danger" appearance="filled-outlined">
          <wa-icon slot="icon" name="circle-exclamation"></wa-icon>
          Failed to load topology: ${this.error}
        </wa-callout>
      `;
    }

    return html`
      <div class="container">
        <div class="legend">
          <span class="legend-item">${serverGlyph("server")} Server</span>
          <span class="legend-item"
            >${serverGlyph("down")} Local server unreachable</span
          >
          <span class="legend-item"
            ><span class="dot outgoing"></span> Database replicated from</span
          >
          <span class="legend-item"
            ><span class="dot incoming"></span> Database replicated to</span
          >
          <span class="legend-item"
            ><span class="dot both"></span> Database replicated both ways</span
          >
          <span class="legend-item"
            ><span class="dot remote"></span> Dashed outline — Remote endpoint
            (not contacted): drawn only because a local replication document
            names it, so it may not exist, and any replication it has with a
            third server is invisible here</span
          >
          <span class="legend-item"
            ><span class="line-hosts"></span> Server hosts database</span
          >
          <span class="legend-item"
            ><span class="line-solid"></span> Continuous replication</span
          >
          <span class="legend-item"
            ><span class="line-dashed"></span> One-time replication</span
          >
        </div>
        <div class="graph"></div>
      </div>
    `;
  }
}
