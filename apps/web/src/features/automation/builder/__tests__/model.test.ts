import { describe, expect, it } from 'vitest';

import { checkDraft, conditionSlot } from '../model/check';
import {
  actionCount,
  canAddAction,
  earlierActions,
  insertAction,
  moveAction,
  moveActionTo,
  newAction,
  newActionId,
  placedActions,
  removeAction,
  replaceAction,
  sameDefinition,
  switchTrigger,
  type TableId,
} from '../model/draft';
import { firstIssueStep, issuesFromProblem, locateIssue, splitPath } from '../model/issues';
import { cronOf, nextRuns, parseCron, presetOf, tooFrequent } from '../model/schedule';
import { chipNameOf, scopeOf, sourceNameOf, triggerTableOf } from '../model/scope';
import {
  escapeTemplateText,
  hasExpressions,
  isEmptyValue,
  referenceExpression,
  templateOf,
  templateReference,
  templateSegments,
  triggerDataOf,
  triggerValuePartsOf,
} from '../model/values';

import type { AutomationAction, AutomationDefinition, FieldDto } from '@cellhive/contracts';

const TICKETS = 'tbl_Tickets000000001' as TableId;
const ORDERS = 'tbl_Orders0000000001' as TableId;

function definition(actions: AutomationAction[] = []): AutomationDefinition {
  return {
    trigger: { type: 'record.created', table_id: TICKETS, skip_bulk: false },
    condition: null,
    actions,
  };
}

const update = (id: string): AutomationAction => ({
  id,
  type: 'update_record',
  config: { table_id: TICKETS, record_id: null, fields: {} },
});
const find = (id: string): AutomationAction => ({
  id,
  type: 'find_records',
  config: { table_id: ORDERS, filter: null, sort: [], fields: [], limit: 50 },
});
const branch = (
  id: string,
  then: AutomationAction[],
  otherwise: AutomationAction[],
): AutomationAction =>
  ({
    id,
    type: 'if',
    config: { match: 'and', conditions: [], on_false: 'else', then, else: otherwise },
  }) as AutomationAction;

describe('draft operations (T521)', () => {
  const flow = definition([
    update('act_1'),
    branch('act_2', [find('act_3')], [update('act_4')]),
    update('act_5'),
  ]);

  it('numbers steps depth first, across both branches of an if (board)', () => {
    expect(placedActions(flow).map((placed) => [placed.action.id, placed.number])).toEqual([
      ['act_1', '1'],
      ['act_2', '2'],
      ['act_3', '2.1'],
      ['act_4', '2.2'],
      ['act_5', '3'],
    ]);
    expect(actionCount(flow)).toBe(5);
  });

  it.each([
    ['act_1', []],
    ['act_3', ['act_1', 'act_2']],
    // The other branch of its own if never ran with it.
    ['act_4', ['act_1', 'act_2']],
    ['act_5', ['act_1', 'act_2', 'act_3', 'act_4']],
  ])('earlier steps of %s', (id, expected) => {
    expect(earlierActions(flow, id).map((placed) => placed.action.id)).toEqual(expected);
  });

  it('gives new ids above the highest in use', () => {
    expect(newActionId(flow)).toBe('act_6');
    expect(newActionId(definition())).toBe('act_1');
  });

  it('inserts, replaces, moves and removes inside lists and branches', () => {
    const inserted = insertAction(
      flow,
      { kind: 'branch', ifId: 'act_2', branch: 'then' },
      0,
      update('act_9'),
    );
    expect(placedActions(inserted).map((placed) => placed.number)).toEqual([
      '1',
      '2',
      '2.1',
      '2.2',
      '2.3',
      '3',
    ]);
    // An if never goes into a branch (one level, SPEC §11.3).
    expect(
      insertAction(
        flow,
        { kind: 'branch', ifId: 'act_2', branch: 'else' },
        0,
        branch('act_9', [], []),
      ),
    ).toBe(flow);
    const moved = moveAction(flow, 'act_5', -2);
    expect(moved?.actions.map((action) => action.id)).toEqual(['act_5', 'act_1', 'act_2']);
    expect(moveAction(flow, 'act_1', -1)).toBeNull();
    expect(moveActionTo(flow, 'act_1', 'act_5')?.actions.map((action) => action.id)).toEqual([
      'act_2',
      'act_5',
      'act_1',
    ]);
    // Not across lists.
    expect(moveActionTo(flow, 'act_1', 'act_3')).toBeNull();
    const replaced = replaceAction(flow, {
      ...find('act_3'),
      config: { ...find('act_3').config, limit: 7 },
    } as AutomationAction);
    expect(placedActions(replaced)[2]?.action).toMatchObject({ config: { limit: 7 } });
    expect(placedActions(removeAction(flow, 'act_2')).map((placed) => placed.action.id)).toEqual([
      'act_1',
      'act_5',
    ]);
  });

  it('stops at 20 steps, branches included', () => {
    const many = definition(
      Array.from({ length: 20 }, (_, index) => update(`act_${String(index + 1)}`)),
    );
    expect(canAddAction(many)).toBe(false);
    expect(canAddAction(flow)).toBe(true);
  });

  it('starts actions on the trigger table', () => {
    expect(
      newAction('update_record', 'act_1', { triggerTableId: TICKETS, firstTableId: ORDERS }),
    ).toEqual(update('act_1'));
    expect(
      newAction('find_records', 'act_2', { triggerTableId: null, firstTableId: ORDERS }),
    ).toMatchObject({
      config: { table_id: ORDERS, limit: 50 },
    });
  });

  it('switches trigger type keeping the table and the bulk option', () => {
    const trigger = { type: 'record.created' as const, table_id: TICKETS, skip_bulk: true };
    expect(switchTrigger(trigger, 'record.updated', ORDERS)).toEqual({
      type: 'record.updated',
      table_id: TICKETS,
      watch_fields: [],
      skip_bulk: true,
    });
    expect(switchTrigger(trigger, 'schedule', ORDERS)).toEqual({
      type: 'schedule',
      cron: '0 8 * * *',
      timezone: null,
    });
    expect(
      switchTrigger(
        { type: 'schedule', cron: '0 8 * * *', timezone: null },
        'record.deleted',
        ORDERS,
      ),
    ).toEqual({
      type: 'record.deleted',
      table_id: ORDERS,
      skip_bulk: false,
    });
  });

  it('compares definitions whatever the key order', () => {
    expect(sameDefinition({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameDefinition({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});

describe('issues from server paths (CONTRACTS §21)', () => {
  const flow = definition([update('act_1'), branch('act_2', [find('act_3')], [update('act_4')])]);

  it.each([
    ['definition.trigger.watch_fields', 'trigger', 'watch_fields'],
    ['definition.condition.items[0].field', 'condition', 'items[0].field'],
    ['definition.actions[0].config.fields.fld_X', 'act_1', 'config.fields.fld_X'],
    ['definition.actions[1].config.then[0].config.table_id', 'act_3', 'config.table_id'],
    ['definition.actions[1].config.else[0]', 'act_4', ''],
    ['definition.actions[1].config.conditions[0].filter', 'act_2', 'config.conditions[0].filter'],
    ['definition.actions', 'general', 'definition.actions'],
    ['definition.actions[9].config', 'general', 'definition.actions[9].config'],
  ])('%s → %s %s', (path, step, inner) => {
    expect(locateIssue(flow, path)).toEqual({ step, path: inner });
  });

  it('splits paths with indices', () => {
    expect(splitPath('definition.actions[1].config.then[0].id')).toEqual([
      'definition',
      'actions',
      1,
      'config',
      'then',
      0,
      'id',
    ]);
  });

  it('orders issues as the flow for "go to the first problem"', () => {
    const issues = issuesFromProblem(flow, [
      { path: 'definition.actions[1].config.else[0].config.table_id', code: 'UNKNOWN_TABLE' },
      { path: 'definition.trigger.table_id', code: 'PERMISSION_DENIED' },
      { path: 'name', code: 'TOO_BIG' },
    ]);
    expect(issues.map((issue) => issue.step)).toEqual(['act_4', 'trigger', 'general']);
    expect(firstIssueStep(flow, issues)).toBe('general');
    expect(firstIssueStep(flow, issues.slice(0, 1))).toBe('act_4');
  });
});

describe('template values (SPEC §11.4)', () => {
  it.each([
    [
      'Hello {{ [fld_A] }}!',
      [
        { kind: 'text', text: 'Hello ' },
        { kind: 'ref', expression: '[fld_A]' },
        { kind: 'text', text: '!' },
      ],
    ],
    ['\\{{ not }}', [{ kind: 'text', text: '{{ not }}' }]],
    ['open {{ x', [{ kind: 'text', text: 'open {{ x' }]],
    [
      '{{ IF([fld_A] > 1, "a}}b", "c") }}',
      [{ kind: 'ref', expression: 'IF([fld_A] > 1, "a}}b", "c")' }],
    ],
  ])('splits %j', (template, segments) => {
    expect(templateSegments(template)).toEqual(segments);
  });

  it.each(['plain', 'a { b } \\ c', '{{ x }} literal', 'path\\{x'])(
    'round-trips literal text %j',
    (text) => {
      expect(templateSegments(escapeTemplateText(text))).toEqual([{ kind: 'text', text }]);
    },
  );

  it('writes chips in the canonical form', () => {
    expect(
      templateOf([
        { kind: 'text', text: 'Order {' },
        { kind: 'ref', expression: '[act_1].[fld_B]' },
      ]),
    ).toBe('Order \\{{{ [act_1].[fld_B] }}');
  });

  it.each([
    ['[fld_A]', { kind: 'field', fieldId: 'fld_A' }],
    ['[@url]', { kind: 'record', ref: '@url' }],
    ['[@fired_at]', { kind: 'trigger', ref: '@fired_at' }],
    ['[act_2]', { kind: 'step', step: 'act_2', fieldId: null, ref: null }],
    ['[act_2].[fld_B]', { kind: 'step', step: 'act_2', fieldId: 'fld_B', ref: null }],
    ['[act_2].[@url]', { kind: 'step', step: 'act_2', fieldId: null, ref: '@url' }],
    ['[@previous].[fld_A]', { kind: 'previous', fieldId: 'fld_A' }],
    ['[@actor]', { kind: 'trigger', ref: '@actor' }],
    ['[@previous]', null],
    ['[fld_A].[fld_B]', null],
    ['UPPER([fld_A])', null],
    ['[Title]', null],
  ])('reads reference %s', (expression, expected) => {
    const reference = templateReference(expression);
    expect(reference).toEqual(expected);
    if (reference !== null) expect(referenceExpression(reference)).toBe(expression);
  });

  it('knows when the server must name an expression', () => {
    expect(hasExpressions('{{ [fld_A] }} {{ [act_1].[fld_B] }}')).toBe(false);
    expect(hasExpressions('{{ UPPER([fld_A]) }}')).toBe(true);
  });

  it.each([
    [undefined, true],
    [{ literal: '  ' }, true],
    [{ literal: [] }, true],
    [{ literal: 0 }, false],
    [{ template: '' }, true],
    [{ field: 'fld_A' }, false],
  ] as const)('empty value %j → %s', (value, empty) => {
    expect(isEmptyValue(value as never)).toBe(empty);
  });
});

describe('scope and chip names', () => {
  const fields = [
    { id: 'fld_Title', name: 'Title' },
    { id: 'fld_Level', name: 'Level' },
  ] as unknown as FieldDto[];
  const names = {
    fieldsOf: (tableId: string) => (tableId === TICKETS || tableId === ORDERS ? fields : undefined),
  };
  const flow = definition([find('act_1'), update('act_2')]);
  const scope = scopeOf(flow, 'act_2', TICKETS);

  it('lists earlier steps with their tables', () => {
    expect(scope.steps).toEqual([
      { id: 'act_1', number: '1', type: 'find_records', tableId: ORDERS },
    ]);
    expect(scopeOf(flow, null, TICKETS).steps).toEqual([]);
  });

  it.each([
    ['[fld_Title]', { tone: 'field', field: 'Title' }],
    ['[fld_Gone]', { tone: 'error', ref: 'fld_Gone' }],
    ['[@fired_at]', { tone: 'trigger', data: 'fired_at' }],
    ['[@due_at]', { tone: 'error', ref: '@due_at' }],
    ['[@url]', { tone: 'trigger', record: '@url' }],
    ['[act_1].[fld_Level]', { tone: 'step', number: '1', field: 'Level' }],
    ['[act_1]', { tone: 'step', number: '1', part: 'record' }],
    ['[act_9]', { tone: 'error', ref: 'act_9' }],
    ['[@actor]', { tone: 'trigger', data: 'actor' }],
    // `[@previous]` is for record.updated only (this scope is record.created).
    ['[@previous].[fld_Title]', { tone: 'error', ref: '@previous' }],
    ['IF([fld_Title], 1, 2)', { tone: 'expression', expression: 'IF([fld_Title], 1, 2)' }],
  ])('names %s', (expression, name) => {
    expect(chipNameOf(expression, scope, names)).toEqual(name);
  });

  it('names single sources', () => {
    expect(sourceNameOf({ field: 'fld_Level' }, scope, names)).toEqual({
      tone: 'field',
      field: 'Level',
    });
    expect(sourceNameOf({ step: 'act_1', path: 'count' }, scope, names)).toEqual({
      tone: 'step',
      number: '1',
      part: 'count',
    });
    expect(sourceNameOf({ trigger: 'clicked_by' }, scope, names)).toEqual({
      tone: 'error',
      ref: 'clicked_by',
    });
  });

  it('finds the trigger table (forms by their view)', () => {
    expect(
      triggerTableOf({ type: 'schedule', cron: '0 8 * * *', timezone: null }, () => undefined),
    ).toBeNull();
    expect(triggerTableOf({ type: 'form.submitted', view_id: 'viw_Form' }, () => ORDERS)).toBe(
      ORDERS,
    );
    expect(
      triggerTableOf(
        { type: 'record.created', table_id: '' as TableId, skip_bulk: false },
        () => undefined,
      ),
    ).toBeNull();
  });
});

describe('schedule (SPEC §11.2)', () => {
  it.each([
    ['0 8 * * *', { kind: 'daily', hour: 8, minute: 0 }],
    ['30 7 * * 1-5', { kind: 'weekly', hour: 7, minute: 30, weekdays: [1, 2, 3, 4, 5] }],
    ['0 9 * * 1,3,7', { kind: 'weekly', hour: 9, minute: 0, weekdays: [0, 1, 3] }],
    ['15 6 10 * *', { kind: 'monthly', hour: 6, minute: 15, day: 10 }],
    ['*/15 * * * *', { kind: 'cron', cron: '*/15 * * * *' }],
    ['0 8 1 1 *', { kind: 'cron', cron: '0 8 1 1 *' }],
  ])('reads %s', (cron, preset) => {
    expect(presetOf(cron)).toEqual(preset);
  });

  it.each([
    [{ kind: 'daily', hour: 8, minute: 5 }, '5 8 * * *'],
    [{ kind: 'weekly', hour: 8, minute: 0, weekdays: [5, 1, 2, 3, 4] }, '0 8 * * 1-5'],
    [{ kind: 'weekly', hour: 8, minute: 0, weekdays: [1, 3] }, '0 8 * * 1,3'],
    [{ kind: 'monthly', hour: 23, minute: 59, day: 31 }, '59 23 31 * *'],
  ] as const)('writes %j', (preset, cron) => {
    expect(cronOf(preset)).toBe(cron);
  });

  it.each(['* * * *', '60 * * * *', '0 24 * * *', '0 8 0 * *', 'a b c d e', '0 8 5-1 * *'])(
    'refuses %s',
    (cron) => {
      expect(parseCron(cron)).toBeNull();
    },
  );

  it('lists the next runs in the time zone', () => {
    const from = new Date('2026-10-05T03:00:00.000Z'); // Monday 10:00 in Ho Chi Minh City
    const runs = nextRuns('0 8 * * 1', 'Asia/Ho_Chi_Minh', from, 3);
    expect(runs?.map((run) => run.toISOString())).toEqual([
      '2026-10-12T01:00:00.000Z',
      '2026-10-19T01:00:00.000Z',
      '2026-10-26T01:00:00.000Z',
    ]);
    // Day or weekday when both are restricted (cron rule).
    const either = nextRuns('0 0 1 * 0', 'UTC', new Date('2026-10-02T00:00:00.000Z'), 3);
    expect(either?.map((run) => run.toISOString().slice(0, 10))).toEqual([
      '2026-10-04',
      '2026-10-11',
      '2026-10-18',
    ]);
    expect(nextRuns('0 0 31 2 *', 'UTC', from, 1)).toEqual([]);
    expect(nextRuns('0 8 * * *', 'Mars/Base', from)).toBeNull();
  });

  it('skips the wall times a DST change removes', () => {
    // 2026-03-29 02:30 does not exist in Berlin.
    const runs = nextRuns('30 2 * * *', 'Europe/Berlin', new Date('2026-03-28T12:00:00.000Z'), 2);
    expect(runs?.map((run) => run.toISOString())).toEqual([
      '2026-03-30T00:30:00.000Z',
      '2026-03-31T00:30:00.000Z',
    ]);
  });

  it('flags runs closer than 5 minutes', () => {
    const now = new Date('2026-10-05T00:00:00.000Z');
    expect(tooFrequent(nextRuns('*/1 * * * *', 'UTC', now) ?? [])).toBe(true);
    expect(tooFrequent(nextRuns('*/5 * * * *', 'UTC', now) ?? [])).toBe(false);
  });
});

describe('check before saving', () => {
  const context = {
    name: 'Watch',
    conditions: new Map(),
    orgTimeZone: 'UTC',
    now: new Date('2026-10-05T00:00:00.000Z'),
  };

  it('passes a complete definition', () => {
    expect(checkDraft(definition([update('act_1')]), context)).toEqual([]);
  });

  it('names what is still to choose', () => {
    const draft: AutomationDefinition = {
      trigger: { type: 'record.updated', table_id: TICKETS, watch_fields: [], skip_bulk: false },
      condition: null,
      actions: [
        { id: 'act_1', type: 'create_record', config: { table_id: '' as TableId, fields: {} } },
        branch('act_2', [], []),
        {
          ...update('act_3'),
          config: { ...update('act_3').config, fields: { fld_A: undefined as never } },
        } as AutomationAction,
      ],
    };
    const issues = checkDraft(draft, { ...context, name: ' ' });
    expect(issues.map((issue) => [issue.step, issue.path, issue.code])).toEqual([
      ['general', 'name', 'NAME_REQUIRED'],
      ['trigger', 'watch_fields', 'REQUIRED'],
      ['act_1', 'config.table_id', 'REQUIRED'],
      ['act_2', 'config.conditions', 'NO_CONDITIONS'],
      ['act_3', 'config.fields.fld_A', 'REQUIRED'],
    ]);
  });

  it('reports conditions the editors still hold', () => {
    const conditions = new Map([
      [conditionSlot('condition', ''), { valid: true, incomplete: 2 }],
      [conditionSlot('act_1', 'config.filter'), { valid: false, incomplete: 0 }],
    ]);
    const issues = checkDraft(definition([find('act_1')]), { ...context, conditions });
    expect(issues.map((issue) => [issue.step, issue.code, issue.params])).toEqual([
      ['condition', 'CONDITION_INCOMPLETE', { count: 2 }],
      ['act_1', 'CONDITION_INVALID', undefined],
    ]);
  });

  it('checks schedules', () => {
    const at = (cron: string): AutomationDefinition => ({
      trigger: { type: 'schedule', cron, timezone: null },
      condition: null,
      actions: [find('act_1')],
    });
    expect(checkDraft(at('0 8 * * *'), context)).toEqual([]);
    expect(checkDraft(at('nope'), context).map((issue) => issue.code)).toEqual(['CRON_INVALID']);
    expect(checkDraft(at('*/2 * * * *'), context).map((issue) => issue.code)).toEqual([
      'CRON_TOO_FREQUENT',
    ]);
  });

  it.each([
    ['without its button', '', null, [['trigger', 'field_id', 'REQUIRED']]],
    ['complete, always enabled', 'fld_Approve000000001', null, []],
    [
      'with an unfinished enabled_when',
      'fld_Approve000000001',
      { valid: true, incomplete: 1 },
      [['trigger', 'enabled_when', 'CONDITION_INCOMPLETE']],
    ],
  ] as const)('checks a button.clicked trigger %s (T525)', (_name, fieldId, slot, expected) => {
    const draft: AutomationDefinition = {
      trigger: {
        type: 'button.clicked',
        table_id: ORDERS,
        field_id: fieldId as never,
        min_permission: 'read',
        enabled_when: null,
      },
      condition: null,
      actions: [update('act_1')],
    };
    const conditions = new Map(
      slot === null ? [] : [[conditionSlot('trigger', 'enabled_when'), slot]],
    );
    expect(
      checkDraft(draft, { ...context, conditions }).map((issue) => [
        issue.step,
        issue.path,
        issue.code,
      ]),
    ).toEqual(expected);
  });

  it('names what record.matches, update_records and delay still need (T506)', () => {
    const draft: AutomationDefinition = {
      trigger: { type: 'record.matches', table_id: TICKETS, condition: {}, skip_bulk: false },
      condition: null,
      actions: [
        {
          id: 'act_1',
          type: 'update_records',
          config: { table_id: ORDERS, filter: {}, fields: {}, limit: 1000 },
        },
        {
          id: 'act_2',
          type: 'delay',
          config: { minutes: null, until: { literal: '' }, recheck_condition: {} },
        },
        {
          id: 'act_3',
          type: 'delay',
          config: { minutes: 30, until: null, recheck_condition: null },
        },
      ],
    };
    expect(checkDraft(draft, context).map((issue) => [issue.step, issue.path, issue.code])).toEqual(
      [
        ['trigger', 'condition', 'CONDITION_REQUIRED'],
        ['act_1', 'config.filter', 'CONDITION_REQUIRED'],
        ['act_2', 'config.until', 'REQUIRED'],
        ['act_2', 'config.recheck_condition', 'CONDITION_REQUIRED'],
      ],
    );
  });

  it('names the bot, chat and text a new send_telegram step still needs (T516)', () => {
    const fresh = newAction('send_telegram', 'act_1', {
      triggerTableId: TICKETS,
      firstTableId: null,
    });
    expect(fresh).toEqual({
      id: 'act_1',
      type: 'send_telegram',
      config: { secret_id: '', chat_id: { literal: '' }, text: { template: '', digest: null } },
    });
    expect(
      checkDraft(definition([fresh]), context).map((issue) => [issue.step, issue.path, issue.code]),
    ).toEqual([
      ['act_1', 'config.secret_id', 'REQUIRED'],
      ['act_1', 'config.chat_id', 'REQUIRED'],
      ['act_1', 'config.text.template', 'REQUIRED'],
    ]);
    const complete: AutomationAction = {
      id: 'act_1',
      type: 'send_telegram',
      config: {
        secret_id: 'sec_0000000000000001',
        chat_id: { literal: -1001234567890 },
        text: { template: '<b>Xong</b>', digest: null },
      },
    };
    expect(checkDraft(definition([complete]), context)).toEqual([]);
  });
});

describe('trigger data (CONTRACTS §21, T521b)', () => {
  it.each([
    ['record.updated', ['fired_at', 'actor'], ['actor']],
    ['form.submitted', ['fired_at', 'actor'], ['actor']],
    ['schedule', ['fired_at'], ['fired_at']],
    ['record.date_reached', ['fired_at', 'due_at'], ['due_at']],
    ['button.clicked', ['fired_at', 'clicked_by', 'clicked_at'], ['clicked_by', 'clicked_at']],
  ])('%s: templates %j, values %j', (type, template, value) => {
    expect(triggerDataOf(type)).toEqual(template);
    expect(triggerValuePartsOf(type)).toEqual(value);
  });
});
