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

import { describe, it, expect, vi, afterEach } from 'vitest';
import '../src/plugins/config/cca-config-compare-table';
import type { CcaConfigCompareTable } from '../src/plugins/config/cca-config-compare-table';
import type { CompareColumn, CompareRow } from '../src/plugins/config/compare-model';

// Real Erlang node names: `@` and `.` are the characters this feature actually
// carries through URLs, query params and DOM attribute selectors.
const NODE_A = 'couchdb@node1.test.local';
const NODE_B = 'couchdb@node2.test.local';

const columns: CompareColumn[] = [
  { id: NODE_A, name: NODE_A, reachable: true },
  { id: NODE_B, name: NODE_B, reachable: false, error: true },
];

const rows: CompareRow[] = [
  { section: 'httpd', key: 'port', values: { [NODE_A]: '5984', [NODE_B]: '5984' }, differs: false },
  {
    section: 'httpd',
    key: 'bind_address',
    values: { [NODE_A]: '0.0.0.0', [NODE_B]: undefined },
    differs: true,
  },
  {
    section: 'ssl',
    key: 'cert_file',
    values: { [NODE_A]: '/path/cert.pem', [NODE_B]: '/path/cert.pem' },
    differs: false,
  },
];

let mounted: HTMLElement[] = [];

async function mount(
  overrides: Partial<{
    columns: CompareColumn[];
    rows: CompareRow[];
    showOnlyDiffs: boolean;
  }> = {}
): Promise<CcaConfigCompareTable> {
  const el = document.createElement('cca-config-compare-table') as CcaConfigCompareTable;
  el.columns = overrides.columns ?? columns;
  el.rows = overrides.rows ?? rows;
  if (overrides.showOnlyDiffs !== undefined) el.showOnlyDiffs = overrides.showOnlyDiffs;
  document.body.appendChild(el);
  mounted.push(el);
  await el.updateComplete;
  return el;
}

function findRow(el: CcaConfigCompareTable, textFragment: string): Element | undefined {
  return Array.from(el.shadowRoot!.querySelectorAll('[data-row]')).find((tr) =>
    tr.textContent?.includes(textFragment)
  );
}

describe('cca-config-compare-table', () => {
  afterEach(() => {
    for (const el of mounted) el.remove();
    mounted = [];
  });

  it('renders one value column per columns entry, headers show names', async () => {
    const el = await mount();
    const headerCells = el.shadowRoot!.querySelectorAll('thead th');
    expect(headerCells.length).toBe(2 + columns.length);
    const text = Array.from(headerCells).map((th) => th.textContent?.trim() ?? '');
    expect(text.some((t) => t.includes(NODE_A))).toBe(true);
    expect(text.some((t) => t.includes(NODE_B))).toBe(true);
  });

  it('marks a differing row data-differs="true" and a matching row data-differs="false"', async () => {
    const el = await mount();
    const differing = findRow(el, 'bind_address');
    const matching = findRow(el, 'port');
    expect(differing?.getAttribute('data-differs')).toBe('true');
    expect(matching?.getAttribute('data-differs')).toBe('false');
  });

  it('renders a muted em dash for an undefined value', async () => {
    const el = await mount();
    const row = findRow(el, 'bind_address');
    const dash = row?.querySelector(`[data-cell="${NODE_B}"] [data-empty-value]`);
    expect(dash?.textContent?.trim()).toBe('—');
  });

  it('renders only differing rows when showOnlyDiffs is true', async () => {
    const el = await mount({ showOnlyDiffs: true });
    const trs = el.shadowRoot!.querySelectorAll('[data-row]');
    expect(trs.length).toBe(1);
    expect(trs[0].getAttribute('data-differs')).toBe('true');
    expect(trs[0].textContent).toContain('bind_address');
  });

  it('dispatches cell-edit with section/key/node/value when a value cell is clicked', async () => {
    const el = await mount();
    const listener = vi.fn();
    el.addEventListener('cell-edit', listener);
    const row = findRow(el, 'port');
    const cell = row!.querySelector(`[data-cell="${NODE_A}"]`) as HTMLElement;
    cell.click();
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      section: 'httpd',
      key: 'port',
      node: NODE_A,
      value: '5984',
    });
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
  });

  it('dispatches cell-copy with section/key/sourceNode/value when the copy affordance is clicked', async () => {
    const el = await mount();
    const editListener = vi.fn();
    const copyListener = vi.fn();
    el.addEventListener('cell-edit', editListener);
    el.addEventListener('cell-copy', copyListener);
    const row = findRow(el, 'port');
    const cell = row!.querySelector(`[data-cell="${NODE_A}"]`) as HTMLElement;
    const copyBtn = cell.querySelector('[data-copy]') as HTMLElement;
    expect(copyBtn).toBeTruthy();
    copyBtn.click();
    expect(copyListener).toHaveBeenCalledTimes(1);
    const event = copyListener.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      section: 'httpd',
      key: 'port',
      sourceNode: NODE_A,
      value: '5984',
    });
    expect(editListener).not.toHaveBeenCalled();
  });

  it('names the copy affordance "other nodes", not "other servers"', async () => {
    const el = await mount();
    const row = findRow(el, 'port');
    const copyBtn = row!.querySelector(`[data-cell="${NODE_A}"] [data-copy]`) as HTMLElement;
    expect(copyBtn.getAttribute('title')).toBe('Copy to other nodes');
  });

  it('does not render a copy affordance for an undefined value', async () => {
    const el = await mount();
    const row = findRow(el, 'bind_address');
    const cell = row!.querySelector(`[data-cell="${NODE_B}"]`) as HTMLElement;
    expect(cell.querySelector('[data-copy]')).toBeNull();
  });

  it('shows an empty message when there are no rows', async () => {
    const el = await mount({ rows: [] });
    const empty = el.shadowRoot!.querySelector('[data-empty]');
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain('No configuration');
    expect(el.shadowRoot!.querySelectorAll('[data-row]').length).toBe(0);
  });

  it('shows a "no differences" message when filtering and nothing differs', async () => {
    const el = await mount({ rows: [rows[0], rows[2]], showOnlyDiffs: true });
    const empty = el.shadowRoot!.querySelector('[data-empty]');
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain('No differences');
  });

  it('groups rows by section, showing the section label only on the first row of each group', async () => {
    const el = await mount();
    const sectionLabels = el.shadowRoot!.querySelectorAll('[data-section]');
    // Two distinct sections (httpd, ssl) across three rows -> two labels shown.
    expect(sectionLabels.length).toBe(2);
    expect(sectionLabels[0].textContent?.trim()).toBe('httpd');
    expect(sectionLabels[1].textContent?.trim()).toBe('ssl');
  });

  it('computes section grouping from the filtered rows, not the full unfiltered list, when showOnlyDiffs is true', async () => {
    // The non-differing httpd row is listed first, ahead of the two differing
    // httpd rows. If section grouping were computed against this full,
    // unfiltered array (instead of the post-filter visible rows), the first
    // *visible* httpd row (bind_address) would wrongly be treated as a
    // continuation of the section its filtered-out predecessor (log_level)
    // started, and would not get a section label.
    const groupedRows: CompareRow[] = [
      { section: 'httpd', key: 'log_level', values: { a: 'info', b: 'info' }, differs: false },
      {
        section: 'httpd',
        key: 'bind_address',
        values: { a: '0.0.0.0', b: '127.0.0.1' },
        differs: true,
      },
      { section: 'httpd', key: 'port', values: { a: '5984', b: '6984' }, differs: true },
      {
        section: 'chttpd',
        key: 'require_valid_user',
        values: { a: 'true', b: 'false' },
        differs: true,
      },
    ];
    const el = await mount({ rows: groupedRows, showOnlyDiffs: true });

    const trs = el.shadowRoot!.querySelectorAll('[data-row]');
    expect(trs.length).toBe(3);

    const bindAddressRow = findRow(el, 'bind_address');
    const portRow = findRow(el, 'port');
    const chttpdRow = findRow(el, 'require_valid_user');

    expect(bindAddressRow?.querySelector('[data-section]')?.textContent?.trim()).toBe('httpd');
    expect(portRow?.querySelector('[data-section]')).toBeNull();
    expect(chttpdRow?.querySelector('[data-section]')?.textContent?.trim()).toBe('chttpd');

    expect(findRow(el, 'log_level')).toBeUndefined();
  });
});
