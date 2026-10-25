import { describe, expect, it } from 'vitest';

import {
  attachRealtimePublisher,
  jobProgressEnvelope,
  MAX_RECORD_CHANGES_PER_ENVELOPE,
  orgBusChannel,
  orgOfBusChannel,
  parseRealtimeEnvelope,
  publishRealtime,
  REALTIME_ENVELOPE_VERSION,
  RealtimeRecordChangePublisher,
  RealtimeSchemaChangePublisher,
  recordChangesEnvelopes,
  ValkeyRealtimeBus,
  type RealtimeEnvelope,
} from '../../src/realtime/index.js';

import type { Db } from '../../src/db/index.js';
import type { JobRecord } from '../../src/jobs/index.js';
import type { RecordChange } from '../../src/records/index.js';

const ORG = 'org_A1b2C3d4E5f6G7h8';
const OTHER_ORG = 'org_Z1b2C3d4E5f6G7h8';
const BSE = 'bse_A1b2C3d4E5f6G7h8';
const TBL = 'tbl_A1b2C3d4E5f6G7h8';
const USR = 'usr_A1b2C3d4E5f6G7h8';
const JOB = 'job_A1b2C3d4E5f6G7h8';

const schemaChanged: RealtimeEnvelope = {
  v: REALTIME_ENVELOPE_VERSION,
  type: 'schema.changed',
  organization_id: ORG,
  base_id: BSE,
  table_id: TBL,
  entity: 'field',
  entity_id: 'fld_A1b2C3d4E5f6G7h8',
  action: 'created',
};

describe('bus channels', () => {
  it('maps organizations to channels and back', () => {
    expect(orgBusChannel(ORG)).toBe(`rt:org:${ORG}`);
    expect(orgOfBusChannel(orgBusChannel(ORG))).toBe(ORG);
  });

  it.each(['rt:org:nope', `rt:user:${ORG}`, ORG, ''])('ignores %s', (channel) => {
    expect(orgOfBusChannel(channel)).toBeUndefined();
  });
});

describe('parseRealtimeEnvelope', () => {
  it.each<[string, RealtimeEnvelope]>([
    ['schema.changed', schemaChanged],
    [
      'permission.changed',
      { v: 1, type: 'permission.changed', organization_id: ORG, base_ids: [BSE] },
    ],
    [
      'job.progress',
      {
        v: 1,
        type: 'job.progress',
        organization_id: ORG,
        user_id: USR,
        job_id: JOB,
        progress: 0.5,
        status: 'running',
      },
    ],
  ])('accepts %s', (_type, envelope) => {
    expect(parseRealtimeEnvelope(JSON.stringify(envelope), ORG)).toEqual(envelope);
  });

  it.each([
    ['malformed JSON', '{'],
    ['another organization', JSON.stringify({ ...schemaChanged, organization_id: OTHER_ORG })],
    ['another version', JSON.stringify({ ...schemaChanged, v: 2 })],
    ['an unknown type', JSON.stringify({ ...schemaChanged, type: 'record.changed' })],
    [
      'no base ids',
      JSON.stringify({ v: 1, type: 'permission.changed', organization_id: ORG, base_ids: [] }),
    ],
  ])('drops %s', (_name, message) => {
    expect(parseRealtimeEnvelope(message, ORG)).toBeUndefined();
  });
});

describe('ValkeyRealtimeBus', () => {
  it('publishes JSON on the organization channel', async () => {
    const sent: [string, string][] = [];
    const bus = new ValkeyRealtimeBus({
      publish: (channel, message) => {
        sent.push([channel, message]);
        return Promise.resolve(1);
      },
    });
    await bus.publish(schemaChanged);
    expect(sent).toEqual([[`rt:org:${ORG}`, JSON.stringify(schemaChanged)]]);
  });

  it('reports failures to its handler instead of rejecting', async () => {
    const failures: unknown[] = [];
    const bus = new ValkeyRealtimeBus(
      { publish: () => Promise.reject(new Error('down')) },
      (error) => failures.push(error),
    );
    await expect(bus.publish(schemaChanged)).resolves.toBeUndefined();
    expect(failures).toHaveLength(1);
    // Without a handler the failure is swallowed too.
    await expect(
      new ValkeyRealtimeBus({ publish: () => Promise.reject(new Error('down')) }).publish(
        schemaChanged,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('publishers', () => {
  it('maps schema changes one to one', async () => {
    const published: RealtimeEnvelope[] = [];
    const publisher = new RealtimeSchemaChangePublisher({
      publish: (envelope) => {
        published.push(envelope);
        return Promise.resolve();
      },
    });
    await publisher.publish({
      organization_id: ORG,
      base_id: BSE,
      table_id: TBL,
      entity: 'field',
      entity_id: 'fld_A1b2C3d4E5f6G7h8',
      action: 'created',
    });
    expect(published).toEqual([schemaChanged]);
  });

  it('addresses job progress to the creator only', () => {
    const now = new Date();
    const job: JobRecord = {
      id: JOB,
      organization_id: ORG,
      type: 'audit.export',
      status: 'running',
      progress: 0.25,
      result: null,
      error: null,
      created_by: USR,
      started_at: now,
      finished_at: null,
      created_at: now,
      updated_at: now,
    };
    expect(jobProgressEnvelope(job)).toEqual({
      v: 1,
      type: 'job.progress',
      organization_id: ORG,
      user_id: USR,
      job_id: JOB,
      progress: 0.25,
      status: 'running',
    });
    expect(jobProgressEnvelope({ ...job, created_by: null })).toBeUndefined();
  });

  it('publishes at once outside a transaction, and nothing without a bus', async () => {
    const db = {} as Db;
    await expect(publishRealtime(db, undefined, schemaChanged)).resolves.toBeUndefined();
    const published: RealtimeEnvelope[] = [];
    attachRealtimePublisher(db, {
      publish: (envelope) => {
        published.push(envelope);
        return Promise.resolve();
      },
    });
    await publishRealtime(db, undefined, schemaChanged);
    expect(published).toEqual([schemaChanged]);
  });
});

describe('record changes', () => {
  const FLD = 'fld_A1b2C3d4E5f6G7h8';
  const change = (n: number, tableId: RecordChange['tableId'] = TBL): RecordChange => ({
    type: 'record.updated',
    organizationId: ORG,
    baseId: BSE,
    tableId,
    recordId: `rec_${String(n).padStart(16, '0')}`,
    version: 2,
    changedFieldIds: [FLD],
    eventId: `evt_${String(n).padStart(16, '0')}`,
    actor: { type: 'user', id: USR },
    actorUserId: USR,
    before: { [FLD]: 'a' },
    after: { [FLD]: 'b' },
    values: { [FLD]: 'b' },
  });
  const fields = [{ id: FLD, type: 'text', options: {} }] as const;

  it('maps changes to valid record.changes envelopes, one per table', () => {
    const other = 'tbl_Z1b2C3d4E5f6G7h8';
    const envelopes = recordChangesEnvelopes([change(1), change(2), change(3, other)], fields);
    expect(envelopes.map((envelope) => [envelope.table_id, envelope.changes.length])).toEqual([
      [TBL, 2],
      [other, 1],
    ]);
    // Not split: no batch marker.
    expect(envelopes.every((envelope) => envelope.batch === undefined)).toBe(true);
    expect(envelopes[0]).toEqual({
      v: 1,
      type: 'record.changes',
      organization_id: ORG,
      base_id: BSE,
      table_id: TBL,
      actor_id: USR,
      fields,
      changes: [1, 2].map((n) => ({
        op: 'updated',
        record_id: `rec_${String(n).padStart(16, '0')}`,
        version: 2,
        event_id: `evt_${String(n).padStart(16, '0')}`,
        changed: [FLD],
        before: { [FLD]: 'a' },
        after: { [FLD]: 'b' },
        values: { [FLD]: 'b' },
      })),
    });
    for (const envelope of envelopes) {
      expect(parseRealtimeEnvelope(JSON.stringify(envelope), ORG)).toEqual(envelope);
    }
  });

  it('carries the link fields of the values (T401) for the gateway to hide titles', () => {
    const link = {
      id: FLD,
      tableId: 'tbl_Z1b2C3d4E5f6G7h8',
      titleFieldId: 'fld_Z1b2C3d4E5f6G7h8',
    } as const;
    const [envelope] = recordChangesEnvelopes([change(1)], fields, {}, [link]);
    expect(envelope?.links).toEqual([
      { field_id: FLD, table_id: link.tableId, title_field_id: link.titleFieldId },
    ]);
    expect(parseRealtimeEnvelope(JSON.stringify(envelope), ORG)).toEqual(envelope);
  });

  it('marks link cells changed by another table (T402) on every part', () => {
    const changes = Array.from({ length: 600 }, (_, index) => change(index));
    const envelopes = recordChangesEnvelopes(changes, fields, {}, [], {
      fieldId: FLD,
      titlesOnly: true,
      values: false,
    });
    expect(envelopes).toHaveLength(2);
    for (const envelope of envelopes) {
      expect(envelope.link_fanout).toEqual({ field_id: FLD, titles_only: true, values: false });
      expect(parseRealtimeEnvelope(JSON.stringify(envelope), ORG)).toEqual(envelope);
    }
    expect(recordChangesEnvelopes([change(1)], fields)[0]).not.toHaveProperty('link_fanout');
  });

  it('splits large batches by count and by size, keeping the order', () => {
    const changes = Array.from({ length: 1200 }, (_, index) => change(index));
    const byCount = recordChangesEnvelopes(changes, fields);
    expect(byCount.map((envelope) => envelope.changes.length)).toEqual([
      MAX_RECORD_CHANGES_PER_ENVELOPE,
      MAX_RECORD_CHANGES_PER_ENVELOPE,
      200,
    ]);
    // One write split in parts: a shared batch marker, in order (T303).
    const id = byCount[0]?.batch?.id;
    expect(id).toEqual(expect.any(String));
    expect(byCount.map((envelope) => envelope.batch)).toEqual(
      [0, 1, 2].map((part) => ({ id, part, parts: 3 })),
    );
    for (const envelope of byCount) {
      expect(parseRealtimeEnvelope(JSON.stringify(envelope), ORG)).toEqual(envelope);
    }
    expect(recordChangesEnvelopes(changes, fields)[0]?.batch?.id).not.toBe(id);
    const bySize = recordChangesEnvelopes(changes, fields, { maxBytes: 20_000 });
    expect(bySize.length).toBeGreaterThan(10);
    for (const envelope of bySize) {
      expect(JSON.stringify(envelope).length).toBeLessThan(20_000);
    }
    expect(bySize.flatMap((envelope) => envelope.changes.map((item) => item.record_id))).toEqual(
      changes.map((item) => item.recordId),
    );
  });

  it('publishes on the attached bus only, in order', async () => {
    const db = {} as Db;
    const publisher = new RealtimeRecordChangePublisher(db, { maxChanges: 2 });
    expect(publisher.active).toBe(false);
    await publisher.publish([change(1)], fields);
    const published: RealtimeEnvelope[] = [];
    attachRealtimePublisher(db, {
      publish: (envelope) => {
        published.push(envelope);
        return Promise.resolve();
      },
    });
    expect(publisher.active).toBe(true);
    await publisher.publish([change(1), change(2), change(3)], fields);
    expect(
      published.map((envelope) =>
        envelope.type === 'record.changes' ? envelope.changes.length : 0,
      ),
    ).toEqual([2, 1]);
  });
});
