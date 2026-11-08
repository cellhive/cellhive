import { describe, expect, it } from 'vitest';

import {
  aiCellReasonOf,
  aiCellStateOf,
  aiConfigOf,
  aiPausedOf,
  aiRetryAtOf,
  aiTaskOf,
  estimateAiTokens,
  isAiConfigHidden,
  isAiField,
} from '../ai-field';

import type { FieldDto } from '@cellhive/contracts';

const AI = {
  task: 'translate',
  prompt: 'Translate: {{ [Mô tả] }}',
  instructions: 'Short',
  auto_update: false,
  max_output_tokens: 100,
};

describe('AI fields (T915)', () => {
  it.each<[string, Pick<FieldDto, 'type' | 'options'>, boolean]>([
    ['text with AI', { type: 'text', options: { ai: AI } }, true],
    ['select with AI', { type: 'select', options: { multiple: false, options: [], ai: AI } }, true],
    ['AI removed', { type: 'text', options: { ai: null } }, false],
    ['plain text', { type: 'text', options: {} }, false],
    ['a formula', { type: 'formula', options: { ai: AI } }, false],
  ])('%s', (_case, field, expected) => {
    expect(isAiField(field)).toBe(expected);
  });

  // T1006: readers other than its managers get `options.ai = { task }` and no `ai_state`.
  it.each<[string, Pick<FieldDto, 'type' | 'options'>, boolean, boolean, string | null]>([
    ['whole configuration', { type: 'text', options: { ai: AI } }, true, false, 'translate'],
    [
      '{ task } only',
      { type: 'text', options: { ai: { task: 'classify' } } },
      true,
      true,
      'classify',
    ],
    [
      'a select with { task } only',
      { type: 'select', options: { multiple: false, options: [], ai: { task: 'classify' } } },
      true,
      true,
      'classify',
    ],
    ['AI removed', { type: 'text', options: { ai: null } }, false, false, null],
    ['an empty object', { type: 'text', options: { ai: {} } }, false, false, null],
    [
      'a formula with { task }',
      { type: 'formula', options: { ai: { task: 'custom' } } },
      false,
      false,
      null,
    ],
  ])('%s: AI field %s, configuration hidden %s, task %s', (_case, field, ai, hidden, task) => {
    expect(isAiField(field)).toBe(ai);
    expect(isAiConfigHidden(field)).toBe(hidden);
    expect(aiTaskOf(field)).toBe(task);
    if (hidden) expect(aiConfigOf(field)).toBeNull();
  });

  it('reads options.ai with its defaults', () => {
    expect(aiConfigOf({ type: 'text', options: { ai: AI } })).toEqual(AI);
    expect(aiConfigOf({ type: 'text', options: { ai: { prompt: 'x' } } })).toEqual({
      task: 'custom',
      prompt: 'x',
      instructions: null,
      auto_update: true,
      max_output_tokens: 300,
    });
  });

  it('reads the state of a cell and why (T1002: `{ state, reason? }`)', () => {
    const record = {
      meta: {
        ai: {
          fld_Summary000000001: { state: 'running' as const },
          fld_Level00000000001: { state: 'failed' as const, reason: 'truncated' as const },
        },
      },
    };
    expect(aiCellStateOf(record, 'fld_Summary000000001')).toBe('running');
    expect(aiCellReasonOf(record, 'fld_Summary000000001')).toBeUndefined();
    expect(aiCellStateOf(record, 'fld_Level00000000001')).toBe('failed');
    expect(aiCellReasonOf(record, 'fld_Level00000000001')).toBe('truncated');
    expect(aiCellStateOf(record, 'fld_Other0000000001')).toBeUndefined();
    expect(aiCellStateOf({}, 'fld_Summary000000001')).toBeUndefined();
    expect(aiCellStateOf(undefined, 'fld_Summary000000001')).toBeUndefined();
  });

  const state = (
    queued: number,
    paused: number,
    extra: Partial<NonNullable<FieldDto['ai_state']>> = {},
  ) => ({
    ai_state: {
      queued,
      failed: 0,
      paused,
      paused_reason: null,
      paused_detail: null,
      retry_at: null,
      ...extra,
    },
  });

  it('reads the paused rows of a field, why and what the provider rejected', () => {
    expect(aiPausedOf({})).toBeNull();
    expect(aiPausedOf(state(3, 0))).toBeNull();
    expect(aiPausedOf(state(0, 4, { paused_reason: 'quota' }))).toEqual({
      count: 4,
      reason: 'quota',
      detail: null,
    });
    expect(
      aiPausedOf(state(0, 4, { paused_reason: 'provider_error', paused_detail: 'unauthorized' })),
    ).toEqual({ count: 4, reason: 'provider_error', detail: 'unauthorized' });
  });

  it('reads when queued rows go on while the provider asked to wait', () => {
    const at = '2026-11-07T10:00:30.000Z';
    const before = Date.parse('2026-11-07T10:00:00.000Z');
    expect(aiRetryAtOf({}, before)).toBeNull();
    expect(aiRetryAtOf(state(3, 0), before)).toBeNull();
    expect(aiRetryAtOf(state(3, 0, { retry_at: at }), before)).toBe(at);
    // Past: the rows go on already.
    expect(aiRetryAtOf(state(3, 0, { retry_at: at }), Date.parse(at))).toBeNull();
    // Paused cells say more: the banner shows those.
    expect(aiRetryAtOf(state(3, 1, { retry_at: at, paused_reason: 'quota' }), before)).toBeNull();
  });

  it.each([
    // The server's rough upper bound: ceil(code points / 3) + the longest answer, per row.
    ['upper bound', 10, { prompt: 'abcdef', max_output_tokens: 100 }, undefined, 1_020],
    ['code points, not UTF-16 units', 1, { prompt: '😀😀😀', max_output_tokens: 0 }, undefined, 1],
    ['a preview’s average', 120, { prompt: 'x', max_output_tokens: 300 }, 80.5, 9_660],
  ])('estimates tokens: %s', (_case, rows, config, perRow, expected) => {
    expect(estimateAiTokens(rows, config, perRow)).toBe(expected);
  });
});
