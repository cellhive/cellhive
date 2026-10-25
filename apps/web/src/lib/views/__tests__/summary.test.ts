import { describe, expect, it } from 'vitest';

import { parseDraft } from '../config';
import { formatSummary, shortCount, type SummaryTexts } from '../summary/format';
import { applicableSummaries, summaryMenuGroups } from '../summary/functions';
import { changesSummaries, summaryRequestOf } from '../summary/use-summaries';

import type { ChannelMessage } from '../../realtime/socket';
import type { FieldDto } from '@cellhive/contracts';

const field = (type: string, options: unknown = {}, extra: Partial<FieldDto> = {}): FieldDto =>
  ({
    id: `fld_${type.padEnd(16, '0').slice(0, 16)}`,
    table_id: 'tbl_0000000000000000',
    name: type,
    type,
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  }) as FieldDto;

const texts: SummaryTexts = {
  label: (fn) => `<${fn}>`,
  days: (days) => `(${String(days)} days)`,
};
const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const en = { locale: 'en', timeZone: 'UTC' };

describe('summary menu by field type (CONTRACTS §15)', () => {
  it.each<[string, FieldDto, string[][]]>([
    [
      'text',
      field('text'),
      [
        ['count', 'count_all', 'filled', 'empty', 'unique'],
        ['percent', 'percent_filled', 'percent_empty'],
      ],
    ],
    [
      'number',
      field('number'),
      [
        ['count', 'count_all', 'filled', 'empty', 'unique'],
        ['percent', 'percent_filled', 'percent_empty'],
        ['number', 'sum', 'avg', 'min', 'max', 'range'],
      ],
    ],
    [
      'created_at',
      field('created_at'),
      [
        ['count', 'count_all', 'filled', 'empty', 'unique'],
        ['percent', 'percent_filled', 'percent_empty'],
        ['date', 'earliest', 'latest', 'date_range'],
      ],
    ],
    [
      'checkbox',
      field('checkbox'),
      [
        ['count', 'count_all'],
        ['checkbox', 'checked', 'unchecked', 'percent_checked'],
      ],
    ],
    [
      'formula number',
      field('formula', {}, { result_type: { kind: 'number', list: false } }),
      [
        ['count', 'count_all', 'filled', 'empty', 'unique'],
        ['percent', 'percent_filled', 'percent_empty'],
        ['number', 'sum', 'avg', 'min', 'max', 'range'],
      ],
    ],
    [
      'lookup list of numbers: counts only',
      field('lookup', {}, { result_type: { kind: 'number', list: true } }),
      [
        ['count', 'count_all', 'filled', 'empty', 'unique'],
        ['percent', 'percent_filled', 'percent_empty'],
      ],
    ],
    [
      'link',
      field('link'),
      [
        ['count', 'count_all', 'filled', 'empty', 'unique'],
        ['percent', 'percent_filled', 'percent_empty'],
      ],
    ],
  ])('%s', (_label, item, groups) => {
    expect(summaryMenuGroups(item).map((group) => [group.key, ...group.functions])).toEqual(groups);
  });

  it('applicable summaries: stale functions, locked and unknown fields left out', () => {
    const amount = field('number');
    const title = field('text');
    const locked = field(
      'formula',
      {},
      { locked: true, result_type: { kind: 'number', list: false } },
    );
    expect(
      applicableSummaries(
        {
          [amount.id]: 'sum',
          [title.id]: 'sum',
          [locked.id]: 'sum',
          fld_unknown000000000: 'filled',
        },
        [amount, title, locked],
      ),
    ).toEqual({ [amount.id]: 'sum' });
  });
});

describe('summary texts (board "Cách đọc số")', () => {
  const money = field('number', { style: { type: 'currency', currency_code: 'VND' } });
  it('a sum in the field style; a sum of ratings as a number', () => {
    expect(formatSummary(money, { fn: 'sum', value: 1_284_500_000 }, vi, texts)).toEqual({
      label: '<sum>',
      value: '1.284.500.000 ₫',
    });
    const rating = field('number', { style: { type: 'rating', max: 5 } });
    expect(formatSummary(rating, { fn: 'sum', value: 9 }, en, texts).value).toBe('9');
    expect(formatSummary(rating, { fn: 'avg', value: 3.456 }, en, texts).value).toBe('3.46');
  });

  it('percentages with their count, ranges and date ranges', () => {
    expect(
      formatSummary(field('text'), { fn: 'percent_filled', value: 46 / 48, count: 46 }, vi, texts)
        .value,
    ).toBe('46 (96%)');
    expect(
      formatSummary(money, { fn: 'range', value: { min: 1_980_000, max: 96_300_000 } }, vi, texts)
        .value,
    ).toBe('1.980.000 ₫ → 96.300.000 ₫');
    const joined = field('datetime', { style: { format: 'dd/MM/yyyy' } });
    expect(
      formatSummary(
        joined,
        { fn: 'date_range', value: { min: '2022-01-02', max: '2024-11-08', days: 1041 } },
        vi,
        texts,
      ).value,
    ).toBe('02/01/2022 → 08/11/2024 (1041 days)');
    expect(formatSummary(joined, { fn: 'earliest', value: null }, vi, texts).value).toBeNull();
    expect(formatSummary(field('text'), { fn: 'unique', value: 1234 }, en, texts).value).toBe(
      '1,234',
    );
  });

  it.each([
    [48, '48'],
    [1234, '1.2k'],
    [203_000, '203k'],
    [2_450_000, '2.4M'],
  ])('short count %i → %s', (count, text) => {
    expect(shortCount(count, 'en')).toBe(text);
  });
});

describe('summary request (T472)', () => {
  const query = {
    view_id: 'viw_1',
    filter: { op: 'and', items: [] },
    filter_mode: 'replace' as const,
  };
  it('sends the summaries only when they differ from the saved ones', () => {
    expect(
      summaryRequestOf({ query, summaries: { fld_a: 'sum' }, saved: { fld_a: 'sum' } }),
    ).toEqual({ view_id: 'viw_1', filter: query.filter, filter_mode: 'replace' });
    expect(
      summaryRequestOf({
        query: { view_id: 'viw_1', search: 'an', group: [{ field: 'fld_g' }] },
        summaries: { fld_a: 'avg' },
        saved: undefined,
      }),
    ).toEqual({
      view_id: 'viw_1',
      search: 'an',
      group: [{ field: 'fld_g', direction: 'asc' }],
      summaries: { fld_a: 'avg' },
    });
  });

  it('record messages and recomputed values refresh; others do not', () => {
    expect(changesSummaries({ type: 'record.updated' } as ChannelMessage)).toBe(true);
    expect(changesSummaries({ type: 'record.batch' } as ChannelMessage)).toBe(true);
    expect(changesSummaries({ type: 'computed.recomputing' } as ChannelMessage)).toBe(true);
    expect(changesSummaries({ type: 'schema.changed' } as ChannelMessage)).toBe(false);
  });

  it('a grid draft with summaries survives a reload', () => {
    expect(parseDraft(JSON.stringify({ summaries: { fld_a000000000000000: 'sum' } }))).toEqual({
      summaries: { fld_a000000000000000: 'sum' },
    });
    expect(parseDraft(JSON.stringify({ summaries: { fld_a000000000000000: 'median' } }))).toEqual(
      {},
    );
  });
});
