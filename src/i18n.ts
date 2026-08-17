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

export type Direction = 'ltr' | 'rtl';
export type Locale = 'en-US' | 'ar-SA';

export interface LocaleChangedDetail {
  locale?: string;
  direction?: Direction;
  messages?: Record<string, string>;
}

const DEFAULT_LOCALE: Locale = 'en-US';
const DEFAULT_DIRECTION: Direction = 'ltr';

let currentLocale: Locale = DEFAULT_LOCALE;
let currentDirection: Direction = DEFAULT_DIRECTION;
let currentMessages: Record<string, string> = {};
const localeMessageCache: Partial<Record<Locale, Record<string, string>>> = {};

const PLACEHOLDER_PATTERN = /\{\s*\$(\w+)\s*\}/g;

const normalizeLocale = (value?: string): Locale => {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'ar' || normalized === 'ar-sa') {
    return 'ar-SA';
  }
  return 'en-US';
};

const isRtlLocale = (value?: string): boolean => {
  return normalizeLocale(value) === 'ar-SA';
};

const sanitizeMessages = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const source = value as Record<string, unknown>;
  const next: Record<string, string> = {};

  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw === 'string') {
      next[key] = raw;
    }
  }

  return next;
};

export const applyLocaleDetail = (detail: unknown): void => {
  if (!detail || typeof detail !== 'object') {
    return;
  }

  const payload = detail as LocaleChangedDetail;
  currentLocale = normalizeLocale(payload.locale);
  const inferredDirection: Direction = isRtlLocale(currentLocale) ? 'rtl' : 'ltr';
  currentDirection = payload.direction === 'rtl' || payload.direction === 'ltr'
    ? payload.direction
    : inferredDirection;

  const incomingMessages = sanitizeMessages(payload.messages);
  const hasIncomingMessages = Object.keys(incomingMessages).length > 0;

  if (hasIncomingMessages) {
    localeMessageCache[currentLocale] = incomingMessages;
    currentMessages = incomingMessages;
    return;
  }

  const cachedMessages = localeMessageCache[currentLocale];
  if (cachedMessages) {
    currentMessages = cachedMessages;
  }
};

export const translate = (
  key: string,
  fallback: string,
  variables?: Record<string, string | number>
): string => {
  const template = currentMessages[key] ?? fallback;
  if (!variables) {
    return template;
  }

  return template.replace(PLACEHOLDER_PATTERN, (_match, variableName: string) => {
    const value = variables[variableName];
    return value === undefined ? '' : String(value);
  });
};

export const getLocale = (): Locale => {
  return currentLocale;
};

export const getDirection = (): Direction => {
  return currentDirection;
};

export const isRtl = (): boolean => {
  return currentDirection === 'rtl';
};
