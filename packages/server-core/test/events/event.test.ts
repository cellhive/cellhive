import { EVENT_TYPES, type EventType, type Id } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildEventRow,
  childCausation,
  entityTypeOf,
  MAX_CAUSATION_CHAIN,
  mergeCausations,
  toEventDocument,
  type EventInput,
  type StoredEvent,
} from '../../src/events/event.js';

const ORG = 'org_EventOrg00000001';
const EVT = 'evt_EventId000000001';
const AUT = 'aut_Automation000001';

function input(overrides: Record<string, unknown> = {}): EventInput {
  return {
    type: 'record.updated',
    organizationId: ORG,
    entityId: 'rec_Record0000000001',
    actor: { type: 'user', id: 'usr_User000000000001' },
    ...overrides,
  };
}

describe('entityTypeOf', () => {
  it.each<[EventType, string]>([
    ['record.updated', 'record'],
    ['org_member.role_changed', 'org_member'],
    ['automation.run.failed', 'automation_run'],
    ['share_link.revoked', 'share_link'],
  ])('%s → %s', (type, expected) => {
    expect(entityTypeOf(type)).toBe(expected);
  });

  it('gives a valid entity type for every catalogue event', () => {
    for (const type of EVENT_TYPES) expect(entityTypeOf(type)).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe('buildEventRow', () => {
  it('builds columns, payload and a root causation (depth 0) by default', () => {
    const row = buildEventRow(
      input({
        baseId: 'bse_Base000000000001',
        tableId: 'tbl_Table00000000001',
        changes: { fld_status: { from: ['opt_new'], to: ['opt_done'] } },
        recordVersion: 6,
      }),
      EVT,
    );
    expect(row).toEqual({
      id: EVT,
      organization_id: ORG,
      type: 'record.updated',
      entity_type: 'record',
      entity_id: 'rec_Record0000000001',
      actor_type: 'user',
      actor_id: 'usr_User000000000001',
      payload: {
        base_id: 'bse_Base000000000001',
        table_id: 'tbl_Table00000000001',
        changes: { fld_status: { from: ['opt_new'], to: ['opt_done'] } },
        record_version: 6,
      },
      causation: { root_event_id: EVT, depth: 0, automation_chain: [] },
    });
  });

  it('keeps a given causation and entity type', () => {
    const causation = { root_event_id: 'evt_Root000000000001', depth: 1, automation_chain: [AUT] };
    const row = buildEventRow(input({ causation, entityType: 'record' }), EVT);
    expect(row.causation).toEqual(causation);
  });

  it.each<[string, Record<string, unknown>]>([
    ['unknown event type', { type: 'record.exploded' }],
    ['audit-only action as event', { type: 'auth.login' }],
    ['bad organization id', { organizationId: 'org_short' }],
    ['user actor without id', { actor: { type: 'user', id: null } }],
    ['unknown actor type', { actor: { type: 'robot', id: 'x' } }],
    ['base id with another prefix', { baseId: 'tbl_Table00000000001' }],
    [
      'depth over the maximum',
      { causation: { root_event_id: EVT, depth: 6, automation_chain: [] } },
    ],
    ['non-finite number in data', { data: { n: Number.POSITIVE_INFINITY } }],
    ['unknown key', { extra: true }],
    ['bad entity type', { entityType: 'Record' }],
  ])('rejects %s with a TypeError', (_name, overrides) => {
    expect(() => buildEventRow(input(overrides), EVT)).toThrow(TypeError);
  });

  it('accepts a system actor without id', () => {
    const row = buildEventRow(
      input({ type: 'schedule.fired', actor: { type: 'system', id: null } }),
      EVT,
    );
    expect(row).toMatchObject({ actor_type: 'system', actor_id: null, entity_type: 'schedule' });
  });
});

describe('childCausation', () => {
  it('increments the depth and appends the automation (SPEC §11.6)', () => {
    const parent = {
      id: 'evt_Parent0000000001' as Id<'evt'>,
      causation: {
        root_event_id: 'evt_Root000000000001' as Id<'evt'>,
        depth: 1,
        automation_chain: ['aut_First00000000001' as Id<'aut'>],
      },
    };
    expect(childCausation(parent, AUT)).toEqual({
      root_event_id: 'evt_Root000000000001',
      depth: 2,
      automation_chain: ['aut_First00000000001', AUT],
    });
  });
});

describe('toEventDocument', () => {
  it('rebuilds the CONTRACTS §8 document from a row', () => {
    const row = buildEventRow(
      input({ tableId: 'tbl_Table00000000001', changes: { fld_a: { from: 1, to: 2 } } }),
      EVT,
    );
    const stored: StoredEvent = {
      ...row,
      causation: { ...row.causation, automation_chain: [] },
      created_at: new Date('2026-09-20T03:15:00.000Z'),
    };
    expect(toEventDocument(stored)).toEqual({
      id: EVT,
      type: 'record.updated',
      organization_id: ORG,
      table_id: 'tbl_Table00000000001',
      entity_type: 'record',
      entity_id: 'rec_Record0000000001',
      actor: { type: 'user', id: 'usr_User000000000001' },
      changes: { fld_a: { from: 1, to: 2 } },
      causation: { root_event_id: EVT, depth: 0, automation_chain: [] },
      created_at: '2026-09-20T03:15:00.000Z',
    });
  });
});

describe('batch and via (ADR-26 §1, BACKLOG T503)', () => {
  it('stores batch and via in the payload and reads them back', () => {
    const row = buildEventRow(
      input({
        tableId: 'tbl_Table00000000001',
        batch: { id: 'job_Import0000000001', size: 1000 },
        via: { import_job_id: 'job_Import0000000001' },
      }),
      EVT,
    );
    expect(row.payload).toEqual({
      table_id: 'tbl_Table00000000001',
      batch: { id: 'job_Import0000000001', size: 1000 },
      via: { import_job_id: 'job_Import0000000001' },
    });
    const document = toEventDocument({
      ...row,
      causation: { ...row.causation, automation_chain: [] },
      created_at: new Date('2026-10-05T00:00:00Z'),
    });
    expect(document.batch).toEqual({ id: 'job_Import0000000001', size: 1000 });
    expect(document.via).toEqual({ import_job_id: 'job_Import0000000001' });
  });

  it('accepts request, job and run batches', () => {
    for (const id of ['req_Request000000001', 'job_Job0000000000001', 'run_Run0000000000001']) {
      expect(buildEventRow(input({ batch: { id, size: 2 } }), EVT).payload.batch).toEqual({
        id,
        size: 2,
      });
    }
  });

  it.each([
    ['another prefix', { id: 'rec_Record0000000001', size: 1 }],
    ['size 0', { id: 'req_Request000000001', size: 0 }],
    ['extra key', { id: 'req_Request000000001', size: 1, at: 1 }],
  ])('rejects a malformed batch (%s)', (_name, batch) => {
    expect(() => buildEventRow(input({ batch }), EVT)).toThrow(TypeError);
  });

  it('an old event without batch reads as a single change', () => {
    const row = buildEventRow(input(), EVT);
    const document = toEventDocument({
      ...row,
      causation: { ...row.causation, automation_chain: [] },
      created_at: new Date('2026-10-05T00:00:00Z'),
    });
    expect(document).not.toHaveProperty('batch');
    expect(document).not.toHaveProperty('via');
  });
});

describe('recomputed values: via and merged causations (BACKLOG T509)', () => {
  it('keeps computed_recompute and job_id (null for a write that recomputed itself)', () => {
    for (const via of [
      { computed_recompute: true, job_id: 'job_Job0000000000001' },
      { computed_recompute: true, job_id: null, import_job_id: 'job_Import0000000001' },
    ] as const) {
      const row = buildEventRow(input({ via }), EVT);
      expect(row.payload.via).toEqual(via);
      const document = toEventDocument({
        ...row,
        causation: { ...row.causation, automation_chain: [] },
        created_at: new Date('2026-10-05T00:00:00Z'),
      });
      expect(document.via).toEqual(via);
    }
    expect(() => buildEventRow(input({ via: { computed_recompute: false } }), EVT)).toThrow(
      TypeError,
    );
  });

  const A = 'aut_A000000000000001' as Id<'aut'>;
  const B = 'aut_B000000000000001' as Id<'aut'>;
  const C = 'aut_C000000000000001' as Id<'aut'>;
  const root = (id: string, depth: number, chain: Id<'aut'>[]) => ({
    root_event_id: id as Id<'evt'>,
    depth,
    automation_chain: chain,
  });

  it.each([
    ['unknown + unknown', undefined, undefined, undefined],
    ['unknown + known', undefined, root(EVT, 1, [A]), root(EVT, 1, [A])],
    ['known + unknown', root(EVT, 2, [A, B]), undefined, root(EVT, 2, [A, B])],
    [
      'depth = max, chain = union, root of the first',
      root(EVT, 1, [A]),
      root('evt_Other00000000001', 2, [B, A, C]),
      root(EVT, 2, [A, B, C]),
    ],
    ['a user write merged with a run of A', root(EVT, 0, []), root(EVT, 1, [A]), root(EVT, 1, [A])],
  ])('mergeCausations: %s', (_name, a, b, expected) => {
    expect(mergeCausations(a, b)).toEqual(expected);
  });

  it('accepts merged chains longer than the depth, up to MAX_CAUSATION_CHAIN', () => {
    const chain = Array.from(
      { length: MAX_CAUSATION_CHAIN },
      (_, index): Id<'aut'> => `aut_${String(index).padStart(16, '0')}`,
    );
    const row = buildEventRow(input({ causation: root(EVT, 3, chain) }), EVT);
    expect(row.causation.automation_chain).toHaveLength(MAX_CAUSATION_CHAIN);
    expect(mergeCausations(root(EVT, 1, chain), root(EVT, 1, [A]))?.automation_chain).toHaveLength(
      MAX_CAUSATION_CHAIN,
    );
  });
});
