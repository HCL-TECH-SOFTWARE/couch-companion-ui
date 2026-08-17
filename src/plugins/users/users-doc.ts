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

import type { UserDoc, UserDraft } from './types.js';

/** The `_users` system database name. */
export const USERS_DB = '_users';
/** CouchDB user-document id namespace prefix. */
export const USER_ID_PREFIX = 'org.couchdb.user:';
/** Placeholder shown instead of a cleartext password in the Raw preview. */
export const PASSWORD_MASK = '••••••';

export function buildUserId(name: string): string {
  return `${USER_ID_PREFIX}${name}`;
}

export function isUserDoc(doc: Record<string, unknown>): boolean {
  return !!doc && doc.type === 'user';
}

/** @returns an error message, or null when the username is valid. */
export function validateUsername(name: string): string | null {
  if (!name || !name.trim()) return 'Username is required.';
  if (name.startsWith('_')) return 'Username may not start with an underscore.';
  if (name !== name.toLowerCase()) return 'Username must be lowercase.';
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return 'Username may only contain letters, numbers, _ and - (no spaces).';
  }
  return null;
}

/** @returns an error message, or null when the role is valid. */
export function validateRole(role: string): string | null {
  if (!role || !role.trim()) return 'Role name is required.';
  if (role.startsWith('_') && role !== '_metrics') {
    return 'System roles (leading underscore) are not allowed, except _metrics.';
  }
  return null;
}

export function collectRoles(users: UserDoc[]): string[] {
  const set = new Set<string>();
  for (const u of users) {
    for (const r of u.roles ?? []) set.add(r);
  }
  return [...set].sort();
}

/**
 * Merge `_users`-derived candidate roles with roles harvested from database
 * `_security` objects. Security-derived roles must pass validateRole (drops
 * `_`-prefixed system roles such as `_admin`, keeps `_metrics`); user-derived
 * roles stay unfiltered, matching collectRoles behaviour. Distinct and sorted.
 */
export function mergeCandidateRoles(userRoles: string[], securityRoles: string[]): string[] {
  const set = new Set(userRoles);
  for (const r of securityRoles) {
    if (validateRole(r) === null) set.add(r);
  }
  return [...set].sort();
}

export function buildCreateDoc(draft: UserDraft): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    _id: buildUserId(draft.name),
    name: draft.name,
    type: 'user',
    roles: draft.roles ?? [],
  };
  if (draft.password) doc.password = draft.password;
  return doc;
}

export function buildUpdateDoc(
  original: Record<string, unknown>,
  changes: { roles: string[]; newPassword?: string },
): Record<string, unknown> {
  const doc: Record<string, unknown> = { ...original, roles: changes.roles };
  if (changes.newPassword) doc.password = changes.newPassword;
  return doc;
}

export function maskDocForPreview(doc: Record<string, unknown>): Record<string, unknown> {
  if (doc.password == null) return doc;
  return { ...doc, password: PASSWORD_MASK };
}
