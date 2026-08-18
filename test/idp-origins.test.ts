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
  idpConnectOrigins,
  releasableIdpOrigins,
  requiredIdpOrigins
} from '../src/services/idp-origins';

/**
 * The identity-provider side of the same problem (#149).
 *
 * The case that drives all of it is Google's, whose live discovery document splits the three
 * fetches a login makes across three hosts:
 *
 *     issuer          https://accounts.google.com
 *     jwks_uri        https://www.googleapis.com
 *     token_endpoint  https://oauth2.googleapis.com
 */
describe('idpConnectOrigins', () => {
  const GOOGLE = {
    well_known_url: 'https://accounts.google.com/.well-known/openid-configuration',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    token_endpoint: 'https://oauth2.googleapis.com/token'
  };

  it('collects all three hosts a login actually fetches from', () => {
    expect(idpConnectOrigins(GOOGLE)).toEqual([
      'https://accounts.google.com',
      'https://www.googleapis.com',
      'https://oauth2.googleapis.com'
    ]);
  });

  it('collapses a provider that serves everything from one host to one origin', () => {
    expect(
      idpConnectOrigins({
        well_known_url: 'https://sso.example.com/realms/x/.well-known/openid-configuration',
        jwks_uri: 'https://sso.example.com/realms/x/protocol/openid-connect/certs',
        token_endpoint: 'https://sso.example.com/realms/x/protocol/openid-connect/token'
      })
    ).toEqual(['https://sso.example.com']);
  });

  it('skips what it cannot parse rather than guessing an origin', () => {
    expect(
      idpConnectOrigins({ well_known_url: 'not a url', jwks_uri: null, token_endpoint: undefined })
    ).toEqual([]);
  });
});

describe('requiredIdpOrigins', () => {
  it('unions the stored origins across providers, keeping each once', () => {
    expect(
      requiredIdpOrigins([
        { csp_origins: ['https://a.example', 'https://shared.example'] },
        { csp_origins: ['https://shared.example', 'https://b.example'] }
      ])
    ).toEqual(['https://a.example', 'https://shared.example', 'https://b.example']);
  });

  /*
   * The pre-#149 entry. Its other two endpoints are unrecoverable without a network call from a
   * screen whose problem may be that the network is blocked, so it contributes the one origin it
   * can prove and a refresh fills in the rest.
   */
  it('falls back to the discovery origin for an entry stored before csp_origins existed', () => {
    expect(
      requiredIdpOrigins([
        { well_known_url: 'https://legacy.example.com/.well-known/openid-configuration' }
      ])
    ).toEqual(['https://legacy.example.com']);
  });

  it('treats the legacy null array as absent rather than crashing on it', () => {
    expect(
      requiredIdpOrigins([
        { csp_origins: null, well_known_url: 'https://legacy.example.com/.well-known/x' }
      ])
    ).toEqual(['https://legacy.example.com']);
  });
});

describe('releasableIdpOrigins', () => {
  const removed = { csp_origins: ['https://gone.example', 'https://shared.example'] };

  it('releases only what no remaining provider still needs', () => {
    expect(releasableIdpOrigins(removed, [{ csp_origins: ['https://shared.example'] }])).toEqual([
      'https://gone.example'
    ]);
  });

  it('releases everything when nothing is left', () => {
    expect(releasableIdpOrigins(removed, [])).toEqual([
      'https://gone.example',
      'https://shared.example'
    ]);
  });

  /* Two realms on one Keycloak: deleting the first must not lock the second out. */
  it('releases nothing when another provider shares every origin', () => {
    const realm = { csp_origins: ['https://sso.example.com'] };
    expect(releasableIdpOrigins(realm, [{ csp_origins: ['https://sso.example.com'] }])).toEqual([]);
  });
});
