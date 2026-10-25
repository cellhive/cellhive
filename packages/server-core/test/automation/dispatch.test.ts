import { describe, expect, it } from 'vitest';

import {
  automationMaxDepthOf,
  changeConditionsOf,
  foldChangeConditions,
  isBulkEvent,
  loopGuard,
  recomputeJobBatchId,
  triggerMismatch,
  triggerRecordIdOf,
  triggerUnitOf,
} from '../../src/automation/index.js';

import type { EventDocument } from '../../src/events/index.js';
import type { AutomationTrigger } from '@cellhive/contracts';
import type { FilterCondition, FilterNode } from '@cellhive/filter-dsl';

const ROOT = 'evt_Root000000000001';
const TBL = 'tbl_Orders0000000001';
const AUT = 'aut_Automation000001';

function event(overrides: Partial<EventDocument> = {}): EventDocument {
  return {
    id: 'evt_Event00000000001',
    type: 'record.updated',
    organization_id: 'org_Org0000000000001',
    table_id: TBL,
    entity_type: 'record',
    entity_id: 'rec_Record0000000001',
    actor: { type: 'user', id: 'usr_User000000000001' },
    changes: { fld_status: { from: ['opt_new'], to: ['opt_done'] } },
    causation: { root_event_id: ROOT, depth: 0, automation_chain: [] },
    created_at: '2026-10-05T00:00:00.000Z',
    ...overrides,
  };
}

const changed = (field: string): FilterCondition => ({
  field: field as `fld_${string}`,
  operator: 'changed',
});
const eq = (field: string): FilterCondition => ({
  field: field as `fld_${string}`,
  operator: 'eq',
  value: 'x',
});

describe('foldChangeConditions (SPEC §11.3)', () => {
  const decideA = (leaf: FilterCondition) => leaf.field === 'fld_a';
  it.each<[string, FilterNode, ReturnType<typeof foldChangeConditions>]>([
    ['changed true', changed('fld_a'), { kind: 'constant', value: true }],
    ['changed false', changed('fld_b'), { kind: 'constant', value: false }],
    ['standard leaf kept', eq('fld_x'), { kind: 'filter', filter: eq('fld_x') }],
    [
      'and: false absorbs',
      { op: 'and', items: [changed('fld_b'), eq('fld_x')] },
      { kind: 'constant', value: false },
    ],
    [
      'and: true dropped, single item unwrapped',
      { op: 'and', items: [changed('fld_a'), eq('fld_x')] },
      { kind: 'filter', filter: eq('fld_x') },
    ],
    [
      'and: only true items',
      { op: 'and', items: [changed('fld_a'), changed('fld_a')] },
      { kind: 'constant', value: true },
    ],
    [
      'or: true absorbs',
      { op: 'or', items: [eq('fld_x'), changed('fld_a')] },
      { kind: 'constant', value: true },
    ],
    [
      'or: false dropped',
      { op: 'or', items: [changed('fld_b'), eq('fld_x'), eq('fld_y')] },
      { kind: 'filter', filter: { op: 'or', items: [eq('fld_x'), eq('fld_y')] } },
    ],
    [
      'or: only false items',
      { op: 'or', items: [changed('fld_b')] },
      { kind: 'constant', value: false },
    ],
    [
      'not of a constant',
      { op: 'not', item: changed('fld_a') },
      { kind: 'constant', value: false },
    ],
    [
      'not of a filter',
      { op: 'not', item: eq('fld_x') },
      { kind: 'filter', filter: { op: 'not', item: eq('fld_x') } },
    ],
    [
      'nested',
      {
        op: 'and',
        items: [
          { op: 'or', items: [changed('fld_b'), eq('fld_x')] },
          { op: 'not', item: changed('fld_b') },
        ],
      },
      { kind: 'filter', filter: eq('fld_x') },
    ],
  ])('%s', (_name, node, expected) => {
    expect(foldChangeConditions(node, decideA)).toEqual(expected);
  });

  it('lists the changed* conditions only', () => {
    const node: FilterNode = {
      op: 'and',
      items: [
        changed('fld_a'),
        eq('fld_x'),
        { op: 'not', item: { field: 'fld_b', operator: 'changed_to', value: 'y' } },
      ],
    };
    expect(changeConditionsOf(node).map((leaf) => [leaf.field, leaf.operator])).toEqual([
      ['fld_a', 'changed'],
      ['fld_b', 'changed_to'],
    ]);
  });
});

describe('bulk events and trigger units (ADR-26 §2, §5)', () => {
  it.each<[string, Partial<EventDocument>, boolean, string]>([
    ['no batch (old event)', {}, false, ROOT],
    ['one record', { batch: { id: 'req_Request000000001', size: 1 } }, false, ROOT],
    [
      'paste of two rows',
      { batch: { id: 'req_Request000000001', size: 2 } },
      true,
      'req_Request000000001',
    ],
    [
      'import (one row of the lot)',
      {
        batch: { id: 'job_Import0000000001', size: 1 },
        via: { import_job_id: 'job_Import0000000001' },
      },
      true,
      'job_Import0000000001',
    ],
    [
      'form through a share link',
      {
        batch: { id: 'req_Request000000001', size: 3 },
        via: { share_link_id: 'shl_Link000000000001' },
      },
      false,
      ROOT,
    ],
    [
      'recomputed by a computed.recompute run (one record): always bulk (T509)',
      {
        batch: { id: 'job_Recompute0000001', size: 1 },
        via: { computed_recompute: true, job_id: 'job_Recompute0000001' },
      },
      true,
      'job_Recompute0000001',
    ],
    [
      'recomputed by a single write: like the write (T509)',
      {
        batch: { id: 'req_Request000000001', size: 1 },
        via: { computed_recompute: true, job_id: null },
      },
      false,
      ROOT,
    ],
    [
      'update_records of a run',
      {
        batch: { id: 'run_Run0000000000001', size: 500 },
        causation: { root_event_id: ROOT, depth: 1, automation_chain: [AUT] },
      },
      true,
      'run_Run0000000000001',
    ],
  ])('%s', (_name, overrides, bulk, unit) => {
    const doc = event(overrides);
    expect(isBulkEvent(doc)).toBe(bulk);
    expect(triggerUnitOf(doc)).toBe(unit);
  });
});

describe('triggerMismatch (SPEC §11.2)', () => {
  const created: AutomationTrigger = { type: 'record.created', table_id: TBL, skip_bulk: false };
  const updated: AutomationTrigger = {
    type: 'record.updated',
    table_id: TBL,
    watch_fields: ['fld_status'],
    skip_bulk: true,
  };
  const form: AutomationTrigger = { type: 'form.submitted', view_id: 'viw_Form000000000001' };
  const bulk = { batch: { id: 'req_Request000000001', size: 2 } } as const;

  it.each<[string, AutomationTrigger, Partial<EventDocument>, string | null]>([
    ['created on its table', created, { type: 'record.created' }, null],
    [
      'created on another table',
      created,
      { type: 'record.created', table_id: 'tbl_Other00000000001' },
      'other_table',
    ],
    ['another event type', created, { type: 'record.deleted' }, 'other_trigger'],
    ['updated, watched field changed', updated, {}, null],
    [
      'updated, other field changed',
      updated,
      { changes: { fld_title: { from: 'a', to: 'b' } } },
      'watch_fields_unchanged',
    ],
    ['updated, bulk with skip_bulk', updated, bulk, 'bulk_skipped'],
    ['created, bulk without skip_bulk', created, { type: 'record.created', ...bulk }, null],
    [
      'form of the trigger',
      form,
      { type: 'form.submitted', entity_type: 'form', data: { view_id: 'viw_Form000000000001' } },
      null,
    ],
    [
      'another form',
      form,
      { type: 'form.submitted', entity_type: 'form', data: { view_id: 'viw_Form000000000002' } },
      'other_view',
    ],
    ['automation events start nothing', created, { type: 'automation.disabled' }, 'other_trigger'],
  ])('%s', (_name, trigger, overrides, expected) => {
    expect(triggerMismatch(trigger, event(overrides))).toBe(expected);
  });

  it('finds the trigger record of record and form events', () => {
    expect(triggerRecordIdOf(event())).toBe('rec_Record0000000001');
    expect(
      triggerRecordIdOf(
        event({
          type: 'form.submitted',
          entity_type: 'form',
          entity_id: 'viw_Form000000000001',
          data: { record_id: 'rec_Submitted0000001' },
        }),
      ),
    ).toBe('rec_Submitted0000001');
  });
});

describe('loop guard (SPEC §11.6)', () => {
  it.each<[string, number, readonly string[], number, string | null]>([
    ['a person’s change', 0, [], 3, null],
    ['depth 2 of 3', 2, ['aut_Other00000000001'], 3, null],
    ['depth 3 of 3', 3, ['aut_A000000000000001'], 3, 'max_depth'],
    ['depth 4 of org limit 5', 4, [], 5, null],
    ['itself in the chain', 1, [AUT], 3, 'already_in_chain'],
  ])('%s', (_name, depth, chain, max, expected) => {
    expect(
      loopGuard(
        { root_event_id: ROOT, depth, automation_chain: chain as `aut_${string}`[] },
        AUT,
        max,
      ),
    ).toBe(expected);
  });

  it.each<[unknown, number]>([
    [null, 3],
    [{}, 3],
    [{ automation_max_depth: 5 }, 5],
    [{ automation_max_depth: 1 }, 1],
    [{ automation_max_depth: 6 }, 3],
    [{ automation_max_depth: 0 }, 3],
    [{ automation_max_depth: 2.5 }, 3],
    [{ automation_max_depth: '4' }, 3],
  ])('settings %j → max depth %d', (settings, expected) => {
    expect(automationMaxDepthOf(settings as never)).toBe(expected);
  });
});

describe('recomputeJobBatchId (T509)', () => {
  it.each([
    ['0', 'job_0000000000000000'],
    ['61', 'job_000000000000000z'],
    ['62', 'job_0000000000000010'],
    ['3843', 'job_00000000000000zz'],
  ])('%s → %s', (id, expected) => {
    expect(recomputeJobBatchId(id)).toBe(expected);
  });

  it('is a job id, stable for one job and distinct across jobs', () => {
    expect(recomputeJobBatchId('9223372036854775807')).toMatch(/^job_[0-9A-Za-z]{16}$/);
    expect(recomputeJobBatchId('123456')).toBe(recomputeJobBatchId(123456n));
    expect(recomputeJobBatchId('123456')).not.toBe(recomputeJobBatchId('123457'));
  });
});

describe('webhook.received: match and trigger unit (BACKLOG T604, ADR-35 §5)', () => {
  const HOOK = 'hok_Hook000000000001';
  const hookTrigger: AutomationTrigger = { type: 'webhook.received', incoming_webhook_id: HOOK };
  const received = (overrides: Partial<EventDocument> = {}): EventDocument => {
    const id = overrides.id ?? 'evt_Request000000001';
    const base = event();
    return {
      id,
      organization_id: base.organization_id,
      created_at: base.created_at,
      type: 'webhook.received',
      base_id: 'bse_Base000000000001',
      entity_type: 'incoming_webhook',
      entity_id: HOOK,
      actor: { type: 'webhook', id: HOOK },
      data: { incoming_webhook_id: HOOK, request_id: 'whr_Request000000001' },
      causation: { root_event_id: id, depth: 0, automation_chain: [] },
      ...overrides,
    };
  };

  it('fires for its hook only', () => {
    expect(triggerMismatch(hookTrigger, received())).toBeNull();
    expect(
      triggerMismatch(
        { type: 'webhook.received', incoming_webhook_id: 'hok_Other00000000001' },
        received(),
      ),
    ).toBe('other_webhook');
    expect(triggerMismatch(hookTrigger, event({ type: 'record.created' }))).toBe('other_trigger');
  });

  it('without causation: every request of the hook in the same second is one unit', () => {
    const at = (iso: string, id: string) =>
      triggerUnitOf(received({ id: id as `evt_${string}`, created_at: iso }));
    const first = at('2026-10-05T00:00:07.010Z', 'evt_Request000000001');
    expect(first).toBe(`webhook:${HOOK}:${String(Date.parse('2026-10-05T00:00:07Z') / 1000)}`);
    expect(at('2026-10-05T00:00:07.990Z', 'evt_Request000000002')).toBe(first);
    expect(at('2026-10-05T00:00:08.000Z', 'evt_Request000000003')).not.toBe(first);
    // 300 requests over one minute (5 req/s): at most 60 units, under the breaker's 100.
    const units = new Set(
      Array.from({ length: 300 }, (_, index) =>
        at(
          new Date(Date.parse('2026-10-05T00:00:00Z') + index * 200).toISOString(),
          `evt_Request${String(index).padStart(9, '0')}`,
        ),
      ),
    );
    expect(units.size).toBe(60);
  });

  it('with a valid causation: the root event of the chain, like an internal event', () => {
    expect(
      triggerUnitOf(
        received({ causation: { root_event_id: ROOT, depth: 1, automation_chain: [AUT] } }),
      ),
    ).toBe(ROOT);
  });
});
