import { describe, expect, it } from 'vitest';

import {
  gridConfigInputSchema,
  kanbanConfigInputSchema,
  recordSummariesRequestSchema,
  summaryFunctionsOf,
  summaryKindOf,
  type SummaryResultType,
} from '../src/index.js';

const COMMON = ['count_all', 'filled', 'empty', 'unique', 'percent_filled', 'percent_empty'];

describe('summary functions by type (T472, CONTRACTS §15)', () => {
  it.each<[string, SummaryResultType | null, string, string[]]>([
    ['text', null, 'other', COMMON],
    ['auto_number', null, 'other', COMMON],
    ['select', null, 'other', COMMON],
    ['user', null, 'other', COMMON],
    ['link', null, 'other', COMMON],
    ['attachment', null, 'other', COMMON],
    ['number', null, 'number', [...COMMON, 'sum', 'avg', 'min', 'max', 'range']],
    ['datetime', null, 'date', [...COMMON, 'earliest', 'latest', 'date_range']],
    ['created_at', null, 'date', [...COMMON, 'earliest', 'latest', 'date_range']],
    ['updated_at', null, 'date', [...COMMON, 'earliest', 'latest', 'date_range']],
    ['checkbox', null, 'checkbox', ['count_all', 'checked', 'unchecked', 'percent_checked']],
    [
      'formula',
      { kind: 'number', list: false },
      'number',
      [...COMMON, 'sum', 'avg', 'min', 'max', 'range'],
    ],
    ['lookup', { kind: 'number', list: true }, 'other', COMMON],
    [
      'formula',
      { kind: 'date', list: false },
      'date',
      [...COMMON, 'earliest', 'latest', 'date_range'],
    ],
    [
      'formula',
      { kind: 'datetime', list: false },
      'date',
      [...COMMON, 'earliest', 'latest', 'date_range'],
    ],
    [
      'formula',
      { kind: 'boolean', list: false },
      'checkbox',
      ['count_all', 'checked', 'unchecked', 'percent_checked'],
    ],
    ['lookup', { kind: 'record', list: true }, 'other', COMMON],
    ['formula', null, 'other', COMMON],
  ])('%s %j → %s', (type, result, kind, functions) => {
    expect(summaryKindOf(type, result)).toBe(kind);
    expect(summaryFunctionsOf(type, result)).toEqual(functions);
  });

  it('only grid configs take summaries; unknown functions are refused', () => {
    const summaries = { fld_a000000000000000: 'sum' };
    expect(gridConfigInputSchema.safeParse({ summaries }).success).toBe(true);
    expect(kanbanConfigInputSchema.safeParse({ summaries }).success).toBe(false);
    expect(
      gridConfigInputSchema.safeParse({ summaries: { fld_a000000000000000: 'median' } }).success,
    ).toBe(false);
    expect(recordSummariesRequestSchema.safeParse({ summaries: { amount: 'avg' } }).success).toBe(
      true,
    );
    expect(recordSummariesRequestSchema.safeParse({ ids: [] }).success).toBe(false);
  });
});
