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

// Deliberately minimal. No shared preset — the repo had no ESLint at all, and switching on
// eslint:recommended / typescript-eslint here would surface a large pre-existing backlog and bury
// the guardrails below. Preset adoption is #703; linting test/ is #704.
//
// The rules encode one architectural rule: component -> service -> ApiClient -> network.
// Nothing may skip a layer. `no-restricted-globals` stops a component reaching the network;
// `SERVICE_LAYER_ONLY` stops it reaching ApiClient; `SESSION_KEY_LITERALS` stops it reaching the
// session token.
//
// Two kinds of exemption, and the difference matters:
//
//   * PERMANENT — declared at the bottom of this file. api-client.ts is the only sanctioned
//     HTTP boundary; log-service.ts is the only sanctioned console; auth-service.ts is the
//     only place the session storage keys may be named. These are intentional, not debt.
//
//   * TEMPORARY — an `eslint-disable` comment in the offending file, tagged with the issue
//     that will remove it. `reportUnusedDisableDirectives: "error"` means that once the last
//     violation in a file is migrated, the now-pointless directive itself fails the lint. The
//     ratchet cleans up after itself. `grep -rl "eslint-disable no-restricted" src/` is the
//     progress bar for #678; empty means done.

import globals from 'globals';
import tseslint from 'typescript-eslint';
import maxTernaryLines from './eslint-rules/max-ternary-lines.js';
import noCcaCustomProperty from './eslint-rules/no-cca-custom-property.js';
import noHardcodedTypography from './eslint-rules/no-hardcoded-typography.js';
import noUndefinedWaToken from './eslint-rules/no-undefined-wa-token.js';

/** The network primitives that must not be reached for outside ApiClient. See #678. */
const NETWORK_GLOBALS = [
  {
    name: 'fetch',
    message:
      'Do not call fetch directly. Go through a service (ctx.<service>), which owns an ApiClient. ' +
      'ApiClient attaches the bearer token and handles 401 -> logout centrally. See #678.',
  },
  {
    name: 'XMLHttpRequest',
    message: 'Do not use XMLHttpRequest. Go through a service, which owns an ApiClient. See #678.',
  },
  {
    // No WebSocket transport exists in this app today — reachability moved to polling
    // (see reachability-status-service.ts). The rule stays live as a guard: it fires on
    // value references only (a type position like `let x: WebSocket` is not reported),
    // which is intended, since holding e.g. readyState constants means holding a socket.
    name: 'WebSocket',
    message:
      'Do not reference the WebSocket global. No WebSocket transport exists in this app; ' +
      'the polling services cover live status. If one is ever needed again, add a ' +
      'dedicated sanctioned boundary file first. See #690.',
  },
];

/**
 * The sessionStorage keys holding the session token and username. Naming either of them outside
 * AuthService means authentication logic has leaked out of the service that owns it — the thing
 * #678 exists to stop. Catches the string literal, so a `const TOKEN_KEY = 'cca_token'` alias
 * does not slip through.
 */
const SESSION_KEY_LITERALS = [
  {
    selector: "Literal[value='cca_token']",
    message:
      "The session token is AuthService's to hold. Read it via ctx.auth, or let ApiClient attach " +
      'it for you. See #678.',
  },
  {
    selector: "Literal[value='cca_user']",
    message: 'Read the current username from ctx.auth.state.username, not sessionStorage. See #678.',
  },
];

/**
 * `ApiClient.request()` became public in #683, which removed 55 `this.api['request'](…)` hacks.
 * Public, but not public to everyone: the layering is component -> service -> ApiClient. A
 * component reaching past its service and calling `ctx.api.request(...)` is the same architectural
 * break as calling `fetch` directly, and would otherwise now typecheck.
 */
const SERVICE_LAYER_ONLY = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name=/^request(WithHeaders)?$/]",
    message:
      'Only services may call ApiClient.request()/requestWithHeaders(). Components go through a ' +
      'service (ctx.<service>). See #678.',
  },
];

/**
 * `request()` was `private` until #683, and seven services defeated the modifier with string-index
 * access — which TypeScript does not enforce and the runtime does not enforce at all. It is public
 * now, so there is no motive; this makes sure the habit does not come back for the next `private`.
 */
const NO_BRACKET_ACCESS = [
  {
    selector: "MemberExpression[computed=true][property.value=/^request(WithHeaders)?$/]",
    message:
      "Call api.request(...) directly. Bracket access was a workaround for `private` and is no " +
      'longer needed. See #683.',
  },
];

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: globals.browser,
    },
    linterOptions: {
      // A stale `eslint-disable` is an error, not a warning. This is what makes the
      // temporary exemptions above self-cleaning.
      reportUnusedDisableDirectives: 'error',
    },
    plugins: {
      cca: {
        rules: {
          'no-undefined-wa-token': noUndefinedWaToken,
          'no-cca-custom-property': noCcaCustomProperty,
          'no-hardcoded-typography': noHardcodedTypography,
          'max-ternary-lines': maxTernaryLines,
        },
      },
    },
    rules: {
      // A --wa- token the theme never declares renders as the guaranteed-invalid value: the
      // declaration is dropped, or a colour silently becomes currentcolor. See #718, and #580
      // for what it looks like in production.
      'cca/no-undefined-wa-token': 'error',
      // The sibling rule. Web Awesome's tokens are the only palette: the retired --cca- ones
      // were light-mode literals that ignored wa-dark. See #729.
      'cca/no-cca-custom-property': 'error',
      // Typography literals sever the only path a theme switch has into a shadow root; text
      // must derive from the --wa- font tokens. See #774.
      'cca/no-hardcoded-typography': 'error',
      // A smell, not a defect, so it warns rather than fails the build — and there is a
      // pre-existing backlog nobody has agreed to pay down yet. Raise to 'error' once it is zero.
      'cca/max-ternary-lines': ['warn', { maxLines: 10 }],
      'no-console': 'error',
      'no-restricted-globals': ['error', ...NETWORK_GLOBALS],
      'no-restricted-syntax': [
        'error',
        ...SESSION_KEY_LITERALS,
        ...SERVICE_LAYER_ONLY,
        ...NO_BRACKET_ACCESS,
      ],
    },
  },

  // ── Permanent exemptions ────────────────────────────────────────────────────
  // `no-restricted-syntax` replaces its options wholesale rather than merging, so each block
  // below restates every selector it still wants. Later blocks win; order matters.
  {
    // The sanctioned HTTP boundary. The whole point of the rule is that this is the only file.
    files: ['src/services/api-client.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // The second sanctioned HTTP boundary — foreign origins only. Separate from api-client.ts
    // because GitHub's wildcard CORS header is invalid in credentialed mode, and because a
    // GitHub 401 must not trigger the CouchDB logout. See the file's own header comment.
    files: ['src/services/git/git-http.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // The third sanctioned HTTP boundary — identity providers only. Separate from api-client.ts
    // because an IdP 401 must not trigger the CouchDB logout, because the base URL is
    // per-request, and because it must never send credentials. See the file's own header.
    files: ['src/services/oidc-http.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // The logging facade every other module is required to use.
    files: ['src/services/log-service.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Services are the layer allowed to speak to ApiClient. They still may not name the session
    // keys, and still may not reach for `private` members through bracket access.
    files: ['src/services/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...SESSION_KEY_LITERALS, ...NO_BRACKET_ACCESS],
    },
  },
  {
    // Owns the JWT lifecycle, so it owns the storage keys. Being a service, it may call request().
    files: ['src/services/auth-service.ts'],
    rules: { 'no-restricted-syntax': ['error', ...NO_BRACKET_ACCESS] },
  },
];
