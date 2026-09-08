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

// The sessionStorage keys holding the session token and username. Naming either of them outside
// AuthService means authentication logic has leaked out of the service that owns it — the thing
// #678 exists to stop.
//
// This matches the string LITERAL rather than a storage call, so a `const TOKEN_KEY = 'cca_token'`
// alias does not slip through: wherever the name is written down, it is reported. auth-service.ts
// is the sanctioned exception, declared in .oxlintrc.json.
//
// Was `no-restricted-syntax` with a `Literal[value='cca_token']` selector under ESLint. oxlint
// does not implement that rule, so the selector became this. Same two names, same two messages.

/**
 * The session keys AuthService owns, each with the fix a caller should reach for instead.
 *
 * A Map, not an object literal: the lookup key is whatever literal the linted file contains, so a
 * plain object would resolve `'toString'`, `'constructor'` and friends through Object.prototype
 * and report them as session keys. cca-element.ts has literals that do exactly that.
 */
const SESSION_KEYS = new Map([
  [
    'cca_token',
    "The session token is AuthService's to hold. Read it via ctx.auth, or let ApiClient attach " +
      'it for you. See #678.',
  ],
  [
    'cca_user',
    'Read the current username from ctx.auth.state.username, not sessionStorage. See #678.',
  ],
]);

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow naming the session storage keys outside AuthService, which owns the JWT lifecycle.',
    },
    schema: [],
    messages: {
      sessionKey: '{{detail}}',
    },
  },

  create(context) {
    return {
      Literal(node) {
        const detail = SESSION_KEYS.get(node.value);
        if (detail === undefined) return;

        context.report({ node, messageId: 'sessionKey', data: { detail } });
      },
    };
  },
};

export default rule;
