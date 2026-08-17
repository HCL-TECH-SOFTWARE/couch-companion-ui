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

import { describe, it, expect } from 'vitest';
import {
  parseEntries,
  buildDoc,
  toDatetimeLocal,
  fromDatetimeLocal,
  validateEntry,
  isExpired,
  formatUntil,
} from '../src/plugins/banner-admin/banner-doc';
import type { BannerEntry } from '../src/plugins/banner-admin/types';

describe('banner-doc', () => {
  describe('parseEntries', () => {
    it('returns [] for a null doc, a missing array, or a non-array banners field', () => {
      expect(parseEntries(null)).toEqual([]);
      expect(parseEntries({ _id: 'BannerMessages' })).toEqual([]);
      expect(parseEntries({ banners: 'nope' })).toEqual([]);
    });

    it('normalises each entry, dropping empty optional fields', () => {
      const entries = parseEntries({
        banners: [
          { message: 'Hi', icon: 'bell', link: 'https://x', until: '2026-07-01T12:00:00Z' },
          { message: 'No extras', icon: '', link: '', until: '2026-08-01' },
          { message: 42, until: 5 }, // junk types coerced to ''
        ],
      });
      expect(entries).toEqual([
        { message: 'Hi', icon: 'bell', link: 'https://x', until: '2026-07-01T12:00:00Z' },
        { message: 'No extras', until: '2026-08-01' },
        { message: '', until: '' },
      ]);
    });
  });

  describe('buildDoc', () => {
    it('preserves _id and _rev from the original and trims/cleans entries', () => {
      const original = { _id: 'BannerMessages', _rev: '3-abc', extra: 'keep' };
      const doc = buildDoc(original, [
        { message: '  spaced  ', icon: '  bell  ', link: '', until: '2026-07-01T12:00:00Z' },
      ]);
      expect(doc._id).toBe('BannerMessages');
      expect(doc._rev).toBe('3-abc');
      expect(doc.extra).toBe('keep');
      expect(doc.banners).toEqual([
        { message: 'spaced', icon: 'bell', until: '2026-07-01T12:00:00Z' },
      ]);
    });

    it('defaults _id to BannerMessages and omits _rev when there is no original', () => {
      const doc = buildDoc(null, []);
      expect(doc._id).toBe('BannerMessages');
      expect('_rev' in doc).toBe(false);
      expect(doc.banners).toEqual([]);
    });
  });

  describe('datetime-local conversion', () => {
    it('returns "" for empty or unparseable input', () => {
      expect(toDatetimeLocal('')).toBe('');
      expect(toDatetimeLocal('not-a-date')).toBe('');
      expect(fromDatetimeLocal('')).toBe('');
      expect(fromDatetimeLocal('not-a-date')).toBe('');
    });

    it('round-trips a local datetime through RFC 3339 (timezone-agnostic)', () => {
      const local = '2026-07-01T13:30';
      const rfc = fromDatetimeLocal(local);
      // Valid RFC 3339 with timezone designator.
      expect(rfc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
      expect(toDatetimeLocal(rfc)).toBe(local);
    });
  });

  describe('validateEntry', () => {
    const base: BannerEntry = { message: 'Hi', until: '2026-07-01T12:00:00Z' };
    it('accepts a valid entry', () => {
      expect(validateEntry(base)).toBeNull();
    });
    it('requires a non-empty message', () => {
      expect(validateEntry({ ...base, message: '   ' })).toMatch(/message/i);
    });
    it('requires a present, parseable until', () => {
      expect(validateEntry({ ...base, until: '' })).toMatch(/until|date/i);
      expect(validateEntry({ ...base, until: 'garbage' })).toMatch(/until|date|valid/i);
    });
  });

  describe('isExpired', () => {
    const now = Date.parse('2026-07-01T12:00:00Z');
    it('is true for a past until, false for a future one', () => {
      expect(isExpired('2026-06-01T00:00:00Z', now)).toBe(true);
      expect(isExpired('2026-08-01T00:00:00Z', now)).toBe(false);
    });
    it('is false for empty or unparseable input', () => {
      expect(isExpired('', now)).toBe(false);
      expect(isExpired('garbage', now)).toBe(false);
    });
  });

  describe('formatUntil', () => {
    it('returns "" for empty or unparseable input', () => {
      expect(formatUntil('')).toBe('');
      expect(formatUntil('garbage')).toBe('');
    });
    it('renders a non-empty human-readable string including the year', () => {
      expect(formatUntil('2026-07-01T12:00:00Z')).toMatch(/2026/);
    });
  });
});
