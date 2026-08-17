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
 * How many documents a list screen fetches per page, remembered across reloads.
 *
 * The preference lives in `localStorage`, following {@link
 * ../services/theme-service.APPEARANCE_STORAGE_KEY}'s convention — never in the
 * `couchcompanion` database, which D13 (`docs/derivate-creation.md`) reserves for
 * things that are not per-browser UI state (#80).
 */

/** The sizes offered by the page-size selector (#80). */
export const PAGE_SIZE_OPTIONS: readonly number[] = [5, 10, 25, 50, 100];

/** The size used until the user picks another — this app's long-standing `PAGE_SIZE`. */
export const DEFAULT_PAGE_SIZE = 25;

/** `localStorage` key holding `cca-doc-browser`'s page size. */
export const DOC_BROWSER_PAGE_SIZE_KEY = "ccaDocBrowserPageSize";

/** `localStorage` key holding `cca-doc-query`'s page size. */
export const DOC_QUERY_PAGE_SIZE_KEY = "ccaDocQueryPageSize";

/**
 * Reads a stored page size, falling back to {@link DEFAULT_PAGE_SIZE} when unset,
 * unparsable, or no longer one of {@link PAGE_SIZE_OPTIONS} — a value that is not
 * on the selector cannot be shown as selected, so it is not honoured either.
 */
export function getPageSize(key: string): number {
  const stored = Number(localStorage.getItem(key));
  return PAGE_SIZE_OPTIONS.includes(stored) ? stored : DEFAULT_PAGE_SIZE;
}

/** Stores a page size. Values outside {@link PAGE_SIZE_OPTIONS} are ignored. */
export function setPageSize(key: string, size: number): void {
  if (!PAGE_SIZE_OPTIONS.includes(size)) return;
  localStorage.setItem(key, String(size));
}

/**
 * Parses a skip field's raw text into a non-negative integer, or `null` when it is
 * not one. Empty means zero: clearing the box is how a user removes the offset.
 * Digits only — `-1`, `1.5` and `1e3` are all rejected rather than coerced, so a
 * typo never silently pages somewhere else.
 */
export function parseSkip(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}
