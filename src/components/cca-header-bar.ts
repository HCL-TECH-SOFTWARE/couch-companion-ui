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
import { customElement, property } from "lit/decorators.js";
import { CcaElement } from "./cca-element.js";

/**
 * Reusable header bar component for database management pages.
 * Provides a consistent header layout with back button, title, and optional subtitle.
 *
 * Properties:
 * - title: Main header title (required for simple mode)
 * - subtitle: Secondary subtitle text (optional)
 * - showBackButton: Whether to show the back button (default: true)
 *
 * Events:
 * - cca-header-back: Emitted when back button is clicked
 *
 * Slots:
 * - default: Left content (back button + title group) - auto-generated if title is set
 * - right: Right-aligned content (optional)
 */
@customElement("cca-header-bar")
export class CcaHeaderBar extends CcaElement {
  @property() title: any = "";
  @property() subtitle: any = "";
  @property({ type: Boolean }) showBackButton = true;
  static override get styles() {
    return css`
      :host {
        display: block;
      }
      .header-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
      }
      .header-bar-left {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .header-title-group {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
      }
      .header-title {
        margin: 0;
        font-size: var(--wa-font-size-l);
        color: var(--wa-color-text-normal, #1f2a35);
      }
      .header-subtitle {
        font-size: var(--wa-font-size-xs);
        opacity: 0.55;
        line-height: var(--wa-line-height-condensed);
        color: var(--wa-color-text-normal, #1f2a35);
      }
      ::slotted(.header-title) {
        margin: 0;
        font-size: var(--wa-font-size-l);
        color: var(--wa-color-text-normal, #1f2a35);
      }
      ::slotted(.header-subtitle) {
        font-size: var(--wa-font-size-xs);
        opacity: 0.55;
        line-height: var(--wa-line-height-condensed);
        color: var(--wa-color-text-normal, #1f2a35);
      }
      .header-right {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
    `;
  }

  private _handleBackClick() {
    this.dispatchEvent(
      new CustomEvent("cca-header-back", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    // If title is provided, render default structure; otherwise use slots
    if (this.title) {
      return html`
        <div class="header-bar">
          <div class="header-bar-left">
            ${
              this.showBackButton
                ? html`<wa-button
                    appearance="plain"
                    @click=${() => this._handleBackClick()}
                  >
                    ← Back
                  </wa-button>`
                : ""
            }
            <div class="header-title-group">
              <h2 class="header-title">
                <slot name="title">${this.title}</slot>
              </h2>
              ${
                this.subtitle
                  ? html`<span class="header-subtitle">${this.subtitle}</span>`
                  : ""
              }
            </div>
          </div>
          <div class="header-right">
            <slot name="right"></slot>
          </div>
        </div>
      `;
    }

    // Fallback to slot-based layout for custom content
    return html`
      <div class="header-bar">
        <div class="header-bar-left">
          <slot></slot>
        </div>
        <div class="header-right">
          <slot name="right"></slot>
        </div>
      </div>
    `;
  }
}

/**
 * Helper component for organizing title and subtitle within the header.
 * Use inside cca-header-bar default slot.
 */
@customElement("cca-header-title-group")
export class CcaHeaderTitleGroup extends CcaElement {
  static override get styles() {
    return css`
      :host {
        display: contents;
      }
      .header-title-group {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
      }
      ::slotted(.header-title) {
        margin: 0;
        font-size: var(--wa-font-size-l);
        color: var(--wa-color-text-normal, #1f2a35);
      }
      ::slotted(.header-subtitle) {
        font-size: var(--wa-font-size-xs);
        opacity: 0.55;
        line-height: var(--wa-line-height-condensed);
        color: var(--wa-color-text-normal, #1f2a35);
      }
    `;
  }

  override render() {
    return html`
      <div class="header-title-group">
        <slot></slot>
      </div>
    `;
  }
}
