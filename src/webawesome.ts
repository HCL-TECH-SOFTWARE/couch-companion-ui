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

// Centralized WebAwesome side-effect imports loaded once at app startup.

// Must stay first: points the icon resolver at our local SVGs before any component loads (#741).
import './icons.js';

import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/breadcrumb-item/breadcrumb-item.js';
import '@awesome.me/webawesome/dist/components/breadcrumb/breadcrumb.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/checkbox/checkbox.js';
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/drawer/drawer.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/format-bytes/format-bytes.js';
import '@awesome.me/webawesome/dist/components/format-number/format-number.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/input/input.js';
import '@awesome.me/webawesome/dist/components/option/option.js';
import '@awesome.me/webawesome/dist/components/page/page.js';
import '@awesome.me/webawesome/dist/components/select/select.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/split-panel/split-panel.js';
import '@awesome.me/webawesome/dist/components/switch/switch.js';
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '@awesome.me/webawesome/dist/components/tab/tab.js';
import '@awesome.me/webawesome/dist/components/tab-group/tab-group.js';
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
// Styles. Every theme loads eagerly: each scopes its tokens to `.wa-theme-*`, so the class on
// <html> decides which one is in force (see services/theme-service.ts) and the active theme wins
// on specificity, not source order. Switching is then a class swap with no flash.
import '@awesome.me/webawesome/dist/styles/native.css';
import '@awesome.me/webawesome/dist/styles/themes/default.css';
import '@awesome.me/webawesome/dist/styles/themes/shoelace.css';
import '@awesome.me/webawesome/dist/styles/themes/awesome.css';
// Ours, not Web Awesome's, and it only overrides — it leans on default.css for every token it
// does not declare, so it has to come after it.
import './themes/enchanted.css';
import '@awesome.me/webawesome/dist/styles/webawesome.css';

// Self-hosted replacements for the fonts themes/awesome.css would otherwise fetch from
// fonts.bunny.net; the remote @import is stripped in vite.config.ts.
import '@fontsource-variable/quicksand/index.css';
import '@fontsource-variable/crimson-pro/index.css';
import '@fontsource-variable/crimson-pro/wght-italic.css';
import './styles/awesome-fonts.css';
