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

// Fetches a JWKS and prints one line per RSA signing key:
//   <kid>\t<JSON-encoded SPKI PEM>
// CouchDB's _config PUT rejects values containing literal newline bytes
// (apache/couchdb#5091): it wants the PEM's line breaks stored as the
// literal two-character escape "\n", not an actual 0x0A byte. Plain
// JSON.stringify() on a real multi-line string does NOT produce that --
// a JSON parser decodes \n back into a real newline -- so the newlines
// are converted to literal backslash-n *before* JSON-encoding, which
// makes JSON.stringify double-escape the backslash and preserve it as
// text through the round trip.
import { createPublicKey } from 'node:crypto';

const [url] = process.argv.slice(2);
if (!url) {
  console.error('usage: node jwks-to-pem.mjs <jwks-url>');
  process.exit(1);
}
const jwks = await (await fetch(url)).json();
for (const jwk of jwks.keys ?? []) {
  if (jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig')) continue;
  const pem = createPublicKey({ key: jwk, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' })
    .toString()
    .replace(/\n/g, '\\n');
  process.stdout.write(`${jwk.kid}\t${JSON.stringify(pem)}\n`);
}
