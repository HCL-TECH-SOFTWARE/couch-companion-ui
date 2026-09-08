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

// `request()` was `private` until #683, and seven services defeated the modifier with string-index
// access — which TypeScript does not enforce and the runtime does not enforce at all. It is public
// now, so there is no motive; this makes sure the habit does not come back for the next `private`.
//
// This one has no exemptions. Even auth-service.ts, which is excused from the session-key rule
// because it owns the JWT lifecycle, has no reason to reach through a bracket.
//
// Was a `no-restricted-syntax` selector under ESLint. It reads `property.value` rather than
// `property.name` because a computed member's property is a string Literal, not an Identifier.

/** `request` and `requestWithHeaders` are the two entry points ApiClient exposes. */
const REQUEST_METHODS = /^request(WithHeaders)?$/;

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reaching ApiClient methods through bracket access, a workaround for `private`.',
    },
    schema: [],
    messages: {
      bracketAccess:
        'Call api.request(...) directly. Bracket access was a workaround for `private` and is no ' +
        'longer needed. See #683.',
    },
  },

  create(context) {
    return {
      MemberExpression(node) {
        if (!node.computed) return;
        if (!REQUEST_METHODS.test(node.property.value ?? '')) return;

        context.report({ node, messageId: 'bracketAccess' });
      },
    };
  },
};

export default rule;
