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
import { buildReplicatorCurl } from "../src/plugins/replication/replicator-curl.js";

const doc = {
  _id: "cca_users_to_eu",
  _rev: "3-abc",
  source: { url: "https://a/db", headers: { Authorization: "Basic c2VjcmV0" } },
  target: { url: "https://b/db2", headers: {} },
  create_target: true,
  continuous: true,
  owner: "admin"
};

/** The JSON body between the <<'JSON' heredoc markers. */
function heredocBody(cmd: string): Record<string, any> {
  const afterMarker = cmd.split("<<'JSON'\n")[1];
  expect(afterMarker).toBeDefined();
  return JSON.parse(afterMarker.slice(0, afterMarker.lastIndexOf("\nJSON")));
}

describe("buildReplicatorCurl", () => {
  it("POSTs to the host's _replicator database", () => {
    const cmd = buildReplicatorCurl("https://a", doc);
    expect(cmd.startsWith('curl -X POST "https://a/_replicator" \\')).toBe(true);
    expect(cmd).toContain('-H "Content-Type: application/json"');
  });

  it("normalizes a trailing slash on the server url", () => {
    const cmd = buildReplicatorCurl("https://a/", doc);
    expect(cmd).toContain('"https://a/_replicator"');
  });

  it("strips _id and _rev but keeps non-credential fields verbatim", () => {
    const body = heredocBody(buildReplicatorCurl("https://a", doc));
    expect(body._id).toBeUndefined();
    expect(body._rev).toBeUndefined();
    expect(body.owner).toBe("admin");
    expect(body.create_target).toBe(true);
    expect(body.continuous).toBe(true);
    expect(body.source.url).toBe("https://a/db");
  });

  it("emits a placeholder instead of the real Authorization header", () => {
    const cmd = buildReplicatorCurl("https://a", doc);
    expect(cmd).not.toContain("Basic c2VjcmV0");
    expect(cmd).toMatch(/REPLACE_WITH_CREDENTIALS/);

    const body = heredocBody(cmd);
    expect(body.source.headers.Authorization).toBe("REPLACE_WITH_CREDENTIALS");
  });

  it("masks userinfo in endpoint URLs", () => {
    const withUrlCreds = {
      ...doc,
      source: { url: "https://admin:hunter2@a/db", headers: {} },
    };
    const cmd = buildReplicatorCurl("https://a", withUrlCreds);
    expect(cmd).not.toContain("hunter2");

    const body = heredocBody(cmd);
    expect(body.source.url).toContain("***");
    expect(body.source.url).not.toContain("hunter2");
  });

  it("masks every header value, not just Authorization", () => {
    const withExtra = {
      ...doc,
      source: {
        url: "https://a/db",
        headers: { Authorization: "Basic c2VjcmV0", "X-Auth-CouchDB-Token": "tok-abc123" },
      },
    };
    const cmd = buildReplicatorCurl("https://a", withExtra);
    expect(cmd).not.toContain("tok-abc123");
    const body = heredocBody(cmd);
    // Keys pass through untouched; only the value is replaced.
    expect(body.source.headers["X-Auth-CouchDB-Token"]).toBe("REPLACE_WITH_CREDENTIALS");
    expect(body.source.headers.Authorization).toBe("REPLACE_WITH_CREDENTIALS");
  });

  it("uses env-var auth placeholders and a quoted heredoc ending in JSON", () => {
    const cmd = buildReplicatorCurl("https://a", doc);
    expect(cmd).toContain('-u "$COUCHDB_USER:$COUCHDB_PASSWORD"');
    expect(cmd).toContain("--data-binary @- <<'JSON'");
    expect(cmd.endsWith("\nJSON")).toBe(true);
  });

  it("does not mutate the input document", () => {
    const copy = structuredClone(doc);
    buildReplicatorCurl("https://a", doc);
    expect(doc).toEqual(copy);
  });
});
