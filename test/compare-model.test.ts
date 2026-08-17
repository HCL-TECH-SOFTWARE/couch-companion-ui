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

import { buildCompareModel, type CompareColumn } from '../src/plugins/config/compare-model';
import type { NodeConfig } from '../src/plugins/config/types';

function col(id: string, overrides: Partial<CompareColumn> = {}): CompareColumn {
  return { id, name: id, reachable: true, ...overrides };
}

describe('buildCompareModel', () => {
  it('marks all rows as not differing when two nodes have identical config', () => {
    const configs: Record<string, NodeConfig> = {
      a: { httpd: { port: '5984', bind_address: '0.0.0.0' } },
      b: { httpd: { port: '5984', bind_address: '0.0.0.0' } },
    };
    const model = buildCompareModel([col('a'), col('b')], configs);

    expect(model.totalCount).toBe(2);
    expect(model.differingCount).toBe(0);
    expect(model.rows.every((r) => !r.differs)).toBe(true);
  });

  it('flags a row where two nodes differ on one key, leaves others unaffected', () => {
    const configs: Record<string, NodeConfig> = {
      a: { httpd: { port: '5984', bind_address: '0.0.0.0' } },
      b: { httpd: { port: '5985', bind_address: '0.0.0.0' } },
    };
    const model = buildCompareModel([col('a'), col('b')], configs);

    const portRow = model.rows.find((r) => r.section === 'httpd' && r.key === 'port');
    const bindRow = model.rows.find((r) => r.section === 'httpd' && r.key === 'bind_address');

    expect(portRow?.differs).toBe(true);
    expect(bindRow?.differs).toBe(false);
    expect(model.differingCount).toBe(1);
    expect(model.totalCount).toBe(2);
  });

  it('flags a row as differing when a key is present on one node and absent on another', () => {
    const configs: Record<string, NodeConfig> = {
      a: { httpd: { port: '5984', extra_key: 'x' } },
      b: { httpd: { port: '5984' } },
    };
    const model = buildCompareModel([col('a'), col('b')], configs);

    const extraRow = model.rows.find((r) => r.section === 'httpd' && r.key === 'extra_key');
    expect(extraRow?.differs).toBe(true);
    expect(extraRow?.values.b).toBeUndefined();
    expect(extraRow?.values.a).toBe('x');
  });

  it('treats keys of a section present on only one node as differing rows', () => {
    const configs: Record<string, NodeConfig> = {
      a: { ssl: { cert_file: '/path/cert.pem' } },
      b: {},
    };
    const model = buildCompareModel([col('a'), col('b')], configs);

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].section).toBe('ssl');
    expect(model.rows[0].key).toBe('cert_file');
    expect(model.rows[0].differs).toBe(true);
    expect(model.rows[0].values.a).toBe('/path/cert.pem');
    expect(model.rows[0].values.b).toBeUndefined();
  });

  it('sorts rows by section then key ascending regardless of input order', () => {
    const configs: Record<string, NodeConfig> = {
      a: {
        zeta: { b_key: '1', a_key: '2' },
        alpha: { z_key: '3', a_key: '4' },
      },
    };
    const model = buildCompareModel([col('a')], configs);

    const ordering = model.rows.map((r) => `${r.section}:${r.key}`);
    expect(ordering).toEqual(['alpha:a_key', 'alpha:z_key', 'zeta:a_key', 'zeta:b_key']);
  });

  it('flags a row as differing if any pair among three or four nodes differs', () => {
    const configs: Record<string, NodeConfig> = {
      a: { httpd: { port: '5984' } },
      b: { httpd: { port: '5984' } },
      c: { httpd: { port: '5984' } },
      d: { httpd: { port: '5985' } },
    };
    const model = buildCompareModel([col('a'), col('b'), col('c'), col('d')], configs);

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].differs).toBe(true);
    expect(model.differingCount).toBe(1);
  });

  it('does not flag a row as differing when all three/four nodes agree', () => {
    const configs: Record<string, NodeConfig> = {
      a: { httpd: { port: '5984' } },
      b: { httpd: { port: '5984' } },
      c: { httpd: { port: '5984' } },
      d: { httpd: { port: '5984' } },
    };
    const model = buildCompareModel([col('a'), col('b'), col('c'), col('d')], configs);

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].differs).toBe(false);
    expect(model.differingCount).toBe(0);
  });

  it('treats a column with error:true and no entry in configs as all-undefined and differing', () => {
    const configs: Record<string, NodeConfig> = {
      a: { httpd: { port: '5984' } },
      // 'b' intentionally absent from configs
    };
    const model = buildCompareModel([col('a'), col('b', { error: true })], configs);

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].values.b).toBeUndefined();
    expect(model.rows[0].values.a).toBe('5984');
    expect(model.rows[0].differs).toBe(true);
  });

  it('treats a column mapped to an empty config object the same as a missing column', () => {
    const configs: Record<string, NodeConfig> = {
      a: { httpd: { port: '5984' } },
      b: {},
    };
    const model = buildCompareModel([col('a'), col('b')], configs);

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].values.b).toBeUndefined();
    expect(model.rows[0].differs).toBe(true);
  });

  it('produces an all-undefined row that still differs when every column is missing/errored', () => {
    const columns = [
      { id: 'a', name: 'A', reachable: true },
      { id: 'b', name: 'B', reachable: true },
    ];
    const configs: Record<string, NodeConfig> = {
      a: {},
      ghost: { httpd: { port: '5984' } },
    };
    const model = buildCompareModel(columns, configs);

    // 'a' and 'b' are in columns but have no values in configs.
    // 'ghost' is not in columns but contributes the httpd/port section/key.
    // The row exists because the section/key comes from the union of all config keys,
    // but both columns 'a' and 'b' resolve to undefined. The row differs because
    // the values are not uniform (undefined across all columns is a difference state).
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].section).toBe('httpd');
    expect(model.rows[0].key).toBe('port');
    expect(model.rows[0].values.a).toBeUndefined();
    expect(model.rows[0].values.b).toBeUndefined();
    expect(model.rows[0].differs).toBe(true);
    expect(model.differingCount).toBe(1);
    expect(model.totalCount).toBe(1);
  });

  it('returns empty rows and zero counts when configs is empty', () => {
    const model = buildCompareModel([col('a'), col('b')], {});

    expect(model.rows).toEqual([]);
    expect(model.totalCount).toBe(0);
    expect(model.differingCount).toBe(0);
  });

  it('preserves the columns array as provided', () => {
    const columns = [col('a'), col('b', { reachable: false, error: true })];
    const model = buildCompareModel(columns, { a: { httpd: { port: '5984' } } });

    expect(model.columns).toEqual(columns);
  });

  // The short ids above keep the other cases readable, but the real column id is an
  // Erlang node name. `@` and `.` are exactly the characters that get mangled if
  // anything downstream starts treating an id as a path segment or a selector.
  it('keys rows by full Erlang node names, dots and @ included', () => {
    const n1 = 'couchdb@couchdb1.ccui.local';
    const n3 = 'couchdb@couchdb3.ccui.local';
    const configs: Record<string, NodeConfig> = {
      [n1]: { log: { level: 'info' } },
      [n3]: { log: { level: 'debug', writer: 'stderr' } },
    };
    const model = buildCompareModel([col(n1), col(n3)], configs);

    expect(model.totalCount).toBe(2);
    const level = model.rows.find((r) => r.key === 'level');
    expect(level?.values[n1]).toBe('info');
    expect(level?.values[n3]).toBe('debug');
    expect(level?.differs).toBe(true);

    // Present on one node only — the shape a `_node/_local/_config` write produces.
    const writer = model.rows.find((r) => r.key === 'writer');
    expect(writer?.values[n1]).toBeUndefined();
    expect(writer?.values[n3]).toBe('stderr');
    expect(writer?.differs).toBe(true);
  });
});
