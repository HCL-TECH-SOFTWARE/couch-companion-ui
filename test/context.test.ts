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

import { describe, it, expect, beforeEach } from 'vitest';
import { getContext } from '../src/context';
import { SINGLE_SERVER_ID } from '../src/services/single-server';
import type { AppContext } from '../src/context';

describe('context', () => {
  let ctx: AppContext;

  beforeEach(() => {
    sessionStorage.clear();
    ctx = getContext();
  });

  it('returns an AppContext with all expected properties', () => {
    expect(ctx.api).toBeDefined();
    expect(ctx.auth).toBeDefined();
    expect(ctx.router).toBeDefined();
    expect(ctx.plugins).toBeDefined();
  });

  it('returns the same singleton instance on repeated calls', () => {
    const second = getContext();
    expect(second).toBe(ctx);
  });

  // #31: there is exactly one CouchDB, so "the selected server" is a constant,
  // not mutable state. The getter is kept (spec D6) so consumers compile
  // unchanged, but nothing can write it and nothing can subscribe to it.
  describe('single-server selection (#31)', () => {
    it('selectedServer is the single-server constant', () => {
      expect(ctx.selectedServer).toBe(SINGLE_SERVER_ID);
    });

    it('exposes no selection write path and no subscription', () => {
      const surface = ctx as unknown as Record<string, unknown>;
      expect(surface.selectServer).toBeUndefined();
      expect(surface.subscribeServerSelection).toBeUndefined();
    });

    it('the getter is not writable back to something else', () => {
      const surface = ctx as unknown as Record<string, unknown>;
      try {
        surface.selectedServer = 'somewhere-else';
      } catch {
        /* a readonly accessor throws in strict mode — equally acceptable */
      }
      expect(ctx.selectedServer).toBe(SINGLE_SERVER_ID);
    });
  });
});
