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

/** CouchDB `_session` shapes — POST returns the flat form, GET the userCtx form. */
export interface SessionUserCtx {
  name: string | null;
  roles: string[];
}
export interface SessionResponse {
  ok?: boolean;
  name?: string | null;
  roles?: string[];
  userCtx?: SessionUserCtx;
}

/** Server-driven announcement banner. Empty object means no active banner. */
export interface Banner {
  message?: string;
  icon?: string;
  link?: string;
  /** ISO 8601 datetime; banner self-expires at this point. */
  until?: string;
}
