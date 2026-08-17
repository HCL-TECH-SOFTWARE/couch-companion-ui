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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from '../src/services/api-client';
import { ApiError } from '../src/services/api-error';
import { DbMgmtService } from '../src/services/db-mgmt-service';
import { BannerAdminService } from '../src/services/banner-admin-service';

describe('BannerAdminService.getActiveBanner', () => {
  let apiClient: ApiClient;
  let dbMgmt: DbMgmtService;
  let service: BannerAdminService;

  const doc = (banners: unknown[]) => ({ _id: 'BannerMessages', _rev: '1-a', banners });

  beforeEach(() => {
    apiClient = new ApiClient('http://test');
    dbMgmt = new DbMgmtService(apiClient);
    service = new BannerAdminService(dbMgmt);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the first non-expired banner', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    vi.spyOn(dbMgmt, 'getDoc').mockResolvedValue(doc([
      { message: 'old', until: '2020-01-01T00:00:00Z' },
      { message: 'current', icon: 'bullhorn', until: future },
    ]));
    await expect(service.getActiveBanner()).resolves.toMatchObject({ message: 'current', icon: 'bullhorn' });
  });

  it('treats a missing until as never expiring', async () => {
    vi.spyOn(dbMgmt, 'getDoc').mockResolvedValue(doc([{ message: 'forever' }]));
    await expect(service.getActiveBanner()).resolves.toMatchObject({ message: 'forever' });
  });

  it('resolves {} when every banner has expired, the doc is missing, or the read fails', async () => {
    vi.spyOn(dbMgmt, 'getDoc').mockResolvedValue(doc([{ message: 'old', until: '2020-01-01T00:00:00Z' }]));
    await expect(service.getActiveBanner()).resolves.toEqual({});
    vi.spyOn(dbMgmt, 'getDoc').mockRejectedValue(new ApiError(404, 'Database does not exist.'));
    await expect(service.getActiveBanner()).resolves.toEqual({});
    vi.spyOn(dbMgmt, 'getDoc').mockRejectedValue(new TypeError('network'));
    await expect(service.getActiveBanner()).resolves.toEqual({});
  });

  it('ignores a malformed banners field', async () => {
    vi.spyOn(dbMgmt, 'getDoc').mockResolvedValue({ _id: 'BannerMessages', banners: 'nope' } as never);
    await expect(service.getActiveBanner()).resolves.toEqual({});
  });
});
