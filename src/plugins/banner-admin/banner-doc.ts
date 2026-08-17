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

import { BANNER_DOC_ID } from './types.js';
import type { BannerEntry, BannerMessagesDoc } from './types.js';

/** Reads the `banners` array out of a loaded document, defensively. */
export function parseEntries(doc: Record<string, unknown> | null): BannerEntry[] {
  const raw = doc && Array.isArray(doc.banners) ? (doc.banners as unknown[]) : [];
  return raw.map((e) => {
    const entry = (e ?? {}) as Record<string, unknown>;
    const out: BannerEntry = {
      message: typeof entry.message === 'string' ? entry.message : '',
      until: typeof entry.until === 'string' ? entry.until : '',
    };
    if (typeof entry.icon === 'string' && entry.icon) out.icon = entry.icon;
    if (typeof entry.link === 'string' && entry.link) out.link = entry.link;
    return out;
  });
}

/** Trims an entry and drops empty optional fields so the stored doc stays clean. */
function cleanEntry(e: BannerEntry): BannerEntry {
  const out: BannerEntry = { message: e.message.trim(), until: e.until };
  const icon = e.icon?.trim();
  const link = e.link?.trim();
  if (icon) out.icon = icon;
  if (link) out.link = link;
  return out;
}

/** Builds the document to save, preserving `_id`/`_rev` (and any other fields) from the original. */
export function buildDoc(
  original: Record<string, unknown> | null,
  entries: BannerEntry[],
): BannerMessagesDoc {
  return {
    ...(original ?? {}),
    _id: (original?._id as string) ?? BANNER_DOC_ID,
    banners: entries.map(cleanEntry),
  };
}

/** Converts an RFC 3339 datetime (or date) to a `<input type="datetime-local">` value (local time). */
export function toDatetimeLocal(rfc3339: string): string {
  if (!rfc3339) return '';
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Converts a `<input type="datetime-local">` value (local, no tz) to an RFC 3339 UTC string. */
export function fromDatetimeLocal(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

/** @returns true when `until` is a valid datetime already in the past. */
export function isExpired(until: string, now: number = Date.now()): boolean {
  const t = Date.parse(until);
  return !Number.isNaN(t) && t < now;
}

/** Formats an RFC 3339 datetime for display in the user's locale, or `""` when invalid. */
export function formatUntil(until: string): string {
  if (!until) return '';
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** @returns a human-readable error if the entry is invalid, else `null`. */
export function validateEntry(e: BannerEntry): string | null {
  if (!e.message || !e.message.trim()) return 'Message is required.';
  if (!e.until || !e.until.trim()) return 'An "until" date-time is required.';
  if (Number.isNaN(new Date(e.until).getTime())) return 'The "until" value is not a valid date-time.';
  return null;
}
