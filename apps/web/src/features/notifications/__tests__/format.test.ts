import { describe, expect, it } from 'vitest';

import { hourLabel, timeZoneLabel } from '../settings/format';

describe('hourLabel', () => {
  it.each([
    [0, 'en', '00:00'],
    [8, 'en', '08:00'],
    [23, 'vi', '23:00'],
  ])('%i in %s → %s', (hour, locale, label) => {
    expect(hourLabel(hour, locale)).toBe(label);
  });
});

describe('timeZoneLabel', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  it.each([
    ['Asia/Ho_Chi_Minh', /^Asia\/Ho_Chi_Minh \(GMT\+7\)$/u],
    // ICU versions write UTC's offset as "GMT" or "GMT+0".
    ['UTC', /^UTC \(GMT(\+0)?\)$/u],
    ['Not/AZone', /^Not\/AZone$/u],
  ])('%s', (zone, label) => {
    expect(timeZoneLabel(zone, 'en', now)).toMatch(label);
  });
});
