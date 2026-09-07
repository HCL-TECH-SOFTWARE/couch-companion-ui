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

// `ApiClient.request()` became public in #683, which removed 55 `this.api['request'](…)` hacks.
// Public, but not public to everyone: the layering is component -> service -> ApiClient. A
// component reaching past its service and calling `ctx.api.request(...)` is the same architectural
// break as calling `fetch` directly, and would otherwise now typecheck.
//
// Services are the layer allowed to speak to ApiClient, so `src/services/**` turns this rule off
// in .oxlintrc.json. Everything else — components, plugins — goes through a service.
//
// Was a `no-restricted-syntax` selector under ESLint. Matching the CALL rather than the member
// access is deliberate: passing the method around as a value (`const r = api.request`) is rare
// enough not to be worth the false positives, and the call is where the layering actually breaks.

/** `request` and `requestWithHeaders` are the two entry points ApiClient exposes. */
const REQUEST_METHODS = /^request(WithHeaders)?$/;

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow calling ApiClient.request()/requestWithHeaders() outside the service layer.',
    },
    schema: [],
    messages: {
      serviceLayerOnly:
        'Only services may call ApiClient.request()/requestWithHeaders(). Components go through a ' +
        'service (ctx.<service>). See #678.',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (!REQUEST_METHODS.test(callee.property.name ?? '')) return;

        context.report({ node, messageId: 'serviceLayerOnly' });
      },
    };
  },
};

export default rule;
