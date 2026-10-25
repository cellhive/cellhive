import { describe, expect, it } from 'vitest';

import { toGridField } from '../../../grid/types';
import { cardHeight, cardLayout, isCodeField } from '../components/KanbanCard';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';

function field(id: string, type: string, options: unknown = {}): FieldDto {
  return {
    id,
    table_id: 'tbl_Tickets000000001',
    name: id,
    type,
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
  } as FieldDto;
}

const code = toGridField(field('fld_code', 'auto_number'));
const status = toGridField(field('fld_status', 'text'));
const due = toGridField(field('fld_due', 'datetime'));

describe('kanban card layout (design "Kanban")', () => {
  it('shows the first code field above the title, the other fields as values', () => {
    expect(isCodeField(code)).toBe(true);
    expect(isCodeField(status)).toBe(false);
    const layout = cardLayout([status, code, due]);
    expect(layout.code).toBe(code);
    expect(layout.values).toEqual([status, due]);
  });

  it('estimates the tallest card: code line, two title lines, rows of three values', () => {
    // Padding 12 + 12 and border 1 + 1 (4 px grid, T322b), two 18 px title lines.
    const title = 26 + 36;
    expect(cardHeight([])).toBe(title);
    expect(cardHeight([code])).toBe(title + 20);
    expect(cardHeight([code, status, due])).toBe(title + 20 + 8 + 22);
    expect(cardHeight([status, due, status, due])).toBe(title + 8 + 22 * 2 + 4);
    // At most three rows of values.
    expect(cardHeight(Array.from({ length: 20 }, () => due))).toBe(title + 8 + 22 * 3 + 8);
  });
});
