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

/** The companion server's internal database that holds app config docs. */
export const BANNER_DB = 'couchcompanion';
/** The `_id` of the document holding the banner array. */
export const BANNER_DOC_ID = 'BannerMessages';

/** A single announcement entry stored in the `banners` array. */
export interface BannerEntry {
  /** Required announcement text. */
  message: string;
  /** Optional Web Awesome icon name, e.g. "circle-info". */
  icon?: string;
  /** Optional absolute URL; opens in a new tab on the display side. */
  link?: string;
  /** RFC 3339 datetime at which the banner self-expires. Required. */
  until: string;
}

/** The `BannerMessages` document shape (CouchDB metadata + the banner array). */
export interface BannerMessagesDoc {
  _id?: string;
  _rev?: string;
  banners: BannerEntry[];
  [key: string]: unknown;
}
