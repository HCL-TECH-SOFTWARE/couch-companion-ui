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

/** Payload of every `server-dashboard:<tile>:request` event. */
export interface DashboardRequest {
  serverId: string;
}

export const WELCOME_REQUEST = "server-dashboard:welcome:request";
export const WELCOME_DATA = "server-dashboard:welcome:data";
/**
 * Two sources, deliberately kept apart.
 *
 * `name`/`url`/`username`/`reachable`/`lastChecked` come from the stored server record and are
 * always available. `couchdb`/`uuid`/`gitSha`/`features`/`vendor` come from the server's live
 * `GET /` and are absent when it could not be reached — which is why they are optional and why
 * `liveError` exists: a down server still renders a useful tile from the record, rather than the
 * whole tile collapsing to an error.
 *
 * `version` is the one field both could supply. It carries the live value when we have it and
 * falls back to the record's `couch_version`, so an upgraded server reads correctly at once.
 */
export interface WelcomeData {
  serverId: string;
  name?: string;
  url?: string;
  username?: string;
  version?: string | null;
  reachable?: boolean;
  lastChecked?: string | null;
  /** The greeting from `GET /`, conventionally "Welcome". */
  couchdb?: string;
  uuid?: string;
  gitSha?: string;
  features?: string[];
  vendor?: string;
  /** Why the live `GET /` failed, when the stored record still loaded. */
  liveError?: string;
  /** The stored record itself could not be loaded — nothing to show. */
  error?: string;
}

export const STORAGE_REQUEST = "server-dashboard:storage:request";
export const STORAGE_DATA = "server-dashboard:storage:data";
export interface StorageData {
  serverId: string;
  dbCount?: number;
  docTotal?: number;
  storageBytes?: number;
  error?: string;
}

export const REPLICATIONS_REQUEST = "server-dashboard:replications:request";
export const REPLICATIONS_DATA = "server-dashboard:replications:data";
export interface ReplicationsData {
  serverId: string;
  continuousCount?: number;
  totalCount?: number;
  error?: string;
}

export const TASKS_REQUEST = "server-dashboard:tasks:request";
export const TASKS_DATA = "server-dashboard:tasks:data";
export interface TasksData {
  serverId: string;
  byType?: Record<string, number>;
  error?: string;
}

export const IDP_REQUEST = "server-dashboard:idp:request";
export const IDP_DATA = "server-dashboard:idp:data";
export interface IdpTileEntry {
  id: string;
  name: string;
  issuer: string;
}
export interface IdpData {
  serverId: string;
  idps?: IdpTileEntry[];
  error?: string;
}

/** Every request event name — used to refresh all tiles at once. */
export const ALL_REQUEST_EVENTS = [
  WELCOME_REQUEST,
  STORAGE_REQUEST,
  REPLICATIONS_REQUEST,
  TASKS_REQUEST,
  IDP_REQUEST,
] as const;
