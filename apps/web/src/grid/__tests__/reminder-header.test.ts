import { describe, expect, it } from 'vitest';

import { HEADER_ICONS, headerIcon, toGridColumns } from '../columns';
import { toGridField } from '../types';

import type { FieldDto } from '@cellhive/contracts';

/** (T554) A date field with a reminder: alarm icon; a reminder not sent: crossed out. */
function due(options: Record<string, unknown>): FieldDto {
  return {
    id: 'fld_Due0000000000001',
    table_id: 'tbl_Tasks00000000001',
    name: 'Due',
    type: 'datetime',
    options: { style: { format: 'dd/MM/yyyy' }, ...options },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: '2026-10-17T00:00:00.000Z',
    updated_at: '2026-10-17T00:00:00.000Z',
  };
}

const REMINDER = {
  offset_minutes: -1440,
  time_of_day: null,
  recipients: 'field_user',
  user_field_id: 'fld_Owner00000000001',
};

describe('reminder column header (T554)', () => {
  it.each([
    ['no reminder', {}, undefined, headerIcon('datetime')],
    ['reminder off (null)', { reminder: null }, undefined, headerIcon('datetime')],
    ['a reminder', { reminder: REMINDER }, undefined, headerIcon('alarm')],
    [
      'a reminder not sent',
      { reminder: REMINDER },
      new Set(['fld_Due0000000000001']),
      headerIcon('alarmOff'),
    ],
  ])('%s', (_label, options, reminderOff, icon) => {
    const [column] = toGridColumns([toGridField(due(options))], {
      hasMenu: true,
      ...(reminderOff === undefined ? {} : { reminderOff }),
    });
    expect(column?.icon).toBe(icon);
  });

  it('draws both icons as stroked sprites', () => {
    for (const glyph of ['alarm', 'alarmOff'] as const) {
      const svg = HEADER_ICONS[headerIcon(glyph)]?.({ fgColor: '#fff', bgColor: '#5B6470' });
      expect(svg).toContain('stroke="#5B6470"');
    }
  });
});
