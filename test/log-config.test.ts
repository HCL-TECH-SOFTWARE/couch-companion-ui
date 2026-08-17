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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger, Level } from '../src/services/log-service';
import { initLogConfig, LOG_LEVEL_STORAGE_KEY } from '../src/services/log-config';

describe('initLogConfig', () => {
  beforeEach(() => {
    Logger.setLevel(Level.ALL);
    localStorage.clear();
    history.replaceState({}, '', '/');
  });

  afterEach(() => {
    localStorage.clear();
    history.replaceState({}, '', '/');
    vi.unstubAllEnvs();
  });

  it('uses Vite-mode default DEBUG when DEV is true', () => {
    vi.stubEnv('DEV', true);
    initLogConfig();
    expect(Logger.getLevel()).toBe(Level.DEBUG);
  });

  it('uses Vite-mode default INFO when DEV is false', () => {
    vi.stubEnv('DEV', false);
    initLogConfig();
    expect(Logger.getLevel()).toBe(Level.INFO);
  });

  it('honours localStorage override over Vite default', () => {
    vi.stubEnv('DEV', false);
    localStorage.setItem(LOG_LEVEL_STORAGE_KEY, 'warn');
    initLogConfig();
    expect(Logger.getLevel()).toBe(Level.WARN);
  });

  it('URL query overrides localStorage and persists to localStorage', () => {
    vi.stubEnv('DEV', false);
    localStorage.setItem(LOG_LEVEL_STORAGE_KEY, 'warn');
    history.replaceState({}, '', '/?logLevel=trace');
    initLogConfig();
    expect(Logger.getLevel()).toBe(Level.TRACE);
    expect(localStorage.getItem(LOG_LEVEL_STORAGE_KEY)).toBe('trace');
  });

  it('reset clears localStorage and falls back to Vite default', () => {
    vi.stubEnv('DEV', true);
    localStorage.setItem(LOG_LEVEL_STORAGE_KEY, 'warn');
    history.replaceState({}, '', '/?logLevel=reset');
    initLogConfig();
    expect(Logger.getLevel()).toBe(Level.DEBUG);
    expect(localStorage.getItem(LOG_LEVEL_STORAGE_KEY)).toBeNull();
  });

  it('ignores unknown URL value and keeps localStorage / default', () => {
    vi.stubEnv('DEV', false);
    history.replaceState({}, '', '/?logLevel=bogus');
    initLogConfig();
    expect(Logger.getLevel()).toBe(Level.INFO);
  });

  it('accepts uppercase URL value', () => {
    vi.stubEnv('DEV', false);
    history.replaceState({}, '', '/?logLevel=ERROR');
    initLogConfig();
    expect(Logger.getLevel()).toBe(Level.ERROR);
  });
});
