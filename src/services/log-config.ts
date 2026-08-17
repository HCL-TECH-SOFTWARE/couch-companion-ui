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

import { Logger, Level } from './log-service';

export const LOG_LEVEL_STORAGE_KEY = 'ccaLogLevel';
const URL_PARAM = 'logLevel';
const RESET = 'reset';

const NAME_TO_LEVEL: Record<string, number> = {
  all: Level.ALL,
  trace: Level.TRACE,
  debug: Level.DEBUG,
  info: Level.INFO,
  warn: Level.WARN,
  error: Level.ERROR,
  fatal: Level.FATAL,
  off: Level.OFF,
};

const parseLevel = (raw: string | null | undefined): number | undefined => {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  return NAME_TO_LEVEL[key];
};

const defaultLevel = (): number =>
  import.meta.env.DEV ? Level.DEBUG : Level.INFO;

/**
 * Resolve the active log level from (priority order):
 *   1. URL query `?logLevel=<name|reset>` (also persisted to localStorage)
 *   2. localStorage `ccaLogLevel`
 *   3. Vite mode default (`DEBUG` in dev, `INFO` in prod)
 *
 * Safe to call multiple times.
 */
export const initLogConfig = (): void => {
  const params = new URLSearchParams(window.location.search);
  const urlRaw = params.get(URL_PARAM);

  if (urlRaw) {
    if (urlRaw.toLowerCase() === RESET) {
      localStorage.removeItem(LOG_LEVEL_STORAGE_KEY);
      Logger.setLevel(defaultLevel());
      return;
    }
    const fromUrl = parseLevel(urlRaw);
    if (fromUrl !== undefined) {
      localStorage.setItem(LOG_LEVEL_STORAGE_KEY, urlRaw.toLowerCase());
      Logger.setLevel(fromUrl);
      return;
    }
  }

  const fromStorage = parseLevel(localStorage.getItem(LOG_LEVEL_STORAGE_KEY));
  if (fromStorage !== undefined) {
    Logger.setLevel(fromStorage);
    return;
  }

  Logger.setLevel(defaultLevel());
};
