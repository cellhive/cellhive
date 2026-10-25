import { describe, expect, it, vi } from 'vitest';

import { orgScope } from '../../src/db/repository.js';
import { AppError } from '../../src/errors/app-error.js';
import {
  DUE_INDEX_RECHECK_MS,
  dueAt,
  dueRuleOf,
  openWindow,
  TimeScanCore,
  valueRangeOf,
  windowOf,
  type DueRule,
  type TimeScanResult,
  type TimeScanWindow,
} from '../../src/time-scan/index.js';

import { FAKE_TX, MemoryCursorStore, MemoryScanner, type MemoryRecord } from './support.js';

import type { Id } from '@cellhive/contracts';

const scope = orgScope('org_A1b2C3d4E5f6G7h8');
const TABLE = 'tbl_A1b2C3d4E5f6G7h8' as Id<'tbl'>;
const FIELD = 'fld_A1b2C3d4E5f6G7h8' as Id<'fld'>;
const USER_FIELD = 'fld_U1b2C3d4E5f6G7h8' as Id<'fld'>;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const rec = (n: number | string) => `rec_${String(n).padStart(16, '0')}`;

const UTC_INSTANT: DueRule = {
  kind: 'instant',
  offsetMinutes: 0,
  timeOfDay: null,
  timeZone: 'UTC',
};
const HCM_DATE: DueRule = {
  kind: 'date',
  offsetMinutes: 0,
  timeOfDay: null,
  timeZone: 'Asia/Ho_Chi_Minh',
};
const NY_DATE: DueRule = { ...HCM_DATE, timeZone: 'America/New_York' };

interface ScanOptions {
  readonly rule: DueRule;
  readonly records: readonly MemoryRecord[];
  readonly window: TimeScanWindow;
  readonly maxHits?: number;
  readonly pageSize?: number;
  /** Record ids the consumer already handled (its dedupe: `onDue` → `false`). */
  readonly seen?: ReadonlySet<string>;
}

/** Runs one scan; returns the result and the records `onDue` saw, in order. */
async function scanOnce(options: ScanOptions) {
  const scanner = new MemoryScanner(options.rule.kind, options.records);
  const core = new TimeScanCore(scanner);
  const due: { id: string; due: string; hit: boolean }[] = [];
  const result = await core.scan(scope, {
    tx: FAKE_TX,
    tableId: TABLE,
    fieldId: FIELD,
    rule: options.rule,
    window: options.window,
    access: { member: true } as never,
    pageSize: options.pageSize ?? 500,
    maxHits: options.maxHits ?? 1_000,
    onDue: (_tx, record, dueMs) => {
      const hit = !(options.seen?.has(record.id) ?? false);
      due.push({ id: record.id, due: iso(dueMs), hit });
      return Promise.resolve(hit);
    },
  });
  return { result, due, scanner };
}

const view = (result: TimeScanResult) => ({
  outcome: result.outcome,
  hits: result.hits,
  until: result.until.toISOString(),
});

describe('windowOf (ADR-34 §1: `(max(scanned_until, armed_at), now]`)', () => {
  const t = (minute: number) => new Date(at('2026-10-05T10:00Z') + minute * MINUTE);
  it.each([
    ['cursor at now: empty', { scannedUntil: t(0), armedAt: null }, t(0), null],
    ['cursor after now: empty', { scannedUntil: t(5), armedAt: null }, t(0), null],
    ['no arming moment', { scannedUntil: t(0), armedAt: null }, t(3), [t(0), t(3)]],
    ['armed after the cursor', { scannedUntil: t(0), armedAt: t(2) }, t(3), [t(2), t(3)]],
    ['armed before the cursor', { scannedUntil: t(2), armedAt: t(0) }, t(3), [t(2), t(3)]],
    ['armed after now: empty', { scannedUntil: t(0), armedAt: t(4) }, t(3), null],
    ['armed exactly now: empty', { scannedUntil: t(0), armedAt: t(3) }, t(3), null],
  ] as const)('%s', (_name, cursor, now, expected) => {
    expect(windowOf(cursor, now)).toEqual(
      expected === null ? null : { from: expected[0].getTime(), to: expected[1].getTime() },
    );
  });

  it('openWindow locks the cursor (created at the arming moment) and returns its window', async () => {
    const store = new MemoryCursorStore();
    store.arm('a', t(1));
    expect(await openWindow(store, scope, 'a', t(4))).toEqual({
      from: t(1).getTime(),
      to: t(4).getTime(),
    });
    expect(store.cursors.get('a')).toEqual(t(1));
    // Without an arming moment the cursor starts now: nothing before it counts.
    expect(await openWindow(store, scope, 'b', t(4))).toBeNull();
    expect(store.cursors.get('b')).toEqual(t(4));
    expect(store.locks).toBe(2);
  });
});

describe('dueRuleOf (ADR-21: field zone, else organization, else instance default)', () => {
  const timing = { offsetMinutes: -30, timeOfDay: '07:30' };
  const dateField = (options: object = {}) => ({
    type: 'datetime',
    options: { style: { format: 'yyyy-MM-dd' }, ...options },
  });
  it.each([
    [
      'date-only in the field’s zone',
      dateField({ timezone: 'America/New_York' }),
      { organization: 'Asia/Ho_Chi_Minh', fallback: 'UTC' },
      { kind: 'date', timeZone: 'America/New_York' },
    ],
    [
      'date-only in the organization’s zone',
      dateField(),
      { organization: 'Asia/Ho_Chi_Minh', fallback: 'UTC' },
      { kind: 'date', timeZone: 'Asia/Ho_Chi_Minh' },
    ],
    [
      'invalid field and organization zones: instance default',
      dateField({ timezone: 'Mars/Olympus' }),
      { organization: 42, fallback: 'Europe/Paris' },
      { kind: 'date', timeZone: 'Europe/Paris' },
    ],
    [
      'no valid zone at all: UTC',
      dateField(),
      { organization: null, fallback: 'Not/AZone' },
      { kind: 'date', timeZone: 'UTC' },
    ],
    [
      'datetime with a time',
      { type: 'datetime', options: { style: { format: 'yyyy-MM-dd HH:mm' } } },
      { organization: 'Asia/Ho_Chi_Minh', fallback: 'UTC' },
      { kind: 'instant', timeZone: 'Asia/Ho_Chi_Minh' },
    ],
    [
      'created_at',
      { type: 'created_at', options: null },
      { organization: undefined, fallback: 'UTC' },
      { kind: 'instant', timeZone: 'UTC' },
    ],
    [
      'stored formula of type date',
      { type: 'formula', options: {}, compute_mode: 'stored', result_type: { kind: 'date' } },
      { organization: 'Asia/Ho_Chi_Minh', fallback: 'UTC' },
      { kind: 'date', timeZone: 'Asia/Ho_Chi_Minh' },
    ],
    [
      'virtual formula: not scanned',
      { type: 'formula', options: {}, compute_mode: 'virtual', result_type: { kind: 'date' } },
      { organization: 'Asia/Ho_Chi_Minh', fallback: 'UTC' },
      null,
    ],
    [
      'text: not scanned',
      { type: 'text', options: {} },
      { organization: 'Asia/Ho_Chi_Minh', fallback: 'UTC' },
      null,
    ],
  ] as const)('%s', (_name, field, zones, expected) => {
    expect(dueRuleOf(field, timing, zones)).toEqual(
      expected === null ? null : { ...expected, offsetMinutes: -30, timeOfDay: '07:30' },
    );
  });
});

describe('TimeScanCore.scan (ADR-34 §1, BACKLOG T546)', () => {
  const T = at('2026-10-05T10:00:00Z');
  const instantAt = (id: number, ms: number): MemoryRecord => ({ id: rec(id), value: iso(ms) });

  it.each<[string, ScanOptions, ReturnType<typeof view>, string[]]>([
    [
      'empty window: nothing due',
      { rule: UTC_INSTANT, records: [], window: { from: T, to: T + MINUTE } },
      { outcome: 'done', hits: 0, until: iso(T + MINUTE) },
      [],
    ],
    [
      'window bounds: start excluded, end included',
      {
        rule: UTC_INSTANT,
        records: [
          instantAt(1, T - MINUTE),
          instantAt(2, T),
          instantAt(3, T + 1),
          instantAt(4, T + MINUTE),
          instantAt(5, T + MINUTE + 1),
        ],
        window: { from: T, to: T + MINUTE },
      },
      { outcome: 'done', hits: 2, until: iso(T + MINUTE) },
      [rec(3), rec(4)],
    ],
    [
      'same due moment across pages: every record once, in id order',
      {
        rule: UTC_INSTANT,
        records: [5, 3, 1, 4, 2].map((n) => instantAt(n, T + 30_000)),
        window: { from: T, to: T + MINUTE },
        pageSize: 2,
      },
      { outcome: 'done', hits: 5, until: iso(T + MINUTE) },
      [1, 2, 3, 4, 5].map(rec),
    ],
    [
      'pages ordered by value then id',
      {
        rule: UTC_INSTANT,
        records: [
          instantAt(9, T + 3),
          instantAt(1, T + 2),
          instantAt(5, T + 2),
          instantAt(2, T + 1),
        ],
        window: { from: T, to: T + MINUTE },
        pageSize: 3,
      },
      { outcome: 'done', hits: 4, until: iso(T + MINUTE) },
      [rec(2), rec(1), rec(5), rec(9)],
    ],
    [
      'capped: stops at maxHits, cursor just before the last due moment',
      {
        rule: UTC_INSTANT,
        records: [1, 2, 3].map((n) => instantAt(n, T + 30_000)),
        window: { from: T, to: T + MINUTE },
        maxHits: 2,
      },
      { outcome: 'capped', hits: 2, until: iso(T + 30_000 - 1) },
      [rec(1), rec(2)],
    ],
    [
      'capped right after the window start: the cursor stays at the start',
      {
        rule: UTC_INSTANT,
        records: [1, 2].map((n) => instantAt(n, T + 1)),
        window: { from: T, to: T + MINUTE },
        maxHits: 1,
      },
      { outcome: 'capped', hits: 1, until: iso(T) },
      [rec(1)],
    ],
    [
      'duplicates (handled by an earlier scan) do not count towards the cap',
      {
        rule: UTC_INSTANT,
        records: [1, 2, 3].map((n) => instantAt(n, T + n * 1_000)),
        window: { from: T, to: T + MINUTE },
        maxHits: 2,
        seen: new Set([rec(1)]),
      },
      { outcome: 'capped', hits: 2, until: iso(T + 3_000 - 1) },
      [rec(1), rec(2), rec(3)],
    ],
    [
      'offset −1 day: the value a day ahead is due now',
      {
        rule: { ...UTC_INSTANT, offsetMinutes: -1_440 },
        records: [instantAt(1, T + 24 * HOUR + 30_000), instantAt(2, T + 30_000)],
        window: { from: T, to: T + MINUTE },
      },
      { outcome: 'done', hits: 1, until: iso(T + MINUTE) },
      [rec(1)],
    ],
    [
      'date-only at 09:00 (default) in Asia/Ho_Chi_Minh = 02:00 UTC',
      {
        rule: HCM_DATE,
        records: [
          { id: rec(1), value: '2026-10-04' },
          { id: rec(2), value: '2026-10-05' },
          { id: rec(3), value: '2026-10-06' },
          { id: rec(4), value: '2026-10-05x' },
        ],
        window: { from: at('2026-10-05T01:59Z'), to: at('2026-10-05T02:00Z') },
      },
      { outcome: 'done', hits: 1, until: '2026-10-05T02:00:00.000Z' },
      [rec(2)],
    ],
    [
      'date-only with time of day and offset: 07:30 − 30 min in UTC+7 = 00:00 UTC',
      {
        rule: { ...HCM_DATE, timeOfDay: '07:30', offsetMinutes: -30 },
        records: [{ id: rec(1), value: '2026-10-05' }],
        window: { from: at('2026-10-04T23:59Z'), to: at('2026-10-05T00:00Z') },
      },
      { outcome: 'done', hits: 1, until: '2026-10-05T00:00:00.000Z' },
      [rec(1)],
    ],
    [
      'DST forward (New York): skipped 02:30 is due at the shifted instant 07:30 UTC',
      {
        rule: { ...NY_DATE, timeOfDay: '02:30' },
        records: [{ id: rec(1), value: '2026-03-08' }],
        window: { from: at('2026-03-08T07:29Z'), to: at('2026-03-08T07:30Z') },
      },
      { outcome: 'done', hits: 1, until: '2026-03-08T07:30:00.000Z' },
      [rec(1)],
    ],
    [
      'DST back (New York): repeated 01:30 is due once, at the earlier instant',
      {
        rule: { ...NY_DATE, timeOfDay: '01:30' },
        records: [{ id: rec(1), value: '2026-11-01' }],
        window: { from: at('2026-11-01T05:00Z'), to: at('2026-11-01T07:00Z') },
      },
      { outcome: 'done', hits: 1, until: '2026-11-01T07:00:00.000Z' },
      [rec(1)],
    ],
    [
      'DST back (New York): nothing in the second 01:30',
      {
        rule: { ...NY_DATE, timeOfDay: '01:30' },
        records: [{ id: rec(1), value: '2026-11-01' }],
        window: { from: at('2026-11-01T05:31Z'), to: at('2026-11-01T07:00Z') },
      },
      { outcome: 'done', hits: 0, until: '2026-11-01T07:00:00.000Z' },
      [],
    ],
  ])('%s', async (_name, options, expected, ids) => {
    const { result, due } = await scanOnce(options);
    expect(view(result)).toEqual(expected);
    expect(due.map((item) => item.id)).toEqual(ids);
    for (const item of due) {
      const record = options.records.find((candidate) => candidate.id === item.id);
      expect(item.due).toBe(iso(dueAt(options.rule, record?.value ?? '') ?? NaN));
    }
  });

  it('reads the range of the window with the consumer’s access, filter and fields', async () => {
    const scanner = new MemoryScanner('instant', [
      { id: rec(1), value: iso(T + 1_000), cells: { [USER_FIELD]: [{ id: 'usr_x' }], other: 1 } },
    ]);
    const core = new TimeScanCore(scanner);
    const access = { member: 'run_as' } as never;
    const filter = { op: 'and', items: [] };
    const seen: unknown[] = [];
    const rule = { ...UTC_INSTANT, offsetMinutes: 60 };
    const window = { from: T, to: T + MINUTE };
    const result = await core.scan(scope, {
      tx: FAKE_TX,
      tableId: TABLE,
      fieldId: FIELD,
      rule,
      window,
      access,
      filter,
      fields: [USER_FIELD],
      pageSize: 10,
      maxHits: 10,
      onDue: (tx, record) => {
        seen.push(tx, record);
        return Promise.resolve(true);
      },
    });
    // Offset +60 min: values from an hour before the window are due in it.
    expect(result.hits).toBe(0);
    const [first] = scanner.requests;
    expect(first?.access).toBe(access);
    expect(first?.request).toEqual({
      fieldId: FIELD,
      ...valueRangeOf(rule, window.from, window.to),
      after: null,
      limit: 10,
      filter,
      fields: [USER_FIELD],
    });

    const due = await core.scan(scope, {
      tx: FAKE_TX,
      tableId: TABLE,
      fieldId: FIELD,
      rule: UTC_INSTANT,
      window,
      access,
      fields: [USER_FIELD],
      pageSize: 10,
      maxHits: 10,
      onDue: (tx, record) => {
        seen.push(tx, record);
        return Promise.resolve(true);
      },
    });
    expect(due.hits).toBe(1);
    expect(seen).toEqual([
      FAKE_TX,
      { id: rec(1), value: iso(T + 1_000), fields: { [USER_FIELD]: [{ id: 'usr_x' }] } },
    ]);
    // No filter, no fields: neither is sent.
    await core.scan(scope, {
      tx: FAKE_TX,
      tableId: TABLE,
      fieldId: FIELD,
      rule: UTC_INSTANT,
      window,
      access,
      pageSize: 10,
      maxHits: 10,
      onDue: () => Promise.resolve(false),
    });
    const last = scanner.requests.at(-1)?.request;
    expect(last).not.toHaveProperty('filter');
    expect(last).not.toHaveProperty('fields');
  });

  it.each([
    ['NOT_FOUND (table gone, reader lost the table)', new AppError('NOT_FOUND')],
    ['INVALID_FILTER (field gone or unreadable)', new AppError('INVALID_FILTER')],
  ])('%s: unavailable, the window counts as handled', async (_name, error) => {
    const records = [1, 2, 3, 4].map((n) => instantAt(n, T + n * 1_000));
    const scanner = new MemoryScanner('instant', records);
    scanner.fail = { error, fromCall: 2 };
    const core = new TimeScanCore(scanner);
    const result = await core.scan(scope, {
      tx: FAKE_TX,
      tableId: TABLE,
      fieldId: FIELD,
      rule: UTC_INSTANT,
      window: { from: T, to: T + MINUTE },
      access: {} as never,
      pageSize: 2,
      maxHits: 10,
      onDue: () => Promise.resolve(true),
    });
    // The hits of the first page stay (the consumer's transaction keeps them).
    expect(view(result)).toEqual({ outcome: 'unavailable', hits: 2, until: iso(T + MINUTE) });
  });

  it.each([
    ['a database error', new Error('connection reset')],
    ['a timeout', new AppError('QUERY_TIMEOUT')],
  ])('%s is thrown (the consumer rolls back, the next scan retries)', async (_name, error) => {
    const scanner = new MemoryScanner('instant', []);
    scanner.fail = { error, fromCall: 1 };
    const core = new TimeScanCore(scanner);
    await expect(
      core.scan(scope, {
        tx: FAKE_TX,
        tableId: TABLE,
        fieldId: FIELD,
        rule: UTC_INSTANT,
        window: { from: T, to: T + MINUTE },
        access: {} as never,
        pageSize: 2,
        maxHits: 10,
        onDue: () => Promise.resolve(true),
      }),
    ).rejects.toBe(error);
  });

  it.each([
    ['maxHits 0', { maxHits: 0, pageSize: 1 }],
    ['maxHits 1.5', { maxHits: 1.5, pageSize: 1 }],
    ['pageSize 0', { maxHits: 1, pageSize: 0 }],
  ])('rejects %s', async (_name, sizes) => {
    const core = new TimeScanCore(new MemoryScanner('instant', []));
    await expect(
      core.scan(scope, {
        tx: FAKE_TX,
        tableId: TABLE,
        fieldId: FIELD,
        rule: UTC_INSTANT,
        window: { from: T, to: T + MINUTE },
        access: {} as never,
        ...sizes,
        onDue: () => Promise.resolve(true),
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('TimeScanCore with a cursor store in memory (a consumer’s cycle)', () => {
  const T = at('2026-10-05T10:00:00Z');

  /** One consumer tick: lock → window → scan → advance; dedupe by `record:value`. */
  function consumer(records: MemoryRecord[], maxHits = 1_000) {
    const store = new MemoryCursorStore();
    const core = new TimeScanCore(new MemoryScanner('instant', records));
    const fired: string[] = [];
    const keys = new Set<string>();
    const tick = async (now: number) => {
      const window = await openWindow(store, scope, 'consumer', new Date(now));
      if (window === null) return null;
      const result = await core.scan(scope, {
        tx: FAKE_TX,
        tableId: TABLE,
        fieldId: FIELD,
        rule: UTC_INSTANT,
        window,
        access: {} as never,
        pageSize: 2,
        maxHits,
        onDue: (_tx, record) => {
          const key = `${record.id}:${record.value}`;
          if (keys.has(key)) return Promise.resolve(false);
          keys.add(key);
          fired.push(record.id);
          return Promise.resolve(true);
        },
      });
      await store.advance(scope, 'consumer', result.until);
      return result;
    };
    return { store, tick, fired };
  }

  it('a stopped worker catches up: each record due meanwhile fires exactly once', async () => {
    const records = [1, 2, 3, 4, 5].map((n) => ({ id: rec(n), value: iso(T + n * MINUTE) }));
    const { store, tick, fired } = consumer(records);
    store.arm('consumer', new Date(T));
    expect(await tick(T)).toBeNull();
    expect((await tick(T + 10 * MINUTE))?.hits).toBe(5);
    expect((await tick(T + 11 * MINUTE))?.hits).toBe(0);
    expect(fired).toEqual([1, 2, 3, 4, 5].map(rec));
    expect(store.cursors.get('consumer')).toEqual(new Date(T + 11 * MINUTE));
  });

  it('values that passed before arming never fire; re-arming skips what passed meanwhile', async () => {
    const records = [
      { id: rec(1), value: iso(T - MINUTE) },
      { id: rec(2), value: iso(T + 2 * MINUTE) },
      { id: rec(3), value: iso(T + 6 * MINUTE) },
    ];
    const { store, tick, fired } = consumer(records);
    store.arm('consumer', new Date(T));
    expect((await tick(T + 3 * MINUTE))?.hits).toBe(1);
    // Turned off then on again at T + 7 min: rec 3 (T + 6) passed while off.
    store.arm('consumer', new Date(T + 7 * MINUTE));
    expect((await tick(T + 8 * MINUTE))?.hits).toBe(0);
    expect(fired).toEqual([rec(2)]);
  });

  it('capped scans hand the rest to the next scan, exactly once overall', async () => {
    const records = [1, 2, 3, 4, 5].map((n) => ({ id: rec(n), value: iso(T + 30_000) }));
    records.push({ id: rec(6), value: iso(T + 40_000) });
    const { store, tick, fired } = consumer(records, 2);
    store.arm('consumer', new Date(T));
    expect(await tick(T + MINUTE)).toMatchObject({ outcome: 'capped', hits: 2 });
    expect(store.cursors.get('consumer')).toEqual(new Date(T + 30_000 - 1));
    expect(await tick(T + 2 * MINUTE)).toMatchObject({ outcome: 'capped', hits: 2 });
    // Reaching the cap on the last record still counts as capped (T508).
    expect(await tick(T + 3 * MINUTE)).toMatchObject({ outcome: 'capped', hits: 2 });
    expect(store.cursors.get('consumer')).toEqual(new Date(T + 40_000 - 1));
    expect(await tick(T + 4 * MINUTE)).toMatchObject({ outcome: 'done', hits: 0 });
    expect(store.cursors.get('consumer')).toEqual(new Date(T + 4 * MINUTE));
    expect(fired).toEqual([1, 2, 3, 4, 5, 6].map(rec));
  });
});

describe('TimeScanCore resumeAfter (QA S5b M7: many records due at one moment)', () => {
  const T = at('2026-10-05T10:00:00Z');
  const SAME = 50;
  const records: MemoryRecord[] = Array.from({ length: SAME }, (_, n) => ({
    id: rec(n + 1),
    value: iso(T + 30_000),
  }));
  records.push({ id: rec(SAME + 1), value: iso(T + 40_000) });

  it('each capped scan seeks past the handled records of its boundary: reads stay flat', async () => {
    const scanner = new MemoryScanner('instant', records);
    const core = new TimeScanCore(scanner);
    const fired: string[] = [];
    let from = T;
    let resume: { due: number; id: Id<'rec'> } | undefined;
    const rowsRead: number[] = [];
    for (let tick = 0; tick < 20; tick += 1) {
      const before = scanner.requests.length;
      const read: number[] = [];
      const result = await core.scan(scope, {
        tx: FAKE_TX,
        tableId: TABLE,
        fieldId: FIELD,
        rule: UTC_INSTANT,
        window: { from, to: T + 10 * MINUTE },
        access: {} as never,
        pageSize: 5,
        maxHits: 5,
        ...(resume === undefined ? {} : { resumeAfter: resume }),
        onDue: (_tx, record, due) => {
          // No dedupe here: a record handed twice would show up twice.
          fired.push(record.id);
          resume = { due, id: record.id };
          read.push(1);
          return Promise.resolve(true);
        },
      });
      rowsRead.push(
        scanner.requests
          .slice(before)
          .reduce((sum, { request }) => sum + Math.min(request.limit, SAME + 1), 0),
      );
      if (result.outcome !== 'capped') break;
      from = result.until.getTime();
    }
    expect(fired).toEqual(records.map((record) => record.id));
    // At most a probe row + one page (+ the empty end page) per scan, whatever
    // the number of records already handled at that moment.
    expect(Math.max(...rowsRead)).toBeLessThanOrEqual(1 + 5 + 5);
  });

  it('without resumeAfter the core reads the moment again from its start (consumer dedupe)', async () => {
    const { due } = await scanOnce({
      rule: UTC_INSTANT,
      records,
      window: { from: T + 30_000 - 1, to: T + 10 * MINUTE },
      maxHits: 5,
      seen: new Set(records.slice(0, 20).map((record) => record.id)),
    });
    expect(due.filter((item) => !item.hit)).toHaveLength(20);
  });

  it('a boundary whose moment holds no record any more scans normally', async () => {
    const scanner = new MemoryScanner('instant', [{ id: rec(9), value: iso(T + 40_000) }]);
    const result = await new TimeScanCore(scanner).scan(scope, {
      tx: FAKE_TX,
      tableId: TABLE,
      fieldId: FIELD,
      rule: UTC_INSTANT,
      window: { from: T + 30_000 - 1, to: T + 10 * MINUTE },
      access: {} as never,
      pageSize: 5,
      maxHits: 5,
      resumeAfter: { due: T + 30_000, id: rec(3) as Id<'rec'> },
      onDue: () => Promise.resolve(true),
    });
    expect(result).toMatchObject({ outcome: 'done', hits: 1 });
  });
});

describe('TimeScanCore.ensureIndex', () => {
  const scanner = new MemoryScanner('instant', []);
  const other = 'fld_B1b2C3d4E5f6G7h8' as Id<'fld'>;

  it('creates the index of a field once, not on every scan', async () => {
    const ensureDueIndex = vi.fn(() => Promise.resolve('created' as const));
    const core = new TimeScanCore(scanner, { schema: { ensureDueIndex } });
    await core.ensureIndex(scope, FIELD);
    await core.ensureIndex(scope, FIELD);
    await core.ensureIndex(scope, other);
    expect(ensureDueIndex.mock.calls).toEqual([
      [scope, FIELD],
      [scope, other],
    ]);
  });

  it('checks the index again once DUE_INDEX_RECHECK_MS passed (compaction, conversions)', async () => {
    let now = 1_000_000;
    const ensureDueIndex = vi.fn(() => Promise.resolve('exists' as const));
    const core = new TimeScanCore(scanner, { schema: { ensureDueIndex }, now: () => now });
    await core.ensureIndex(scope, FIELD);
    now += DUE_INDEX_RECHECK_MS - 1;
    await core.ensureIndex(scope, FIELD);
    expect(ensureDueIndex).toHaveBeenCalledTimes(1);
    now += 1;
    await core.ensureIndex(scope, FIELD);
    expect(ensureDueIndex).toHaveBeenCalledTimes(2);
  });

  it('asks again for a field that needs none', async () => {
    const ensureDueIndex = vi.fn(() => Promise.resolve('not_applicable' as const));
    const core = new TimeScanCore(scanner, { schema: { ensureDueIndex } });
    await core.ensureIndex(scope, FIELD);
    await core.ensureIndex(scope, FIELD);
    expect(ensureDueIndex).toHaveBeenCalledTimes(2);
  });

  it('reports an error and goes on (the scan reads without the index), retrying next time', async () => {
    const error = new Error('lock timeout');
    const ensureDueIndex = vi
      .fn<() => Promise<'exists' | 'created' | 'not_applicable'>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('exists');
    const onIndexError = vi.fn();
    const core = new TimeScanCore(scanner, { schema: { ensureDueIndex }, onIndexError });
    await expect(core.ensureIndex(scope, FIELD)).resolves.toBeUndefined();
    expect(onIndexError).toHaveBeenCalledWith(error, FIELD);
    await core.ensureIndex(scope, FIELD);
    await core.ensureIndex(scope, FIELD);
    expect(ensureDueIndex).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a schema service', async () => {
    const core = new TimeScanCore(scanner);
    await expect(core.ensureIndex(scope, FIELD)).resolves.toBeUndefined();
  });
});
