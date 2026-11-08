import { describe, expect, it } from 'vitest';

import { aiAskRequestSchema } from '../src/ai-ask.js';
import { setupRequestSchema, timeZoneSchema, updateMeRequestSchema } from '../src/auth.js';
import { scheduleTriggerSchema } from '../src/automation-triggers/schedule.js';
import {
  widgetDataRequestSchema,
  widgetExportQuerySchema,
  widgetOptionsRequestSchema,
  widgetRecordsRequestSchema,
} from '../src/dashboard-data.js';
import { aggregateRecordsInputSchema } from '../src/mcp.js';
import {
  acceptInvitationRequestSchema,
  createOrganizationRequestSchema,
  updateOrganizationRequestSchema,
} from '../src/orgs.js';
import { shareExportQuerySchema } from '../src/shares.js';
import {
  canonicalTimeZone,
  canonicalTimeZones,
  IANA_PRIMARY,
  isUtcOffset,
  TIME_ZONE_HINT,
  timeZoneProblem,
  type TimeZoneProblem,
} from '../src/time-zones.js';

import type { z } from 'zod';

/** UTC offsets written as a zone: refused everywhere, never converted (BACKLOG T1005). */
const OFFSETS = [
  '+07:00',
  '-0530',
  '+7',
  '+07',
  '+0700',
  '-05:30',
  '\u221207:00',
  '+00:00',
  '-12:00',
  '+14:00',
  '+7.5',
  'UTC+7',
  'UTC+07:00',
  'utc-5',
  'UTC -05:30',
  'GMT+07:00',
  'GMT-5',
  'GMT+0',
  'UT+7',
] as const;

/** Names that are zones, written like offsets or near them. */
const NOT_OFFSETS = [
  'UTC',
  'Etc/UTC',
  'GMT',
  'Etc/GMT',
  'Etc/GMT0',
  'Etc/GMT-7',
  'Etc/GMT+12',
  'Etc/GMT-14',
  'Asia/Ho_Chi_Minh',
  'America/Port-au-Prince',
  'EST5EDT',
  'SystemV/AST4',
] as const;

/** Offsets of `zone` in winter and in summer 2026 (`-04:00`…). */
function offsetsOf(zone: string): string[] {
  return ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z'].map(
    (instant) =>
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
        .formatToParts(new Date(instant))
        .find((part) => part.type === 'timeZoneName')?.value ?? '',
  );
}

/**
 * T819 (QA S7): Chrome reports Vietnam as `Asia/Saigon`, a name the
 * `postgres:18` image (tzdata without `backward`) rejects — a shared
 * dashboard with date buckets answered 500 to every such visitor.
 */
describe('canonicalTimeZone', () => {
  it.each([
    ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
    ['Asia/Ho_Chi_Minh', 'Asia/Ho_Chi_Minh'],
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Asia/Kolkata', 'Asia/Kolkata'],
    ['Europe/Kiev', 'Europe/Kyiv'],
    ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['US/Eastern', 'America/New_York'],
    ['Etc/UTC', 'UTC'],
    ['UTC', 'UTC'],
    ['Asia/Bangkok', 'Asia/Bangkok'],
    ['Europe/Amsterdam', 'Europe/Amsterdam'],
  ])('%s → %s', (zone, expected) => {
    expect(canonicalTimeZone(zone)).toBe(expected);
  });

  it.each([['Mars/Olympus'], [''], [42], [null], [undefined]])('%s is not a zone', (zone) => {
    expect(canonicalTimeZone(zone)).toBeNull();
  });

  it.each(OFFSETS)('%s is a UTC offset, not a zone (never converted)', (zone) => {
    expect(canonicalTimeZone(zone)).toBeNull();
  });

  it.each([
    ['Etc/GMT-7', 'Etc/GMT-7'],
    ['etc/gmt+12', 'Etc/GMT+12'],
    ['Etc/GMT+0', 'UTC'],
    ['Etc/GMT0', 'UTC'],
    ['GMT', 'UTC'],
  ])('%s is the fixed zone %s', (zone, expected) => {
    expect(canonicalTimeZone(zone)).toBe(expected);
  });

  it.each([
    // tzdata 2026c `backward`.
    ['CST6CDT', 'America/Chicago'],
    ['EST5EDT', 'America/New_York'],
    ['est5edt', 'America/New_York'],
    ['MST7MDT', 'America/Denver'],
    ['PST8PDT', 'America/Los_Angeles'],
    ['EST', 'America/Panama'],
    ['MST', 'America/Phoenix'],
    ['HST', 'Pacific/Honolulu'],
    // ICU `icuzones`.
    ['SystemV/AST4', 'Etc/GMT+4'],
    ['SystemV/AST4ADT', 'America/Halifax'],
    ['SystemV/CST6', 'Etc/GMT+6'],
    ['SystemV/CST6CDT', 'America/Chicago'],
    ['SystemV/EST5', 'America/Panama'],
    ['SystemV/EST5EDT', 'America/New_York'],
    ['systemv/est5edt', 'America/New_York'],
    ['SystemV/HST10', 'Pacific/Honolulu'],
    ['SystemV/MST7', 'America/Phoenix'],
    ['SystemV/MST7MDT', 'America/Denver'],
    ['SystemV/PST8', 'Etc/GMT+8'],
    ['SystemV/PST8PDT', 'America/Los_Angeles'],
    ['SystemV/YST9', 'Etc/GMT+9'],
    ['SystemV/YST9YDT', 'America/Anchorage'],
  ])('the legacy name %s is %s', (zone, expected) => {
    expect(canonicalTimeZone(zone)).toBe(expected);
  });

  it('maps every name of IANA_PRIMARY to a primary name with the same offsets', () => {
    expect(Object.keys(IANA_PRIMARY)).toHaveLength(18 + 7 + 13);
    for (const [name, primary] of Object.entries(IANA_PRIMARY)) {
      // A target is its own primary name: no chain of names.
      expect(canonicalTimeZone(primary), primary).toBe(primary);
      expect(IANA_PRIMARY[primary], primary).toBeUndefined();
      // Winter and summer of 2026: the same clock (SystemV/* follow the 1976 US rules,
      // which differ only in March, April, late October and November).
      expect(offsetsOf(primary), name).toEqual(offsetsOf(name));
    }
  });

  it('lists each zone once, by its IANA primary name', () => {
    const zones = canonicalTimeZones();
    expect(zones).toContain('Asia/Ho_Chi_Minh');
    expect(zones).toContain('Asia/Kolkata');
    expect(zones).not.toContain('Asia/Saigon');
    expect(zones).not.toContain('Asia/Calcutta');
    for (const name of Object.keys(IANA_PRIMARY)) expect(zones).not.toContain(name);
    expect(zones.filter(isUtcOffset)).toEqual([]);
    expect(new Set(zones).size).toBe(zones.length);
    for (const zone of zones) expect(canonicalTimeZone(zone)).toBe(zone);
  });
});

describe('isUtcOffset', () => {
  it.each(OFFSETS)('%s is an offset', (zone) => {
    expect(isUtcOffset(zone)).toBe(true);
  });

  it.each(NOT_OFFSETS)('%s is not', (zone) => {
    expect(isUtcOffset(zone)).toBe(false);
  });
});

describe('timeZoneProblem', () => {
  it.each<[unknown, TimeZoneProblem | null]>([
    ...OFFSETS.map((zone): [unknown, TimeZoneProblem] => [zone, 'utc_offset']),
    ['Mars/Olympus', 'unknown'],
    ['', 'unknown'],
    [42, 'unknown'],
    ...NOT_OFFSETS.map((zone): [unknown, null] => [zone, null]),
  ])('%j → %s', (zone, expected) => {
    expect(timeZoneProblem(zone)).toBe(expected);
  });
});

/**
 * Every request schema with a time zone (research §1: 13 places with the
 * CLI `setup`, `apps/api/test/unit/cli.test.ts`): an offset is
 * `INVALID_TIME_ZONE` with `params.hint` at the zone's path; an IANA name
 * is stored by its primary name (`EST5EDT` → `America/New_York`).
 */
describe.each<[string, z.ZodType, Record<string, unknown>, readonly (string | number)[]]>([
  [
    'setupRequestSchema',
    setupRequestSchema,
    {
      email: 'an@example.com',
      password: 'Correct-Horse-9',
      display_name: 'An',
      org_name: 'A',
    },
    ['timezone'],
  ],
  ['updateMeRequestSchema', updateMeRequestSchema, {}, ['timezone']],
  [
    'createOrganizationRequestSchema',
    createOrganizationRequestSchema,
    { name: 'Acme' },
    ['timezone'],
  ],
  [
    'updateOrganizationRequestSchema',
    updateOrganizationRequestSchema,
    {},
    ['settings', 'timezone'],
  ],
  ['acceptInvitationRequestSchema', acceptInvitationRequestSchema, {}, ['timezone']],
  ['widgetDataRequestSchema', widgetDataRequestSchema, {}, ['timezone']],
  ['widgetOptionsRequestSchema', widgetOptionsRequestSchema, {}, ['timezone']],
  ['widgetRecordsRequestSchema', widgetRecordsRequestSchema, {}, ['timezone']],
  ['widgetExportQuerySchema', widgetExportQuerySchema, {}, ['timezone']],
  ['shareExportQuerySchema', shareExportQuerySchema, {}, ['tz']],
  ['aiAskRequestSchema', aiAskRequestSchema, { question: 'Revenue by month' }, ['timezone']],
  [
    'aggregateRecordsInputSchema',
    aggregateRecordsInputSchema,
    {
      table_id: 'tbl_A1b2C3d4E5f6G7h8',
      metrics: [{ aggregation: 'count' }],
    },
    ['timezone'],
  ],
])('%s', (_name, schema, base, path) => {
  const withZone = (zone: string): Record<string, unknown> => {
    const input: Record<string, unknown> = structuredClone(base);
    let target = input;
    for (const key of path.slice(0, -1)) {
      target = (target[key] ??= {}) as Record<string, unknown>;
    }
    target[path.at(-1) as string] = zone;
    return input;
  };
  const zoneOf = (output: unknown): unknown =>
    path.reduce<unknown>((value, key) => (value as Record<string | number, unknown>)[key], output);

  it.each(OFFSETS)('refuses the offset %s with INVALID_TIME_ZONE and a hint', (zone) => {
    const result = schema.safeParse(withZone(zone));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path,
        message: expect.stringContaining('UTC offset') as string,
        params: { code: 'INVALID_TIME_ZONE', hint: TIME_ZONE_HINT },
      }),
    ]);
  });

  it('refuses an unknown name with the same code and hint', () => {
    expect(schema.safeParse(withZone('Mars/Olympus')).error?.issues).toEqual([
      expect.objectContaining({
        path,
        message: 'Must be an IANA time zone',
        params: { code: 'INVALID_TIME_ZONE', hint: TIME_ZONE_HINT },
      }),
    ]);
  });

  it.each([
    ['Etc/GMT-7', 'Etc/GMT-7'],
    ['Etc/GMT+12', 'Etc/GMT+12'],
    ['UTC', 'UTC'],
    ['Etc/UTC', 'UTC'],
    ['EST5EDT', 'America/New_York'],
    ['SystemV/PST8PDT', 'America/Los_Angeles'],
    ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
  ])('stores %s as %s', (zone, expected) => {
    expect(zoneOf(schema.parse(withZone(zone)))).toBe(expected);
  });
});

describe('timeZoneSchema', () => {
  it('stores the IANA primary name', () => {
    expect(timeZoneSchema.parse('Asia/Saigon')).toBe('Asia/Ho_Chi_Minh');
    expect(
      setupRequestSchema.parse({
        email: 'an@example.com',
        password: 'Correct-Horse-9',
        display_name: 'An',
        org_name: 'A',
        timezone: 'Asia/Saigon',
      }).timezone,
    ).toBe('Asia/Ho_Chi_Minh');
    expect(widgetDataRequestSchema.parse({ timezone: 'Asia/Calcutta' }).timezone).toBe(
      'Asia/Kolkata',
    );
  });

  it('stores the zone of a schedule trigger by its IANA primary name (T901)', () => {
    const parse = (timezone: string | null) =>
      scheduleTriggerSchema.parse({ type: 'schedule', cron: '0 8 * * *', timezone }).timezone;
    expect(parse('Asia/Saigon')).toBe('Asia/Ho_Chi_Minh');
    expect(parse('EST5EDT')).toBe('America/New_York');
    expect(parse(null)).toBeNull();
    // The server answers INVALID_TIME_ZONE (automation validation), not the schema:
    // an offset is kept as sent, never converted.
    expect(parse('Mars/Olympus')).toBe('Mars/Olympus');
    expect(parse('+07:00')).toBe('+07:00');
  });

  it('still refuses an unknown zone', () => {
    expect(timeZoneSchema.safeParse('Mars/Olympus').success).toBe(false);
  });
});
