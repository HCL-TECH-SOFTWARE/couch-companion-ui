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

// The `cca` plugin, loaded by .oxlintrc.json via `jsPlugins`. Rule names here are what the config
// switches on and off: `cca/<key>`.
//
// The first four rules catch mistakes that are invisible in review and loud in production. The
// last three encode one architectural rule: component -> service -> ApiClient -> network, and
// nothing may skip a layer. `no-restricted-globals` (built into oxlint) stops a component reaching
// the network; `service-layer-only` stops it reaching ApiClient; `no-session-key-literals` stops
// it reaching the session token.

import maxTernaryLines from './max-ternary-lines.js';
import noBracketRequestAccess from './no-bracket-request-access.js';
import noCcaCustomProperty from './no-cca-custom-property.js';
import noHardcodedTypography from './no-hardcoded-typography.js';
import noSessionKeyLiterals from './no-session-key-literals.js';
import noUndefinedWaToken from './no-undefined-wa-token.js';
import serviceLayerOnly from './service-layer-only.js';

export default {
  meta: { name: 'cca' },
  rules: {
    'max-ternary-lines': maxTernaryLines,
    'no-bracket-request-access': noBracketRequestAccess,
    'no-cca-custom-property': noCcaCustomProperty,
    'no-hardcoded-typography': noHardcodedTypography,
    'no-session-key-literals': noSessionKeyLiterals,
    'no-undefined-wa-token': noUndefinedWaToken,
    'service-layer-only': serviceLayerOnly,
  },
};
