import { canonicalTimeZone, canonicalTimeZones, IANA_PRIMARY } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import type { Db } from '../../src/db/index.js';

/** The fixed zones of tzdata (`etcetera`): `Etc/GMT-14` (UTC+14) … `Etc/GMT+12` (UTC−12). */
const FIXED_ZONES = [
  ...Array.from({ length: 14 }, (_, index) => `Etc/GMT-${String(index + 1)}`),
  ...Array.from({ length: 12 }, (_, index) => `Etc/GMT+${String(index + 1)}`),
];

const INSTANTS = ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z'] as const;

/** Offset of `zone` at `instant` in minutes, by the runtime's tz data. */
function offsetMinutes(zone: string, instant: string): number {
  const text =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(instant))
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/u.exec(text);
  if (match === null) throw new Error(`unexpected offset ${text} of ${zone}`);
  if (match[1] === undefined) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * BACKLOG T1005: every zone name Cellhive stores or hands to SQL — the
 * picker's names, the targets of the legacy names, the fixed zones a
 * whole-hour offset becomes (migration 0058) — is a zone of the
 * `postgres:18` image (tzdata without `backward`), not a POSIX string it
 * would read with the sign reversed, and `AT TIME ZONE` gives the clock
 * the runtime gives.
 */
describe('time zone names on postgres:18 (T1005)', () => {
  let database: TestDatabase;
  let db: Db;
  const targets = [...new Set([...Object.values(IANA_PRIMARY), ...FIXED_ZONES, 'UTC'])].sort();

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('every name is its own primary name', () => {
    for (const zone of targets) expect(canonicalTimeZone(zone), zone).toBe(zone);
  });

  it.each([
    ['the targets of the legacy names and the fixed zones', () => targets],
    ['every zone of the pickers (canonicalTimeZones)', canonicalTimeZones],
  ])('%s are zones PostgreSQL knows by name', async (_name, names) => {
    const zones = names();
    expect(zones.length).toBeGreaterThan(20);
    const { rows } = await sql<{ name: string }>`
      SELECT zone AS name FROM unnest(${zones}::text[]) AS zone
       WHERE NOT EXISTS (SELECT 1 FROM pg_timezone_names AS known WHERE known.name = zone)
    `.execute(db.kysely);
    expect(rows.map((row) => row.name)).toEqual([]);
  });

  it('AT TIME ZONE of every target gives the runtime’s clock, winter and summer', async () => {
    for (const instant of INSTANTS) {
      const { rows } = await sql<{ name: string; minutes: number }>`
        SELECT zone AS name,
               (extract(epoch FROM (${instant}::timestamptz AT TIME ZONE zone)
                                   - (${instant}::timestamptz AT TIME ZONE 'UTC')) / 60)::int
                 AS minutes
          FROM unnest(${targets}::text[]) AS zone
      `.execute(db.kysely);
      expect(Object.fromEntries(rows.map((row) => [row.name, row.minutes]))).toEqual(
        Object.fromEntries(targets.map((zone) => [zone, offsetMinutes(zone, instant)])),
      );
    }
  });

  it('Etc/GMT-7 is seven hours ahead of UTC (the POSIX sign of its name)', async () => {
    const { rows } = await sql<{ local: string }>`
      SELECT to_char('2026-07-15T12:00:00Z'::timestamptz AT TIME ZONE 'Etc/GMT-7', 'HH24:MI') AS local
    `.execute(db.kysely);
    expect(rows[0]?.local).toBe('19:00');
  });
});
