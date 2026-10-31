import {
  automationDefinitionSchema,
  type AutomationDefinitionInput,
  type AutomationDto,
} from '@cellhive/contracts';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../../test/i18n';
import { formatClock, readCron, weekdayName, zoneOffsetLabel } from '../model/cron';
import { filterAutomations, foldText, newlyDisabled, statusCounts } from '../model/filter';
import { automationScope } from '../model/scope';
import { summarizeTrigger, type SchemaNames } from '../model/summary';

import type { TFunction } from 'i18next';

const TICKETS = 'tbl_Tickets000000001';
const ORDERS = 'tbl_Orders0000000001';

const names: SchemaNames = {
  table: (id) => ({ [TICKETS]: 'Tickets', [ORDERS]: 'Orders' })[id],
  field: (_table, id) =>
    ({
      fld_Priority00000001: 'Priority',
      fld_Due0000000000001: 'Due date',
      fld_Status0000000001: 'Status',
    })[id],
  view: (id) => (id === 'viw_Form000000000001' ? 'Support request' : undefined),
};

describe('readCron', () => {
  it.each([
    ['*/15 * * * *', { kind: 'minutes', every: 15 }],
    ['5 * * * *', { kind: 'hourly', minute: 5 }],
    ['0 8 * * *', { kind: 'daily', hour: 8, minute: 0 }],
    ['30 7 * * 1-5', { kind: 'weekdays', hour: 7, minute: 30 }],
    ['0 8 * * 1', { kind: 'weekly', weekday: 1, hour: 8, minute: 0 }],
    ['0 8 * * 7', { kind: 'weekly', weekday: 0, hour: 8, minute: 0 }],
    ['0 9 15 * *', { kind: 'monthly', day: 15, hour: 9, minute: 0 }],
    ['0 8 1 1 *', { kind: 'raw', cron: '0 8 1 1 *' }],
    ['0 8 * * 1,3', { kind: 'raw', cron: '0 8 * * 1,3' }],
    ['0 25 * * *', { kind: 'raw', cron: '0 25 * * *' }],
    ['nonsense', { kind: 'raw', cron: 'nonsense' }],
  ])('%s', (cron, expected) => {
    expect(readCron(cron)).toEqual(expected);
  });

  it('formats clocks, weekdays and zones', () => {
    expect(formatClock('en', 8, 0)).toBe('8:00 AM');
    expect(formatClock('vi', 8, 0)).toBe('08:00');
    expect(weekdayName('en', 1)).toBe('Monday');
    expect(weekdayName('en', 0)).toBe('Sunday');
    expect(zoneOffsetLabel('Asia/Ho_Chi_Minh')).toBe('GMT+7');
    expect(zoneOffsetLabel('Not/AZone')).toBeNull();
  });
});

function automation(definition: AutomationDefinitionInput) {
  return { definition: automationDefinitionSchema.parse(definition) };
}

describe('summarizeTrigger', () => {
  let en: TFunction<'automation'>;
  let vi: TFunction<'automation'>;
  beforeAll(async () => {
    en = (await createTestI18n('en')).getFixedT('en', 'automation');
    vi = (await createTestI18n('vi')).getFixedT('vi', 'automation');
  });

  it.each<[string, AutomationDefinitionInput, string, string | null]>([
    [
      'record.created',
      { trigger: { type: 'record.created', table_id: TICKETS } },
      'When a record is created',
      'Tickets',
    ],
    [
      'record.updated with watched fields',
      {
        trigger: {
          type: 'record.updated',
          table_id: TICKETS,
          watch_fields: ['fld_Priority00000001', 'fld_Status0000000001', 'fld_Due0000000000001'],
        },
      },
      'When a record is updated',
      'Tickets · watching Priority, Status +1',
    ],
    [
      'form.submitted',
      { trigger: { type: 'form.submitted', view_id: 'viw_Form000000000001' } },
      'When a form is submitted',
      'Support request',
    ],
    [
      'schedule in a zone',
      { trigger: { type: 'schedule', cron: '0 8 * * 1', timezone: 'Asia/Ho_Chi_Minh' } },
      'On a schedule',
      'Every Monday, 8:00 AM (GMT+7)',
    ],
    [
      'schedule in the org zone',
      { trigger: { type: 'schedule', cron: '0 8 1 1 *', timezone: null } },
      'On a schedule',
      'cron 0 8 1 1 * (organization time zone)',
    ],
    [
      'date reached',
      {
        trigger: {
          type: 'record.date_reached',
          table_id: ORDERS,
          field_id: 'fld_Due0000000000001',
          offset_minutes: -7 * 1440,
          time_of_day: '08:00',
        },
      },
      'When a date in a record is reached',
      'Orders · 7 days before Due date, 8:00 AM',
    ],
    [
      'button',
      {
        trigger: {
          type: 'button.clicked',
          table_id: ORDERS,
          field_id: 'fld_Unknown000000001',
        },
      },
      'When a button is clicked',
      'Orders · button a field no longer available · people who can edit',
    ],
  ])('%s', (_name, definition, label, detail) => {
    expect(summarizeTrigger(automation(definition), names, en, 'en')).toEqual({ label, detail });
  });

  it('reads in Vietnamese', () => {
    const summary = summarizeTrigger(
      automation({
        trigger: {
          type: 'record.date_reached',
          table_id: 'tbl_Gone000000000001',
          field_id: 'fld_Due0000000000001',
          offset_minutes: 120,
        },
      }),
      names,
      vi,
      'vi',
    );
    expect(summary).toEqual({
      label: 'Khi đến ngày trong bản ghi',
      detail: 'bảng không còn · 2 giờ sau Due date',
    });
  });
});

describe('automationScope', () => {
  it('collects read and written tables, fields, adds and deletes (also in if branches)', () => {
    const definition = automationDefinitionSchema.parse({
      trigger: { type: 'record.created', table_id: TICKETS },
      actions: [
        {
          id: 'act_1',
          type: 'find_records',
          config: { table_id: ORDERS, filter: null },
        },
        {
          id: 'act_2',
          type: 'if',
          config: {
            conditions: [{ value: { literal: 1 }, operator: 'is_not_empty' }],
            then: [
              {
                id: 'act_3',
                type: 'update_record',
                config: {
                  table_id: TICKETS,
                  record_id: null,
                  fields: { fld_Status0000000001: { literal: 'x' } },
                },
              },
            ],
            else: [{ id: 'act_4', type: 'delete_record', config: {} }],
          },
        },
        {
          id: 'act_5',
          type: 'create_record',
          config: { table_id: ORDERS, fields: {} },
        },
        {
          id: 'act_6',
          type: 'ai_classify',
          config: { input: 'x', target_field_id: 'fld_Priority00000001' },
        },
        { id: 'act_7', type: 'ai_generate_text', config: { prompt: 'x' } },
      ],
    });
    expect(automationScope(definition)).toEqual({
      reads: [TICKETS, ORDERS],
      writes: [
        {
          tableId: TICKETS,
          fields: ['fld_Status0000000001', 'fld_Priority00000001'],
          add: false,
          delete: true,
        },
        { tableId: ORDERS, fields: [], add: true, delete: false },
      ],
    });
  });
});

describe('list filter', () => {
  type Item = Pick<AutomationDto, 'id' | 'name' | 'enabled' | 'disabled_reason'>;
  const items: Item[] = [
    { id: 'aut_a', name: 'Đồng bộ tồn kho', enabled: true, disabled_reason: null },
    { id: 'aut_b', name: 'Báo Telegram', enabled: false, disabled_reason: null },
    { id: 'aut_c', name: 'Nhắc hạn', enabled: false, disabled_reason: 'circuit_breaker' },
  ];

  it('folds accents and case', () => {
    expect(foldText('  Đồng BỘ ')).toBe('dong bo');
  });

  it('filters by status and name', () => {
    expect(filterAutomations(items, 'all', 'dong').map((item) => item.id)).toEqual(['aut_a']);
    expect(filterAutomations(items, 'off', '').map((item) => item.id)).toEqual(['aut_b', 'aut_c']);
    expect(filterAutomations(items, 'on', 'bao')).toEqual([]);
    expect(statusCounts(items)).toEqual({ all: 3, on: 1, off: 2, errors: 0 });
  });

  it('filters the automations with failed runs in 24 hours (T523)', () => {
    const counted = items.map((item, index) => ({
      ...item,
      errors_24h: index === 1 ? 0 : index + 1,
    }));
    expect(filterAutomations(counted, 'errors', '').map((item) => item.id)).toEqual([
      'aut_a',
      'aut_c',
    ]);
    expect(filterAutomations(counted, 'errors', 'nhac').map((item) => item.id)).toEqual(['aut_c']);
    expect(statusCounts(counted)).toEqual({ all: 3, on: 1, off: 2, errors: 2 });
  });

  it('finds the automations the system just turned off', () => {
    const before: Item[] = items.map((item) => ({ ...item, enabled: true, disabled_reason: null }));
    expect(newlyDisabled(before, items).map((item) => item.id)).toEqual(['aut_c']);
  });
});
