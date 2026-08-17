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
 * JWKS → PEM, in the browser.
 *
 * CouchDB's `[jwt_keys]` wants an SPKI PEM per signing key; an IdP's JWKS endpoint serves
 * JWKs. The parent product bridged that gap server-side, which is why `JwkKey` (the stored
 * shape in `plugins/idp/types.ts`) carries an already-converted `value` and no key material.
 * Backend-less, the conversion has to happen here.
 *
 * `scripts/jwks-to-pem.mjs` does the same job in Node for `seed-dev.sh`. The two must agree
 * byte-for-byte — `test/jwk-to-pem.test.ts` pins this converter against that script's real
 * output for the devcontainer Keycloak key, because a PEM CouchDB already accepts is the
 * only definition of correct here.
 */

/** One entry of an IdP's JWKS, as served. Not the stored {@link JwkKey}, which holds a PEM. */
export interface RsaJwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

/** RSA keys usable for signature verification — `use: "sig"`, or no `use` at all (RFC 7517 §4.2
 *  makes it optional, and Keycloak omits it on some realm configurations). */
export function signingKeys<T extends { kty: string; use?: string }>(keys: T[]): T[] {
  return keys.filter((k) => k.kty === 'RSA' && (!k.use || k.use === 'sig'));
}

/** RSASSA-PKCS1-v1_5 digest for a JWS `alg`. The exported SPKI is digest-independent, but
 *  `importKey` validates the pair, so a declared RS384/RS512 key must be imported as such. */
function digestFor(alg: string | undefined): string {
  if (alg === 'RS384') return 'SHA-384';
  if (alg === 'RS512') return 'SHA-512';
  return 'SHA-256';
}

function base64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Converts one RSA JWK to an SPKI PEM, trailing newline included — exactly what
 * `openssl`/`node:crypto` emit, so the string can be compared against either.
 *
 * @throws if the key is not RSA, or if its `n`/`e` do not import
 */
export async function jwkToSpkiPem(jwk: RsaJwk): Promise<string> {
  if (jwk.kty !== 'RSA') {
    throw new Error(`Not an RSA key: kty=${jwk.kty} (kid=${jwk.kid})`);
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: digestFor(jwk.alg) },
    true,
    ['verify'],
  );

  const body = base64(await crypto.subtle.exportKey('spki', key));
  const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Renders a value safe for a CouchDB `_config` PUT.
 *
 * CouchDB rejects config values containing literal newline bytes (apache/couchdb#5091); it
 * wants line breaks as the two-character escape `\n`. Applied at the config-write edge only —
 * {@link jwkToSpkiPem} returns a real PEM, because every other consumer (display, download,
 * comparison against `openssl`) wants real newlines.
 */
export function escapeForCouchConfig(value: string): string {
  return value.replace(/\n/g, '\\n');
}

/**
 * The inverse of {@link escapeForCouchConfig}, for reading a stored value back.
 *
 * `[jwt_keys]` is the only place an applied signing key survives now that IdP metadata lives in
 * `[oidc]` (#32), so the PEM shown on the detail screen is read out of CouchDB rather than kept
 * in a second copy — and it comes back exactly as it was written, with the line breaks still
 * escaped.
 */
export function unescapeFromCouchConfig(value: string): string {
  return value.replace(/\\n/g, '\n');
}
