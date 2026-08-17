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

/**
 * Service for logging messages to the console.
 *
 * `Logger` is the project-wide diagnostic facade. Production code must not call
 * `console.*` directly; use `Logger.<level>()` or `getLogger("namespace")`.
 */

/** Numeric thresholds — Logger ignores messages below the active level. */
export const Level = {
  ALL: 0,
  TRACE: 1,
  DEBUG: 2,
  INFO: 3,
  WARN: 4,
  ERROR: 5,
  FATAL: 6,
  OFF: 7,
};

/** Structured context that survives into DevTools (or a future remote sink). */
export type LogContext = Record<string, unknown> | Error;

type LogLevel = typeof Level[keyof typeof Level];
type LogTargetFn = (...data: unknown[]) => void;
type LogTargetMap = { [key in LogLevel]?: LogTargetFn };

const actualOutput = (
  msg: string,
  func: LogTargetFn | undefined,
  context?: LogContext,
) => {
  const handler: LogTargetFn = typeof func === 'function' ? func : console.warn;
  if (context !== undefined) {
    handler(msg, context);
  } else {
    handler(msg);
  }
};

export const Logger = {
  /** The current logging level. Messages with a level lower than this are dropped. */
  level: Level.ALL as LogLevel,

  /** Per-level output sinks; default is the matching `console.*`. */
  logTarget: {
    /* TRACE */ 1: console.trace,
    /* DEBUG */ 2: console.debug,
    /* INFO  */ 3: console.info,
    /* WARN  */ 4: console.warn,
    /* ERROR */ 5: console.error,
    /* FATAL */ 6: console.error,
  } as LogTargetMap,

  setLevel(newLevel: number) {
    if (Object.values(Level).includes(newLevel)) {
      this.level = newLevel as LogLevel;
    } else {
      console.warn(`Invalid log level: ${newLevel}, staying at ${this.level}`);
    }
  },

  getLevel(): LogLevel {
    return this.level;
  },

  setLogTarget(level: number, func: LogTargetFn | undefined) {
    if (!Object.values(Level).includes(level)) {
      console.error(`Invalid log level: ${level}, cannot set log target`);
      return;
    }
    if (typeof func !== 'function') {
      console.error(`Invalid log target function for level ${level}`);
      return;
    }
    this.logTarget[level as LogLevel] = func;
  },

  trace(message: string, context?: LogContext) {
    if (this.level <= Level.TRACE) {
      actualOutput(message, this.logTarget[Level.TRACE], context);
    }
  },
  debug(message: string, context?: LogContext) {
    if (this.level <= Level.DEBUG) {
      actualOutput(message, this.logTarget[Level.DEBUG], context);
    }
  },
  info(message: string, context?: LogContext) {
    if (this.level <= Level.INFO) {
      actualOutput(message, this.logTarget[Level.INFO], context);
    }
  },
  log(message: string, context?: LogContext) {
    this.info(message, context);
  },
  warn(message: string, context?: LogContext) {
    if (this.level <= Level.WARN) {
      actualOutput(message, this.logTarget[Level.WARN], context);
    }
  },
  error(message: string, context?: LogContext) {
    if (this.level <= Level.ERROR) {
      actualOutput(message, this.logTarget[Level.ERROR], context);
    }
  },
  fatal(message: string, context?: LogContext) {
    if (this.level <= Level.FATAL) {
      actualOutput(`FATAL: ${message}`, this.logTarget[Level.FATAL], context);
    }
  },
};

/** Namespaced view over `Logger` — every message is prefixed `[namespace] `. */
export interface NamespacedLogger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  log(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
}

/**
 * Returns a logger that prepends `[namespace] ` to every message.
 * Filtering by namespace in DevTools' filter box is the intended use.
 */
export function getLogger(namespace: string): NamespacedLogger {
  const tag = `[${namespace}]`;
  return {
    trace: (m, c) => Logger.trace(`${tag} ${m}`, c),
    debug: (m, c) => Logger.debug(`${tag} ${m}`, c),
    info: (m, c) => Logger.info(`${tag} ${m}`, c),
    log: (m, c) => Logger.info(`${tag} ${m}`, c),
    warn: (m, c) => Logger.warn(`${tag} ${m}`, c),
    error: (m, c) => Logger.error(`${tag} ${m}`, c),
    fatal: (m, c) => Logger.fatal(`${tag} ${m}`, c),
  };
}
