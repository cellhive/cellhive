import { describe, expect, it } from 'vitest';

import { buttonAutomationOf, buttonGateOf, clickedByOf } from '../../src/automation/index.js';

import type { AutomationRow, AutomationRunRow } from '../../src/db/schema.js';

const TBL = 'tbl_ButtonTrigr00001';
const FLD = 'fld_ButtonTrigr00001';
const STATUS = 'fld_ButtonTrigr00002';
const NOTE = 'fld_ButtonTrigr00003';
const ACTIONS = [{ id: 'act_1', type: 'delete_record', config: {} }] as const;

function row(definition: object): AutomationRow {
  return { definition } as unknown as AutomationRow;
}

const trigger = (extra: object = {}) => ({
  type: 'button.clicked',
  table_id: TBL,
  field_id: FLD,
  ...extra,
});

const isNew = { field: STATUS, operator: 'is', value: 'opt_ButtonTrigr00001' };
const noteFilled = { field: NOTE, operator: 'is_not_empty' };
const noteChanged = { field: NOTE, operator: 'changed' };

describe('buttonAutomationOf (T517)', () => {
  it('parses a button.clicked automation on the button, defaults filled', () => {
    const parsed = buttonAutomationOf(
      row({ trigger: trigger(), condition: null, actions: ACTIONS }),
      TBL,
      FLD,
    );
    expect(parsed?.trigger).toEqual({ ...trigger(), min_permission: 'edit', enabled_when: null });
  });

  it.each([
    ['another field', { trigger: trigger({ field_id: 'fld_ButtonTrigr00009' }) }],
    ['another table', { trigger: trigger({ table_id: 'tbl_ButtonTrigr00009' }) }],
    ['another trigger', { trigger: { type: 'record.created', table_id: TBL } }],
    ['a definition that no longer parses', { trigger: trigger({ min_permission: 'manage' }) }],
  ])('is null for %s', (_name, definition) => {
    expect(
      buttonAutomationOf(row({ condition: null, actions: ACTIONS, ...definition }), TBL, FLD),
    ).toBeNull();
  });
});

describe('buttonGateOf (T517)', () => {
  const gate = (enabledWhen: object | null, condition: object | null) => {
    const parsed = buttonAutomationOf(
      row({ trigger: trigger({ enabled_when: enabledWhen }), condition, actions: ACTIONS }),
      TBL,
      FLD,
    );
    if (parsed === null) throw new Error('definition does not parse');
    return buttonGateOf(parsed);
  };

  it.each<[string, object | null, object | null, unknown]>([
    ['neither', null, null, true],
    ['enabled_when only', isNew, null, isNew],
    ['condition only', null, noteFilled, noteFilled],
    ['both, AND-ed', isNew, noteFilled, { op: 'and', items: [isNew, noteFilled] }],
    ['a changed* condition alone (a click changes nothing)', null, noteChanged, false],
    [
      'changed* OR a condition',
      isNew,
      { op: 'or', items: [noteChanged, noteFilled] },
      { op: 'and', items: [isNew, noteFilled] },
    ],
    ['NOT changed* (always true)', isNew, { op: 'not', item: noteChanged }, isNew],
  ])('%s', (_name, enabledWhen, condition, expected) => {
    expect(gate(enabledWhen, condition)).toEqual(expected);
  });
});

describe('clickedByOf (T517)', () => {
  it.each<[string, unknown, unknown]>([
    [
      'a click',
      {
        trigger: {
          type: 'button.clicked',
          table_id: TBL,
          record_id: 'rec_ButtonTrigr00001',
          data: { clicked_by: 'usr_ButtonTrigr00001', clicked_at: '2026-10-06T00:00:00.000Z' },
        },
      },
      {
        userId: 'usr_ButtonTrigr00001',
        tableId: TBL,
        recordId: 'rec_ButtonTrigr00001',
      },
    ],
    ['a schedule', { trigger: { type: 'schedule', data: { fired_at: 'x' } } }, null],
    ['a click without a user', { trigger: { type: 'button.clicked', data: {} } }, null],
    ['no input', {}, null],
  ])('%s', (_name, input, expected) => {
    expect(clickedByOf({ input } as unknown as AutomationRunRow)).toEqual(expected);
  });
});
