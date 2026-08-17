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

/**
 * The rule both document lists turn a page of documents into columns by (#79).
 */

import { describe, it, expect } from "vitest";
import {
  deriveFieldNames,
  formatCellValue,
  resolveColumns,
} from "../src/services/derived-columns";

describe("deriveFieldNames", () => {
  it("has no columns to offer for no documents", () => {
    expect(deriveFieldNames([])).toEqual([]);
  });

  it("names one column per field the documents carry", () => {
    expect(
      deriveFieldNames([{ _id: "a", _rev: "1-a", name: "Ada", age: 36 }]),
    ).toEqual(["_id", "_rev", "name", "age"]);
  });

  // The whole point of deriving: what the table shows is what this database holds,
  // not the two fields every CouchDB document has.
  it("gives a document with extra fields extra columns", () => {
    const plain = deriveFieldNames([{ _id: "a", _rev: "1-a" }]);
    const rich = deriveFieldNames([
      { _id: "a", _rev: "1-a", title: "Doc", tags: ["x"] },
    ]);
    expect(plain).toEqual(["_id", "_rev"]);
    expect(rich).toEqual(["_id", "_rev", "title", "tags"]);
  });

  // CouchDB databases are heterogeneous by design. Keying off `documents[0]` alone —
  // what doc-query did before #79 — hides every field the first document lacks.
  it("unions the fields across the page, not just the first document", () => {
    expect(
      deriveFieldNames([
        { _id: "a", _rev: "1-a", name: "Ada" },
        { _id: "b", _rev: "1-b", email: "b@example.test" },
      ]),
    ).toEqual(["_id", "_rev", "name", "email"]);
  });

  it("names each field once, however many documents carry it", () => {
    expect(
      deriveFieldNames([
        { _id: "a", name: "Ada" },
        { _id: "b", name: "Bea" },
      ]),
    ).toEqual(["_id", "name"]);
  });

  // Leftmost columns that shuffle from page to page are unreadable; `_id` and `_rev`
  // are also the two doc-browser used to hardcode, and it still opens on them.
  it("leads with _id and _rev wherever the JSON put them", () => {
    expect(deriveFieldNames([{ name: "Ada", _rev: "1-a", _id: "a" }])).toEqual([
      "_id",
      "_rev",
      "name",
    ]);
  });

  it("leaves out the identity fields the documents do not have", () => {
    expect(deriveFieldNames([{ name: "Ada" }])).toEqual(["name"]);
  });

  /**
   * `_attachments` is in the documents — `scope: "full"` brings the stubs along — and is
   * still not a column: as one it renders a blob of stub JSON in every row. The paperclip
   * indicator says the same thing in a glyph and a number (#84), so the raw field is
   * excluded here, which keeps it out of every picker's offer as well.
   */
  it("leaves _attachments out, however many documents carry it", () => {
    const stubs = { "a.png": { content_type: "image/png", stub: true } };
    expect(
      deriveFieldNames([{ _id: "a", _rev: "1-a", _attachments: stubs }]),
    ).toEqual(["_id", "_rev"]);
  });

  it("keeps the fields around an excluded one", () => {
    expect(
      deriveFieldNames([{ _id: "a", _attachments: {}, name: "Ada" }]),
    ).toEqual(["_id", "name"]);
  });
});

describe("resolveColumns", () => {
  const docs = [{ _id: "a", _rev: "1-a", name: "Ada", email: "a@b.test" }];

  it("shows the derived fields until a picker is used", () => {
    expect(resolveColumns(docs, null)).toEqual({
      fields: ["_id", "_rev", "name", "email"],
      available: ["_id", "_rev", "name", "email"],
    });
  });

  it("shows exactly what was chosen once one is", () => {
    expect(resolveColumns(docs, ["_id", "email"]).fields).toEqual([
      "_id",
      "email",
    ]);
  });

  // The field a swap replaced must not come back on the next page — that would undo
  // the swap, once per page, and look like the picker forgetting.
  it("does not re-add a derived field the chosen list dropped", () => {
    expect(resolveColumns(docs, ["_id", "email"]).fields).not.toContain("_rev");
  });

  // A chosen field this page's documents lack still has a column (rendering the
  // missing-value dash) and still has to be offerable, or the picker could not show
  // which field the column is set to.
  it("still offers a chosen field the current page does not carry", () => {
    const resolved = resolveColumns([{ _id: "a" }], ["_id", "nickname"]);
    expect(resolved.fields).toEqual(["_id", "nickname"]);
    expect(resolved.available).toEqual(["_id", "nickname"]);
  });

  it("offers every derived field even where none is shown", () => {
    expect(resolveColumns(docs, ["name"]).available).toEqual([
      "_id",
      "_rev",
      "name",
      "email",
    ]);
  });

  // What a picker offers comes from here, so excluding `_attachments` from the derived
  // set is also what keeps it out of the menus (#84).
  it("never offers _attachments to a picker", () => {
    const resolved = resolveColumns(
      [{ _id: "a", _attachments: { "a.png": { stub: true } }, name: "Ada" }],
      null,
    );
    expect(resolved.fields).toEqual(["_id", "name"]);
    expect(resolved.available).not.toContain("_attachments");
  });
});

describe("formatCellValue", () => {
  it("shows a missing field as the dash the table uses for one", () => {
    expect(formatCellValue(undefined)).toBe("—");
  });

  it("tells a null field apart from a missing one", () => {
    expect(formatCellValue(null)).toBe("null");
  });

  it("passes primitives through", () => {
    expect(formatCellValue("Ada")).toBe("Ada");
    expect(formatCellValue(36)).toBe("36");
    expect(formatCellValue(false)).toBe("false");
  });

  // `${value}` on an object renders `[object Object]` — the same nothing for every
  // object, in a table whose whole job is showing what is in the documents.
  it("shows what is inside an object or array, not [object Object]", () => {
    expect(formatCellValue({ city: "Oslo" })).toBe('{"city":"Oslo"}');
    expect(formatCellValue([1, 2])).toBe("[1,2]");
  });

  it("cuts a value too long to sit in a row", () => {
    const formatted = formatCellValue("x".repeat(500));
    expect(formatted).toHaveLength(81);
    expect(formatted.endsWith("…")).toBe(true);
  });
});
