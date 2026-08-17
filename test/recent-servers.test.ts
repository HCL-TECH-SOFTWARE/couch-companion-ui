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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadRecentServers,
  recordRecentServer,
  getLastServer,
  STORAGE_KEY,
} from '../src/services/recent-servers';

function seed(entries: Array<{ url: string; last_used: number }>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

describe('recent-servers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loadRecentServers', () => {
    it('returns [] when nothing is stored', () => {
      expect(loadRecentServers()).toEqual([]);
    });

    it('returns stored entries MRU-sorted by last_used desc', () => {
      seed([
        { url: 'https://old.example', last_used: 100 },
        { url: 'https://new.example', last_used: 300 },
        { url: 'https://mid.example', last_used: 200 },
      ]);

      expect(loadRecentServers().map((e) => e.url)).toEqual([
        'https://new.example',
        'https://mid.example',
        'https://old.example',
      ]);
    });

    it('returns [] on malformed JSON', () => {
      localStorage.setItem(STORAGE_KEY, '{not json');
      expect(loadRecentServers()).toEqual([]);
    });

    it('drops entries with the wrong shape', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([
          { url: 'https://good.example', last_used: 1 },
          { url: 42 },
          'nope',
          { last_used: 5 },
          { url: 'https://good2.example', last_used: 2 },
        ])
      );

      expect(loadRecentServers().map((e) => e.url)).toEqual([
        'https://good2.example',
        'https://good.example',
      ]);
    });
  });

  describe('recordRecentServer', () => {
    it('appends a new entry with current timestamp', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-22T10:00:00Z'));

      recordRecentServer('https://a.example');

      const entries = loadRecentServers();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.url).toBe('https://a.example');
      expect(entries[0]?.last_used).toBe(Date.now());
    });

    it('dedupes by url and updates last_used', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-22T10:00:00Z'));
      recordRecentServer('https://a.example');

      vi.setSystemTime(new Date('2026-05-22T11:00:00Z'));
      recordRecentServer('https://b.example');

      vi.setSystemTime(new Date('2026-05-22T12:00:00Z'));
      recordRecentServer('https://a.example');

      const entries = loadRecentServers();
      expect(entries.map((e) => e.url)).toEqual([
        'https://a.example',
        'https://b.example',
      ]);
      expect(entries[0]?.last_used).toBe(
        new Date('2026-05-22T12:00:00Z').getTime()
      );
    });

    it('caps stored entries at 20 (drops oldest)', () => {
      const existing = Array.from({ length: 20 }, (_, i) => ({
        url: `https://srv-${i}.example`,
        last_used: 1000 + i,
      }));
      seed(existing);

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-22T12:00:00Z'));
      recordRecentServer('https://srv-new.example');

      const entries = loadRecentServers();
      expect(entries).toHaveLength(20);
      expect(entries[0]?.url).toBe('https://srv-new.example');
      // The oldest entry (last_used: 1000, srv-0) should be gone.
      expect(entries.find((e) => e.url === 'https://srv-0.example')).toBeUndefined();
    });
  });

  describe('getLastServer', () => {
    it('returns null when storage is empty', () => {
      expect(getLastServer()).toBeNull();
    });

    it('returns the url of the most-recently-used entry', () => {
      seed([
        { url: 'https://old.example', last_used: 100 },
        { url: 'https://new.example', last_used: 300 },
        { url: 'https://mid.example', last_used: 200 },
      ]);

      expect(getLastServer()).toBe('https://new.example');
    });
  });
});
