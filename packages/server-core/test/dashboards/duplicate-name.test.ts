import { MAX_DASHBOARD_NAME_LENGTH } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { duplicateDashboardName } from '../../src/dashboards/index.js';

describe('duplicateDashboardName', () => {
  const none = () => false;

  it.each([
    ['Sales', 'en', 'Sales (copy)'],
    ['Sales', 'en-US', 'Sales (copy)'],
    ['Sales', 'vi', 'Sales (bản sao)'],
    ['Sales', 'vi-VN', 'Sales (bản sao)'],
    ['Sales', null, 'Sales (copy)'],
    ['  Sales  ', 'en', 'Sales (copy)'],
  ])('%j in %s → %j', (name, locale, expected) => {
    expect(duplicateDashboardName(name, locale, none)).toBe(expected);
  });

  it('numbers the copy while the name is taken', () => {
    const taken = new Set(['sales (copy)', 'sales (copy) 2']);
    expect(duplicateDashboardName('Sales', 'en', (name) => taken.has(name.toLowerCase()))).toBe(
      'Sales (copy) 3',
    );
  });

  it('cuts long names to stay within the limit', () => {
    const long = 'x'.repeat(MAX_DASHBOARD_NAME_LENGTH);
    const first = duplicateDashboardName(long, 'vi', none);
    expect(first.length).toBe(MAX_DASHBOARD_NAME_LENGTH);
    expect(first.endsWith(' (bản sao)')).toBe(true);
    const second = duplicateDashboardName(long, 'en', (name) => name.endsWith(' (copy)'));
    expect(second.length).toBe(MAX_DASHBOARD_NAME_LENGTH);
    expect(second.endsWith(' (copy) 2')).toBe(true);
  });
});
