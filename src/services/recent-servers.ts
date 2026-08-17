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

export interface RecentServer {
  url: string;
  last_used: number;
}

export const STORAGE_KEY = 'cca_recent_servers';
const MAX_ENTRIES = 20;

function isRecentServer(value: unknown): value is RecentServer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RecentServer).url === 'string' &&
    typeof (value as RecentServer).last_used === 'number'
  );
}

function readRaw(): RecentServer[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isRecentServer);
  } catch {
    return [];
  }
}

function sortMru(entries: RecentServer[]): RecentServer[] {
  return [...entries].sort((a, b) => b.last_used - a.last_used);
}

export function loadRecentServers(): RecentServer[] {
  return sortMru(readRaw());
}

export function recordRecentServer(url: string): void {
  const others = readRaw().filter((e) => e.url !== url);
  const updated = sortMru([{ url, last_used: Date.now() }, ...others]).slice(
    0,
    MAX_ENTRIES
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function getLastServer(): string | null {
  return loadRecentServers()[0]?.url ?? null;
}
