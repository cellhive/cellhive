import { describe, expect, it } from 'vitest';

import { isValidTimeZone, toWallTime, wallTimeToEpoch, type WallTime } from '../src/index.js';

function wall(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): WallTime {
  return { year, month, day, hour, minute, second, millisecond };
}

describe('isValidTimeZone', () => {
  it.each([
    ['Asia/Ho_Chi_Minh', true],
    ['America/New_York', true],
    ['UTC', true],
    ['Not/AZone', false],
    ['', false],
  ])('%j -> %s', (tz, expected) => {
    expect(isValidTimeZone(tz)).toBe(expected);
  });
});

describe('toWallTime', () => {
  it.each([
    ['2026-09-25T02:00:00.000Z', 'Asia/Ho_Chi_Minh', wall(2026, 9, 25, 9, 0)],
    ['2026-09-24T17:00:00.000Z', 'Asia/Ho_Chi_Minh', wall(2026, 9, 25, 0, 0)],
    ['2026-03-08T06:59:59.999Z', 'America/New_York', wall(2026, 3, 8, 1, 59, 59, 999)],
    ['2026-03-08T07:00:00.000Z', 'America/New_York', wall(2026, 3, 8, 3, 0)],
    ['2026-11-01T05:30:00.000Z', 'America/New_York', wall(2026, 11, 1, 1, 30)],
    ['2026-11-01T06:30:00.000Z', 'America/New_York', wall(2026, 11, 1, 1, 30)],
    ['2026-01-01T00:00:00.000Z', 'UTC', wall(2026, 1, 1)],
  ])('%s in %s', (iso, tz, expected) => {
    expect(toWallTime(Date.parse(iso), tz)).toEqual(expected);
  });
});

describe('wallTimeToEpoch', () => {
  it.each([
    // Plain offsets.
    [wall(2026, 9, 25, 9, 0), 'Asia/Ho_Chi_Minh', '2026-09-25T02:00:00.000Z'],
    [wall(2026, 1, 15, 12, 0), 'America/New_York', '2026-01-15T17:00:00.000Z'],
    [wall(2026, 7, 15, 12, 0), 'America/New_York', '2026-07-15T16:00:00.000Z'],
    // Around the March 2026 switch in New York (02:00 EST -> 03:00 EDT on 8 March).
    [wall(2026, 3, 8, 1, 59), 'America/New_York', '2026-03-08T06:59:00.000Z'],
    [wall(2026, 3, 8, 3, 0), 'America/New_York', '2026-03-08T07:00:00.000Z'],
    // 02:30 does not exist: shifted forward by the gap (Temporal "compatible").
    [wall(2026, 3, 8, 2, 30), 'America/New_York', '2026-03-08T07:30:00.000Z'],
    // 01:30 on 1 November happens twice: the earlier (EDT) instant wins.
    [wall(2026, 11, 1, 1, 30), 'America/New_York', '2026-11-01T05:30:00.000Z'],
    [wall(2026, 11, 1, 2, 30), 'America/New_York', '2026-11-01T07:30:00.000Z'],
    [wall(2026, 3, 29, 1, 30, 15, 250), 'Europe/London', '2026-03-29T01:30:15.250Z'],
  ])('%j in %s', (input, tz, expected) => {
    expect(new Date(wallTimeToEpoch(input, tz)).toISOString()).toBe(expected);
  });
});
