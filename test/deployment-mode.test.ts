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

import { describe, it, expect, vi } from "vitest";
import { detectDeployment } from "../src/services/deployment-mode";
import type { ApiClient } from "../src/services/api-client";

const fakeApi = (up: boolean) =>
  ({ probeUp: vi.fn().mockResolvedValue(up) }) as unknown as ApiClient;

describe("detectDeployment", () => {
  it("returns same-origin with the page origin when /_up answers", async () => {
    const api = fakeApi(true);
    const dep = await detectDeployment(api);
    expect(dep).toEqual({ mode: "same-origin", baseUrl: window.location.origin });
    expect(api.probeUp).toHaveBeenCalledWith(window.location.origin);
  });

  it("returns spa with empty base when the probe fails", async () => {
    await expect(detectDeployment(fakeApi(false))).resolves.toEqual({ mode: "spa", baseUrl: "" });
  });
});
