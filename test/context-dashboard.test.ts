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

import { describe, it, expect } from "vitest";
import { getRouter } from "../src/customEventRouter.js";
import { getContext } from "../src/context";
import { ALL_REQUEST_EVENTS } from "../src/components/server-dashboard/events";

describe("context wires the server dashboard service", () => {
  it("subscribes the dashboard service to every request event", () => {
    getContext(); // builds + starts ServerDashboardService on first call
    const router = getRouter();
    for (const eventName of ALL_REQUEST_EVENTS) {
      expect(router.subscribers(eventName).length).toBeGreaterThan(0);
    }
  });
});
