import { GridCellKind } from '@glideapps/glide-data-grid';
import { describe, expect, it } from 'vitest';

import { themeTokens } from '../../../test/tokens';
import { columnHeaderLabel } from '../a11y';
import { renderAiCell } from '../cellRenderers/ai';
import { headerIconOf } from '../columns';
import { isAiStateCell } from '../customCells/ai';
import { isComputedMarkCell } from '../customCells/computed';
import { isEditableField } from '../editors/index';
import { tokensToAppearance } from '../theme';
import { toGridField, type CellRenderContext } from '../types';

import type { FieldDto, RecordDto } from '@cellhive/contracts';
import type { TFunction } from 'i18next';

/**
 * T915: cells of AI fields (FRONTEND §4.10, CONTRACTS §29.5) — never
 * editable; a lock when the reader cannot read the prompt's fields; the
 * value under its state (`record.meta.ai`) while it waits, failed or paused.
 */

const NOW = '2026-11-01T00:00:00.000Z';
const SUMMARY = 'fld_Summary000000001';
const AI = { task: 'summarize', prompt: 'Sum {{ [Mô tả] }}', instructions: null };

function aiField(extra: Partial<FieldDto> = {}): FieldDto {
  return {
    id: SUMMARY,
    table_id: 'tbl_Tickets000000001',
    name: 'Summary',
    type: 'text',
    options: { style: { type: 'plain' }, default_value: null, ai: AI },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 3,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  };
}

function record(value: unknown, state?: string): RecordDto {
  return {
    id: 'rec_A000000000000001',
    created_at: NOW,
    updated_at: NOW,
    version: 2,
    fields: { [SUMMARY]: value },
    ...(state === undefined ? {} : { meta: { ai: { [SUMMARY]: state } } }),
  } as RecordDto;
}

const ctx: CellRenderContext = {
  locale: { locale: 'en', timeZone: 'UTC' },
  palette: tokensToAppearance(themeTokens('light')).palette,
  labels: {
    formerMember: 'Former member',
    ai: {
      queued: 'waiting for AI',
      running: 'AI is generating',
      failed: 'AI could not generate it',
      paused: 'AI paused',
      locked: 'Cannot read its fields',
    },
  },
};

describe('AI cells (T915)', () => {
  it('marks the column: read-only, the sparkles icon, its accessible name', () => {
    const field = toGridField(aiField());
    expect(field.ai).toEqual({ locked: false });
    expect(isEditableField(field)).toBe(false);
    expect(headerIconOf(field)).toBe('ob-sparkles');
    const t = ((key: string, options?: Record<string, unknown>) =>
      key === 'header.ai'
        ? `${String(options?.['label'])}, filled by AI`
        : `${String(options?.['name'])}, text`) as TFunction<'grid'>;
    expect(columnHeaderLabel(field, t)).toBe('Summary, text, filled by AI');
    // A text field without AI keeps its own.
    expect(toGridField(aiField({ options: { ai: null } })).ai).toBeUndefined();
  });

  it('draws the value as its type when it is current', () => {
    const cell = renderAiCell(toGridField(aiField()), record('A summary'), ctx);
    expect(cell.kind).toBe(GridCellKind.Text);
    expect((cell as { data: string }).data).toBe('A summary');
  });

  it.each([
    ['queued', 'A summary', 'A summary (waiting for AI)'],
    ['running', null, 'AI is generating'],
    ['failed', 'Old', 'Old (AI could not generate it)'],
    ['paused', null, 'AI paused'],
  ])('shows the %s state over the value', (state, value, a11y) => {
    const cell = renderAiCell(toGridField(aiField()), record(value, state), ctx);
    expect(isAiStateCell(cell)).toBe(true);
    if (!isAiStateCell(cell)) return;
    expect(cell.data).toMatchObject({ state, text: value ?? '' });
    expect(cell.copyData).toBe(a11y);
    expect(cell.readonly).toBe(true);
  });

  it('locks every cell when the reader cannot read the prompt’s fields', () => {
    const cell = renderAiCell(toGridField(aiField({ locked: true })), record(null), ctx);
    expect(isComputedMarkCell(cell)).toBe(true);
    expect(cell.copyData).toBe('Cannot read its fields');
  });

  it('draws a select AI field with its option chip', () => {
    const field = toGridField(
      aiField({
        type: 'select',
        options: {
          multiple: false,
          options: [{ id: 'opt_High000000000001', name: 'Cao', color: 4 }],
          ai: { ...AI, task: 'classify' },
        },
      }),
    );
    const cell = renderAiCell(field, record('Cao'), ctx);
    expect(cell.kind).toBe(GridCellKind.Custom);
    expect(cell.copyData).toBe('Cao');
  });
});
