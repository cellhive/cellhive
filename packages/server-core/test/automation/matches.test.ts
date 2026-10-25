import { foldTransition, type FilterNode, type FilterTableMeta } from '@cellhive/filter-dsl';
import { describe, expect, it } from 'vitest';

import {
  conditionFieldIdsOf,
  planTransition,
  transitionImagesOf,
  triggerMismatch,
  triggerTypesFor,
  withLaterChanges,
} from '../../src/automation/index.js';

import type { EventDocument } from '../../src/events/index.js';
import type { AutomationTrigger } from '@cellhive/contracts';

const TBL = 'tbl_Tickets000000001';
const PRIORITY = 'fld_Priority00000001';
const TITLE = 'fld_Title00000000001';
const SCORE = 'fld_Score00000000001';
const URGENT = 'opt_Urgent0000000001';
const NORMAL = 'opt_Normal0000000001';

const table: FilterTableMeta = {
  fields: [
    { id: TITLE, name: 'Tiêu đề', type: 'text' },
    {
      id: PRIORITY,
      name: 'Ưu tiên',
      type: 'select',
      options: {
        multiple: false,
        options: [
          { id: URGENT, name: 'Khẩn' },
          { id: NORMAL, name: 'Thường' },
        ],
      },
    },
    { id: SCORE, name: 'Điểm', type: 'number' },
  ],
};

type EventOverrides = Omit<Partial<EventDocument>, 'changes'> & {
  /** `undefined`: an event without `changes` (`record.restored`). */
  readonly changes?: EventDocument['changes'] | undefined;
};

function event(overrides: EventOverrides = {}): EventDocument {
  const { changes, ...rest } = {
    changes: { [PRIORITY]: { from: [NORMAL], to: [URGENT] } },
    ...overrides,
  };
  return {
    id: 'evt_Event00000000001',
    type: 'record.updated',
    organization_id: 'org_Org0000000000001',
    table_id: TBL,
    entity_type: 'record',
    entity_id: 'rec_Record0000000001',
    actor: { type: 'user', id: 'usr_User000000000001' },
    causation: { root_event_id: 'evt_Root000000000001', depth: 0, automation_chain: [] },
    created_at: '2026-10-05T00:00:00.000Z',
    ...rest,
    ...(changes === undefined ? {} : { changes }),
  };
}

const isUrgent: FilterNode = { field: PRIORITY, operator: 'is', value: URGENT };
const matches: AutomationTrigger = {
  type: 'record.matches',
  table_id: TBL,
  condition: isUrgent as unknown as Record<string, unknown>,
  skip_bulk: false,
};

describe('record.matches dispatch (T510)', () => {
  it.each<[string, string, string[]]>([
    ['record.created', 'record.created', ['record.created', 'record.matches']],
    ['record.updated', 'record.updated', ['record.updated', 'record.matches']],
    ['record.restored', 'record.restored', ['record.matches']],
    ['record.deleted', 'record.deleted', ['record.deleted']],
    ['form.submitted', 'form.submitted', ['form.submitted']],
    ['automation.enabled', 'automation.enabled', []],
  ])('%s starts %j', (_name, type, expected) => {
    expect(triggerTypesFor({ type: type as EventDocument['type'] })).toEqual(expected);
  });

  it.each<[string, AutomationTrigger, EventOverrides, string | null]>([
    ['a new record', matches, { type: 'record.created' }, null],
    ['a restored record', matches, { type: 'record.restored', changes: undefined }, null],
    ['a change of a condition field', matches, {}, null],
    [
      'a change of another field only (both sides equal)',
      matches,
      { changes: { [TITLE]: { from: 'a', to: 'b' } } },
      'condition_fields_unchanged',
    ],
    ['another table', matches, { table_id: 'tbl_Other00000000001' }, 'other_table'],
    ['a deleted record', matches, { type: 'record.deleted' }, 'other_trigger'],
    [
      'bulk with skip_bulk',
      { ...matches, skip_bulk: true },
      { batch: { id: 'req_Request000000001', size: 500 } },
      'bulk_skipped',
    ],
    [
      'bulk without skip_bulk',
      matches,
      { type: 'record.created', batch: { id: 'req_Request000000001', size: 500 } },
      null,
    ],
    [
      'a recomputed value (T509) is bulk through the job',
      { ...matches, skip_bulk: true },
      { via: { computed_recompute: true, job_id: 'job_0000000000000001' } },
      'bulk_skipped',
    ],
  ])('%s', (_name, trigger, overrides, expected) => {
    expect(triggerMismatch(trigger, event(overrides))).toBe(expected);
  });

  it('collects the fields of a stored condition', () => {
    expect(
      conditionFieldIdsOf({
        op: 'or',
        items: [isUrgent, { op: 'not', item: { field: SCORE, operator: 'is_empty' } }],
      }),
    ).toEqual(new Set([PRIORITY, SCORE]));
    expect(conditionFieldIdsOf(null)).toEqual(new Set());
    expect(conditionFieldIdsOf(['x'])).toEqual(new Set());
  });

  it('builds the before/after images from the event alone', () => {
    expect(transitionImagesOf(event())).toEqual({
      before: { [PRIORITY]: [NORMAL] },
      after: { [PRIORITY]: [URGENT] },
      changed: [PRIORITY],
    });
    expect(
      transitionImagesOf(
        event({ type: 'record.created', changes: { [PRIORITY]: { from: null, to: [URGENT] } } }),
      ),
    ).toEqual({ before: null, after: { [PRIORITY]: [URGENT] }, changed: [PRIORITY] });
    expect(transitionImagesOf(event({ type: 'record.restored', changes: undefined }))).toEqual({
      before: null,
      after: {},
      changed: [],
    });
    expect(transitionImagesOf(event({ type: 'record.deleted' }))).toBeNull();
  });

  // T527: an event dispatched after later changes of its record.
  it.each<[string, EventOverrides, Record<string, { from?: unknown; to?: unknown }>[], unknown]>([
    [
      'created without priority, then set Khẩn before dispatch: pinned to empty',
      { type: 'record.created', changes: { [TITLE]: { from: null, to: 'x' } } },
      [{ [PRIORITY]: { from: null, to: [URGENT] } }],
      { before: null, after: { [TITLE]: 'x', [PRIORITY]: null }, changed: [TITLE, PRIORITY] },
    ],
    [
      'the first later change gives the value; the event own changes win',
      {},
      [
        { [PRIORITY]: { from: [URGENT], to: [NORMAL] }, [TITLE]: { from: 'a', to: 'b' } },
        { [TITLE]: { from: 'b', to: 'c' } },
      ],
      {
        before: { [PRIORITY]: [NORMAL], [TITLE]: 'a' },
        after: { [PRIORITY]: [URGENT], [TITLE]: 'a' },
        changed: [PRIORITY, TITLE],
      },
    ],
    [
      'no later change: unchanged',
      {},
      [],
      { before: { [PRIORITY]: [NORMAL] }, after: { [PRIORITY]: [URGENT] }, changed: [PRIORITY] },
    ],
  ])('%s', (_name, overrides, later, expected) => {
    const images = transitionImagesOf(event(overrides));
    if (images === null) throw new Error('no images');
    expect(withLaterChanges(images, later)).toEqual(expected);
  });

  it('a creation changed into the condition before dispatch is decided not matching', () => {
    const images = transitionImagesOf(
      event({ type: 'record.created', changes: { [TITLE]: { from: null, to: 'x' } } }),
    );
    if (images === null) throw new Error('no images');
    const later = withLaterChanges(images, [{ [PRIORITY]: { from: null, to: [URGENT] } }]);
    expect(planTransition(foldTransition(isUrgent, later, { table, resolve }))).toEqual({
      kind: 'decided',
      outcome: 'not_matching',
    });
  });

  const resolve = {
    userId: 'usr_User000000000001' as const,
    groupMemberUserIds: [],
    timeZone: 'Asia/Ho_Chi_Minh',
    now: new Date('2026-10-05T00:00:00.000Z'),
  };
  const titled: FilterNode = { field: TITLE, operator: 'is_not_empty' };
  const plan = (condition: FilterNode, overrides: EventOverrides) => {
    const images = transitionImagesOf(event(overrides));
    if (images === null) throw new Error('no images');
    return planTransition(foldTransition(condition, images, { table, resolve }));
  };

  it.each<[string, FilterNode, EventOverrides, ReturnType<typeof planTransition>]>([
    [
      'Thường → Khẩn: enters, only the record must still be readable',
      isUrgent,
      {},
      { kind: 'query', after: null, before: null },
    ],
    [
      'Khẩn → Thường: leaves',
      isUrgent,
      { changes: { [PRIORITY]: { from: [URGENT], to: [NORMAL] } } },
      { kind: 'decided', outcome: 'not_matching' },
    ],
    [
      'Khẩn → Khẩn (re-saved, multi to single): already matching',
      isUrgent,
      { changes: { [PRIORITY]: { from: [URGENT], to: [URGENT] } } },
      { kind: 'decided', outcome: 'already_matching' },
    ],
    [
      'new record created Khẩn',
      isUrgent,
      { type: 'record.created', changes: { [PRIORITY]: { from: null, to: [URGENT] } } },
      { kind: 'query', after: null, before: null },
    ],
    [
      'new record without priority',
      isUrgent,
      { type: 'record.created', changes: { [TITLE]: { from: null, to: 'x' } } },
      { kind: 'query', after: isUrgent, before: null },
    ],
    [
      'and with an unchanged field: tested on the current record for after only',
      { op: 'and', items: [isUrgent, titled] },
      {},
      { kind: 'query', after: titled, before: null },
    ],
    [
      'or with an unchanged field: before may already match through it',
      { op: 'or', items: [isUrgent, titled] },
      {},
      { kind: 'query', after: null, before: titled },
    ],
    [
      'score crosses a threshold',
      { field: SCORE, operator: 'gte', value: 10 },
      { changes: { [SCORE]: { from: 9.5, to: '10' } } },
      { kind: 'query', after: null, before: null },
    ],
  ])('%s', (_name, condition, overrides, expected) => {
    expect(plan(condition, overrides)).toEqual(expected);
  });
});
