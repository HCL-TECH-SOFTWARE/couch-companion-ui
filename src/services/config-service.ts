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

import type { ApiClient } from './api-client.js';
import type { NodeConfig } from '../plugins/config/types.js';

const seg = (s: string): string => encodeURIComponent(s);

/**
 * Reads and writes the local CouchDB node configuration
 * (Fauxton-equivalent), via the `/_node/_local/_config` endpoints.
 * @param api - shared ApiClient (token already set by AuthService)
 */
export class ConfigService {
  constructor(private api: ApiClient) {}

  /** Full node configuration, grouped by section. */
  async getConfig(_serverId: string): Promise<NodeConfig> {
    return this.api.request<NodeConfig>("GET", "/_node/_local/_config");
  }

  /**
   * One key's value, or `null` when the section or the key is absent.
   *
   * A missing key 404s, which is the ordinary answer for an optional setting that nobody has
   * written — `[oidc] log`, for instance, whose absence means "off" (#32). Resolving that to
   * `null` keeps the caller from having to tell a missing key apart from a failed read.
   */
  async getConfigValue(_serverId: string, section: string, key: string): Promise<string | null> {
    try {
      return await this.api.request<string>(
        "GET",
        `/_node/_local/_config/${seg(section)}/${seg(key)}`,
      );
    } catch {
      return null;
    }
  }

  /**
   * Writes one key. CouchDB's config API takes the value as a bare JSON string
   * body and answers with the PREVIOUS value (empty string when there was
   * none), which the caller surfaces in its "changed from … to …" toast.
   */
  async setConfigValue(_serverId: string, section: string, key: string, value: string): Promise<string> {
    const previous = await this.api.request<string>(
      "PUT",
      `/_node/_local/_config/${seg(section)}/${seg(key)}`,
      value,
    );
    return previous ?? "";
  }

  /*
   * Node-scoped twins of the `_local` methods above.
   *
   * `_local` resolves to whichever node happened to serve the request, so a comparison view built
   * on it renders N identical columns — which reads as "the cluster agrees" instead of showing the
   * disagreement it was meant to expose (#73). Addressing nodes by name is the only way to read
   * each one's own configuration.
   *
   * Erlang node names contain an `@`, and percent-encoding it is safe: verified live against
   * CouchDB 3.5.2 on a real 3-node cluster, `_node/couchdb%40couchdb3.ccui.local/_config` and
   * `_node/couchdb@couchdb3.ccui.local/_config` behave identically on both GET and PUT. Hence the
   * plain `seg()` below, same as every other path segment here.
   */

  /** Full configuration of one named cluster node, grouped by section. */
  async getNodeConfig(node: string): Promise<NodeConfig> {
    return this.api.request<NodeConfig>("GET", `/_node/${seg(node)}/_config`);
  }

  /**
   * Writes one key on one named cluster node. Like {@link setConfigValue}, the value travels as a
   * bare JSON string body and CouchDB answers with the PREVIOUS value (empty string when none).
   */
  async setNodeConfigValue(node: string, section: string, key: string, value: string): Promise<string> {
    const previous = await this.api.request<string>(
      "PUT",
      `/_node/${seg(node)}/_config/${seg(section)}/${seg(key)}`,
      value,
    );
    return previous ?? "";
  }

  /** Removes a single configuration key. */
  async deleteConfigValue(_serverId: string, section: string, key: string): Promise<void> {
    await this.api.request<void>("DELETE", `/_node/_local/_config/${seg(section)}/${seg(key)}`);
  }

  /** Restarts the local node — the only way a changed authentication handler takes effect. */
  async restartNode(_serverId: string): Promise<void> {
    await this.api.request<void>("POST", "/_node/_local/_restart");
  }
}
