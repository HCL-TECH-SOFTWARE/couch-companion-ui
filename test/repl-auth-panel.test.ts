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

import { describe, it, expect, afterEach } from "vitest";
import { LitElement } from "lit";
import "../src/plugins/replication/repl-auth-panel.js";
import type {
  CcaReplAuthPanel,
  ReplAuthChangeDetail,
} from "../src/plugins/replication/repl-auth-panel.js";

// Light-DOM stubs so the panel renders under happy-dom without real wa-* internals.
class WaStub extends LitElement {
  open = false;
  value = "";
  createRenderRoot() {
    return this;
  }
}
for (const tag of [
  "wa-dialog",
  "wa-button",
  "wa-select",
  "wa-option",
  "wa-input",
  "cca-http-headers-table",
]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends WaStub {});
  }
}

function mount(auth: Record<string, string>): CcaReplAuthPanel {
  const el = document.createElement("cca-repl-auth-panel") as CcaReplAuthPanel;
  el.title = "Source Authentication";
  el.auth = auth;
  document.body.appendChild(el);
  return el;
}

function root(el: CcaReplAuthPanel): ShadowRoot {
  if (!el.shadowRoot) throw new Error("expected shadowRoot");
  return el.shadowRoot;
}

/** Mounts with a stored `Authorization` header and opens the dialog, so `seedDraft()` runs. */
async function mountWithStoredAuth(
  authorizationValue: string,
): Promise<CcaReplAuthPanel> {
  const el = mount({ Authorization: authorizationValue });
  await el.updateComplete;
  (root(el).querySelector("[data-auth-trigger]") as HTMLElement).click();
  await el.updateComplete;
  return el;
}

describe("cca-repl-auth-panel", () => {
  let el: CcaReplAuthPanel;

  afterEach(() => {
    el?.remove();
  });

  it("derives the button label from the auth object", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{}, "None"],
      [{ Authorization: "Bearer tok" }, "Bearer"],
      [{ Authorization: `Basic ${btoa("u:p")}` }, "Basic"],
      [{ "X-Api-Key": "k" }, "Custom"],
      [{ Authorization: "Basic not-valid-base64!!" }, "Custom"],
      [{ Authorization: "Bearer x", "X-Extra": "y" }, "Custom"],
    ];
    for (const [auth, label] of cases) {
      el = mount(auth);
      await el.updateComplete;
      const btn = root(el).querySelector("[data-auth-trigger]");
      expect(btn?.textContent?.trim()).toBe(label);
      el.remove();
    }
  });

  it("never renders a stored password back into the form", async () => {
    el = await mountWithStoredAuth("Basic " + btoa("admin:hunter2"));

    const html = root(el).innerHTML;
    expect(html).not.toContain("hunter2");
    const pw = root(el).querySelector(
      'wa-input[type="password"]',
    ) as (HTMLInputElement & { value: string }) | null;
    expect(pw?.value ?? "").toBe("");
    expect(root(el).textContent).toMatch(/stored|saved/i);
  });

  it("keeps the stored credential when the user does not touch the panel", async () => {
    const original = "Basic " + btoa("admin:hunter2");
    el = await mountWithStoredAuth(original);

    let detail: ReplAuthChangeDetail | undefined;
    el.addEventListener("cca-auth-change", (e) => {
      detail = (e as CustomEvent<ReplAuthChangeDetail>).detail;
    });
    // Apply is clicked directly, without ever hitting Replace or Clear.
    (root(el).querySelector("[data-confirm]") as HTMLElement).click();

    expect(detail?.auth).toEqual({ Authorization: original });
  });

  it("clears the credential when the user explicitly clears it", async () => {
    el = await mountWithStoredAuth("Basic " + btoa("admin:hunter2"));

    (root(el).querySelector("[data-clear]") as HTMLElement).click();
    await el.updateComplete;

    let detail: ReplAuthChangeDetail | undefined;
    el.addEventListener("cca-auth-change", (e) => {
      detail = (e as CustomEvent<ReplAuthChangeDetail>).detail;
    });
    (root(el).querySelector("[data-confirm]") as HTMLElement).click();

    expect(detail?.auth).toEqual({});
  });

  it("replaces a stored credential with a freshly entered one, never pre-filled", async () => {
    el = await mountWithStoredAuth("Basic " + btoa("admin:hunter2"));

    (root(el).querySelector("[data-replace]") as HTMLElement).click();
    await el.updateComplete;

    const user = root(el).querySelector(
      "[data-user]",
    ) as HTMLInputElement & { value: string };
    const pass = root(el).querySelector(
      "[data-password]",
    ) as HTMLInputElement & { value: string };
    expect(user.value).toBe("");
    expect(pass.value).toBe("");

    user.value = "newuser";
    user.dispatchEvent(new Event("input"));
    pass.value = "newpass";
    pass.dispatchEvent(new Event("input"));
    await el.updateComplete;

    let detail: ReplAuthChangeDetail | undefined;
    el.addEventListener("cca-auth-change", (e) => {
      detail = (e as CustomEvent<ReplAuthChangeDetail>).detail;
    });
    (root(el).querySelector("[data-confirm]") as HTMLElement).click();

    expect(detail?.auth).toEqual({
      Authorization: `Basic ${btoa("newuser:newpass")}`,
    });
  });

  // Finding #5 of the Phase 4 final-review wave: without this guard, clicking Replace then Apply
  // with blank fields would compile a bare "Basic "/"Bearer " scheme, which repl-editor.ts's
  // cleanAuthObject trims into a truthy "Basic"/"Bearer" — overwriting the real stored credential
  // with garbage. Apply must stay disabled (and confirm() must no-op) until real content exists.
  it("disables Apply after Replace until a real credential is entered, so a blank Apply cannot overwrite the stored credential", async () => {
    el = await mountWithStoredAuth("Basic " + btoa("admin:hunter2"));

    (root(el).querySelector("[data-replace]") as HTMLElement).click();
    await el.updateComplete;

    const confirmBtn = root(el).querySelector(
      "[data-confirm]",
    ) as HTMLElement;
    expect(confirmBtn.hasAttribute("disabled")).toBe(true);

    let detail: ReplAuthChangeDetail | undefined;
    el.addEventListener("cca-auth-change", (e) => {
      detail = (e as CustomEvent<ReplAuthChangeDetail>).detail;
    });
    confirmBtn.click();
    expect(detail).toBeUndefined();

    // Entering either field alone already compiles to a real (if partial) credential — not the
    // bare "Basic " scheme — so Apply re-enables as soon as there is ANY content.
    const user = root(el).querySelector(
      "[data-user]",
    ) as HTMLInputElement & { value: string };
    user.value = "newuser";
    user.dispatchEvent(new Event("input"));
    await el.updateComplete;
    expect(
      (root(el).querySelector("[data-confirm]") as HTMLElement).hasAttribute(
        "disabled",
      ),
    ).toBe(false);

    const pass = root(el).querySelector(
      "[data-password]",
    ) as HTMLInputElement & { value: string };
    pass.value = "newpass";
    pass.dispatchEvent(new Event("input"));
    await el.updateComplete;

    expect(
      (root(el).querySelector("[data-confirm]") as HTMLElement).hasAttribute(
        "disabled",
      ),
    ).toBe(false);
    (root(el).querySelector("[data-confirm]") as HTMLElement).click();
    expect(detail?.auth).toEqual({
      Authorization: `Basic ${btoa("newuser:newpass")}`,
    });
  });

  it("does not disable Apply when Clear selects the 'none' mode (an empty object is the intended result)", async () => {
    el = await mountWithStoredAuth("Basic " + btoa("admin:hunter2"));

    (root(el).querySelector("[data-clear]") as HTMLElement).click();
    await el.updateComplete;

    expect(
      (root(el).querySelector("[data-confirm]") as HTMLElement).hasAttribute(
        "disabled",
      ),
    ).toBe(false);
  });

  it("emits cca-auth-change with the compiled bearer header on confirm", async () => {
    el = mount({ Authorization: "Bearer old" });
    await el.updateComplete;
    (root(el).querySelector("[data-auth-trigger]") as HTMLElement).click();
    await el.updateComplete;
    // A stored credential (Bearer old) must be replaced before its fields appear.
    (root(el).querySelector("[data-replace]") as HTMLElement).click();
    await el.updateComplete;

    const token = root(el).querySelector("[data-token]") as HTMLInputElement & {
      value: string;
    };
    token.value = "new";
    token.dispatchEvent(new Event("input"));
    await el.updateComplete;

    let detail: ReplAuthChangeDetail | undefined;
    el.addEventListener("cca-auth-change", (e) => {
      detail = (e as CustomEvent<ReplAuthChangeDetail>).detail;
    });
    (root(el).querySelector("[data-confirm]") as HTMLElement).click();

    expect(detail?.auth).toEqual({ Authorization: "Bearer new" });
  });

  it("compiles an empty object when the mode is none", async () => {
    el = mount({ Authorization: "Bearer old" });
    await el.updateComplete;
    (root(el).querySelector("[data-auth-trigger]") as HTMLElement).click();
    await el.updateComplete;
    (root(el).querySelector("[data-replace]") as HTMLElement).click();
    await el.updateComplete;

    const mode = root(el).querySelector("[data-mode]") as HTMLSelectElement & {
      value: string;
    };
    mode.value = "none";
    mode.dispatchEvent(new Event("change"));
    await el.updateComplete;

    let detail: ReplAuthChangeDetail | undefined;
    el.addEventListener("cca-auth-change", (e) => {
      detail = (e as CustomEvent<ReplAuthChangeDetail>).detail;
    });
    (root(el).querySelector("[data-confirm]") as HTMLElement).click();

    expect(detail?.auth).toEqual({});
  });

  it("opens straight into the editable form when nothing is stored", async () => {
    el = mount({});
    await el.updateComplete;
    (root(el).querySelector("[data-auth-trigger]") as HTMLElement).click();
    await el.updateComplete;

    // No stored-state affordances, and the mode select is immediately usable.
    expect(root(el).querySelector("[data-replace]")).toBeNull();
    expect(root(el).querySelector("[data-clear]")).toBeNull();
    expect(root(el).querySelector("[data-mode]")).not.toBeNull();
  });

  it("does not treat a bare Bearer placeholder as a stored credential", async () => {
    // repl-editor.ts used to default sourceAuth/targetAuth to exactly this value before
    // anything was loaded or typed; it must open straight into the editable form, not the
    // "stored" screen, or a fresh Create Replication would be unusable.
    el = mount({ Authorization: "Bearer " });
    await el.updateComplete;
    expect(
      (root(el).querySelector("[data-auth-trigger]") as HTMLElement).textContent?.trim(),
    ).toBe("None");
    (root(el).querySelector("[data-auth-trigger]") as HTMLElement).click();
    await el.updateComplete;

    expect(root(el).querySelector("[data-replace]")).toBeNull();
    expect(root(el).querySelector("[data-clear]")).toBeNull();
    expect(root(el).querySelector("[data-mode]")).not.toBeNull();
  });

  it("does not treat a bare Basic placeholder as a stored credential", async () => {
    el = mount({ Authorization: "Basic " });
    await el.updateComplete;
    (root(el).querySelector("[data-auth-trigger]") as HTMLElement).click();
    await el.updateComplete;

    expect(root(el).querySelector("[data-replace]")).toBeNull();
    expect(root(el).querySelector("[data-clear]")).toBeNull();
    expect(root(el).querySelector("[data-mode]")).not.toBeNull();
  });

  it("still protects a real, non-empty Bearer credential", async () => {
    el = await mountWithStoredAuth("Bearer realtoken");

    expect(root(el).querySelector("[data-replace]")).not.toBeNull();
    expect(root(el).querySelector("[data-clear]")).not.toBeNull();
    expect(root(el).querySelector("[data-mode]")).toBeNull();
  });
});
