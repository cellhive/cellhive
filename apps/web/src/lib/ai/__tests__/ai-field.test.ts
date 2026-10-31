import { describe, expect, it } from 'vitest';

import { aiCellStateOf, aiConfigOf, aiPausedOf, estimateAiTokens, isAiField } from '../ai-field';

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

  it('reads the state of a cell', () => {
    const record = { meta: { ai: { fld_Summary000000001: 'running' as const } } };
    expect(aiCellStateOf(record, 'fld_Summary000000001')).toBe('running');
    expect(aiCellStateOf(record, 'fld_Other0000000001')).toBeUndefined();
    expect(aiCellStateOf({}, 'fld_Summary000000001')).toBeUndefined();
    expect(aiCellStateOf(undefined, 'fld_Summary000000001')).toBeUndefined();
  });

  it('reads the paused rows of a field', () => {
    expect(aiPausedOf({})).toBeNull();
    expect(
      aiPausedOf({ ai_state: { queued: 3, failed: 0, paused: 0, paused_reason: null } }),
    ).toBeNull();
    expect(
      aiPausedOf({ ai_state: { queued: 0, failed: 1, paused: 4, paused_reason: 'quota' } }),
    ).toEqual({ count: 4, reason: 'quota' });
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
