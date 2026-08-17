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

import { describe, it, expect } from 'vitest';
import { applyLocaleDetail, translate, getLocale, getDirection, isRtl } from '../src/i18n';

describe('i18n', () => {
  it('applies en-US as ltr', () => {
    applyLocaleDetail({ locale: 'en-US' });
    expect(getLocale()).toBe('en-US');
    expect(getDirection()).toBe('ltr');
    expect(isRtl()).toBe(false);
  });

  it('normalizes "ar" and "ar-SA" to ar-SA with rtl direction', () => {
    applyLocaleDetail({ locale: 'ar' });
    expect(getLocale()).toBe('ar-SA');
    expect(getDirection()).toBe('rtl');
    expect(isRtl()).toBe(true);
    applyLocaleDetail({ locale: 'ar-SA' });
    expect(getLocale()).toBe('ar-SA');
  });

  it('falls back to en-US for an unknown locale', () => {
    applyLocaleDetail({ locale: 'zz-ZZ' });
    expect(getLocale()).toBe('en-US');
  });

  it('honours an explicit direction override', () => {
    applyLocaleDetail({ locale: 'en-US', direction: 'rtl' });
    expect(getDirection()).toBe('rtl');
  });

  it('ignores a non-object detail', () => {
    applyLocaleDetail({ locale: 'ar-SA' });
    applyLocaleDetail(undefined);
    expect(getLocale()).toBe('ar-SA');
  });

  it('ignores a truthy non-object detail', () => {
    applyLocaleDetail({ locale: 'ar-SA' });
    applyLocaleDetail('not-an-object' as unknown);
    expect(getLocale()).toBe('ar-SA');
  });

  it('translate returns the fallback when the key is missing', () => {
    applyLocaleDetail({ locale: 'en-US', messages: { greeting: 'Hi' } });
    expect(translate('nope', 'Fallback')).toBe('Fallback');
  });

  it('translate substitutes {$var} placeholders', () => {
    applyLocaleDetail({ locale: 'en-US', messages: { greet: 'Hello {$name}' } });
    expect(translate('greet', 'x', { name: 'World' })).toBe('Hello World');
  });

  it('translate renders an empty string for a missing variable', () => {
    applyLocaleDetail({ locale: 'en-US', messages: { greet: 'Hello {$name}' } });
    expect(translate('greet', 'x', {})).toBe('Hello ');
  });

  it('reuses cached messages when a later switch omits messages', () => {
    applyLocaleDetail({ locale: 'ar-SA', messages: { hi: 'مرحبا' } });
    expect(translate('hi', 'x')).toBe('مرحبا');
    applyLocaleDetail({ locale: 'en-US', messages: { hi: 'Hello' } });
    applyLocaleDetail({ locale: 'ar-SA' });
    expect(translate('hi', 'x')).toBe('مرحبا');
  });

  it('ignores non-string message values', () => {
    applyLocaleDetail({ locale: 'en-US', messages: { ok: 'yes', bad: 123 as unknown as string } });
    expect(translate('ok', 'x')).toBe('yes');
    expect(translate('bad', 'fallback')).toBe('fallback');
  });
});
