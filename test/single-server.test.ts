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
import { serverKey } from "../src/services/single-server";

// `serverKey` is the one reading of "which server does this URL name?" shared by the topology
// graph (`topology-model.ts`) and the replication editor (`repl-editor.ts#inferServerIdFromUrl`).
// Both compare an endpoint against this deployment's own base URL, and a false negative there
// splits one physical database into a "local" and a "remote" node (#59).
describe("serverKey", () => {
  it("keys on host and port", () => {
    expect(serverKey("http://db.example:5984/mydb")).toBe("db.example:5984");
    expect(serverKey("https://db.example/mydb")).toBe("db.example");
  });

  it("folds the aliases one server answers to", () => {
    const expected = "localhost:5984";
    for (const url of [
      "http://localhost:5984",
      "http://LocalHost:5984/",
      "http://127.0.0.1:5984/db",
      "http://0.0.0.0:5984/db",
      "http://[::1]:5984/db",
      // Credentials, and the `***` sentinel stored endpoints arrive masked with.
      "http://admin:secret@localhost:5984/db",
      "http://***@127.0.0.1:5984/db",
      // Scheme is not part of the key: one server reached two ways.
      "https://localhost:5984/db",
    ]) {
      expect(serverKey(url), url).toBe(expected);
    }
  });

  it("drops the scheme's default port, so it may be written or omitted", () => {
    expect(serverKey("http://db.example:80/x")).toBe("db.example");
    expect(serverKey("http://db.example/x")).toBe("db.example");
    expect(serverKey("https://db.example:443/x")).toBe("db.example");
  });

  it("keeps a non-default port, so a second CouchDB on the same host stays distinct", () => {
    expect(serverKey("http://localhost:5984")).not.toBe(
      serverKey("http://localhost:15984"),
    );
    expect(serverKey("http://127.0.0.1:15984")).toBe(
      serverKey("http://localhost:15984"),
    );
  });

  it("never returns credentials", () => {
    expect(serverKey("http://admin:secret@db.example:5984/x")).toBe(
      "db.example:5984",
    );
    expect(serverKey("http://***@db.example:5984/x")).not.toContain("*");
  });

  it("returns '' for anything that is not an absolute http(s) URL", () => {
    for (const url of [
      "",
      "db_a",
      "not a valid url",
      "//localhost:5984/db",
      "/db",
      "localhost:5984/db",
      "ftp://db.example/x",
      "file:///tmp/db",
    ]) {
      expect(serverKey(url), url).toBe("");
    }
  });

  it("does not fold two genuinely different names for one host", () => {
    // Nothing short of contacting the server could prove a Compose service name and `localhost`
    // are the same box, and spec D10 forbids contacting it. Documented limitation, pinned here so
    // a later "improvement" that guesses has to argue with a test.
    expect(serverKey("http://couchdb:5984")).not.toBe(
      serverKey("http://localhost:5984"),
    );
  });
});
