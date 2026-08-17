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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, Level, getLogger } from '../src/services/log-service';

describe('Level constants', () => {
  it('defines expected log levels in ascending order', () => {
    expect(Level.ALL).toBe(0);
    expect(Level.TRACE).toBe(1);
    expect(Level.DEBUG).toBe(2);
    expect(Level.INFO).toBe(3);
    expect(Level.WARN).toBe(4);
    expect(Level.ERROR).toBe(5);
    expect(Level.FATAL).toBe(6);
    expect(Level.OFF).toBe(7);
  });
});

describe('Logger', () => {
  const targets: Record<number, ReturnType<typeof vi.fn>> = {};
  let savedTargets: typeof Logger.logTarget;

  beforeEach(() => {
    // Save original targets and install spies
    savedTargets = { ...Logger.logTarget };
    Logger.setLevel(Level.ALL);
    for (const lvl of [Level.TRACE, Level.DEBUG, Level.INFO, Level.WARN, Level.ERROR, Level.FATAL]) {
      targets[lvl] = vi.fn();
      Logger.logTarget[lvl] = targets[lvl];
    }
  });

  afterEach(() => {
    // Restore original log targets
    Logger.logTarget = savedTargets;
    Logger.setLevel(Level.ALL);
    vi.restoreAllMocks();
  });

  describe('setLevel / getLevel', () => {
    it('sets and gets a valid level', () => {
      Logger.setLevel(Level.WARN);
      expect(Logger.getLevel()).toBe(Level.WARN);
    });

    it('rejects invalid level and keeps the current one', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      Logger.setLevel(Level.ERROR);
      Logger.setLevel(99);
      expect(Logger.getLevel()).toBe(Level.ERROR);
      warnSpy.mockRestore();
    });
  });

  describe('log methods respect level threshold', () => {
    it('trace logs when level is ALL', () => {
      Logger.trace('test');
      expect(targets[Level.TRACE]).toHaveBeenCalledWith('test');
    });

    it('trace does not log when level is INFO', () => {
      Logger.setLevel(Level.INFO);
      Logger.trace('test');
      expect(targets[Level.TRACE]).not.toHaveBeenCalled();
    });

    it('debug logs when level is DEBUG', () => {
      Logger.setLevel(Level.DEBUG);
      Logger.debug('msg');
      expect(targets[Level.DEBUG]).toHaveBeenCalledWith('msg');
    });

    it('info logs when level is INFO', () => {
      Logger.setLevel(Level.INFO);
      Logger.info('msg');
      expect(targets[Level.INFO]).toHaveBeenCalledWith('msg');
    });

    it('log delegates to info', () => {
      Logger.setLevel(Level.INFO);
      Logger.log('msg');
      expect(targets[Level.INFO]).toHaveBeenCalledWith('msg');
    });

    it('warn logs when level is WARN', () => {
      Logger.setLevel(Level.WARN);
      Logger.warn('msg');
      expect(targets[Level.WARN]).toHaveBeenCalledWith('msg');
    });

    it('error logs when level is ERROR', () => {
      Logger.setLevel(Level.ERROR);
      Logger.error('msg');
      expect(targets[Level.ERROR]).toHaveBeenCalledWith('msg');
    });

    it('fatal prefixes message with FATAL:', () => {
      Logger.fatal('crash');
      expect(targets[Level.FATAL]).toHaveBeenCalledWith('FATAL: crash');
    });

    it('nothing logs when level is OFF', () => {
      Logger.setLevel(Level.OFF);
      Logger.trace('a');
      Logger.debug('b');
      Logger.info('c');
      Logger.warn('d');
      Logger.error('e');
      Logger.fatal('f');
      for (const spy of Object.values(targets)) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });

  describe('log methods accept structured context', () => {
    it('error passes context object as second arg', () => {
      const err = new Error('boom');
      Logger.error('failed', err);
      expect(targets[Level.ERROR]).toHaveBeenCalledWith('failed', err);
    });

    it('warn passes plain object context', () => {
      Logger.warn('odd state', { id: 42 });
      expect(targets[Level.WARN]).toHaveBeenCalledWith('odd state', { id: 42 });
    });

    it('info called without context still invokes target with single arg', () => {
      Logger.info('hi');
      expect(targets[Level.INFO]).toHaveBeenCalledWith('hi');
    });

    it('debug passes context when provided', () => {
      Logger.debug('state', { foo: 'bar' });
      expect(targets[Level.DEBUG]).toHaveBeenCalledWith('state', { foo: 'bar' });
    });

    it('trace passes context when provided', () => {
      Logger.trace('walk', { step: 1 });
      expect(targets[Level.TRACE]).toHaveBeenCalledWith('walk', { step: 1 });
    });

    it('fatal prefixes message and still forwards context', () => {
      const err = new Error('boom');
      Logger.fatal('crash', err);
      expect(targets[Level.FATAL]).toHaveBeenCalledWith('FATAL: crash', err);
    });
  });

  describe('setLogTarget', () => {
    it('replaces the target for a valid level', () => {
      const custom = vi.fn();
      Logger.setLogTarget(Level.INFO, custom);
      Logger.info('hello');
      expect(custom).toHaveBeenCalledWith('hello');
    });

    it('rejects invalid level', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      Logger.setLogTarget(99, vi.fn());
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('rejects non-function target', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      Logger.setLogTarget(Level.INFO, undefined);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});

describe('getLogger', () => {
  const targets: Record<number, ReturnType<typeof vi.fn>> = {};
  let savedTargets: typeof Logger.logTarget;

  beforeEach(() => {
    savedTargets = { ...Logger.logTarget };
    Logger.setLevel(Level.ALL);
    for (const lvl of [Level.TRACE, Level.DEBUG, Level.INFO, Level.WARN, Level.ERROR, Level.FATAL]) {
      targets[lvl] = vi.fn();
      Logger.logTarget[lvl] = targets[lvl];
    }
  });

  afterEach(() => {
    Logger.logTarget = savedTargets;
    Logger.setLevel(Level.ALL);
  });

  it('prefixes the message with the namespace tag', () => {
    const log = getLogger('plugins/idp');
    log.info('loaded');
    expect(targets[Level.INFO]).toHaveBeenCalledWith('[plugins/idp] loaded');
  });

  it('forwards context as second arg through namespace', () => {
    const log = getLogger('services/api');
    const err = new Error('nope');
    log.error('failed', err);
    expect(targets[Level.ERROR]).toHaveBeenCalledWith('[services/api] failed', err);
  });

  it('respects the global level threshold', () => {
    Logger.setLevel(Level.WARN);
    const log = getLogger('comp/x');
    log.debug('hidden');
    log.warn('shown');
    expect(targets[Level.DEBUG]).not.toHaveBeenCalled();
    expect(targets[Level.WARN]).toHaveBeenCalledWith('[comp/x] shown');
  });

  it('namespace fatal still gets FATAL: prefix', () => {
    const log = getLogger('zone');
    log.fatal('dead');
    expect(targets[Level.FATAL]).toHaveBeenCalledWith('FATAL: [zone] dead');
  });
});
