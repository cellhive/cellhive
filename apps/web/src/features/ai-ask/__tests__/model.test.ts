import { describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import { ApiError } from '../../../lib/api/client';
import { askErrorOf } from '../model/errors';
import { filterValueText, interpretationChips, type Translate } from '../model/interpretation';
import {
  clearSessions,
  MAX_ENTRIES,
  readSession,
  sessionKey,
  writeSession,
  type AskEntry,
} from '../model/session';
import { askSuggestions } from '../model/suggestions';

import type { AiAskInterpretation, FieldDto } from '@cellhive/contracts';

/** T914: the pure parts of "Ask AI" — suggestions, interpretation chips, errors, session. */

const field = (name: string, type: string, extra: Partial<FieldDto> = {}) =>
  ({ id: `fld_${name}`, name, type, options: {}, ...extra }) as unknown as FieldDto;
const status = field('Trạng thái', 'select', {
  options: { options: [{ id: 'opt_1', name: 'Mới' }] },
});
const tags = field('Nhãn', 'select', {
  options: { multiple: true, options: [{ id: 'opt_2', name: 'A' }] },
});
const amount = field('amount', 'number');
const date = field('ngày', 'datetime');
const owner = field('owner', 'user');
const title = field('title', 'text');

/** A fake `t`: the key and its parameters, enough to check what is said. */
const fakeT: Translate = (key, params) =>
  params === undefined || Object.keys(params).length === 0
    ? key
    : `${key}(${Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(',')})`;

describe('askSuggestions', () => {
  it.each<[string, FieldDto[], string[]]>([
    [
      'number, date and a select: total by month, count per group, top group',
      [title, amount, date, status],
      ['suggestions.sumByMonth', 'suggestions.countBy', 'suggestions.topBy'],
    ],
    [
      'a user field when no single select has options',
      [title, tags, owner, amount],
      ['suggestions.countBy', 'suggestions.topBy', 'suggestions.total'],
    ],
    [
      'a date without numbers: a count per month',
      [title, date],
      ['suggestions.countByMonth', 'suggestions.count'],
    ],
    ['only text: the record count', [title], ['suggestions.count']],
    [
      'a locked or list formula is no number',
      [
        title,
        field('lãi', 'formula', {
          result_type: { kind: 'number', list: false },
          locked: true,
        }),
        field('các số', 'lookup', {
          result_type: { kind: 'number', list: true },
        }),
      ],
      ['suggestions.count'],
    ],
  ])('%s', (_name, fields, expected) => {
    expect(askSuggestions('Orders', fields).map((suggestion) => suggestion.key)).toEqual(expected);
  });

  it('names the real fields', () => {
    expect(askSuggestions('Orders', [amount, date, status])).toEqual([
      { key: 'suggestions.sumByMonth', params: { number: 'amount' } },
      { key: 'suggestions.countBy', params: { table: 'Orders', field: 'Trạng thái' } },
      { key: 'suggestions.topBy', params: { number: 'amount', field: 'Trạng thái' } },
    ]);
  });
});

const base: AiAskInterpretation = {
  metric: 'sum',
  field: { id: 'fld_amount', name: 'amount' },
  dimension: { id: 'fld_date', name: 'ngày' },
  bucket: 'month',
  series: null,
  series_bucket: null,
  filter_logic: 'and',
  filters: [],
  compare: null,
};

describe('interpretationChips', () => {
  it('metric, grouping with its bucket, split, comparison', () => {
    expect(
      interpretationChips(
        {
          ...base,
          series: { id: 'fld_owner', name: 'owner' },
          compare: null,
        },
        fakeT,
        'en',
      ).map((chip) => chip.text),
    ).toEqual([
      'metrics.sum(field=amount)',
      'dimension.bucket(field=ngày,bucket=buckets.month)',
      'series.plain(field=owner)',
    ]);
    expect(
      interpretationChips(
        { ...base, metric: 'count', field: null, dimension: null, bucket: null, compare: 'month' },
        fakeT,
        'en',
      ).map((chip) => chip.text),
    ).toEqual(['metrics.count(field=)', 'compare.month']);
  });

  it('filters: lists, text, empty, "any of" only for several or-ed filters', () => {
    const chips = interpretationChips(
      {
        ...base,
        filter_logic: 'or',
        filters: [
          {
            field: { id: 'fld_s', name: 'Trạng thái' },
            operator: 'intersects',
            value: ['Mới', 'Xong'],
          },
          { field: { id: 'fld_t', name: 'title' }, operator: 'intersects', value: 'gấp' },
          { field: { id: 'fld_n', name: 'Ghi chú' }, operator: 'empty', value: null },
        ],
      },
      fakeT,
      'en',
    );
    expect(chips.map((chip) => chip.text).slice(2)).toEqual([
      'anyOf',
      'operators.intersectsList(field=Trạng thái,value=Mới, Xong)',
      'operators.intersectsText(field=title,value=gấp)',
      'operators.empty(field=Ghi chú,value=)',
    ]);
    const single = interpretationChips(
      {
        ...base,
        filter_logic: 'or',
        filters: [{ field: { id: 'fld_n', name: 'n' }, operator: 'disjoint', value: ['A'] }],
      },
      fakeT,
      'en',
    );
    expect(single.map((chip) => chip.kind)).toEqual(['metric', 'dimension', 'filter']);
    expect(single.at(-1)?.text).toBe('operators.disjointList(field=n,value=A)');
  });

  it.each<[unknown, string, string]>([
    ['Today', 'en', 'values.today'],
    ['CurrentUser', 'en', 'values.me'],
    ['ExactDate(2026-09-25)', 'en', 'Sep 25, 2026'],
    ['ExactDate(2026-09-25 09:30)', 'vi', '25 thg 9, 2026 09:30'],
    [1500000, 'vi', '1.500.000'],
    [true, 'en', 'values.checked'],
    [['Mới', 'Xong'], 'en', 'Mới, Xong'],
    [null, 'en', ''],
    [{ name: 'An' }, 'en', 'An'],
  ])('a filter value %j in %s reads %j', (value, locale, text) => {
    expect(filterValueText(value, fakeT, locale)).toBe(text);
  });
});

describe('askErrorOf', () => {
  it.each<[string, number, string[], string, boolean]>([
    [
      'AI_QUOTA_EXCEEDED',
      429,
      [],
      "Your organization has used up today's AI quota. Try again in 3 hours.",
      false,
    ],
    [
      'AI_TIMEOUT',
      504,
      [],
      'The AI took longer than 90 seconds. Try again, or ask a simpler question.',
      true,
    ],
    [
      'AI_NOT_CONFIGURED',
      422,
      [],
      'AI is turned off or not set up for this organization. An organization admin can set it up in Organization settings › AI.',
      false,
    ],
    [
      'QUERY_TIMEOUT',
      504,
      [],
      'The numbers took too long to compute. Try again, or narrow the question with a filter.',
      true,
    ],
    [
      'VALIDATION_FAILED',
      422,
      ['WIDGET_TOO_LARGE'],
      'The answer has too many groups (1,200; at most 1,000). Ask for a coarser grouping, or add a filter.',
      false,
    ],
    [
      'AI_PROVIDER_ERROR',
      502,
      [],
      'The AI provider could not be reached or answered with an error.',
      true,
    ],
  ])('%s', async (code, httpStatus, details, message, retry) => {
    const i18n = await createTestI18n('en');
    const error = new ApiError({
      status: httpStatus,
      code: code as never,
      errors: details.map((detail) => ({
        path: '',
        code: detail,
        message: detail,
        params: { groups: 1200, limit: 1000 },
      })),
      ...(httpStatus === 429 ? { retry_after: 10_800 } : {}),
    });
    expect(askErrorOf(error, i18n)).toEqual({ message, retry });
  });
});

describe('session', () => {
  it('keeps the last questions per user and table, in memory', () => {
    clearSessions();
    const key = sessionKey('usr_1', 'tbl_1');
    const entries: AskEntry[] = Array.from({ length: MAX_ENTRIES + 2 }, (_, index) => ({
      id: index,
      question: `q${String(index)}`,
      outcome: { kind: 'unanswerable' },
    }));
    writeSession(key, entries, 'draft');
    expect(readSession(key).entries.map((entry) => entry.id)).toEqual(
      entries.slice(2).map((entry) => entry.id),
    );
    expect(readSession(key).draft).toBe('draft');
    expect(readSession(sessionKey('usr_2', 'tbl_1'))).toEqual({ entries: [], draft: '' });
  });
});
