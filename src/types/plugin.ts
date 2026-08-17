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

/** Describes a plugin's routes, navigation, and entry point so the shell can register and lazy-load it. */
export interface FrontendManifest {
  name: string;
  version: string;
  routes: PluginRoute[];
  nav_items: NavItem[];
  extension_points: ExtensionPoint[];
}

/** Maps a URL path to the custom element that renders it. */
export interface PluginRoute {
  path: string;
  component: string;
  allows_all_servers?: boolean;
}

/** Sidebar navigation entry — order determines position in the nav list. */
export interface NavItem {
  label: string;
  path: string;
  icon: string | null;
  order: number;
}

/** Allows a plugin to inject a component into a named slot of another component. */
export interface ExtensionPoint {
  target: string;
  component: string;
}