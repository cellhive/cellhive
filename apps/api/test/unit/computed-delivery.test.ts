import { describe, expect, it } from 'vitest';

import { computedRecomputingDelivery } from '../../src/modules/realtime/computed-recomputing-delivery.js';
import {
  computedDelivery,
  computedImageDiverges,
  RecordDeliveryStrategy,
} from '../../src/modules/realtime/record-delivery.js';

import type { BaseAccess } from '../../src/common/access/access.service.js';
import type { Delivery } from '../../src/modules/realtime/delivery.js';
import type { Subscriber } from '../../src/modules/realtime/realtime-connection.js';
import type { Id, IdPrefix, RealtimeServerMessage } from '@cellhive/contracts';
import type { FilterNode } from '@cellhive/filter-dsl';
import type {
  ComputedFieldMeta,
  ComputedRecomputingEnvelope,
  RecordChangesEnvelope,
} from '@cellhive/server-core';

/**
 * T459: per-subscriber delivery of recomputed formula/lookup values
 * (CONTRACTS §7): `locked` fields are never sent, values computed with the
 * subscriber's own read scope (record rule on a source table) become one
 * `record.batch`, view filters on computed fields move records in and out
 * of views, and `computed.recomputing` reaches readers of the field only.
 */
const id = <P extends IdPrefix>(prefix: P, n: number): Id<P> =>
  `${prefix}_${String(n).padStart(16, '0')}`;

const ORG = id('org', 1);
const BSE = id('bse', 1);
const CUSTOMERS = id('tbl', 1);
const ORDERS = id('tbl', 2);
const CHANNEL = `table:${CUSTOMERS}`;
const F = {
  name: id('fld', 1),
  phone: id('fld', 2),
  total: id('fld', 3),
  amount: id('fld', 10),
  customer: id('fld', 11),
  owner: id('fld', 12),
};
const U = { admin: id('usr', 1), reader: id('usr', 2), scoped: id('usr', 3) };
const C1 = id('rec', 1);

type Perms = Partial<Record<Id<'fld'>, 'edit' | 'read'>>;

function access(
  tables: Partial<Record<Id<'tbl'>, { fields: Perms; rule: FilterNode | null }>>,
): BaseAccess {
  const readFilters: Record<string, FilterNode | null> = {};
  const accessTables: Record<string, unknown> = {};
  for (const [tableId, table] of Object.entries(tables)) {
    if (table === undefined) continue;
    readFilters[tableId] = table.rule;
    accessTables[tableId] = { perm: 'read_only', fields: table.fields };
  }
  return {
    access: { is_admin: false, tables: accessTables },
    resolved: { internal: { readFilters, editFilters: {} } },
  } as unknown as BaseAccess;
}

const CUSTOMER_FIELDS: Perms = { [F.name]: 'edit', [F.phone]: 'edit', [F.total]: 'read' };
const ORDER_FIELDS: Perms = { [F.amount]: 'edit', [F.customer]: 'edit', [F.owner]: 'edit' };
const ownerIsMe: FilterNode = {
  op: 'and',
  items: [{ field: F.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
};

const everything = access({
  [CUSTOMERS]: { fields: CUSTOMER_FIELDS, rule: null },
  [ORDERS]: { fields: ORDER_FIELDS, rule: null },
});
/** Reads Customers but not Orders: `total` is locked. */
const customersOnly = access({ [CUSTOMERS]: { fields: CUSTOMER_FIELDS, rule: null } });
/** Reads only their own orders: `total` is computed with their scope. */
const ownOrders = access({
  [CUSTOMERS]: { fields: CUSTOMER_FIELDS, rule: null },
  [ORDERS]: { fields: ORDER_FIELDS, rule: ownerIsMe },
});
/** `amount` is no_perm: a field read on other records → locked. */
const noAmount = access({
  [CUSTOMERS]: { fields: CUSTOMER_FIELDS, rule: null },
  [ORDERS]: { fields: { [F.customer]: 'edit', [F.owner]: 'edit' }, rule: null },
});

const TOTAL_META: ComputedFieldMeta = {
  result_type: 'number',
  result_is_list: false,
  tables: [ORDERS],
  cross_fields: [
    { table_id: ORDERS, field_id: F.amount },
    { table_id: ORDERS, field_id: F.customer },
  ],
  same_row_fields: [],
  strict: false,
};

let nextConnection = 1;
function sub(
  userId: Id<'usr'>,
  base: BaseAccess,
  view: Subscriber['view'] = null,
  channel = CHANNEL,
): Subscriber {
  return {
    channel,
    target: { kind: 'table', id: CUSTOMERS },
    tables: null,
    userId,
    connectionId: nextConnection++,
    base,
    previousBase: null,
    variables: { timeZone: 'UTC', groupMemberUserIds: [] },
    view,
  };
}

type Change = RecordChangesEnvelope['changes'][number];

function recomputed(recordId: Id<'rec'>, from: number, to: number): Change {
  return {
    op: 'updated',
    record_id: recordId,
    version: 3,
    event_id: null,
    changed: [F.total],
    before: { [F.total]: from },
    after: { [F.total]: to },
    values: { [F.total]: to },
  };
}

function envelope(changes: Change[], meta: ComputedFieldMeta = TOTAL_META): RecordChangesEnvelope {
  return {
    v: 1,
    type: 'record.changes',
    organization_id: ORG,
    base_id: BSE,
    table_id: CUSTOMERS,
    actor_id: null,
    fields: [{ id: F.total, type: 'lookup', options: {}, computed: meta }],
    changes,
  };
}

const strategy = new RecordDeliveryStrategy({ now: () => new Date('2026-09-28T03:00:00Z') });

function to(deliveries: readonly Delivery[], subscriber: Subscriber): RealtimeServerMessage[] {
  return deliveries.filter((item) => item.subscriber === subscriber).map((item) => item.message);
}

describe('computedDelivery (T459)', () => {
  it.each([
    ['every source readable', everything, TOTAL_META, 'plain'],
    ['source table not readable', customersOnly, TOTAL_META, 'locked'],
    ['field of other records no_perm', noAmount, TOTAL_META, 'locked'],
    ['record rule on a source table', ownOrders, TOTAL_META, 'scoped'],
    [
      'same-record no_perm field, not strict',
      access({ [CUSTOMERS]: { fields: { [F.total]: 'read' }, rule: null } }),
      {
        ...TOTAL_META,
        tables: [],
        cross_fields: [],
        same_row_fields: [{ table_id: CUSTOMERS, field_id: F.phone }],
      },
      'plain',
    ],
    [
      'same-record no_perm field, strict',
      access({ [CUSTOMERS]: { fields: { [F.total]: 'read' }, rule: null } }),
      {
        ...TOTAL_META,
        tables: [],
        cross_fields: [],
        same_row_fields: [{ table_id: CUSTOMERS, field_id: F.phone }],
        strict: true,
      },
      'locked',
    ],
  ] as const)('%s → %s', (_name, base, meta, expected) => {
    expect(computedDelivery(base, meta as unknown as ComputedFieldMeta)).toBe(expected);
  });
});

describe('RecordDeliveryStrategy with computed values (T459)', () => {
  it('plain → the value; locked → nothing; scoped → one record.batch without the value', async () => {
    const admin = sub(U.admin, everything);
    const locked = sub(U.reader, customersOnly);
    const scoped = sub(U.scoped, ownOrders);
    const out = await strategy.deliver(envelope([recomputed(C1, 300, 500)]), [
      admin,
      locked,
      scoped,
    ]);
    expect(to(out, admin)).toEqual([
      {
        type: 'record.updated',
        channel: CHANNEL,
        record_id: C1,
        version: 3,
        fields: { [F.total]: 500 },
        actor_id: null,
        event_id: null,
      },
    ]);
    expect(to(out, locked)).toEqual([]);
    expect(to(out, scoped)).toEqual([
      {
        type: 'record.batch',
        channel: CHANNEL,
        actor_id: null,
        count: 1,
        ops: { created: 0, updated: 1, added: 0, removed_from_view: 0, deleted: 0, restored: 0 },
      },
    ]);
    expect(JSON.stringify(to(out, scoped))).not.toContain('500');
  });

  it('a field no_perm for the subscriber is never sent, even when plain for others', async () => {
    const hidden = sub(
      U.reader,
      access({
        [CUSTOMERS]: { fields: { [F.name]: 'edit' }, rule: null },
        [ORDERS]: { fields: ORDER_FIELDS, rule: null },
      }),
    );
    const out = await strategy.deliver(envelope([recomputed(C1, 1, 2)]), [hidden]);
    expect(to(out, hidden)).toEqual([]);
  });

  it('a saved view filter on a computed field: records enter and leave the view', async () => {
    const view = {
      id: id('viw', 1),
      filterMode: 'and' as const,
      filter: { op: 'and', items: [{ field: F.total, operator: 'gt', value: 400 }] },
    };
    const admin = sub(U.admin, everything, view);
    const scoped = sub(U.scoped, ownOrders, view);
    const up = await strategy.deliver(envelope([recomputed(C1, 300, 500)]), [admin, scoped]);
    expect(to(up, admin)).toEqual([{ type: 'record.added', channel: CHANNEL, record_id: C1 }]);
    // The scoped group cannot evaluate the stored value: the condition is ignored.
    expect(to(up, scoped)).toMatchObject([{ type: 'record.batch', count: 1 }]);
    const down = await strategy.deliver(envelope([recomputed(C1, 500, 100)]), [admin]);
    expect(to(down, admin)).toEqual([
      { type: 'record.removed_from_view', channel: CHANNEL, record_id: C1 },
    ]);
    const outside = await strategy.deliver(envelope([recomputed(C1, 100, 200)]), [admin]);
    expect(to(outside, admin)).toEqual([]);
  });

  it('more than the threshold of recomputed records: one record.batch per group', async () => {
    const admin = sub(U.admin, everything);
    const locked = sub(U.reader, customersOnly);
    const changes = Array.from({ length: 150 }, (_, index) =>
      recomputed(id('rec', index + 1), index, index + 1),
    );
    const out = await strategy.deliver(envelope(changes), [admin, locked]);
    expect(to(out, admin)).toMatchObject([{ type: 'record.batch', count: 150 }]);
    expect(to(out, locked)).toEqual([]);
  });
});

describe('computedImageDiverges (T462)', () => {
  it.each([
    ['every source read without rule', everything, TOTAL_META, false],
    ['source table not readable', customersOnly, TOTAL_META, true],
    ['record rule on a source table', ownOrders, TOTAL_META, true],
    ['field of other records no_perm (stored value is theirs)', noAmount, TOTAL_META, false],
    ['virtual', everything, { ...TOTAL_META, virtual: true }, true],
  ] as const)('%s → %s', (_name, base, meta, expected) => {
    expect(computedImageDiverges(base, meta as unknown as ComputedFieldMeta)).toBe(expected);
  });
});

describe('view filters on computed fields the images cannot decide (T462)', () => {
  const NAME_IS_AN = { field: F.name, operator: 'contains', value: 'An' };
  const nameChanged = (recordId: Id<'rec'>, from: string, to: string, total = 100): Change => ({
    op: 'updated',
    record_id: recordId,
    version: 4,
    event_id: id('evt', 1),
    changed: [F.name],
    before: { [F.name]: from, [F.total]: total },
    after: { [F.name]: to, [F.total]: total },
    values: { [F.name]: to },
  });
  const withName = (meta: ComputedFieldMeta): RecordChangesEnvelope => ({
    ...envelope([]),
    fields: [
      { id: F.name, type: 'text', options: {} },
      { id: F.total, type: 'lookup', options: {}, computed: meta },
    ],
  });

  it('a virtual field in the view filter: one record.batch, never a silently ignored condition', async () => {
    const view = {
      id: id('viw', 2),
      filterMode: 'and' as const,
      filter: { op: 'and', items: [{ field: F.total, operator: 'gt', value: 400 }] },
    };
    const admin = sub(U.admin, everything, view);
    const meta = { ...TOTAL_META, virtual: true };
    const out = await strategy.deliver(
      { ...withName(meta), changes: [nameChanged(C1, 'A', 'B')] },
      [admin],
    );
    expect(to(out, admin)).toEqual([
      {
        type: 'record.batch',
        channel: CHANNEL,
        actor_id: null,
        count: 1,
        ops: { created: 0, updated: 1, added: 0, removed_from_view: 0, deleted: 0, restored: 0 },
      },
    ]);
    // Without the view (or with a stored field), the per-record message as before.
    const plain = sub(U.admin, everything);
    const stored = await strategy.deliver(
      { ...withName(TOTAL_META), changes: [nameChanged(C1, 'A', 'B', 500)] },
      [plain, sub(U.admin, everything, view)],
    );
    expect(to(stored, plain)).toMatchObject([
      { type: 'record.updated', fields: { [F.name]: 'B' } },
    ]);
  });

  it('filter_mode replace: a locked field is not the subscriber’s to filter, its condition applies here', async () => {
    // `total` stored, locked for a reader missing `amount` on Orders (image = their value).
    const view = {
      id: id('viw', 3),
      filterMode: 'replace' as const,
      filter: { op: 'and', items: [NAME_IS_AN, { field: F.total, operator: 'gt', value: 400 }] },
    };
    const locked = sub(U.reader, noAmount, view);
    const admin = sub(U.admin, everything, view);
    const changes = [nameChanged(C1, 'A', 'B', 100), nameChanged(id('rec', 2), 'A', 'B', 500)];
    const out = await strategy.deliver({ ...withName(TOTAL_META), changes }, [locked, admin]);
    // The locked group: only the record matching the hidden condition (total > 400).
    expect(to(out, locked)).toEqual([
      {
        type: 'record.updated',
        channel: CHANNEL,
        record_id: id('rec', 2),
        version: 4,
        fields: { [F.name]: 'B' },
        actor_id: null,
        event_id: id('evt', 1),
      },
    ]);
    // The admin sees `total`: with replace, both conditions are theirs (client side).
    expect(to(out, admin).map((message) => message.type)).toEqual([
      'record.updated',
      'record.updated',
    ]);
  });

  it('filter_mode replace: a locked field over an unreadable table → record.batch', async () => {
    const view = {
      id: id('viw', 4),
      filterMode: 'replace' as const,
      filter: { op: 'and', items: [{ field: F.total, operator: 'gt', value: 400 }] },
    };
    const locked = sub(U.reader, customersOnly, view);
    const out = await strategy.deliver(
      { ...withName(TOTAL_META), changes: [nameChanged(C1, 'A', 'B', 500)] },
      [locked],
    );
    expect(to(out, locked)).toMatchObject([{ type: 'record.batch', count: 1 }]);
    expect(JSON.stringify(to(out, locked))).not.toContain('500');
  });
});

describe('computedRecomputingDelivery (T459)', () => {
  const progress: ComputedRecomputingEnvelope = {
    v: 1,
    type: 'computed.recomputing',
    organization_id: ORG,
    table_id: CUSTOMERS,
    field_id: F.total,
    progress: 0.4,
    status: 'running',
  };

  it('reaches subscribers who read the field, locked or not; never a no_perm field', async () => {
    const admin = sub(U.admin, everything);
    const locked = sub(U.reader, customersOnly);
    const hidden = sub(
      U.scoped,
      access({ [CUSTOMERS]: { fields: { [F.name]: 'edit' }, rule: null } }),
    );
    expect(computedRecomputingDelivery.channels(progress)).toEqual([CHANNEL]);
    const out = await computedRecomputingDelivery.deliver(progress, [admin, locked, hidden]);
    const message = {
      type: 'computed.recomputing',
      channel: CHANNEL,
      field_id: F.total,
      progress: 0.4,
      status: 'running',
    };
    expect(to(out, admin)).toEqual([message]);
    expect(to(out, locked)).toEqual([message]);
    expect(to(out, hidden)).toEqual([]);
  });
});

describe('RecordDeliveryStrategy with AI fields (T910)', () => {
  const summary = id('fld', 20);
  /** An AI field of Customers whose prompt reads `name` and `phone`. */
  const aiEnvelope = (to: string): RecordChangesEnvelope => ({
    v: 1,
    type: 'record.changes',
    organization_id: ORG,
    base_id: BSE,
    table_id: CUSTOMERS,
    actor_id: null,
    fields: [
      {
        id: summary,
        type: 'text',
        options: {
          ai: {
            task: 'summarize',
            prompt: `{{ [${F.name}] }} {{ [${F.phone}] }}`,
            instructions: null,
            auto_update: true,
            max_output_tokens: 300,
          },
        },
      },
    ],
    changes: [
      {
        op: 'updated',
        record_id: C1,
        version: 4,
        event_id: id('evt', 1),
        changed: [summary],
        before: { [summary]: null },
        after: { [summary]: to },
        values: { [summary]: to },
      },
    ],
  });

  it('always strict: a subscriber missing a field of the prompt gets nothing, the others the value', async () => {
    const fields: Perms = { [F.name]: 'edit', [F.phone]: 'edit', [summary]: 'read' };
    const reader = sub(U.admin, access({ [CUSTOMERS]: { fields, rule: null } }));
    const noPhone = sub(
      U.reader,
      access({ [CUSTOMERS]: { fields: { [F.name]: 'edit', [summary]: 'read' }, rule: null } }),
    );
    const out = await strategy.deliver(aiEnvelope('A short summary'), [reader, noPhone]);
    expect(to(out, reader)).toMatchObject([
      { type: 'record.updated', fields: { [summary]: 'A short summary' } },
    ]);
    expect(to(out, noPhone)).toEqual([]);
  });
});
