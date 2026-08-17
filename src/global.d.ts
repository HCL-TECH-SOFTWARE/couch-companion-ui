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

/// <reference types="vite/client" />

declare module "*.css";

declare module "*?worker" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

/*
 * The eight deep paths in src/monaco-registrations.ts. Monaco ships `.d.ts` files beside its
 * published entry points — `features/<x>/register`, `languages/.../register`, `editor` — but not
 * beside the internal modules `esm/vs/index.js` also imports and no feature register covers. They
 * are side-effect imports with nothing to type; `monaco-editor/editor` itself is fully typed and
 * does not match this pattern. monaco-imports.ts resolves each one at build time, so a typo or an
 * upstream move fails there rather than passing silently through this declaration.
 */
declare module "monaco-editor/editor/*";

declare module "@awesome.me/webawesome/dist/components/button/button.js";
declare module "@awesome.me/webawesome/dist/components/badge/badge.js";
declare module "@awesome.me/webawesome/dist/components/card/card.js";
declare module "@awesome.me/webawesome/dist/components/divider/divider.js";
declare module "@awesome.me/webawesome/dist/components/input/input.js";
declare module "@awesome.me/webawesome/dist/components/spinner/spinner.js";
declare module "@awesome.me/webawesome/dist/components/select/select.js";
declare module "@awesome.me/webawesome/dist/components/option/option.js";
