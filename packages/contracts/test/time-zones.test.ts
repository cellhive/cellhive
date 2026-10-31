import { describe, expect, it } from 'vitest';

import { setupRequestSchema, timeZoneSchema } from '../src/auth.js';
import { scheduleTriggerSchema } from '../src/automation-triggers/schedule.js';
import { widgetDataRequestSchema } from '../src/dashboard-data.js';
import { canonicalTimeZone, canonicalTimeZones } from '../src/time-zones.js';

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

  it('lists each zone once, by its IANA primary name', () => {
    const zones = canonicalTimeZones();
    expect(zones).toContain('Asia/Ho_Chi_Minh');
    expect(zones).toContain('Asia/Kolkata');
    expect(zones).not.toContain('Asia/Saigon');
    expect(zones).not.toContain('Asia/Calcutta');
    expect(new Set(zones).size).toBe(zones.length);
    for (const zone of zones) expect(canonicalTimeZone(zone)).toBe(zone);
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
    expect(parse(null)).toBeNull();
    // The server answers INVALID_TIME_ZONE (automation validation), not the schema.
    expect(parse('Mars/Olympus')).toBe('Mars/Olympus');
  });

  it('still refuses an unknown zone', () => {
    expect(timeZoneSchema.safeParse('Mars/Olympus').success).toBe(false);
  });
});
