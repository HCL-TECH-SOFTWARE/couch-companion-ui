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
  buildUserId,
  isUserDoc,
  validateUsername,
  validateRole,
  collectRoles,
  mergeCandidateRoles,
  buildCreateDoc,
  buildUpdateDoc,
  maskDocForPreview,
  PASSWORD_MASK,
} from '../src/plugins/users/users-doc';
import type { UserDoc } from '../src/plugins/users/types';

describe('users-doc', () => {
  it('builds the org.couchdb.user id from the name', () => {
    expect(buildUserId('alice')).toBe('org.couchdb.user:alice');
  });

  it('isUserDoc keeps type=user and rejects design docs', () => {
    expect(isUserDoc({ type: 'user' })).toBe(true);
    expect(isUserDoc({ _id: '_design/_auth' })).toBe(false);
  });

  it('validateUsername enforces CouchDB name rules', () => {
    expect(validateUsername('alice')).toBeNull();
    expect(validateUsername('al_ice-2')).toBeNull();
    expect(validateUsername('')).toMatch(/required/i);
    expect(validateUsername('_admin')).toMatch(/underscore/i);
    expect(validateUsername('Alice')).toMatch(/lowercase/i);
    expect(validateUsername('a b')).toMatch(/only contain|letters, numbers/i);
    expect(validateUsername('a:b')).toMatch(/only contain|letters, numbers/i);
  });

  it('validateRole blocks leading-underscore roles except _metrics', () => {
    expect(validateRole('reader')).toBeNull();
    expect(validateRole('_metrics')).toBeNull();
    expect(validateRole('_admin')).toMatch(/system roles/i);
    expect(validateRole('')).toMatch(/required/i);
  });

  it('collectRoles returns distinct sorted roles across users', () => {
    const users = [
      { roles: ['b', 'a'] },
      { roles: ['a', 'c'] },
      { roles: [] },
    ] as UserDoc[];
    expect(collectRoles(users)).toEqual(['a', 'b', 'c']);
  });

  describe('mergeCandidateRoles', () => {
    it('merges, dedupes, and sorts roles from both sources', () => {
      expect(mergeCandidateRoles(['b', 'a'], ['a', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('drops _admin arriving via securityRoles but keeps _metrics', () => {
      expect(mergeCandidateRoles(['reader'], ['_admin', '_metrics'])).toEqual([
        '_metrics',
        'reader',
      ]);
    });

    it('does not filter user-derived roles (asymmetry with securityRoles)', () => {
      expect(mergeCandidateRoles(['_weird'], [])).toEqual(['_weird']);
    });
  });

  it('buildCreateDoc produces a complete, valid create body', () => {
    expect(buildCreateDoc({ name: 'bob', password: 's3cret', roles: ['reader'] })).toEqual({
      _id: 'org.couchdb.user:bob',
      name: 'bob',
      type: 'user',
      roles: ['reader'],
      password: 's3cret',
    });
  });

  it('buildCreateDoc omits password when not provided', () => {
    const doc = buildCreateDoc({ name: 'bob', roles: [] });
    expect('password' in doc).toBe(false);
  });

  it('buildUpdateDoc preserves _rev and hash fields, changes only roles', () => {
    const original = {
      _id: 'org.couchdb.user:bob',
      _rev: '2-abc',
      name: 'bob',
      type: 'user',
      roles: ['reader'],
      password_scheme: 'pbkdf2',
      derived_key: 'deadbeef',
      salt: 'cafe',
      iterations: 10,
    };
    const out = buildUpdateDoc(original, { roles: ['reader', 'admin'] });
    expect(out._rev).toBe('2-abc');
    expect(out.derived_key).toBe('deadbeef');
    expect(out.salt).toBe('cafe');
    expect(out.roles).toEqual(['reader', 'admin']);
    expect('password' in out).toBe(false);
  });

  it('buildUpdateDoc adds cleartext password only when a new one is staged', () => {
    const original = { _id: 'x', _rev: '1-a', name: 'bob', type: 'user', roles: [] };
    const out = buildUpdateDoc(original, { roles: [], newPassword: 'newpw' });
    expect(out.password).toBe('newpw');
  });

  it('maskDocForPreview hides a cleartext password but leaves other fields', () => {
    const masked = maskDocForPreview({ name: 'bob', password: 'secret', roles: [] });
    expect(masked.password).toBe(PASSWORD_MASK);
    expect(masked.name).toBe('bob');
    // does not mutate the input
    expect(masked).not.toHaveProperty('password', 'secret');
  });

  it('maskDocForPreview is a no-op when there is no password', () => {
    const doc = { name: 'bob', roles: [] };
    expect(maskDocForPreview(doc)).toEqual(doc);
  });
});
