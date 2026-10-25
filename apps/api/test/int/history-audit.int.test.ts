import {
  auditLogListSchema,
  fieldListSchema,
  fieldSchema,
  jobAcceptedSchema,
  jobSchema,
  newId,
  recordHistoryResponseSchema,
  recordSchema,
  recordsResponseSchema,
  recordTrashResponseSchema,
  redactAuditLogsResponseSchema,
  type Id,
  type JobDto,
  type RecordDto,
  type RecordHistoryEntry,
} from '@cellhive/contracts';
import { BaseRolesRepository, orgScope, type Db } from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * Polls a job until it is finished (`succeeded` or `failed`) and returns it:
 * a failed job ends the wait at once and shows in the assertion that
 * follows. The deadline stays under the test timeout (60 s): on a loaded
 * machine (every package's integration tests at once) the worker's start
 * and the job itself take much longer than on an idle one (T319).
 */
async function finishedJob(read: () => Promise<LightMyRequestResponse>): Promise<JobDto> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const job = jobSchema.parse((await read()).json());
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    if (Date.now() > deadline) throw new Error(`job ${job.id} still ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function records(response: LightMyRequestResponse): RecordDto[] {
  expect(response.statusCode).toBeLessThan(300);
  return recordsResponseSchema.parse(response.json()).records;
}

/**
 * T111: record history, value revert, record trash, field restore and the
 * audit log admin API (ADR-23, CONTRACTS §11), end to end on the permission
 * fixture of CONTRACTS §5 (`Sales` hides `cost`, reads `status`, edits only
 * records it owns).
 */
describe('record history, trash and audit log API (T111)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let orders: string;
  let tickets: string;
  let orgAdmin: SeededUser;
  let orgAdminBrowser: Browser;
  let worker: WorkerHandle | undefined;
  const ids: Record<string, Id<'rec'>> = {};

  const historyOf = async (user: FixtureUser, path: string, id: string, query = '') => {
    const response = await fx.call(user, 'GET', `${path}/${id}/history${query}`);
    return response;
  };
  const entriesOf = (response: LightMyRequestResponse): RecordHistoryEntry[] => {
    expect(response.statusCode).toBe(200);
    return recordHistoryResponseSchema.parse(response.json()).items;
  };
  const auditRows = (action: string, actorId: string) =>
    db.kysely
      .selectFrom('meta.audit_logs')
      .selectAll()
      .where('organization_id', '=', fx.orgId)
      .where('action', '=', action)
      .where('actor_id', '=', actorId)
      .execute();

  /** Starts the real worker once (`audit.export` jobs). */
  async function startWorker(): Promise<void> {
    worker ??= await createWorker(t.config, {
      logger: captureLogger().logger,
      pollIntervalMs: 100,
    });
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    orders = `/tables/${fx.orders.id}/records`;
    tickets = `/tables/${fx.tickets.id}/records`;
    orgAdmin = await seedUser(db, {
      memberships: [{ orgId: fx.orgId, role: 'admin' }],
      displayName: 'Org admin',
    });
    orgAdminBrowser = new Browser(t.app);
    expect((await orgAdminBrowser.login(orgAdmin.email)).statusCode).toBe(204);

    const created = records(
      await fx.call('u_admin', 'POST', orders, {
        records: [
          { fields: { title: 'r1', amount: 100, cost: 50, owner: [{ id: fx.users.u_sales1.id }] } },
          { fields: { title: 'r2', amount: 200, cost: 80, owner: [{ id: fx.users.u_sales2.id }] } },
          { fields: { title: 't1', amount: 1, owner: [{ id: fx.users.u_sales1.id }] } },
          { fields: { title: 't2', amount: 2, owner: [{ id: fx.users.u_sales2.id }] } },
        ],
      }),
    );
    for (const record of created) ids[record.fields.title as string] = record.id;
  });

  afterAll(async () => {
    await worker?.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  // --- History ---------------------------------------------------------------------

  describe('history', () => {
    it('one bulk PATCH of 500 records: every history entry has batch.size = 500', async () => {
      const created = records(
        await fx.call('u_admin', 'POST', tickets, {
          records: Array.from({ length: 500 }, (_, index) => ({
            fields: { 'Tiêu đề': `Paste ${String(index)}` },
          })),
        }),
      );
      expect(created).toHaveLength(500);
      const patched = await fx.call('u_admin', 'PATCH', tickets, {
        records: created.map((record, index) => ({
          id: record.id,
          fields: { 'Số tiền': index + 1 },
        })),
      });
      expect(patched.statusCode).toBe(200);
      const batchId = patched.headers['x-request-id'] as string;

      for (let start = 0; start < created.length; start += 50) {
        const chunk = created.slice(start, start + 50);
        const histories = await Promise.all(
          chunk.map(async (record) => entriesOf(await historyOf('u_admin', tickets, record.id))),
        );
        for (const [offset, entries] of histories.entries()) {
          const [updated, creation] = entries;
          expect(updated).toMatchObject({
            action: 'record.updated',
            batch: { id: batchId, size: 500 },
            actor: { type: 'user', id: fx.users.u_admin.id, name: 'User admin' },
            via: null,
            changes: { 'Số tiền': { from: null, to: start + offset + 1 } },
          });
          expect(creation).toMatchObject({ action: 'record.created', batch: { size: 500 } });
        }
      }
    }, 120_000);

    it('u_sales1 on r1: `cost` changes are hidden and cost-only entries are dropped', async () => {
      // Cost only, then amount + cost, then a change by the owner of r1.
      expect(
        (await fx.call('u_admin', 'PATCH', `${orders}/${ids.r1 ?? ''}`, { fields: { cost: 60 } }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await fx.call('u_admin', 'PATCH', `${orders}/${ids.r1 ?? ''}`, {
            fields: { amount: 110, cost: 70 },
          })
        ).statusCode,
      ).toBe(200);

      const admin = entriesOf(await historyOf('u_admin', orders, ids.r1 as string));
      expect(admin.map((entry) => entry.action)).toEqual([
        'record.updated',
        'record.updated',
        'record.created',
      ]);
      expect(Object.keys(admin[0]?.changes ?? {}).sort()).toEqual(['amount', 'cost']);
      expect(Object.keys(admin[1]?.changes ?? {})).toEqual(['cost']);
      expect(admin[2]?.changes).toMatchObject({ cost: { from: null, to: 50 } });
      expect(admin[2]?.batch).toMatchObject({ size: 4 });

      const response = await historyOf('u_sales1', orders, ids.r1 as string);
      const sales = entriesOf(response);
      expect(response.body).not.toContain('"cost"');
      expect(sales.map((entry) => entry.action)).toEqual(['record.updated', 'record.created']);
      expect(sales[0]?.changes).toEqual({ amount: { from: 100, to: 110 } });
      expect(sales[1]?.changes).toMatchObject({
        title: { from: null, to: 'r1' },
        owner: {
          from: null,
          to: [{ id: fx.users.u_sales1.id, name: 'User sales1', email: fx.users.u_sales1.email }],
        },
      });
    });

    it('u_sales1 on r2 (outside its read rule) → 404; strangers → 404', async () => {
      expectProblem(await historyOf('u_sales1', orders, ids.r2 as string), 404, 'NOT_FOUND');
      expectProblem(await historyOf('stranger', orders, ids.r1 as string), 404, 'NOT_FOUND');
      expectProblem(await historyOf('u_out', orders, ids.r1 as string), 404, 'NOT_FOUND');
      expectProblem(await historyOf('u_admin', orders, newId('rec')), 404, 'NOT_FOUND');
    });

    it('?field= keeps entries of that field; a hidden field is an unknown field', async () => {
      const onlyCost = entriesOf(
        await historyOf('u_admin', orders, ids.r1 as string, '?field=cost'),
      );
      expect(onlyCost).toHaveLength(3);
      expect(onlyCost.every((entry) => Object.keys(entry.changes).join() === 'cost')).toBe(true);
      const byId = entriesOf(
        await historyOf(
          'u_admin',
          orders,
          ids.r1 as string,
          `?field_key_type=id&field=${fx.fld.amount?.id ?? ''}`,
        ),
      );
      expect(byId.map((entry) => Object.keys(entry.changes))).toEqual([
        [fx.fld.amount?.id],
        [fx.fld.amount?.id],
      ]);
      const hidden = await historyOf('u_sales1', orders, ids.r1 as string, '?field=cost');
      expectProblem(hidden, 422, 'VALIDATION_FAILED');
    });

    it('pages with a keyset cursor and rejects a forged cursor', async () => {
      const first = await historyOf('u_admin', orders, ids.r1 as string, '?limit=2');
      const page = recordHistoryResponseSchema.parse(first.json());
      expect(page.items).toHaveLength(2);
      expect(page.next_cursor).not.toBeNull();
      const second = recordHistoryResponseSchema.parse(
        (
          await historyOf(
            'u_admin',
            orders,
            ids.r1 as string,
            `?limit=2&cursor=${page.next_cursor ?? ''}`,
          )
        ).json(),
      );
      expect(second.items.map((entry) => entry.action)).toEqual(['record.created']);
      expect(second.next_cursor).toBeNull();
      expectProblem(
        await historyOf('u_admin', orders, ids.r1 as string, '?cursor=not-a-cursor'),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('renders deleted options as { id, name: null, deleted: true }', async () => {
      const field = fieldSchema.parse(
        (
          await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/fields`, {
            name: 'Mức độ',
            type: 'select',
            options: { options: [{ name: 'Cao' }, { name: 'Thấp' }] },
          })
        ).json(),
      );
      const [record] = records(
        await fx.call('u_admin', 'POST', tickets, {
          records: [{ fields: { 'Tiêu đề': 'Options', 'Mức độ': 'Cao' } }],
        }),
      );
      const options = (field.options as { options: { id: string; name: string }[] }).options;
      const high = options.find((option) => option.name === 'Cao');
      const kept = options.filter((option) => option.name !== 'Cao');
      const updated = await fx.call('u_admin', 'PATCH', `/fields/${field.id}`, {
        options: { options: kept },
      });
      expect(updated.statusCode).toBe(200);
      const [creation] = entriesOf(await historyOf('u_admin', tickets, record?.id ?? ''));
      expect(creation?.changes['Mức độ']).toEqual({
        from: null,
        to: { id: high?.id, name: null, deleted: true },
      });
    });
  });

  // --- Revert ----------------------------------------------------------------------

  describe('revert', () => {
    let amountEntry: RecordHistoryEntry;

    beforeAll(async () => {
      const entries = entriesOf(await historyOf('u_admin', orders, ids.r1 as string));
      amountEntry = entries[0] as RecordHistoryEntry;
      expect(Object.keys(amountEntry.changes).sort()).toEqual(['amount', 'cost']);
    });

    it('an audit_id of another record, table or organization → 404', async () => {
      const r2Entry = entriesOf(await historyOf('u_admin', orders, ids.r2 as string))[0];
      const revert = (auditId: string) =>
        fx.call('u_admin', 'POST', `${orders}/${ids.r1 ?? ''}/revert`, { audit_id: auditId });
      expectProblem(await revert(r2Entry?.id ?? ''), 404, 'NOT_FOUND');
      expectProblem(await revert(newId('aud')), 404, 'NOT_FOUND');
      // The r1 entry through another table's route.
      expectProblem(
        await fx.call('u_admin', 'POST', `${tickets}/${ids.r1 ?? ''}/revert`, {
          audit_id: amountEntry.id,
        }),
        404,
        'NOT_FOUND',
      );
      // A stranger (another organization) sees nothing.
      expectProblem(
        await fx.call('stranger', 'POST', `${orders}/${ids.r1 ?? ''}/revert`, {
          audit_id: amountEntry.id,
        }),
        404,
        'NOT_FOUND',
      );
      // A caller who cannot read r2 cannot revert it, whatever the entry.
      expectProblem(
        await fx.call('u_sales1', 'POST', `${orders}/${ids.r2 ?? ''}/revert`, {
          audit_id: r2Entry?.id,
        }),
        404,
        'NOT_FOUND',
      );
    });

    it('a stale version → 409 VERSION_CONFLICT', async () => {
      const response = await fx.call('u_admin', 'POST', `${orders}/${ids.r1 ?? ''}/revert`, {
        audit_id: amountEntry.id,
        version: 1,
      });
      expectProblem(response, 409, 'VERSION_CONFLICT');
    });

    it('u_sales1: cost-only entry → 404; amount+cost entry → only amount is set back', async () => {
      const admin = entriesOf(await historyOf('u_admin', orders, ids.r1 as string));
      const costOnly = admin[1] as RecordHistoryEntry;
      expectProblem(
        await fx.call('u_sales1', 'POST', `${orders}/${ids.r1 ?? ''}/revert`, {
          audit_id: costOnly.id,
        }),
        404,
        'NOT_FOUND',
      );
      const current = recordSchema.parse(
        (await fx.call('u_admin', 'GET', `${orders}/${ids.r1 ?? ''}`)).json(),
      );
      const response = await fx.call('u_sales1', 'POST', `${orders}/${ids.r1 ?? ''}/revert`, {
        audit_id: amountEntry.id,
        version: current.version,
      });
      expect(response.statusCode).toBe(200);
      const record = recordSchema.parse(response.json());
      expect(record.fields).toMatchObject({ amount: 100 });
      expect(record.fields).not.toHaveProperty('cost');
      const after = recordSchema.parse(
        (await fx.call('u_admin', 'GET', `${orders}/${ids.r1 ?? ''}`)).json(),
      );
      expect(after.fields).toMatchObject({ amount: 100, cost: 70 });

      const [latest] = entriesOf(await historyOf('u_sales1', orders, ids.r1 as string));
      expect(latest).toMatchObject({
        action: 'record.updated',
        actor: { id: fx.users.u_sales1.id },
        via: { reverted_from: amountEntry.id },
        changes: { amount: { from: 110, to: 100 } },
      });
    });

    it('happy path: a new history entry with via.reverted_from; readable-not-editable → 403', async () => {
      const response = await fx.call(
        'u_admin',
        'POST',
        `${orders}/${ids.r1 ?? ''}/revert?field_key_type=id`,
        { audit_id: amountEntry.id },
      );
      expect(response.statusCode).toBe(200);
      const record = recordSchema.parse(response.json());
      expect(record.fields[fx.fld.cost?.id ?? '']).toBe(60);
      const [latest] = entriesOf(await historyOf('u_admin', orders, ids.r1 as string));
      expect(latest?.via).toEqual({ reverted_from: amountEntry.id });
      expect(latest?.changes).toEqual({ cost: { from: 70, to: 60 } });
      const rows = await db.kysely
        .selectFrom('meta.audit_logs')
        .select(['via', 'action'])
        .where('id', '=', latest?.id ?? newId('aud'))
        .execute();
      expect(rows).toEqual([{ via: { reverted_from: amountEntry.id }, action: 'record.updated' }]);

      // `status` is readable but not editable for Sales.
      const statusChange = await fx.call('u_admin', 'PATCH', `${orders}/${ids.r1 ?? ''}`, {
        fields: { status: 'Xong' },
      });
      expect(statusChange.statusCode).toBe(200);
      const [statusEntry] = entriesOf(await historyOf('u_sales1', orders, ids.r1 as string));
      expect(Object.keys(statusEntry?.changes ?? {})).toEqual(['status']);
      expectProblem(
        await fx.call('u_sales1', 'POST', `${orders}/${ids.r1 ?? ''}/revert`, {
          audit_id: statusEntry?.id,
        }),
        403,
        'FIELD_READ_ONLY',
      );
    });
  });

  // --- Field restore ----------------------------------------------------------------

  describe('field restore', () => {
    it('restores a deleted field with its data; others get 404; expired → 404', async () => {
      const field = fieldSchema.parse(
        (
          await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/fields`, {
            name: 'Ghi chú',
            type: 'text',
          })
        ).json(),
      );
      const [record] = records(
        await fx.call('u_admin', 'POST', tickets, {
          records: [{ fields: { 'Tiêu đề': 'Có ghi chú', 'Ghi chú': 'Giữ lại nhé' } }],
        }),
      );
      const id = record?.id ?? '';
      expect((await fx.call('u_admin', 'DELETE', `/fields/${field.id}`)).statusCode).toBe(204);
      const hidden = recordSchema.parse(
        (await fx.call('u_admin', 'GET', `${tickets}/${id}`)).json(),
      );
      expect(hidden.fields).not.toHaveProperty('Ghi chú');

      // `include_deleted=true` lists the restorable field with `deleted_at` (schema rights only).
      const fieldsPath = `/tables/${fx.tickets.id}/fields`;
      const live = fieldListSchema.parse((await fx.call('u_admin', 'GET', fieldsPath)).json());
      expect(live.items.map((item) => item.id)).not.toContain(field.id);
      expect(live.items.every((item) => item.deleted_at === undefined)).toBe(true);
      const withTrash = fieldListSchema.parse(
        (await fx.call('u_admin', 'GET', `${fieldsPath}?include_deleted=true`)).json(),
      );
      const trashed = withTrash.items.filter((item) => item.deleted_at !== undefined);
      expect(trashed.map((item) => item.id)).toEqual([field.id]);
      expect(withTrash.total).toBe(live.total + 1);
      expectProblem(
        await fx.call('u_editor', 'GET', `${fieldsPath}?include_deleted=true`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call('stranger', 'GET', `${fieldsPath}?include_deleted=true`),
        404,
        'NOT_FOUND',
      );
      // Deleted fields do not appear in history.
      const [creation] = entriesOf(await historyOf('u_admin', tickets, id));
      expect(creation?.changes).not.toHaveProperty('Ghi chú');

      expectProblem(
        await fx.call('u_editor', 'POST', `/fields/${field.id}/restore`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('stranger', 'POST', `/fields/${field.id}/restore`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('u_admin', 'POST', `/fields/${newId('fld')}/restore`),
        404,
        'NOT_FOUND',
      );

      const restored = await fx.call('u_admin', 'POST', `/fields/${field.id}/restore`);
      expect(restored.statusCode).toBe(200);
      expect(fieldSchema.parse(restored.json())).toMatchObject({ id: field.id, name: 'Ghi chú' });
      const back = recordSchema.parse((await fx.call('u_admin', 'GET', `${tickets}/${id}`)).json());
      expect(back.fields['Ghi chú']).toBe('Giữ lại nhé');
      // Restoring a live field answers it unchanged.
      expect((await fx.call('u_admin', 'POST', `/fields/${field.id}/restore`)).statusCode).toBe(
        200,
      );

      // Older than 30 days → 404.
      expect((await fx.call('u_admin', 'DELETE', `/fields/${field.id}`)).statusCode).toBe(204);
      await sql`UPDATE meta.fields SET deleted_at = now() - interval '31 days'
                 WHERE id = ${field.id}`.execute(db.kysely);
      const expired = fieldListSchema.parse(
        (await fx.call('u_admin', 'GET', `${fieldsPath}?include_deleted=true`)).json(),
      );
      expect(expired.items.map((item) => item.id)).not.toContain(field.id);
      expectProblem(
        await fx.call('u_admin', 'POST', `/fields/${field.id}/restore`),
        404,
        'NOT_FOUND',
      );
    });
  });

  // --- Trash -----------------------------------------------------------------------

  describe('trash', () => {
    beforeAll(async () => {
      // Sales may now delete (and so see the trash of) the records it owns.
      const repository = new BaseRolesRepository(db);
      const scope = orgScope(fx.orgId);
      const sales = (await repository.listByBase(scope, fx.baseId)).find(
        (role) => role.name === 'Sales',
      );
      if (sales === undefined) throw new Error('missing Sales role');
      const config = structuredClone(sales.config) as {
        tables: Record<string, { record_rule: { operations: string[] } }>;
      };
      const table = config.tables[fx.orders.id];
      if (table === undefined) throw new Error('missing Orders config');
      table.record_rule.operations = ['add', 'delete'];
      await repository.update(scope, fx.baseId, sales.id, { config });

      for (const title of ['t1', 't2']) {
        const deleted = await fx.call('u_admin', 'DELETE', `${orders}/${ids[title] ?? ''}`);
        expect(deleted.statusCode).toBe(204);
      }
    });

    it('lists deleted_at and deleted_by, newest deletion first, with a cursor', async () => {
      const response = await fx.call('u_admin', 'GET', `${orders}/trash`);
      expect(response.statusCode).toBe(200);
      const trash = recordTrashResponseSchema.parse(response.json());
      expect(trash.records.map((record) => record.id)).toEqual([ids.t2, ids.t1]);
      expect(trash.records[0]).toMatchObject({
        deleted_by: { id: fx.users.u_admin.id, name: 'User admin' },
        fields: { title: 't2' },
      });
      expect(Date.parse(trash.records[0]?.deleted_at ?? '')).toBeGreaterThanOrEqual(
        Date.parse(trash.records[1]?.deleted_at ?? ''),
      );
      expect(trash.next_cursor).toBeNull();

      const first = recordTrashResponseSchema.parse(
        (await fx.call('u_admin', 'GET', `${orders}/trash?limit=1`)).json(),
      );
      expect(first.records.map((record) => record.id)).toEqual([ids.t2]);
      const second = recordTrashResponseSchema.parse(
        (
          await fx.call(
            'u_admin',
            'GET',
            `${orders}/trash?limit=1&cursor=${first.next_cursor ?? ''}`,
          )
        ).json(),
      );
      expect(second.records.map((record) => record.id)).toEqual([ids.t1]);
      expect(second.next_cursor).toBeNull();
    });

    it('respects the edit rule: u_sales1 sees and restores only what it owns', async () => {
      const response = await fx.call('u_sales1', 'GET', `${orders}/trash`);
      const trash = recordTrashResponseSchema.parse(response.json());
      expect(trash.records.map((record) => record.id)).toEqual([ids.t1]);
      expect(response.body).not.toContain('"cost"');

      expectProblem(
        await fx.call('u_sales1', 'POST', `${orders}/restore`, { ids: [ids.t2] }),
        404,
        'NOT_FOUND',
      );
      const restored = await fx.call('u_sales1', 'POST', `${orders}/restore`, { ids: [ids.t1] });
      expect(records(restored).map((record) => record.id)).toEqual([ids.t1]);
    });

    it('needs edit + delete: readers get 403, outsiders 404', async () => {
      expectProblem(await fx.call('u_reader', 'GET', `${orders}/trash`), 403, 'PERMISSION_DENIED');
      expectProblem(await fx.call('u_out', 'GET', `${orders}/trash`), 404, 'NOT_FOUND');
      expectProblem(await fx.call('stranger', 'GET', `${orders}/trash`), 404, 'NOT_FOUND');
    });
  });

  // --- Audit log --------------------------------------------------------------------

  describe('audit log', () => {
    it('org log: owner and org admin only; anyone else → 404', async () => {
      const response = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/audit-logs?limit=5`);
      expect(response.statusCode).toBe(200);
      const page = auditLogListSchema.parse(response.json());
      expect(page.items).toHaveLength(5);
      expect(page.next_cursor).not.toBeNull();
      const admin = await orgAdminBrowser.request({
        method: 'GET',
        url: `/api/v1/orgs/${fx.orgId}/audit-logs`,
      });
      expect(admin.statusCode).toBe(200);
      for (const user of ['u_admin', 'u_editor', 'u_sales1', 'stranger'] as const) {
        expectProblem(await fx.call(user, 'GET', `/orgs/${fx.orgId}/audit-logs`), 404, 'NOT_FOUND');
      }
    });

    it('filters by table, entity, action, actor and batch, with storage-form values', async () => {
      const response = await fx.call(
        'owner',
        'GET',
        `/orgs/${fx.orgId}/audit-logs?table_id=${fx.orders.id}&entity_id=${ids.r1 ?? ''}` +
          `&action=record.updated&actor_id=${fx.users.u_sales1.id}`,
      );
      const page = auditLogListSchema.parse(response.json());
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        entity_type: 'record',
        entity_id: ids.r1,
        table_id: fx.orders.id,
        base_id: fx.baseId,
        actor: { type: 'user', id: fx.users.u_sales1.id, name: 'User sales1' },
        via: { reverted_from: expect.stringMatching(/^aud_/) as unknown },
        before: { [fx.fld.amount?.id ?? '']: 110 },
        after: { [fx.fld.amount?.id ?? '']: 100 },
      });
      const batchId = page.items[0]?.batch_id ?? '';
      const batch = auditLogListSchema.parse(
        (await fx.call('owner', 'GET', `/orgs/${fx.orgId}/audit-logs?batch_id=${batchId}`)).json(),
      );
      expect(batch.items.map((item) => item.id)).toEqual([page.items[0]?.id]);
      expectProblem(
        await fx.call('owner', 'GET', `/orgs/${fx.orgId}/audit-logs?from=yesterday`),
        422,
        'VALIDATION_FAILED',
      );
    });

    it('base log: base admins only; entries of that base only', async () => {
      const response = await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/audit-logs?limit=50`);
      expect(response.statusCode).toBe(200);
      const page = auditLogListSchema.parse(response.json());
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((item) => item.base_id === fx.baseId)).toBe(true);
      expect((await fx.call('owner', 'GET', `/bases/${fx.baseId}/audit-logs`)).statusCode).toBe(
        200,
      );
      for (const user of ['u_editor', 'u_reader', 'u_sales1', 'u_out', 'stranger'] as const) {
        expectProblem(
          await fx.call(user, 'GET', `/bases/${fx.baseId}/audit-logs`),
          404,
          'NOT_FOUND',
        );
      }
    });

    it('audit.viewed is written at most once per viewer, scope and filters (T709: 10 minutes)', async () => {
      const ownerBefore = (await auditRows('audit.viewed', fx.users.owner.id)).length;
      for (let i = 0; i < 3; i += 1) {
        await fx.call('owner', 'GET', `/orgs/${fx.orgId}/audit-logs?entity_type=view`);
        await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/audit-logs`);
      }
      const ownerViews = await auditRows('audit.viewed', fx.users.owner.id);
      expect(ownerViews).toHaveLength(ownerBefore + 1);
      const adminViews = await auditRows('audit.viewed', fx.users.u_admin.id);
      expect(adminViews.map((row) => [row.entity_type, row.entity_id, row.base_id])).toEqual([
        ['base', fx.baseId, fx.baseId],
      ]);
      expect(adminViews[0]?.before).toBeNull();
      expect(adminViews[0]?.after).toBeNull();
    });

    it('export: 202 job → CSV downloadable by its creator and org admins only', async () => {
      const accepted = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/audit-logs/export`, {
        format: 'csv',
        filters: { table_id: fx.orders.id },
      });
      expect(accepted.statusCode).toBe(202);
      const { job_id: jobId } = jobAcceptedSchema.parse(accepted.json());
      expectProblem(
        await fx.call('u_admin', 'POST', `/orgs/${fx.orgId}/audit-logs/export`, { format: 'csv' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('owner', 'POST', `/orgs/${fx.orgId}/audit-logs/export`, { format: 'xlsx' }),
        422,
        'VALIDATION_FAILED',
      );
      const exported = await auditRows('audit.exported', fx.users.owner.id);
      expect(exported).toHaveLength(1);
      expect(exported[0]).toMatchObject({ entity_type: 'job', entity_id: jobId });

      const queued = jobSchema.parse((await fx.call('owner', 'GET', `/jobs/${jobId}`)).json());
      expect(queued).toMatchObject({ id: jobId, type: 'audit.export', status: 'queued' });
      expectProblem(await fx.call('u_admin', 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
      expectProblem(await fx.call('stranger', 'GET', `/jobs/${jobId}`), 404, 'NOT_FOUND');
      const byOrgAdmin = await orgAdminBrowser.request({
        method: 'GET',
        url: `/api/v1/jobs/${jobId}`,
      });
      expect(byOrgAdmin.statusCode).toBe(200);

      // The real worker runs the `audit.export` task.
      const { rows: queuedJobs } = await sql<{ payload: { filters: Record<string, string> } }>`
        SELECT payload
          FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id)
         WHERE jobs.task_identifier = 'audit.export' AND payload->>'job_id' = ${jobId}
      `.execute(db.kysely);
      expect(queuedJobs[0]?.payload.filters).toEqual({ table_id: fx.orders.id });
      await startWorker();
      const done = await finishedJob(() => fx.call('owner', 'GET', `/jobs/${jobId}`));
      expect(done).toMatchObject({
        status: 'succeeded',
        progress: 1,
        result: { download_url: `/api/v1/files/exports/${jobId}`, truncated: false },
      });
      const downloadUrl = (done.result?.download_url as string).replace('/api/v1', '');

      const redirect = await fx.call('owner', 'GET', downloadUrl);
      expect(redirect.statusCode).toBe(302);
      const location = new URL(redirect.headers.location as string);
      const file = await t.app.inject({
        method: 'GET',
        url: `${location.pathname}${location.search}`,
      });
      expect(file.statusCode).toBe(200);
      // UTF-8 byte order mark first, for spreadsheet apps.
      expect(file.body.charCodeAt(0)).toBe(0xfeff);
      const csv = file.body.slice(1);
      const [header, ...lines] = csv.trim().split('\r\n');
      expect(header?.startsWith('id,created_at,actor_type,actor_id')).toBe(true);
      expect(lines.length).toBe(done.result?.rows);
      expect(csv).toContain(ids.r1);
      expect(csv).not.toContain(fx.tickets.id);

      const adminRedirect = await orgAdminBrowser.request({
        method: 'GET',
        url: `/api/v1${downloadUrl}`,
      });
      expect(adminRedirect.statusCode).toBe(302);
      expectProblem(await fx.call('u_admin', 'GET', downloadUrl), 404, 'NOT_FOUND');
      expectProblem(await fx.call('stranger', 'GET', downloadUrl), 404, 'NOT_FOUND');

      // Past `expires_at` the link is gone.
      await sql`UPDATE meta.jobs
                   SET result = jsonb_set(result, '{expires_at}', to_jsonb('2000-01-01T00:00:00.000Z'::text))
                 WHERE id = ${jobId}`.execute(db.kysely);
      expectProblem(await fx.call('owner', 'GET', downloadUrl), 404, 'NOT_FOUND');
    });

    it('export: a creator who is no longer org owner/admin cannot see the job or the file', async () => {
      const accepted = await orgAdminBrowser.request({
        method: 'POST',
        url: `/api/v1/orgs/${fx.orgId}/audit-logs/export`,
        payload: { format: 'csv' },
      });
      expect(accepted.statusCode).toBe(202);
      const { job_id: jobId } = jobAcceptedSchema.parse(accepted.json());
      const jobUrl = `/api/v1/jobs/${jobId}`;
      const fileUrl = `/api/v1/files/exports/${jobId}`;
      // The real worker (started by the previous test, or now when run alone).
      await startWorker();
      const done = await finishedJob(() => orgAdminBrowser.request({ method: 'GET', url: jobUrl }));
      expect(done.status).toBe('succeeded');
      expect((await orgAdminBrowser.request({ method: 'GET', url: fileUrl })).statusCode).toBe(302);

      const setRole = async (role: 'admin' | 'member') => {
        const response = await fx.call(
          'owner',
          'PATCH',
          `/orgs/${fx.orgId}/members/${orgAdmin.id}`,
          {
            role,
          },
        );
        expect(response.statusCode).toBe(200);
      };
      await setRole('member');
      try {
        expectProblem(
          await orgAdminBrowser.request({ method: 'GET', url: jobUrl }),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          await orgAdminBrowser.request({ method: 'GET', url: fileUrl }),
          404,
          'NOT_FOUND',
        );
        // Owners still see it.
        expect((await fx.call('owner', 'GET', `/jobs/${jobId}`)).statusCode).toBe(200);
      } finally {
        await setRole('admin');
      }
      expect((await orgAdminBrowser.request({ method: 'GET', url: jobUrl })).statusCode).toBe(200);
    });

    it('redact: owner only, never own or audit.* entries, audited without values', async () => {
      // An entry about r1 whose actor is the owner stays readable.
      expect(
        (await fx.call('owner', 'PATCH', `${orders}/${ids.r1 ?? ''}`, { fields: { amount: 7 } }))
          .statusCode,
      ).toBe(200);
      const body = { entity_type: 'record', entity_ids: [ids.r1] };
      const byAdmin = await orgAdminBrowser.request({
        method: 'POST',
        url: `/api/v1/orgs/${fx.orgId}/audit-logs/redact`,
        payload: body,
      });
      expectProblem(byAdmin, 403, 'PERMISSION_DENIED');
      expectProblem(
        await fx.call('u_admin', 'POST', `/orgs/${fx.orgId}/audit-logs/redact`, body),
        404,
        'NOT_FOUND',
      );

      const response = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/audit-logs/redact`, body);
      expect(response.statusCode).toBe(200);
      const { redacted } = redactAuditLogsResponseSchema.parse(response.json());
      expect(redacted).toBeGreaterThan(0);

      const entries = auditLogListSchema.parse(
        (
          await fx.call(
            'owner',
            'GET',
            `/orgs/${fx.orgId}/audit-logs?entity_type=record&entity_id=${ids.r1 ?? ''}&limit=200`,
          )
        ).json(),
      ).items;
      for (const entry of entries) {
        if (entry.actor.id === fx.users.owner.id) {
          expect(entry.after).toEqual({ [fx.fld.amount?.id ?? '']: 7 });
        } else {
          for (const side of [entry.before, entry.after]) {
            expect(side === null || JSON.stringify(side) === '{"redacted":true}').toBe(true);
          }
        }
      }
      expect(entries.some((entry) => JSON.stringify(entry.after) === '{"redacted":true}')).toBe(
        true,
      );
      // History shows no value any more (redacted entries have no visible field).
      const history = entriesOf(await historyOf('u_admin', orders, ids.r1 as string));
      expect(history.every((entry) => entry.actor.id === fx.users.owner.id)).toBe(true);

      const audit = await auditRows('audit.redacted', fx.users.owner.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.after).toEqual({
        entity_type: 'record',
        entity_ids: [ids.r1],
        redacted,
      });
      // By user: ip/user_agent of the user's actions go, except on `audit.*` entries.
      expect((await auditRows('record.deleted', fx.users.u_admin.id))[0]?.ip).not.toBeNull();
      const byUser = redactAuditLogsResponseSchema.parse(
        (
          await fx.call('owner', 'POST', `/orgs/${fx.orgId}/audit-logs/redact`, {
            user_id: fx.users.u_admin.id,
          })
        ).json(),
      );
      expect(byUser.redacted).toBeGreaterThan(0);
      for (const row of await auditRows('record.deleted', fx.users.u_admin.id)) {
        expect([row.ip, row.user_agent]).toEqual([null, null]);
      }
      const viewed = await auditRows('audit.viewed', fx.users.u_admin.id);
      expect(viewed[0]?.ip).not.toBeNull();
    });
  });

  // --- CSRF ------------------------------------------------------------------------

  it('every new POST needs the CSRF token with a session cookie', async () => {
    const browser = new Browser(t.app);
    expect((await browser.login(fx.users.owner.email)).statusCode).toBe(204);
    const posts: [string, object][] = [
      [`/api/v1${orders}/${ids.r1 ?? ''}/revert`, { audit_id: newId('aud') }],
      [`/api/v1/orgs/${fx.orgId}/audit-logs/export`, { format: 'csv' }],
      [`/api/v1/orgs/${fx.orgId}/audit-logs/redact`, { user_id: fx.users.u_out.id }],
      [`/api/v1/fields/${newId('fld')}/restore`, {}],
    ];
    for (const [url, payload] of posts) {
      const response = await browser.request({ method: 'POST', url, payload, csrf: false });
      expectProblem(response, 403, 'CSRF_INVALID');
    }
  });
});
