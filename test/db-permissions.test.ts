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

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fixture, html } from "@open-wc/testing";
import "../src/plugins/db-mgmt/db-permissions.js";
import type { CcaDbPermissions } from "../src/plugins/db-mgmt/db-permissions.js";
import type { DatabaseAccess } from "../src/plugins/db-mgmt/types.js";



describe("cca-db-permissions", () => {
  let element: CcaDbPermissions;
  const defaultAccess: DatabaseAccess = {
    admin: { name: [], roles: ["_admin"] },
    member: { name: [], roles: ["_admin"] },
  };

  beforeEach(async () => {
    element = await fixture<CcaDbPermissions>(html`
      <cca-db-permissions .access=${defaultAccess}></cca-db-permissions>
    `);
  });

  it("should render", () => {
    expect(element).to.exist;
  });

  it("should render admin and member sections", () => {
    const sections = element.shadowRoot!.querySelectorAll(".section");
    expect(sections).to.have.lengthOf(2);
  });

  it("should display default roles", async () => {
    await element.updateComplete;
    const items = element.shadowRoot!.querySelectorAll(".tag");
    // Should have 2 items: _admin role in both admin and member sections
    expect(items.length).to.be.at.least(2);
  });

  it("should add admin user when Add User button is clicked", async () => {
    const eventSpy = vi.fn();
    element.addEventListener("cca-permissions-change", eventSpy);

    // Find admin user input (first .tag-input)
    const inputs = element.shadowRoot!.querySelectorAll(".tag-input");
    const adminUserInput = inputs[0] as HTMLInputElement;

    // Set value and trigger add
    adminUserInput.value = "testuser";
    adminUserInput.dispatchEvent(new Event("input"));
    adminUserInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await element.updateComplete;

    await element.updateComplete;

    expect(eventSpy).toHaveBeenCalled();
    expect(element.access.admin.name).toContain("testuser");
  });

  it("should add admin role when Add Role button is clicked", async () => {
    const eventSpy = vi.fn();
    element.addEventListener("cca-permissions-change", eventSpy);

    // Find admin role input (second .tag-input)
    const inputs = element.shadowRoot!.querySelectorAll(".tag-input");
    const adminRoleInput = inputs[1] as HTMLInputElement;

    // Set value and trigger add
    adminRoleInput.value = "customrole";
    adminRoleInput.dispatchEvent(new Event("input"));
    adminRoleInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await element.updateComplete;

    await element.updateComplete;

    expect(eventSpy).toHaveBeenCalled();
    expect(element.access.admin.roles).toContain("customrole");
  });

  it("should remove user when remove button is clicked", async () => {
    // Set up element with a user
    element.access = {
      admin: { name: ["testuser"], roles: ["_admin"] },
      member: { name: [], roles: ["_admin"] },
    };
    await element.updateComplete;

    const eventSpy = vi.fn();
    element.addEventListener("cca-permissions-change", eventSpy);

    // Find and click remove button
    const removeButtons = element.shadowRoot!.querySelectorAll(".tag-remove");
    (removeButtons[0] as HTMLElement).click();

    await element.updateComplete;

    expect(eventSpy).toHaveBeenCalled();
    expect(element.access.admin.name).to.not.contain("testuser");
  });

  it("should remove role when remove button is clicked", async () => {
    // Set up element with custom role
    element.access = {
      admin: { name: [], roles: ["_admin", "customrole"] },
      member: { name: [], roles: ["_admin"] },
    };
    await element.updateComplete;

    const eventSpy = vi.fn();
    element.addEventListener("cca-permissions-change", eventSpy);

    // Find and click remove button for customrole
    const removeButtons = element.shadowRoot!.querySelectorAll(".tag-remove");
    // Second remove button should be for customrole
    (removeButtons[1] as HTMLElement).click();

    await element.updateComplete;

    expect(eventSpy).toHaveBeenCalled();
    expect(element.access.admin.roles).to.not.contain("customrole");
  });

  it("should not add duplicate users", async () => {
    element.access = {
      admin: { name: ["testuser"], roles: ["_admin"] },
      member: { name: [], roles: ["_admin"] },
    };
    await element.updateComplete;

    const eventSpy = vi.fn();
    element.addEventListener("cca-permissions-change", eventSpy);

    // Try to add the same user again
    const inputs = element.shadowRoot!.querySelectorAll(".tag-input");
    const adminUserInput = inputs[0] as HTMLInputElement;

    adminUserInput.value = "testuser";
    adminUserInput.dispatchEvent(new Event("input"));
    adminUserInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await element.updateComplete;
    await element.updateComplete;

    // Should not emit event for duplicate
    expect(eventSpy).to.not.toHaveBeenCalled();
    expect(
      element.access.admin.name.filter((n) => n === "testuser"),
    ).to.have.lengthOf(1);
  });

  it("should not add duplicate roles", async () => {
    element.access = {
      admin: { name: [], roles: ["_admin", "customrole"] },
      member: { name: [], roles: ["_admin"] },
    };
    await element.updateComplete;

    const eventSpy = vi.fn();
    element.addEventListener("cca-permissions-change", eventSpy);

    // Try to add the same role again
    const inputs = element.shadowRoot!.querySelectorAll(".tag-input");
    const adminRoleInput = inputs[1] as HTMLInputElement;

    adminRoleInput.value = "customrole";
    adminRoleInput.dispatchEvent(new Event("input"));
    adminRoleInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await element.updateComplete;
    await element.updateComplete;

    // Should not emit event for duplicate
    expect(eventSpy).to.not.toHaveBeenCalled();
    expect(
      element.access.admin.roles.filter((r) => r === "customrole"),
    ).to.have.lengthOf(1);
  });

  it("should hide input controls in readonly mode", async () => {
    element.readonly = true;
    await element.updateComplete;

    const inputs = element.shadowRoot!.querySelectorAll(".tag-input");
    expect(inputs).to.have.lengthOf(0);
  });

  it("should show remove buttons in edit mode", async () => {
    element.access = {
      admin: { name: ["user1"], roles: ["_admin", "role1"] },
      member: { name: ["user2"], roles: ["_admin", "role2"] },
    };
    await element.updateComplete;

    const removeButtons = element.shadowRoot!.querySelectorAll(".tag-remove");
    expect(removeButtons.length).to.be.greaterThan(0);
  });

  it("should hide remove buttons in readonly mode", async () => {
    element.access = {
      admin: { name: ["user1"], roles: ["_admin", "role1"] },
      member: { name: ["user2"], roles: ["_admin", "role2"] },
    };
    element.readonly = true;
    await element.updateComplete;

    const removeButtons = element.shadowRoot!.querySelectorAll(".tag-remove");
    expect(removeButtons).to.have.lengthOf(0);
  });

  it("should emit change event with correct detail", async () => {
    let eventDetail: any;
    element.addEventListener("cca-permissions-change", (e: Event) => {
      eventDetail = (e as CustomEvent).detail;
    });

    const inputs = element.shadowRoot!.querySelectorAll(".tag-input");
    const adminUserInput = inputs[0] as HTMLInputElement;

    adminUserInput.value = "newuser";
    adminUserInput.dispatchEvent(new Event("input"));
    adminUserInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await element.updateComplete;
    await element.updateComplete;

    expect(eventDetail).toBeDefined();
    expect(eventDetail.access).toBeDefined();
    expect(eventDetail.access.admin.name).toContain("newuser");
  });
});
